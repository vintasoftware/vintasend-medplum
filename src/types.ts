import type { StorageIdentifiers } from 'vintasend/dist/types/attachment';

/**
 * Medplum-specific storage identifiers.
 * Contains references to FHIR Binary and Media resources.
 *
 * Used when MedplumAttachmentManager uploads files:
 * - Creates a Binary resource to store the file data
 * - Creates a Media resource to store metadata
 * - Returns both IDs so backend can reconstruct file access later
 */
export interface MedplumStorageIdentifiers extends StorageIdentifiers {
  // Standard identifier (required by all StorageIdentifiers)
  id: string;

  // Medplum-specific FHIR resource IDs
  medplumBinaryId: string; // ID of the FHIR Binary resource containing file data
  medplumMediaId: string; // ID of the FHIR Media resource with metadata
  url: string; // URL to Binary resource (format: "Binary/{id}")

  // Index signature to allow additional fields (inherited from StorageIdentifiers)
  [key: string]: unknown;
}
