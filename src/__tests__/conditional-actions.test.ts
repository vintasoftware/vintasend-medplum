/**
 * Moving notifications safely on FHIR: listing them without reading their content, then re-pinning
 * and re-queuing them only while they are at the version that was listed.
 *
 * Driven through `VintaSend` where an application would drive it, over `MedplumNotificationBackend`
 * and the Medplum mock client, so `If-Match` and the searches run against a real FHIR repository.
 */

import {
  type FhirFilterComparison,
  FhirFilterConnective,
  type FhirFilterExpression,
  FhirFilterNegation,
  matchesSearchRequest,
  parseFilterParameter,
} from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import {
  type BaseNotificationAdapter,
  type BaseNotificationTypeConfig,
  NotificationActionError,
  type NotificationFilter,
  VintaSendFactory,
} from 'vintasend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  communicationStatusToNotificationStatus,
  MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS,
  MEDPLUM_NOTIFICATION_TAG,
  NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS,
} from '../index';
import { MedplumNotificationBackend } from '../medplum-backend';

interface TestConfig extends BaseNotificationTypeConfig {
  ContextMap: { testContext: { generate: (params: { p: string }) => Promise<{ v: string }> } };
  NotificationIdType: string;
  UserIdType: string;
}

const PAST = new Date('2000-01-01T00:00:00.000Z');
const FUTURE = new Date('2999-01-01T00:00:00.000Z');
const V = 2;

let medplum: MockClient;
let backend: MedplumNotificationBackend<TestConfig>;
let adapter: { send: ReturnType<typeof vi.fn> } & Record<string, unknown>;

function makeService(options: { withoutAdapters?: boolean } = {}) {
  return new VintaSendFactory<TestConfig>().create({
    adapters: (options.withoutAdapters ? [] : [adapter]) as unknown as BaseNotificationAdapter<
      any,
      TestConfig
    >[],
    backend,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    contextGeneratorsMap: { testContext: { generate: async () => ({ v: 'x' }) } },
    options: { raiseErrorOnFailedSend: false },
  });
}

/** Create a notification and move it to `status` through the backend, as a send would. */
async function seed(
  overrides: {
    bodyTemplate?: string;
    sendAfter?: Date | null;
    requestedTemplateVersion?: number | null;
    status?: 'PENDING_SEND' | 'FAILED' | 'SENT';
  } = {},
): Promise<string> {
  const { status = 'PENDING_SEND', ...fields } = overrides;
  const created = await backend.persistNotification({
    userId: 'Patient/user-1',
    notificationType: 'EMAIL',
    title: 'Hi',
    bodyTemplate: 'welcome',
    contextName: 'testContext',
    contextParameters: { p: 'x' },
    sendAfter: null,
    subjectTemplate: null,
    extraParams: null,
    ...fields,
  } as never);
  if (status === 'FAILED') {
    await backend.markAsFailed(created.id, true);
  } else if (status === 'SENT') {
    await backend.markAsSent(created.id, true);
  }
  return created.id;
}

async function stored(id: string): Promise<Communication> {
  return medplum.readResource('Communication', id);
}

/** Spies on every write the mock client offers, to assert that none happened. */
function spyOnWrites() {
  return [
    vi.spyOn(medplum, 'updateResource'),
    vi.spyOn(medplum, 'createResource'),
    vi.spyOn(medplum, 'deleteResource'),
    vi.spyOn(medplum, 'patchResource'),
  ];
}

