import { MockClient } from '@medplum/mock';
import type { Media, Binary } from '@medplum/fhirtypes';
import { MedplumAttachmentManager } from '../medplum-attachment-manager';

type MediaWithId = Media & { id: string };
type BinaryWithId = Binary & { id: string };

/**
 * Tests for MedplumAttachmentManager.
 *
 * NOTE: MockClient from @medplum/mock runs operations in-memory and is NOT a Jest mock.
 * To verify method calls, use jest.spyOn() instead of treating it as a mock:
 *
 * ✅ Correct: const spy = jest.spyOn(medplumClient, 'createResource').mockResolvedValue({})
 * ❌ Wrong:   medplumClient.createResource.mockResolvedValue({})
 *
 * The test.setup.ts file configures the MockClient with proper FHIR search parameters
 * to enable filtering in tests.
 */
describe('MedplumAttachmentManager', () => {
  let medplumClient: MockClient;
  let manager: MedplumAttachmentManager;

  beforeEach(() => {
    jest.clearAllMocks();

    medplumClient = new MockClient();

    manager = new MedplumAttachmentManager(medplumClient);
  });

  describe('uploadFile', () => {
    it('should upload a Buffer to Medplum as Binary and Media resources', async () => {
      const buffer = Buffer.from('test file content');
      const filename = 'test.txt';
      const contentType = 'text/plain';

      const mockBinary: BinaryWithId = {
        resourceType: 'Binary',
        id: 'binary-123',
        contentType,
        data: buffer.toString('base64'),
      };

      const mockMedia: MediaWithId = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        meta: {
          tag: [{ code: 'attachment-file' }],
        },
        content: {
          contentType,
          url: 'Binary/binary-123',
          size: buffer.length,
          title: filename,
          creation: new Date().toISOString(),
        },
        identifier: [
          {
            system: 'checksum',
            value: expect.any(String),
          },
        ],
        createdDateTime: expect.any(String),
      };

      const createResourceSpy = jest.spyOn(medplumClient, 'createResource')
        .mockResolvedValueOnce(mockBinary as any)
        .mockResolvedValueOnce(mockMedia as any);

      const result = await manager.uploadFile(buffer, filename, contentType);

      expect(createResourceSpy).toHaveBeenCalledTimes(2);

      // Verify Binary resource creation
      expect(createResourceSpy).toHaveBeenNthCalledWith(1, {
        resourceType: 'Binary',
        contentType,
        data: buffer.toString('base64'),
      });

      // Verify Media resource creation
      expect(createResourceSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
        resourceType: 'Media',
        status: 'completed',
        content: expect.objectContaining({
          contentType,
          size: buffer.length,
          title: filename,
        }),
      }));

      // Verify the result structure
      expect(result).toMatchObject({
        id: 'media-123',
        filename,
        contentType,
        size: buffer.length,
        checksum: expect.any(String),
        storageIdentifiers: {
          id: expect.any(String),
          medplumBinaryId: expect.any(String),
          medplumMediaId: expect.any(String),
          url: 'Binary/binary-123',
        },
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });

    it('should auto-detect content type if not provided', async () => {
      const buffer = Buffer.from('PDF content');
      const filename = 'document.pdf';

      const mockBinary: Binary = {
        resourceType: 'Binary',
        id: 'binary-123',
        contentType: 'application/pdf',
        data: buffer.toString('base64'),
      };

      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        meta: {
          tag: [{ code: 'attachment-file' }],
        },
        content: {
          contentType: 'application/pdf',
          url: 'Binary/binary-123',
          size: buffer.length,
          title: filename,
        },
        identifier: [],
        createdDateTime: new Date().toISOString(),
      };

      jest.spyOn(medplumClient, 'createResource')
        .mockResolvedValueOnce(mockBinary as any)
        .mockResolvedValueOnce(mockMedia as any);

      const result = await manager.uploadFile(buffer, filename);

      expect(result.contentType).toBe('application/pdf');
    });

    it('should handle different file types', async () => {
      const testCases = [
        { filename: 'image.png', expected: 'image/png' },
        { filename: 'video.mp4', expected: 'video/mp4' },
        { filename: 'data.json', expected: 'application/json' },
        { filename: 'unknown.unknownext', expected: 'application/octet-stream' },
      ];

      for (const { filename, expected } of testCases) {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: `binary-${filename}`,
          contentType: expected,
          data: Buffer.from('test').toString('base64'),
        };

        const mockMedia: Media = {
          resourceType: 'Media',
          id: `media-${filename}`,
          status: 'completed',
          meta: {
            tag: [{ code: 'attachment-file' }],
          },
          content: {
            contentType: expected,
            url: `Binary/binary-${filename}`,
            size: 4,
            title: filename,
          },
          identifier: [],
          createdDateTime: new Date().toISOString(),
        };

        jest.spyOn(medplumClient, 'createResource')
          .mockResolvedValueOnce(mockBinary as any)
          .mockResolvedValueOnce(mockMedia as any);

        const result = await manager.uploadFile(Buffer.from('test'), filename);
        expect(result.contentType).toBe(expected);
      }
    });

    it('should calculate SHA-256 checksum', async () => {
      const buffer = Buffer.from('test content');

      const mockBinary: Binary = {
        resourceType: 'Binary',
        id: 'binary-123',
        contentType: 'text/plain',
        data: buffer.toString('base64'),
      };

      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        meta: {
          tag: [{ code: 'attachment-file' }],
        },
        content: {
          contentType: 'text/plain',
          url: 'Binary/binary-123',
          size: buffer.length,
          title: 'test.txt',
        },
        identifier: [
          {
            system: 'checksum',
            value: expect.any(String),
          },
        ],
        createdDateTime: new Date().toISOString(),
      };

      jest.spyOn(medplumClient, 'createResource')
        .mockResolvedValueOnce(mockBinary as any)
        .mockResolvedValueOnce(mockMedia as any);

      const result = await manager.uploadFile(buffer, 'test.txt');

      // Verify checksum is a hex string of correct length (64 chars for SHA-256)
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getFile', () => {
    it('should retrieve a Media resource by ID', async () => {
      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        meta: {
          tag: [{ code: 'attachment-file' }],
        },
        content: {
          contentType: 'application/pdf',
          url: 'Binary/binary-123',
          size: 1024,
          title: 'test.pdf',
        },
        identifier: [
          {
            system: 'http://vintasend.com/fhir/attachment-checksum',
            value: 'abc123',
          },
          {
            system: 'http://vintasend.com/fhir/binary-id',
            value: 'binary-123',
          },
        ],
        createdDateTime: '2026-01-15T00:00:00Z',
      };

      const readResourceSpy = jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockMedia as any);

      const result = await manager.getFile('media-123');

      expect(readResourceSpy).toHaveBeenCalledWith('Media', 'media-123');
      expect(result).toMatchObject({
        id: 'media-123',
        filename: 'test.pdf',
        contentType: 'application/pdf',
        size: 1024,
        checksum: 'abc123',
      });
    });

    it('should return null if Media resource not found', async () => {
      jest.spyOn(medplumClient, 'readResource').mockRejectedValue(new Error('Not found'));

      const result = await manager.getFile('nonexistent');

      expect(result).toBeNull();
    });

    it('should extract binaryId from content.url when identifier is missing', async () => {
      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        meta: {
          tag: [{ code: 'attachment-file' }],
        },
        content: {
          contentType: 'application/pdf',
          url: 'Binary/binary-789',
          size: 1024,
          title: 'test.pdf',
        },
        // No identifiers - simulating a Media resource created outside uploadFile
      };

      jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockMedia as any);

      const result = await manager.getFile('media-123');

      expect(result).toMatchObject({
        id: 'media-123',
        filename: 'test.pdf',
        storageIdentifiers: {
          id: 'media-123',
          medplumBinaryId: 'binary-789',
          medplumMediaId: 'media-123',
          url: 'Binary/binary-789',
        },
      });
    });
  });

  describe('deleteFile', () => {
    it('should delete both Media and Binary resources', async () => {
      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        content: {
          contentType: 'application/pdf',
          url: 'Binary/binary-123',
          size: 1024,
          title: 'test.pdf',
        },
      };

      const readResourceSpy = jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockMedia as any);
      const deleteResourceSpy = jest.spyOn(medplumClient, 'deleteResource').mockResolvedValue({} as any);

      await manager.deleteFile('media-123');

      expect(readResourceSpy).toHaveBeenCalledWith('Media', 'media-123');
      expect(deleteResourceSpy).toHaveBeenCalledWith('Media', 'media-123');
      expect(deleteResourceSpy).toHaveBeenCalledWith('Binary', 'binary-123');
    });

    it('should handle deletion when Media resource not found', async () => {
      jest.spyOn(medplumClient, 'readResource').mockRejectedValue(new Error('Not found'));
      const deleteResourceSpy = jest.spyOn(medplumClient, 'deleteResource');

      await expect(manager.deleteFile('nonexistent')).rejects.toThrow('Not found');

      expect(deleteResourceSpy).not.toHaveBeenCalled();
    });

    it('should handle deletion when Binary reference is missing', async () => {
      const mockMedia: Media = {
        resourceType: 'Media',
        id: 'media-123',
        status: 'completed',
        content: {
          contentType: 'application/pdf',
          size: 1024,
          title: 'test.pdf',
        },
      };

      jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockMedia as any);
      const deleteResourceSpy = jest.spyOn(medplumClient, 'deleteResource').mockResolvedValue({} as any);

      await manager.deleteFile('media-123');

      expect(deleteResourceSpy).toHaveBeenCalledWith('Media', 'media-123');
      expect(deleteResourceSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconstructAttachmentFile', () => {
    it('should reconstruct AttachmentFile from storage metadata', () => {
      const storageMetadata = {
        id: 'media-123',
        medplumBinaryId: 'binary-123',
        medplumMediaId: 'media-123',
        url: 'Binary/binary-123',
      };

      const attachmentFile = manager.reconstructAttachmentFile(storageMetadata);

      expect(attachmentFile).toBeDefined();
      expect(typeof attachmentFile.read).toBe('function');
      expect(typeof attachmentFile.stream).toBe('function');
      expect(typeof attachmentFile.url).toBe('function');
      expect(typeof attachmentFile.delete).toBe('function');
    });

    it('should reconstruct AttachmentFile from URL when medplumBinaryId is missing', () => {
      const storageMetadata = {
        id: 'media-456',
        medplumMediaId: 'media-456',
        url: 'Binary/binary-456',
      };

      const attachmentFile = manager.reconstructAttachmentFile(storageMetadata);

      expect(attachmentFile).toBeDefined();
      expect(typeof attachmentFile.read).toBe('function');
    });

    it('should throw error if metadata has neither medplumBinaryId nor valid url', () => {
      const invalidMetadata = { id: 'test-id' };

      expect(() => manager.reconstructAttachmentFile(invalidMetadata)).toThrow(
        'Storage identifiers must contain medplumBinaryId or a url with Binary reference',
      );
    });

    it('should throw error if url does not contain Binary reference', () => {
      const invalidMetadata = {
        id: 'test-id',
        url: 'https://example.com/file',
      };

      expect(() => manager.reconstructAttachmentFile(invalidMetadata)).toThrow(
        'Storage identifiers must contain medplumBinaryId or a url with Binary reference',
      );
    });
  });

  describe('MedplumAttachmentFile', () => {
    let attachmentFile: any;
    const storageMetadata = {
      id: 'media-123',
      medplumBinaryId: 'binary-123',
      medplumMediaId: 'media-123',
      url: 'Binary/binary-123',
    };

    beforeEach(() => {
      attachmentFile = manager.reconstructAttachmentFile(storageMetadata);
    });

    describe('read', () => {
      it('should read file as Buffer from inline data', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
          data: Buffer.from('test content').toString('base64'),
        };

        const readResourceSpy = jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        const result = await attachmentFile.read();

        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.toString()).toBe('test content');
        expect(readResourceSpy).toHaveBeenCalledWith('Binary', 'binary-123');
      });

      it('should download file from URL when data is not available', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
          url: 'https://storage.example.com/binary-123',
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        const testContent = 'downloaded content';
        const testBuffer = Buffer.from(testContent);
        // Create a proper ArrayBuffer from the buffer
        const mockArrayBuffer = testBuffer.buffer.slice(
          testBuffer.byteOffset,
          testBuffer.byteOffset + testBuffer.byteLength
        );

        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: jest.fn().mockResolvedValue(mockArrayBuffer),
        });

        const result = await attachmentFile.read();

        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result.toString()).toBe('downloaded content');
        expect(global.fetch).toHaveBeenCalledWith('https://storage.example.com/binary-123');
      });

      it('should throw error if download fails', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
          url: 'https://storage.example.com/binary-123',
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        global.fetch = jest.fn().mockResolvedValue({
          ok: false,
          statusText: 'Not Found',
        });

        await expect(attachmentFile.read()).rejects.toThrow('Failed to download binary from URL: Not Found');
      });

      it('should throw error if Binary resource has neither data nor url', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        await expect(attachmentFile.read()).rejects.toThrow('Binary resource has neither data nor url');
      });
    });

    describe('stream', () => {
      it('should return ReadableStream', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
          data: Buffer.from('test content').toString('base64'),
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        const result = await attachmentFile.stream();

        expect(result).toBeInstanceOf(ReadableStream);
      });
    });

    describe('url', () => {
      it('should return presigned URL from Binary resource', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
          url: 'https://storage.example.com/binary-123?signature=abc',
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        const url = await attachmentFile.url();

        expect(url).toBe('https://storage.example.com/binary-123?signature=abc');
      });

      it('should throw error if Binary resource has no url', async () => {
        const mockBinary: Binary = {
          resourceType: 'Binary',
          id: 'binary-123',
          contentType: 'text/plain',
        };

        jest.spyOn(medplumClient, 'readResource').mockResolvedValue(mockBinary as any);

        await expect(attachmentFile.url()).rejects.toThrow('Binary resource binary-123 does not have a presigned URL');
      });
    });

    describe('delete', () => {
      it('should delete Binary resource', async () => {
        const deleteResourceSpy = jest.spyOn(medplumClient, 'deleteResource').mockResolvedValue({} as any);

        await attachmentFile.delete();

        expect(deleteResourceSpy).toHaveBeenCalledWith('Binary', 'binary-123');
      });
    });
  });
});
