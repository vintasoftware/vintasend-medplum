/**
 * Template versions on FHIR: both live in identifiers, so a token search can find them.
 *
 * `requestedTemplateVersion` travels with ordinary writes; `usedTemplateVersion` is written only
 * by `storeTemplateVersion`, which the service calls at send time. FHIR identifier values are
 * strings, so the round trip through `String()` and `parseInt` is the part worth pinning.
 */

import { MockClient } from '@medplum/mock';
import type { BaseNotificationTypeConfig } from 'vintasend';
import { beforeEach, describe, expect, it } from 'vitest';

import { MedplumNotificationBackend } from '../medplum-backend';

interface TestConfig extends BaseNotificationTypeConfig {
  ContextMap: { testContext: { generate: (params: { p: string }) => Promise<{ v: string }> } };
  NotificationIdType: string;
  UserIdType: string;
}

const REQUESTED_SYSTEM = 'http://vintasend.com/fhir/requested-template-version';
const USED_SYSTEM = 'http://vintasend.com/fhir/used-template-version';

let medplum: MockClient;
let backend: MedplumNotificationBackend<TestConfig>;

const input = {
  userId: 'Patient/user-1',
  notificationType: 'EMAIL' as const,
  title: 'Hi',
  bodyTemplate: 'welcome',
  contextName: 'testContext' as const,
  contextParameters: { p: 'x' },
  sendAfter: null,
  subjectTemplate: null,
  extraParams: null,
};

async function identifiersOf(id: string) {
  const resource = await medplum.readResource('Communication', id);
  return resource.identifier ?? [];
}

beforeEach(() => {
  medplum = new MockClient();
  backend = new MedplumNotificationBackend<TestConfig>(medplum);
});

describe('round trip', () => {
  it('stores a pinned version and reads it back as a number', async () => {
    const created = await backend.persistNotification({
      ...input,
      requestedTemplateVersion: 3,
    } as never);

    expect(created.requestedTemplateVersion).toBe(3);
    expect(await identifiersOf(created.id)).toContainEqual({
      system: REQUESTED_SYSTEM,
      value: '3',
    });

    const read = await backend.getNotification(created.id, false);
    expect(read?.requestedTemplateVersion).toBe(3);
  });

  it('reads an unpinned notification as null on both fields', async () => {
    const created = await backend.persistNotification(input as never);

    expect(created.requestedTemplateVersion).toBeNull();
    expect(created.usedTemplateVersion).toBeNull();
    expect(await identifiersOf(created.id)).not.toContainEqual(
      expect.objectContaining({ system: REQUESTED_SYSTEM }),
    );
  });

  it('reads a malformed identifier as absent rather than as NaN', async () => {
    const created = await backend.persistNotification(input as never);
    const resource = await medplum.readResource('Communication', created.id);
    await medplum.updateResource({
      ...resource,
      identifier: [...(resource.identifier ?? []), { system: USED_SYSTEM, value: 'not-a-number' }],
    });

    const read = await backend.getNotification(created.id, false);

    expect(read?.usedTemplateVersion).toBeNull();
  });

  it('pins a one-off notification the same way', async () => {
    const created = await backend.persistOneOffNotification({
      emailOrPhone: 'someone@example.com',
      firstName: 'Ana',
      lastName: 'Silva',
      notificationType: 'EMAIL',
      title: 'Hi',
      bodyTemplate: 'welcome',
      contextName: 'testContext',
      contextParameters: { p: 'x' },
      sendAfter: null,
      subjectTemplate: null,
      extraParams: null,
      requestedTemplateVersion: 5,
    } as never);

    expect(created.requestedTemplateVersion).toBe(5);
  });
});

describe('writes', () => {
  it('repoints a notification through an update', async () => {
    const created = await backend.persistNotification({
      ...input,
      requestedTemplateVersion: 3,
    } as never);

    const updated = await backend.persistNotificationUpdate(created.id, {
      requestedTemplateVersion: 6,
    } as never);

    expect(updated.requestedTemplateVersion).toBe(6);
    expect(
      (await identifiersOf(created.id)).filter((i) => i.system === REQUESTED_SYSTEM),
    ).toHaveLength(1);
  });

  it('leaves an existing pin alone on an update that does not mention it', async () => {
    const created = await backend.persistNotification({
      ...input,
      requestedTemplateVersion: 3,
    } as never);

    const updated = await backend.persistNotificationUpdate(created.id, {
      title: 'New title',
    } as never);

    expect(updated.requestedTemplateVersion).toBe(3);
  });

  it('records the used version through storeTemplateVersion', async () => {
    const created = await backend.persistNotification(input as never);

    await backend.storeTemplateVersion(created.id, 7);

    const read = await backend.getNotification(created.id, false);
    expect(read?.usedTemplateVersion).toBe(7);
    expect(read?.requestedTemplateVersion).toBeNull();
  });

  it('replaces the used version rather than accumulating identifiers', async () => {
    const created = await backend.persistNotification(input as never);

    await backend.storeTemplateVersion(created.id, 7);
    await backend.storeTemplateVersion(created.id, 8);

    expect((await identifiersOf(created.id)).filter((i) => i.system === USED_SYSTEM)).toHaveLength(
      1,
    );
    expect((await backend.getNotification(created.id, false))?.usedTemplateVersion).toBe(8);
  });
});

describe('filtering', () => {
  beforeEach(async () => {
    await backend.persistNotification({ ...input, requestedTemplateVersion: 3 } as never);
    const other = await backend.persistNotification({
      ...input,
      requestedTemplateVersion: 4,
    } as never);
    await backend.storeTemplateVersion(other.id, 4);
  });

  it('finds a notification by the version it is pinned to', async () => {
    const found = await backend.filterNotifications({ requestedTemplateVersion: 3 }, 0, 10);

    expect(found).toHaveLength(1);
    expect(found[0]?.requestedTemplateVersion).toBe(3);
  });

  it('finds any of a list of versions', async () => {
    const found = await backend.filterNotifications({ requestedTemplateVersion: [3, 4] }, 0, 10);

    expect(found).toHaveLength(2);
  });

  it('finds a notification by the version that actually rendered', async () => {
    const found = await backend.filterNotifications({ usedTemplateVersion: 4 }, 0, 10);

    expect(found).toHaveLength(1);
    expect(found[0]?.usedTemplateVersion).toBe(4);
  });

  it('declares both fields filterable', () => {
    const capabilities = backend.getFilterCapabilities();

    expect(capabilities['fields.requestedTemplateVersion']).toBe(true);
    expect(capabilities['fields.usedTemplateVersion']).toBe(true);
  });
});
