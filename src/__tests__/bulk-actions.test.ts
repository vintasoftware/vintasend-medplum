/**
 * Moving many notifications at once: recounting a batch by ID, then re-pinning or re-queuing it
 * with one search and one batch of conditional patches, without reading any notification in full.
 *
 * Driven through `VintaSend` over `MedplumNotificationBackend` and the Medplum mock client, so the
 * searches, the batch and `If-Match` run against a real FHIR repository.
 */

import type { Bundle, Communication } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import {
  type BaseNotificationAdapter,
  type BaseNotificationTypeConfig,
  type NotificationFilter,
  VintaSendFactory,
} from 'vintasend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  communicationStatusToNotificationStatus,
  MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS,
} from '../index';
import { MedplumNotificationBackend } from '../medplum-backend';

interface TestConfig extends BaseNotificationTypeConfig {
  ContextMap: { testContext: { generate: (params: { p: string }) => Promise<{ v: string }> } };
  NotificationIdType: string;
  UserIdType: string;
}

const FUTURE = new Date('2999-01-01T00:00:00.000Z');
const V = 2;

let medplum: MockClient;
let backend: MedplumNotificationBackend<TestConfig>;
let adapter: { send: ReturnType<typeof vi.fn> } & Record<string, unknown>;

function makeService() {
  return new VintaSendFactory<TestConfig>().create({
    adapters: [adapter] as unknown as BaseNotificationAdapter<any, TestConfig>[],
    backend,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    contextGeneratorsMap: { testContext: { generate: async () => ({ v: 'x' }) } },
    options: { raiseErrorOnFailedSend: false },
  });
}

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

function tokenOf(resource: Communication): string | undefined {
  return resource.identifier?.find(
    (identifier) =>
      identifier.system === MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.notificationVersion,
  )?.value;
}

function pinOf(resource: Communication): string | undefined {
  return resource.identifier?.find(
    (identifier) =>
      identifier.system === MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS.requestedTemplateVersion,
  )?.value;
}

const WELCOME_MOVABLE: NotificationFilter<TestConfig> = {
  bodyTemplate: 'welcome',
  status: ['PENDING_SEND', 'FAILED'],
};

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