function expectNoWrites(spies: ReturnType<typeof spyOnWrites>) {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

async function expectActionError(promise: Promise<unknown>, reason: string) {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to throw');
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(NotificationActionError);
  expect((error as NotificationActionError).reason).toBe(reason);
  return error as NotificationActionError;
}

/**
 * "This template key's emails that should move to V": pending ones with a send time that are
 * pinned to some other version, and failed ones.
 */
function movableTo(version: number): NotificationFilter<TestConfig> {
  return {
    and: [
      { bodyTemplate: 'welcome' },
      {
        or: [
          {
            and: [
              { status: 'PENDING_SEND', hasSendAfter: true, hasRequestedTemplateVersion: true },
              { not: { requestedTemplateVersion: version } },
            ],
          },
          { status: 'FAILED' },
        ],
      },
    ],
  };
}

beforeEach(() => {
  medplum = new MockClient();
  backend = new MedplumNotificationBackend<TestConfig>(medplum);
  adapter = {
    notificationType: 'EMAIL',
    key: 'test-adapter',
    enqueueNotifications: false,
    send: vi.fn().mockResolvedValue(undefined),
    injectBackend: vi.fn(),
    injectLogger: vi.fn(),
    getTemplateRenderer: () => ({ getLatestTemplateVersion: async () => V }),
    supportsAttachments: false,
  };
});

describe('filterNotificationVersions', () => {
  it('finds the pending and failed emails to move, and nothing else', async () => {
    const pendingOnOld = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
    await seed({ sendAfter: FUTURE, requestedTemplateVersion: V }); // already on V
    await seed({ sendAfter: null, requestedTemplateVersion: 1 }); // no send time
    await seed({ sendAfter: FUTURE, requestedTemplateVersion: null }); // unpinned
    const failed = await seed({ requestedTemplateVersion: V, status: 'FAILED' });
    await seed({ bodyTemplate: 'reset', status: 'FAILED' }); // another key
    await seed({ requestedTemplateVersion: 1, status: 'SENT' }); // delivered

    const listed = await makeService().filterNotificationVersions(movableTo(V), 0, 50);

    expect(listed.map((entry) => entry.id)).toEqual([pendingOnOld, failed].sort());
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'version']);
      expect(entry.version).toBe((await stored(entry.id)).meta?.versionId);
    }
  });

  it('never asks the server for anything but id and meta', async () => {
    await seed({ status: 'FAILED' });
    const search = vi.spyOn(medplum, 'searchResources');

    await backend.filterNotificationVersions(movableTo(V), 0, 50);
    await backend.filterNotificationVersions({ status: 'FAILED' }, 0, 50);

    expect(search).toHaveBeenCalled();
    for (const [, params] of search.mock.calls) {
      const elements = (params as string[][]).filter(([key]) => key === '_elements');
      expect(elements).toEqual([['_elements', 'id,meta']]);
    }
  });

  it('runs a filter without OR as one search, sorted by id', async () => {
    const search = vi.spyOn(medplum, 'searchResources');

    await backend.filterNotificationVersions({ status: 'FAILED', hasSendAfter: false }, 2, 25);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('Communication', [
      ['status', 'stopped'],
      ['sent:missing', 'true'],
      ['_sort', '_id'],
      ['_count', '25'],
      ['_offset', '50'],
      ['_elements', 'id,meta'],
      ['_tag', MEDPLUM_NOTIFICATION_TAG],
    ]);
  });

  it('pages through the union of the branches by id', async () => {
    const ids = [
      await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 }),
      await seed({ status: 'FAILED' }),
      await seed({ sendAfter: PAST, requestedTemplateVersion: 3 }),
      await seed({ status: 'FAILED' }),
    ].sort();

    const pages = [];
    for (let page = 0; page < 3; page += 1) {
      pages.push(
        (await backend.filterNotificationVersions(movableTo(V), page, 2)).map((entry) => entry.id),
      );
    }

    expect(pages).toEqual([ids.slice(0, 2), ids.slice(2, 4), []]);
  });

  it('lists each notification once when it matches several branches', async () => {
    const id = await seed({ status: 'FAILED' });

    const listed = await backend.filterNotificationVersions(
      { or: [{ status: 'FAILED' }, { bodyTemplate: 'welcome' }] },
      0,
      10,
    );

    expect(listed.map((entry) => entry.id)).toEqual([id]);
  });

  it('matches nothing for an empty OR', async () => {
    await seed({ status: 'FAILED' });

    expect(await backend.filterNotificationVersions({ or: [] }, 0, 10)).toEqual([]);
  });

  it('refuses a filter that expands to too many searches', async () => {
    const wide = { or: Array.from({ length: 17 }, () => ({ status: 'FAILED' as const })) };

    await expect(backend.filterNotificationVersions(wide, 0, 10)).rejects.toThrow(
      'separate searches',
    );
  });
});

