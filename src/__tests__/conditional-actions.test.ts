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

/** The version token a stored Communication carries, if any. */
function tokenOf(resource: Communication): string | undefined {
  return resource.identifier?.find(
    (identifier) =>
      identifier.system === MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.notificationVersion,
  )?.value;
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
      expect(entry.version).toBe(tokenOf(await stored(entry.id)));
    }
  });

  it('never asks the server for anything but id, meta and identifier', async () => {
    await seed({ status: 'FAILED' });
    const search = vi.spyOn(medplum, 'searchResources');

    await backend.filterNotificationVersions(movableTo(V), 0, 50);
    await backend.filterNotificationVersions({ status: 'FAILED' }, 0, 50);

    expect(search).toHaveBeenCalled();
    for (const [, params] of search.mock.calls) {
      const elements = (params as string[][]).filter(([key]) => key === '_elements');
      expect(elements).toEqual([['_elements', 'id,meta,identifier']]);
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
      ['_elements', 'id,meta,identifier'],
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
    const versionId = (await stored(id)).meta?.versionId;
    const update = vi.spyOn(medplum, 'updateResource');

    const requeued = await service.requeueNotification(id, {
      templateVersion: V,
      expectedVersion: listed?.version,
      send: false,
    });

    // The token is what was expected; If-Match is on the server's version id of what was read.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'If-Match': `W/"${versionId}"` },
    });
    expect(requeued).toMatchObject({ status: 'PENDING_SEND', requestedTemplateVersion: V });
    const resource = await stored(id);
    expect(tokenOf(resource)).not.toBe(listed?.version);
    expect(requeued.notificationVersion).toBe(tokenOf(resource));
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
    const before = await stored(id);
    const update = vi.spyOn(medplum, 'updateResource');

    const repinned = await makeService().repinNotification(id, {
      expectedVersion: tokenOf(before),
    });

    expect(repinned.requestedTemplateVersion).toBe(V);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'If-Match': `W/"${before.meta?.versionId}"` },
    });
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
    const listed = tokenOf(await stored(id));
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
    const version = tokenOf(await stored(id));
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

/**
 * The version token: generated by the primary on every write, copied as it is by a replica, and
 * what `filterNotificationVersions` lists and `expectedVersion` is checked against.
 */
