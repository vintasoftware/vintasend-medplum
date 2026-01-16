import { MedplumClient } from '@medplum/core';
import type { Binary, Media } from '@medplum/fhirtypes';
import { BaseAttachmentManager } from 'vintasend/dist/services/attachment-manager/base-attachment-manager';
import type {
  AttachmentFileRecord,
  AttachmentFile,
  FileAttachment,
} from 'vintasend/dist/types/attachment';

/**
 * Medplum AttachmentManager implementation.
 *
 * This implementation uses FHIR resources for file storage:
 * - Binary resources store the actual file data
 * - Media resources store file metadata and link to Binary resources
 *
 * Files are uploaded to Medplum's storage and can be accessed via URLs.
 */
export class MedplumAttachmentManager extends BaseAttachmentManager {
  constructor(private medplum: MedplumClient) {
    super();
  }

  /**
   * Upload a file to Medplum storage using Binary and Media resources.
   *
   * @param file - The file data (Buffer, ReadableStream, or file path)
   * @param filename - The filename to use for storage
   * @param contentType - Optional MIME type (auto-detected if not provided)
   * @returns AttachmentFileRecord with metadata about the uploaded file
   */
  async uploadFile(
    file: FileAttachment,
    filename: string,
    contentType?: string,
  ): Promise<AttachmentFileRecord> {
    // Convert file to Buffer
    const buffer = await this.fileToBuffer(file);

    // Calculate checksum for deduplication
    const checksum = this.calculateChecksum(buffer);

    // Detect content type if not provided
    const finalContentType = contentType || this.detectContentType(filename);

    // Create Binary resource with the file data
    const binary: Binary = {
      resourceType: 'Binary',
      contentType: finalContentType,
      data: buffer.toString('base64'),
    };

    const createdBinary = await this.medplum.createResource(binary);
    const binaryUrl = `Binary/${createdBinary.id}`;

    // Create Media resource with metadata
    const media: Media = {
      resourceType: 'Media',
      status: 'completed',
      content: {
        contentType: finalContentType,
        url: binaryUrl,
        size: buffer.length,
        title: filename,
        creation: new Date().toISOString(),
      },
      identifier: [
        {
          system: 'http://vintasend.com/fhir/attachment-checksum',
          value: checksum,
        },
      ],
      meta: {
        tag: [
          { code: 'attachment-file' },
        ],
      },
    };

    const createdMedia = await this.medplum.createResource(media);

    return {
      id: createdMedia.id as string,
      filename,
      contentType: finalContentType,
      size: buffer.length,
      checksum,
      storageMetadata: {
        url: binaryUrl,
        creation: createdMedia.content.creation,
      },
      createdAt: createdMedia.meta?.lastUpdated ? new Date(createdMedia.meta.lastUpdated) : new Date(),
      updatedAt: createdMedia.meta?.lastUpdated ? new Date(createdMedia.meta.lastUpdated) : new Date(),
    };
  }

  /**
   * Retrieve a file record by its Media resource ID.
   *
   * @param fileId - The Media resource ID
   * @returns The file record or null if not found
   */
  async getFile(fileId: string): Promise<AttachmentFileRecord | null> {
    try {
      const media = await this.medplum.readResource('Media', fileId);

      if (!media.content || !media.id) {
        return null;
      }

      return {
        id: media.id,
        filename: media.content.title || 'untitled',
        contentType: media.content.contentType || 'application/octet-stream',
        size: media.content.size || 0,
        checksum: media.identifier?.[0]?.value || '',
        storageMetadata: {
          url: media.content.url,
          creation: media.content.creation,
        },
        createdAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
        updatedAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete a file from Medplum storage.
   *
   * Deletes both the Media resource (metadata) and Binary resource (file data).
   *
   * @param fileId - The Media resource ID
   */
  async deleteFile(fileId: string): Promise<void> {
    // Get Media resource to find the Binary URL
    const media = await this.medplum.readResource('Media', fileId);

    // Extract Binary ID from URL
    const binaryUrl = media.content?.url;
    if (binaryUrl) {
      const match = binaryUrl.match(/Binary\/([^/]+)/);
      if (match) {
        const binaryId = match[1];
        // Delete Binary resource
        try {
          await this.medplum.deleteResource('Binary', binaryId);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`Failed to delete Binary resource ${binaryId}:`, error);
        }
      }
    }

    // Delete Media resource
    await this.medplum.deleteResource('Media', fileId);
  }

  /**
   * Reconstruct an AttachmentFile from storage metadata.
   *
   * @param storageMetadata - Metadata containing either 'url' (Binary URL) or 'binaryId'
   * @returns AttachmentFile instance for accessing the file
   */
  reconstructAttachmentFile(storageMetadata: Record<string, unknown>): AttachmentFile {
    // Support both 'url' (from upload) and 'binaryId' (direct ID)
    let binaryUrl: string;

    if (storageMetadata.binaryId && typeof storageMetadata.binaryId === 'string') {
      // Direct Binary ID format
      binaryUrl = `Binary/${storageMetadata.binaryId}`;
    } else if (storageMetadata.url && typeof storageMetadata.url === 'string') {
      // Binary URL format (from uploadFile)
      binaryUrl = storageMetadata.url;
    } else {
      throw new Error('Storage metadata must contain binaryId for Medplum files');
    }

    return new MedplumAttachmentFile(this.medplum, binaryUrl);
  }
}

/**
 * Medplum AttachmentFile implementation.
 *
 * Provides access to files stored in Medplum Binary resources.
 */
export class MedplumAttachmentFile implements AttachmentFile {
  private binaryId: string;

  constructor(
    private medplum: MedplumClient,
    binaryUrl: string,
  ) {
    // Extract Binary ID from URL (format: "Binary/{id}")
    const match = binaryUrl.match(/Binary\/([^/]+)/);
    if (!match) {
      throw new Error(`Invalid Binary URL format: ${binaryUrl}`);
    }
    this.binaryId = match[1];
  }

  /**
   * Read the entire file into memory as a Buffer.
   */
  async read(): Promise<Buffer> {
    const binary = await this.medplum.readResource('Binary', this.binaryId);
    if (!binary.data) {
      throw new Error('Binary resource has no data');
    }
    return Buffer.from(binary.data, 'base64');
  }

  /**
   * Get a readable stream for the file.
   *
   * Note: For Medplum, we read the entire file and convert to stream.
   * For true streaming, you'd need to use Medplum's binary download API.
   */
  async stream(): Promise<ReadableStream> {
    const buffer = await this.read();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(buffer);
        controller.close();
      },
    });
  }

  /**
   * Generate a URL for accessing the file.
   *
   * For Medplum, this returns the Binary resource URL.
   * In production, you might want to generate a presigned URL.
   *
   * @param expiresIn - Seconds until the URL expires (not used for Medplum)
   * @returns URL for file access
   */
  async url(expiresIn = 3600): Promise<string> {
    // For Medplum, we can use the Binary resource URL
    // In a production setup, you might want to use Medplum's authentication
    // or generate a time-limited access token
    return `Binary/${this.binaryId}`;
  }

  /**
   * Delete this file from storage.
   */
  async delete(): Promise<void> {
    await this.medplum.deleteResource('Binary', this.binaryId);
  }
}