describe('presence filters', () => {
  it('tells notifications with a send time from those without', async () => {
    const scheduled = await seed({ sendAfter: FUTURE });
    const unscheduled = await seed({ sendAfter: null });

    const withTime = await backend.filterNotifications({ hasSendAfter: true }, 0, 10);
    const withoutTime = await backend.filterNotifications({ not: { hasSendAfter: true } }, 0, 10);

    expect(withTime.map((n) => n.id)).toEqual([scheduled]);
    expect(withoutTime.map((n) => n.id)).toEqual([unscheduled]);
  });

  it('tells pinned notifications from unpinned ones', async () => {
    const pinned = await seed({ requestedTemplateVersion: 4 });
    const unpinned = await seed({ requestedTemplateVersion: null });

    const yes = await backend.filterNotifications({ hasRequestedTemplateVersion: true }, 0, 10);
    const no = await backend.filterNotifications({ hasRequestedTemplateVersion: false }, 0, 10);
    const negated = await backend.filterNotifications(
      { not: { hasRequestedTemplateVersion: true } },
      0,
      10,
    );

    expect(yes.map((n) => n.id)).toEqual([pinned]);
    expect(no.map((n) => n.id)).toEqual([unpinned]);
    expect(negated.map((n) => n.id)).toEqual([unpinned]);
  });

  it('ANDs two identifier fields in one leaf instead of ORing them', async () => {
    const match = await seed({ requestedTemplateVersion: 4 });
    await seed({ bodyTemplate: 'reset', requestedTemplateVersion: 4 });
    await seed({ requestedTemplateVersion: 5 });

    const found = await backend.filterNotifications(
      { bodyTemplate: 'welcome', requestedTemplateVersion: 4 },
      0,
      10,
    );

    expect(found.map((n) => n.id)).toEqual([match]);
  });

  it('reports the new filter vocabulary', async () => {
    const capabilities = await makeService().getBackendSupportedFilterCapabilities();

    expect(capabilities).toMatchObject({
      'logical.or': true,
      'fields.hasSendAfter': true,
      'negation.hasSendAfter': true,
      'fields.hasRequestedTemplateVersion': true,
      'negation.hasRequestedTemplateVersion': true,
    });
  });
});

/**
 * Make the mock client honour `_filter`, which its in-memory repository does not support (it
 * matches nothing). The expression is parsed and matched with Medplum's own `_filter` parser and
 * search matcher, and paging is applied after it, as the server's SQL does.
 */
function evaluateFilterParameterInMock() {
  const search = medplum.searchResources.bind(medplum);
  const matches = (resource: Communication, expression: FhirFilterExpression): boolean => {
    if (expression instanceof FhirFilterConnective) {
      const left = matches(resource, expression.left);
      const right = matches(resource, expression.right);
      return expression.keyword === 'and' ? left && right : left || right;
    }
    if (expression instanceof FhirFilterNegation) {
      return !matches(resource, expression.child);
    }
    const { path: code, operator, value } = expression as FhirFilterComparison;
    return matchesSearchRequest(resource, {
      resourceType: 'Communication',
      filters: [{ code, operator, value }],
    });
  };

  return vi.spyOn(medplum, 'searchResources').mockImplementation((async (
    resourceType: 'Communication',
    query: Record<string, string> | string[][],
  ) => {
    const params = new URLSearchParams(query);
    const filter = params.get('_filter');
    if (filter === null) {
      return search(resourceType, query);
    }
    const offset = Number(params.get('_offset') ?? 0);
    const count = Number(params.get('_count') ?? 20);
    for (const key of ['_filter', '_offset', '_count']) {
      params.delete(key);
    }
    params.set('_count', '1000');
    const expression = parseFilterParameter(filter);
    const all = await search(resourceType, [...params.entries()]);
    return all.filter((resource) => matches(resource, expression)).slice(offset, offset + count);
  }) as never);
}

describe('pending notifications', () => {
  beforeEach(() => {
    evaluateFilterParameterInMock();
  });

  /** Due now: one with no send time, one whose send time has passed. Plus ones that are not. */
  async function seedMixed() {
    const unscheduled = await seed({ sendAfter: null });
    const due = await seed({ sendAfter: PAST });
    await seed({ sendAfter: FUTURE });
    await seed({ sendAfter: null, status: 'FAILED' });
    await seed({ sendAfter: PAST, status: 'SENT' });
    return [unscheduled, due].sort();
  }

  it('lists every pending notification, with or without a send time', async () => {
    const expected = await seedMixed();

    const found = await backend.getAllPendingNotifications();

    expect(found.map((n) => n.id).sort()).toEqual(expected);
  });

  it('pages through pending notifications, with or without a send time', async () => {
    const expected = await seedMixed();

    const pages = [];
    for (let page = 0; page < 3; page += 1) {
      pages.push((await backend.getPendingNotifications(page, 1)).map((n) => n.id));
    }

    // No sort is asked for, so only which notifications the pages hold is checked, not their order.
    expect(pages.map((ids) => ids.length)).toEqual([1, 1, 0]);
    expect(pages.flat().sort()).toEqual(expected);
  });

  it('asks the server for one page in one search', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-11T12:00:00.000Z'), toFake: ['Date'] });
    try {
      await backend.getPendingNotifications(2, 25);
    } finally {
      vi.useRealTimers();
    }

    expect(medplum.searchResources).toHaveBeenCalledTimes(1);
    expect(medplum.searchResources).toHaveBeenCalledWith('Communication', {
      status: 'in-progress',
      _tag: MEDPLUM_NOTIFICATION_TAG,
      _filter: 'sent pr false or sent le 2026-11-11T12:00:00.000Z',
      _count: '25',
      _offset: '50',
    });
  });

  it('is what sendPendingNotifications sends', async () => {
    await seedMixed();

    await makeService().sendPendingNotifications();

    expect(adapter.send).toHaveBeenCalledTimes(2);
  });
});

