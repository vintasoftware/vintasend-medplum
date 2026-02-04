import { MedplumClient } from '@medplum/core';
import type { Binary, Media } from '@medplum/fhirtypes';
import { BaseAttachmentManager } from 'vintasend/dist/services/attachment-manager/base-attachment-manager';
import type {
  AttachmentFileRecord,
  AttachmentFile,
  FileAttachment,
  StorageIdentifiers,
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
        {
          system: 'http://vintasend.com/fhir/binary-id',
          value: createdBinary.id as string,
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
      storageIdentifiers: {
        id: createdMedia.id as string,
        url: binaryUrl,
        binaryId: createdBinary.id as string,
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

      // Extract Binary ID from identifier
      const binaryIdIdentifier = media.identifier?.find(
        (id) => id.system === 'http://vintasend.com/fhir/binary-id'
      );
      let binaryId = binaryIdIdentifier?.value;

      // If binaryId not found in identifier, try to extract from content.url
      if (!binaryId && media.content.url) {
        const match = media.content.url.match(/Binary\/([^/]+)/);
        if (match) {
          binaryId = match[1];
        }
      }

      // Extract checksum from identifier
      const checksumIdentifier = media.identifier?.find(
        (id) => id.system === 'http://vintasend.com/fhir/attachment-checksum'
      );
      const checksum = checksumIdentifier?.value || '';

      return {
        id: media.id,
        filename: media.content.title || 'untitled',
        contentType: media.content.contentType || 'application/octet-stream',
        size: media.content.size || 0,
        checksum,
        storageIdentifiers: {
          id: media.id,
          url: media.content.url,
          binaryId: binaryId,
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
   * Delete a file from Medplum storage using storage identifiers.
   */
  async deleteFileByIdentifiers(storageIdentifiers: StorageIdentifiers): Promise<void> {
    if (storageIdentifiers.id && typeof storageIdentifiers.id === 'string') {
      await this.deleteFile(storageIdentifiers.id);
      return;
    }

    throw new Error('Invalid storage identifiers: missing id');
  }

  /**
  * Reconstruct an AttachmentFile from storage identifiers.
   *
  * @param storageMetadata - Identifiers containing 'binaryId' or 'url'
   * @returns AttachmentFile instance for accessing the file
   */
  reconstructAttachmentFile(storageMetadata: StorageIdentifiers): AttachmentFile {
    let binaryId = storageMetadata.binaryId as string | undefined;

    // If binaryId not provided directly, try to extract from url
    if (!binaryId && storageMetadata.url && typeof storageMetadata.url === 'string') {
      const match = storageMetadata.url.match(/Binary\/([^/]+)/);
      if (match) {
        binaryId = match[1];
      }
    }

    if (!binaryId) {
      throw new Error('Storage metadata must contain binaryId or a url with Binary reference');
    }

    return new MedplumAttachmentFile(this.medplum, binaryId);
  }
}

/**
 * Medplum AttachmentFile implementation.
 *
 * Provides access to files stored in Medplum Binary resources.
 */
export class MedplumAttachmentFile implements AttachmentFile {
  constructor(
    private medplum: MedplumClient,
    private binaryId: string,
  ) {}

  /**
   * Read the entire file into memory as a Buffer.
   *
   * Works with Binary resources that have either:
   * - Inline data (base64 encoded)
   * - External storage (downloaded via Medplum client)
   */
  async read(): Promise<Buffer> {
    try {
      // Use Medplum's download method which handles both inline and external storage
      const data = await this.medplum.download(`Binary/${this.binaryId}`);

      // Convert to Buffer
      if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
      } else if (data instanceof Blob) {
        const arrayBuffer = await data.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } else if (typeof data === 'string') {
        // If it's a base64 string
        return Buffer.from(data, 'base64');
      } else if (Buffer.isBuffer(data)) {
        return data;
      }

      // Unexpected data type from download - fall through to fallback
      throw new Error(`Unexpected data type from Medplum download: ${typeof data}`);
    } catch (error) {
      // Fallback to reading the Binary resource directly if download fails
      const binary = await this.medplum.readResource('Binary', this.binaryId);

      // If data is embedded in the Binary resource, use it directly
      if (binary.data) {
        return Buffer.from(binary.data, 'base64');
      }

      // If data is not embedded but a URL is available, download it
      if (binary.url) {
        const response = await fetch(binary.url);
        if (!response.ok) {
          throw new Error(`Failed to download binary from URL: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      // Neither data nor URL available
      throw new Error('Binary resource has neither data nor url');
    }
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
   * For Medplum, this returns a presigned URL from the Binary resource.
   *
   * @param expiresIn - Seconds until the URL expires (not used for Medplum)
   * @returns Presigned URL for file access
   */
  async url(expiresIn = 3600): Promise<string> {
    // Fetch the Binary resource to get the presigned URL
    const binary = await this.medplum.readResource('Binary', this.binaryId);

    if (!binary.url) {
      throw new Error(`Binary resource ${this.binaryId} does not have a presigned URL`);
    }

    return binary.url;
  }

  async delete(): Promise<void> {
    await this.medplum.deleteResource('Binary', this.binaryId);
  }
}