describe('the id filter', () => {
  it('recounts just a batch of IDs against a filter', async () => {
    const a = await seed({ requestedTemplateVersion: 1 });
    const b = await seed({ requestedTemplateVersion: 1 });
    await seed({ requestedTemplateVersion: 1 }); // matches, but not in the batch
    const sent = await seed({ requestedTemplateVersion: 1, status: 'SENT' }); // in the batch only
    const search = vi.spyOn(medplum, 'searchResources');

    const listed = await makeService().filterNotificationVersions(
      { and: [WELCOME_MOVABLE, { id: [a, b, sent] }] },
      0,
      50,
    );

    expect(listed.map((entry) => entry.id)).toEqual([a, b].sort());
    expect(search).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(search.mock.calls[0][1] as string[][]).getAll('_id')).toEqual([
      [a, b, sent].join(','),
    ]);
  });

  it('matches nothing for an empty list, without searching', async () => {
    await seed();
    const search = vi.spyOn(medplum, 'searchResources');

    const listed = await makeService().filterNotificationVersions({ id: [] }, 0, 50);

    expect(listed).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('is reported, and its negation is not', async () => {
    const capabilities = await makeService().getBackendSupportedFilterCapabilities();
    expect(capabilities['fields.id']).toBe(true);
    expect(capabilities['negation.id']).toBe(false);
  });
});

describe('repinNotifications', () => {
  it('re-pins a batch with one search and one batch request, reading no notification', async () => {
    const pending = await seed({ sendAfter: FUTURE, requestedTemplateVersion: 1 });
    const failed = await seed({ requestedTemplateVersion: 1, status: 'FAILED' });
    const service = makeService();
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 50);

    const read = vi.spyOn(medplum, 'readResource');
    const search = vi.spyOn(medplum, 'searchResources');
    const batch = vi.spyOn(medplum, 'executeBatch');
    const update = vi.spyOn(medplum, 'updateResource');
    const patch = vi.spyOn(medplum, 'patchResource');

    const results = await service.repinNotifications(targets, {
      templateVersion: V,
      filter: WELCOME_MOVABLE,
    });

    expect(results.map((result) => [result.id, result.outcome])).toEqual(
      targets.map((target) => [target.id, 'WRITTEN']),
    );
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(search.mock.calls[0][1] as string[][]).get('_elements')).toBe(
      'id,meta,identifier,status,sent',
    );
    expect(batch).toHaveBeenCalledTimes(1);

    for (const id of [pending, failed]) {
      const resource = await stored(id);
      expect(pinOf(resource)).toBe(String(V));
      expect(tokenOf(resource)).toBe(results.find((result) => result.id === id)?.version);
    }
    expect(communicationStatusToNotificationStatus((await stored(pending)).status)).toBe(
      'PENDING_SEND',
    );
  });

  it('skips, with a reason, what changed, moved out of the filter, was sent or is already pinned', async () => {
    const changed = await seed({ requestedTemplateVersion: 1 });
    const outOfFilter = await seed({ bodyTemplate: 'reset', requestedTemplateVersion: 1 });
    const sent = await seed({ requestedTemplateVersion: 1, status: 'SENT' });
    const alreadyOnV = await seed({ requestedTemplateVersion: V });
    const moves = await seed({ requestedTemplateVersion: 1 });
    const service = makeService();
    const targets = await service.filterNotificationVersions(
      { status: ['PENDING_SEND', 'SENT'] },
      0,
      50,
    );
    await backend.markAsFailed(changed, true); // written after it was listed

    const before = new Map(
      await Promise.all(
        [changed, outOfFilter, sent, alreadyOnV].map(
          async (id) => [id, (await stored(id)).meta?.versionId] as const,
        ),
      ),
    );
    const results = await service.repinNotifications(
      [...targets, { id: 'does-not-exist', version: 'x' }],
      { templateVersion: V, filter: { bodyTemplate: 'welcome' } },
    );
    const byId = new Map(results.map((result) => [result.id, result]));

    expect(byId.get(changed)?.outcome).toBe('CHANGED');
    expect(byId.get(outOfFilter)?.outcome).toBe('NOT_MATCHED');
    expect(byId.get(sent)).toMatchObject({ outcome: 'INVALID_STATUS', status: 'SENT' });
    expect(byId.get(alreadyOnV)).toMatchObject({
      outcome: 'UNCHANGED',
      version: targets.find((target) => target.id === alreadyOnV)?.version,
    });
    expect(byId.get(moves)?.outcome).toBe('WRITTEN');
    expect(byId.get('does-not-exist')?.outcome).toBe('NOT_MATCHED');
    for (const [id, versionId] of before) {
      expect((await stored(id)).meta?.versionId).toBe(versionId);
    }
  });

  it('refuses a notification written between the search and the batch', async () => {
    const racing = await seed({ requestedTemplateVersion: 1 });
    const service = makeService();
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 50);

    const search = medplum.searchResources.bind(medplum);
    vi.spyOn(medplum, 'searchResources').mockImplementationOnce((async (...args: unknown[]) => {
      const found = await (search as (...a: unknown[]) => Promise<Communication[]>)(...args);
      // A worker cancels it after the search saw it, which bumps `meta.versionId`.
      const current = await medplum.readResource('Communication', racing);
      await medplum.updateResource({ ...current, status: 'stopped' });
      return found;
    }) as never);

    const results = await service.repinNotifications(targets, { templateVersion: V });

    expect(results).toEqual([{ id: racing, outcome: 'CHANGED' }]);
    expect(pinOf(await stored(racing))).toBe('1');
  });

  it('reports a write the server refused for another reason as FAILED', async () => {
    const id = await seed({ requestedTemplateVersion: 1 });
    const service = makeService();
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 50);
    vi.spyOn(medplum, 'executeBatch').mockResolvedValueOnce({
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [{ response: { status: '403 Forbidden' } }],
    } as Bundle);

    const results = await service.repinNotifications(targets, { templateVersion: V });

    expect(results).toEqual([{ id, outcome: 'FAILED' }]);
  });

  it('splits a large batch into requests of 100', async () => {
    const ids = [];
    for (let index = 0; index < 101; index += 1) {
      ids.push(await seed({ requestedTemplateVersion: 1 }));
    }
    const service = makeService();
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 200);
    const batch = vi.spyOn(medplum, 'executeBatch');

    const results = await service.repinNotifications(targets, { templateVersion: V });

    expect(results.every((result) => result.outcome === 'WRITTEN')).toBe(true);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(101);
  });

  it('leaves later reads through the same client fresh', async () => {
    const id = await seed({ requestedTemplateVersion: 1 });
    const service = makeService();
    await medplum.readResource('Communication', id); // cached
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 50);

    await service.repinNotifications(targets, { templateVersion: V });

    expect((await backend.getNotification(id, false))?.requestedTemplateVersion).toBe(V);
  });
});

describe('requeueNotifications', () => {
  it('re-queues failed notifications, re-pinned and rescheduled, and sends nothing', async () => {
    const failed = await seed({ requestedTemplateVersion: 1, status: 'FAILED' });
    const pending = await seed({ requestedTemplateVersion: 1 });
    const service = makeService();
    const targets = await service.filterNotificationVersions(WELCOME_MOVABLE, 0, 50);
    const read = vi.spyOn(medplum, 'readResource');

    const results = await service.requeueNotifications(targets, {
      templateVersion: V,
      sendAfter: FUTURE,
      filter: WELCOME_MOVABLE,
    });
    const byId = new Map(results.map((result) => [result.id, result]));

    expect(byId.get(failed)?.outcome).toBe('WRITTEN');
    expect(byId.get(pending)).toMatchObject({ outcome: 'INVALID_STATUS', status: 'PENDING_SEND' });
    expect(read).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();

    const requeued = await backend.getNotification(failed, false);
    expect(requeued).toMatchObject({
      status: 'PENDING_SEND',
      requestedTemplateVersion: V,
      sendAfter: FUTURE,
      notificationVersion: byId.get(failed)?.version,
    });
  });

  it('clears the send time when sendAfter is null, and keeps it when it is left out', async () => {
    const cleared = await seed({ sendAfter: FUTURE, status: 'FAILED' });
    const service = makeService();
    let targets = await service.filterNotificationVersions({ id: cleared }, 0, 50);
    await service.requeueNotifications(targets, { sendAfter: null });
    expect((await stored(cleared)).sent).toBeUndefined();

    const kept = await seed({ sendAfter: FUTURE, status: 'FAILED' });
    targets = await service.filterNotificationVersions({ id: kept }, 0, 50);
    await service.requeueNotifications(targets);
    expect((await stored(kept)).sent).toBe(FUTURE.toISOString());
  });
});