describe('filterNotifications with OR', () => {
  it('returns full notifications from every branch', async () => {
    const failed = await seed({ status: 'FAILED' });
    const scheduled = await seed({ sendAfter: FUTURE });
    await seed({ sendAfter: null });

    const found = await backend.filterNotifications(
      { or: [{ status: 'FAILED' }, { hasSendAfter: true }] },
      0,
      10,
    );

    expect(found.map((n) => n.id)).toEqual([failed, scheduled].sort());
    expect(found.every((n) => n.bodyTemplate === 'welcome')).toBe(true);
  });

  it('refuses an orderBy rather than ordering the merge wrongly', async () => {
    const search = vi.spyOn(medplum, 'searchResources');

    await expect(
      backend.filterNotifications({ or: [{ status: 'FAILED' }, { hasSendAfter: true }] }, 0, 10, {
        field: 'createdAt',
        direction: 'desc',
      }),
    ).rejects.toThrow('orderBy is not supported together with an OR filter');
    expect(search).not.toHaveBeenCalled();
  });
});

describe('requeueNotification', () => {
  it('re-pins and re-queues in one update conditional on the listed version', async () => {
    const id = await seed({ requestedTemplateVersion: 1, status: 'FAILED' });
    const service = makeService();
    const [listed] = await service.filterNotificationVersions(movableTo(V), 0, 10);
    const update = vi.spyOn(medplum, 'updateResource');

    const requeued = await service.requeueNotification(id, {
      templateVersion: V,
      expectedVersion: listed?.version,
      send: false,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'If-Match': `W/"${listed?.version}"` },
    });
    expect(requeued).toMatchObject({ status: 'PENDING_SEND', requestedTemplateVersion: V });
    const resource = await stored(id);
    expect(resource.status).toBe('in-progress');
    expect(resource.identifier).toContainEqual({
      system: MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.requestedTemplateVersion,
      value: String(V),
    });
  });

  it('refuses CHANGED for a notification written since it was listed, writing nothing', async () => {
    const id = await seed({ requestedTemplateVersion: 1, status: 'FAILED' });
    const service = makeService();
    const [listed] = await service.filterNotificationVersions(movableTo(V), 0, 10);
    await backend.persistNotificationUpdate(id, { title: 'Edited' } as never);
    const before = await stored(id);
    const writes = spyOnWrites();

    const error = await expectActionError(
      service.requeueNotification(id, { templateVersion: V, expectedVersion: listed?.version }),
      'CHANGED',
    );

    expect(error.message).toBe(
      `Cannot requeue notification ${id}: it changed since the version that was expected`,
    );
    expectNoWrites(writes);
    expect(await stored(id)).toEqual(before);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('refuses CHANGED when the notification changes between its read and its write', async () => {
    const id = await seed({ status: 'FAILED' });
    const stale = await stored(id);
    await medplum.updateResource({ ...stale, topic: { text: 'Written by someone else' } });
    vi.spyOn(medplum, 'readResource').mockResolvedValueOnce(stale as never);

    await expectActionError(backend.requeueNotification(id, {}), 'CHANGED');

    const resource = await stored(id);
    expect(resource.status).toBe('stopped');
    expect(resource.topic?.text).toBe('Written by someone else');
  });

  it.each([
    ['PENDING_SEND', 'in-progress'],
    ['SENT', 'completed'],
  ] as const)('refuses a %s notification, writing nothing', async (status, fhirStatus) => {
    const id = await seed({ status, sendAfter: FUTURE });
    const before = await stored(id);
    const writes = spyOnWrites();

    await expectActionError(
      makeService().requeueNotification(id, { templateVersion: V, expectedVersion: '' }),
      'INVALID_STATUS',
    );

    expectNoWrites(writes);
    expect((await stored(id)).status).toBe(fhirStatus);
    expect(await stored(id)).toEqual(before);
  });

  it('re-queues without sending on a service with no adapter', async () => {
    const id = await seed({ status: 'FAILED' });

    const requeued = await makeService({ withoutAdapters: true }).requeueNotification(id, {
      sendAfter: null,
      templateVersion: V,
      send: false,
    });

    expect(requeued.status).toBe('PENDING_SEND');
    expect((await stored(id)).status).toBe('in-progress');
  });

  it('returns the notification as the send left it', async () => {
    const sentId = await seed({ status: 'FAILED' });
    const failingId = await seed({ status: 'FAILED' });
    const service = makeService();

    const sent = await service.requeueNotification(sentId);
    adapter.send.mockRejectedValueOnce(new Error('provider down'));
    const failing = await service.requeueNotification(failingId);

    expect(sent.status).toBe('SENT');
    expect(failing.status).toBe('FAILED');
  });
});

describe('repinNotification', () => {
  it('re-pins with If-Match on the version it read', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
    const version = (await stored(id)).meta?.versionId;
    const update = vi.spyOn(medplum, 'updateResource');

    const repinned = await makeService().repinNotification(id, { expectedVersion: version });

    expect(repinned.requestedTemplateVersion).toBe(V);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({ headers: { 'If-Match': `W/"${version}"` } });
  });

  it('uses If-Match without an expected version too', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
    const stale = await stored(id);
    await medplum.updateResource({ ...stale, topic: { text: 'Written by someone else' } });
    // Every read sees the stale copy: the service's own, and the backend's before it writes.
    const read = vi.spyOn(medplum, 'readResource').mockResolvedValue(stale as never);

    await expectActionError(makeService().repinNotification(id), 'CHANGED');

    read.mockRestore();
    expect((await backend.getNotification(id, false))?.requestedTemplateVersion).toBe(1);
  });

  it('refuses CHANGED for a stale expected version, writing nothing', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
    const listed = (await stored(id)).meta?.versionId;
    await backend.persistNotificationUpdate(id, { title: 'Edited' } as never);
    const before = await stored(id);
    const writes = spyOnWrites();

    await expectActionError(
      makeService().repinNotification(id, { templateVersion: V, expectedVersion: listed }),
      'CHANGED',
    );

    expectNoWrites(writes);
    expect(await stored(id)).toEqual(before);
  });

  it('refuses CHANGED even when the pin already matches', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: V });
    const writes = spyOnWrites();

    await expectActionError(
      makeService().repinNotification(id, { expectedVersion: 'stale' }),
      'CHANGED',
    );

    expectNoWrites(writes);
  });

  it('writes nothing when the notification is already on that version', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: V });
    const version = (await stored(id)).meta?.versionId;
    const writes = spyOnWrites();

    const repinned = await makeService().repinNotification(id, { expectedVersion: version });

    expectNoWrites(writes);
    expect(repinned.requestedTemplateVersion).toBe(V);
  });

  it('refuses a sent notification on the backend itself, writing nothing', async () => {
    const id = await seed({ status: 'SENT' });
    const writes = spyOnWrites();

    const error = await expectActionError(backend.repinNotification(id, V, {}), 'INVALID_STATUS');

    expect(error.status).toBe('SENT');
    expectNoWrites(writes);
  });

  it('refuses a notification that does not exist', async () => {
    await expectActionError(backend.repinNotification('missing', V, {}), 'NOT_FOUND');
  });
});

describe('capabilities and constants', () => {
  it('reports every optional action', async () => {
    expect(await makeService().getBackendSupportedActionCapabilities()).toEqual({
      'repin.expectedVersion': true,
      'requeue.expectedVersion': true,
      'requeue.templateVersion': true,
      'versions.filter': true,
    });
  });

  it('exports the identifier systems and tag the backend writes', async () => {
    const id = await seed({ requestedTemplateVersion: 3 });
    const resource = await stored(id);

    expect(resource.meta?.tag?.[0]?.code).toBe(MEDPLUM_NOTIFICATION_TAG);
    expect(resource.identifier).toEqual(
      expect.arrayContaining([
        { system: MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.bodyTemplate, value: 'welcome' },
        { system: MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.requestedTemplateVersion, value: '3' },
      ]),
    );
  });

  it('exports the status mapping both ways', async () => {
    const failedId = await seed({ status: 'FAILED' });

    expect((await stored(failedId)).status).toBe(
      NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS.FAILED,
    );
    for (const status of ['PENDING_SEND', 'SENT', 'FAILED'] as const) {
      expect(
        communicationStatusToNotificationStatus(
          NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS[status],
        ),
      ).toBe(status);
    }
  });
});
