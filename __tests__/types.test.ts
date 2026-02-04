import type { MedplumStorageIdentifiers } from '../src/types';

describe('MedplumStorageIdentifiers', () => {
  it('should extend StorageIdentifiers with Medplum fields', () => {
    const ids: MedplumStorageIdentifiers = {
      id: 'media-123',
      medplumBinaryId: 'binary-456',
      medplumMediaId: 'media-123',
      url: 'Binary/binary-456',
    };

    expect(ids.id).toBe('media-123');
    expect(ids.medplumBinaryId).toBe('binary-456');
    expect(ids.medplumMediaId).toBe('media-123');
    expect(ids.url).toBe('Binary/binary-456');
  });

  it('should require all Medplum-specific fields', () => {
    const ids: MedplumStorageIdentifiers = {
      id: 'media-456',
      medplumBinaryId: 'binary-789',
      medplumMediaId: 'media-456',
      url: 'Binary/binary-789',
    };

    // All fields should be present and accessible
    expect(ids.medplumBinaryId).toBeDefined();
    expect(ids.medplumMediaId).toBeDefined();
    expect(ids.url).toBeDefined();
  });

  it('should allow arbitrary additional fields like StorageIdentifiers', () => {
    const ids: MedplumStorageIdentifiers & { customField?: string } = {
      id: 'media-789',
      medplumBinaryId: 'binary-111',
      medplumMediaId: 'media-789',
      url: 'Binary/binary-111',
      customField: 'custom-value',
    };

    expect(ids.customField).toBe('custom-value');
  });

  it('should work as StorageIdentifiers in generic context', () => {
    const ids: MedplumStorageIdentifiers = {
      id: 'media-999',
      medplumBinaryId: 'binary-888',
      medplumMediaId: 'media-999',
      url: 'Binary/binary-888',
    };

    // Should be usable where StorageIdentifiers is expected
    function acceptStorageIdentifiers(ids: { id: string; [key: string]: unknown }) {
      return ids.id;
    }

    expect(acceptStorageIdentifiers(ids)).toBe('media-999');
  });

  it('should validate URL format matches pattern', () => {
    const ids: MedplumStorageIdentifiers = {
      id: 'media-test',
      medplumBinaryId: 'binary-test',
      medplumMediaId: 'media-test',
      url: 'Binary/binary-test',
    };

    expect(ids.url).toMatch(/^Binary\//);
  });
});