describe('notification version tokens', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const oneOffInput = {
    emailOrPhone: 'someone@example.com',
    firstName: 'Some',
    lastName: 'One',
    notificationType: 'EMAIL',
    title: 'Hi',
    bodyTemplate: 'welcome',
    contextName: 'testContext',
    contextParameters: { p: 'x' },
    sendAfter: null,
    subjectTemplate: null,
    extraParams: null,
  } as never;

  /** The tokens a resource carries: always exactly one, once it has been written. */
  async function tokensOf(id: string): Promise<string[]> {
    return ((await stored(id)).identifier ?? [])
      .filter(
        (identifier) =>
          identifier.system === MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.notificationVersion,
      )
      .map((identifier) => identifier.value as string);
  }

  /** Strip the token, as a Communication written before tokens existed would be stored. */
  async function makeLegacy(id: string): Promise<Communication> {
    const resource = await stored(id);
    return medplum.updateResource({
      ...resource,
      identifier: resource.identifier?.filter(
        (identifier) =>
          identifier.system !== MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.notificationVersion,
      ),
    });
  }

  it('generates a new token on every write made without one', async () => {
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
    } as never);
    const id = created.id;
    const seen = [created.notificationVersion];
    expect(await tokensOf(id)).toEqual([created.notificationVersion]);

    const writes: (() => Promise<{ notificationVersion?: string } | undefined>)[] = [
      () => backend.persistNotificationUpdate(id, { title: 'Edited' } as never),
      () => backend.storeAdapterAndContextUsed(id, 'test-adapter', { v: 'x' }),
      () => backend.storeTemplateVersion(id, 3),
      () => backend.markAsSent(id, true),
      () => backend.markAsRead(id, true),
    ];
    for (const write of writes) {
      const token = (await write())?.notificationVersion;
      expect(await tokensOf(id)).toEqual([token]);
      seen.push(token);
    }

    for (const token of seen) {
      expect(token).toMatch(UUID);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('generates a new token on failure, re-queue, re-pin and attachment removal', async () => {
    const id = await seed();
    const seen = [tokenOf(await stored(id))];

    seen.push((await backend.markAsFailed(id, true)).notificationVersion);
    seen.push((await backend.repinNotification(id, V, {})).notificationVersion);
    seen.push((await backend.requeueNotification(id, {})).notificationVersion);
    const resource = await stored(id);
    await medplum.updateResource({
      ...resource,
      payload: [...(resource.payload ?? []), { contentAttachment: { url: 'Binary/file-1' } }],
    });
    await backend.deleteNotificationAttachment(id, 'file-1');
    seen.push(tokenOf(await stored(id)));

    for (const token of seen) {
      expect(token).toMatch(UUID);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('stores exactly the token it is handed, on every write', async () => {
    const created = await backend.persistNotification(
      {
        userId: 'Patient/user-1',
        notificationType: 'EMAIL',
        title: 'Hi',
        bodyTemplate: 'welcome',
        contextName: 'testContext',
        contextParameters: { p: 'x' },
        sendAfter: null,
        subjectTemplate: null,
        extraParams: null,
      } as never,
      { notificationVersion: 'primary-1' },
    );
    const id = created.id;
    expect(created.notificationVersion).toBe('primary-1');
    expect(await tokensOf(id)).toEqual(['primary-1']);

    const writes: [string, () => Promise<{ notificationVersion?: string } | undefined>][] = [
      [
        'primary-2',
        () =>
          backend.persistNotificationUpdate(id, { title: 'Edited' } as never, {
            notificationVersion: 'primary-2',
          }),
      ],
      [
        'primary-3',
        () =>
          backend.storeAdapterAndContextUsed(
            id,
            'test-adapter',
            { v: 'x' },
            { notificationVersion: 'primary-3' },
          ),
      ],
      [
        'primary-4',
        () => backend.storeTemplateVersion(id, 3, { notificationVersion: 'primary-4' }),
      ],
      ['primary-5', () => backend.markAsFailed(id, true, { notificationVersion: 'primary-5' })],
      ['primary-6', () => backend.repinNotification(id, V, { notificationVersion: 'primary-6' })],
      ['primary-7', () => backend.requeueNotification(id, { notificationVersion: 'primary-7' })],
      ['primary-8', () => backend.markAsSent(id, true, { notificationVersion: 'primary-8' })],
      ['primary-9', () => backend.markAsRead(id, true, { notificationVersion: 'primary-9' })],
    ];
    for (const [token, write] of writes) {
      expect((await write())?.notificationVersion).toBe(token);
      expect(await tokensOf(id)).toEqual([token]);
      expect((await backend.getNotification(id, false))?.notificationVersion).toBe(token);
    }
  });

  it('stores a handed token on re-pin even when the pin already matches', async () => {
    const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: V });

    const repinned = await backend.repinNotification(id, V, { notificationVersion: 'caught-up' });

    expect(repinned.notificationVersion).toBe('caught-up');
    expect(await tokensOf(id)).toEqual(['caught-up']);
    expect(repinned.requestedTemplateVersion).toBe(V);
  });

  it('stores the handed token on a one-off notification too', async () => {
    const created = await backend.persistOneOffNotification(oneOffInput, {
      notificationVersion: 'one-off-1',
    });
    expect(created.notificationVersion).toBe('one-off-1');
    expect(await tokensOf(created.id)).toEqual(['one-off-1']);

    const updated = await backend.persistOneOffNotificationUpdate(
      created.id,
      { title: 'Edited' } as never,
      { notificationVersion: 'one-off-2' },
    );
    expect(updated.notificationVersion).toBe('one-off-2');
    expect(await tokensOf(created.id)).toEqual(['one-off-2']);

    const fresh = await backend.persistOneOffNotificationUpdate(created.id, {
      title: 'Again',
    } as never);
    expect(fresh.notificationVersion).toMatch(UUID);
    expect((await backend.getOneOffNotification(created.id, false))?.notificationVersion).toBe(
      fresh.notificationVersion,
    );
  });

  it('stores bulk tokens by index, generating one where none is given', async () => {
    const input = {
      userId: 'Patient/user-1',
      notificationType: 'EMAIL',
      title: 'Hi',
      bodyTemplate: 'welcome',
      contextName: 'testContext',
      contextParameters: { p: 'x' },
      sendAfter: null,
      subjectTemplate: null,
      extraParams: null,
    } as never;

    const ids = await backend.bulkPersistNotifications([input, input, input], {
      notificationVersions: ['bulk-1', undefined, 'bulk-3'],
    });
    const unreplicated = await backend.bulkPersistNotifications([input, input]);

    expect(await tokensOf(ids[0] as string)).toEqual(['bulk-1']);
    expect((await tokensOf(ids[1] as string))[0]).toMatch(UUID);
    expect(await tokensOf(ids[2] as string)).toEqual(['bulk-3']);
    const [first, second] = await Promise.all(unreplicated.map((id) => tokensOf(id)));
    expect(first?.[0]).toMatch(UUID);
    expect(second?.[0]).toMatch(UUID);
    expect(first?.[0]).not.toBe(second?.[0]);
  });

  it('returns no token from a cancel, which deletes the notification', async () => {
    const id = await seed({ sendAfter: FUTURE });

    expect(
      await backend.cancelNotification(id, { notificationVersion: 'ignored' }),
    ).toBeUndefined();
    expect(await backend.getNotification(id, false)).toBeNull();
  });

  it('lists the stored token from filterNotificationVersions', async () => {
    const id = await seed({ status: 'FAILED' });
    await backend.persistNotificationUpdate(id, { title: 'Edited' } as never, {
      notificationVersion: 'replicated',
    });

    expect(await backend.filterNotificationVersions({ status: 'FAILED' }, 0, 10)).toEqual([
      { id, version: 'replicated' },
    ]);
  });

  it('copies the snapshot token when a replication snapshot is applied', async () => {
    const id = await seed({ status: 'FAILED' });
    const snapshot = await backend.getNotification(id, false);
    const replica = new MedplumNotificationBackend<TestConfig>(new MockClient());

    expect(await replica.applyReplicationSnapshotIfNewer(snapshot as never)).toEqual({
      applied: true,
    });

    expect((await replica.getNotification(id, false))?.notificationVersion).toBe(
      snapshot?.notificationVersion,
    );
  });

  describe('a token listed from a replica, acted on at the primary', () => {
    let replica: MedplumNotificationBackend<TestConfig>;

    /** Create on the primary and copy each write to the replica the way VintaSend does. */
    async function seedReplicated(): Promise<string> {
      const input = {
        userId: 'Patient/user-1',
        notificationType: 'EMAIL',
        title: 'Hi',
        bodyTemplate: 'welcome',
        contextName: 'testContext',
        contextParameters: { p: 'x' },
        sendAfter: FUTURE,
        subjectTemplate: null,
        extraParams: null,
        requestedTemplateVersion: 1,
      };
      const created = await backend.persistNotification(input as never);
      await replica.persistNotification({ ...input, id: created.id } as never, {
        notificationVersion: created.notificationVersion,
      });
      const failed = await backend.markAsFailed(created.id, true);
      await replica.markAsFailed(created.id, true, {
        notificationVersion: failed.notificationVersion,
      });
      return created.id;
    }

    beforeEach(() => {
      replica = new MedplumNotificationBackend<TestConfig>(new MockClient());
    });

    it('matches once the replica has caught up', async () => {
      const id = await seedReplicated();
      const [listed] = await replica.filterNotificationVersions(movableTo(V), 0, 10);
      expect(listed?.version).toBe(tokenOf(await stored(id)));

      const requeued = await backend.requeueNotification(id, {
        templateVersion: V,
        expectedVersion: listed?.version,
      });

      expect(requeued).toMatchObject({ status: 'PENDING_SEND', requestedTemplateVersion: V });
    });

    it('refuses CHANGED while the replica lags behind, writing nothing', async () => {
      const id = await seedReplicated();
      const [listed] = await replica.filterNotificationVersions(movableTo(V), 0, 10);
      await backend.persistNotificationUpdate(id, { title: 'Edited' } as never); // not replicated
      const before = await stored(id);
      const writes = spyOnWrites();

      await expectActionError(
        backend.repinNotification(id, V, { expectedVersion: listed?.version }),
        'CHANGED',
      );

      expectNoWrites(writes);
      expect(await stored(id)).toEqual(before);
    });
  });

  it('still refuses CHANGED when a write lands between the token check and the update', async () => {
    const id = await seed({ status: 'FAILED' });
    const read = await stored(id);
    await backend.persistNotificationUpdate(id, { title: 'Written by someone else' } as never);
    vi.spyOn(medplum, 'readResource').mockResolvedValueOnce(read as never);

    // The token read matches, but If-Match names the server version that has since moved on.
    await expectActionError(
      backend.requeueNotification(id, { expectedVersion: tokenOf(read) }),
      'CHANGED',
    );

    expect((await stored(id)).status).toBe('stopped');
  });

  describe('on a Communication written before tokens existed', () => {
    it('reads and lists meta.versionId as the token', async () => {
      const id = await seed({ status: 'FAILED' });
      const legacy = await makeLegacy(id);

      expect((await backend.getNotification(id, false))?.notificationVersion).toBe(
        legacy.meta?.versionId,
      );
      expect(await backend.filterNotificationVersions({ status: 'FAILED' }, 0, 10)).toEqual([
        { id, version: legacy.meta?.versionId },
      ]);
    });

    it('accepts meta.versionId as expectedVersion, and gives it a token on that write', async () => {
      const id = await seed({ status: 'FAILED' });
      const legacy = await makeLegacy(id);

      await backend.requeueNotification(id, { expectedVersion: legacy.meta?.versionId });

      const tokens = await tokensOf(id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatch(UUID);
      expect(tokens[0]).not.toBe(legacy.meta?.versionId);
    });

    it('refuses CHANGED for a stale meta.versionId, writing nothing', async () => {
      const id = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
      const legacy = await makeLegacy(id);
      await medplum.updateResource({ ...legacy, topic: { text: 'Edited' } });
      const writes = spyOnWrites();

      await expectActionError(
        backend.repinNotification(id, V, { expectedVersion: legacy.meta?.versionId }),
        'CHANGED',
      );

      expectNoWrites(writes);
    });
  });
});

describe('capabilities and constants', () => {
  it('reports every optional action', async () => {
    expect(await makeService().getBackendSupportedActionCapabilities()).toEqual({
      'repin.expectedVersion': true,
      'requeue.expectedVersion': true,
      'requeue.templateVersion': true,
      'versions.filter': true,
      'repin.bulk': true,
      'requeue.bulk': true,
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
        {
          system: MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.notificationVersion,
          value: expect.any(String),
        },
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
