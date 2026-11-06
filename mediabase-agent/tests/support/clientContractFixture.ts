import {
  SPONSOR_METADATA_CONTRACT,
  type ClientMetadataContract
} from "../../src/submission/clientMetadataContract";

/**
 * Fictional technical-test policy, not the sponsor contract. It exercises
 * supported encodings while the sponsor's mandatory mappings remain unresolved.
 */
export const TECHNICAL_TEST_CONTRACT: ClientMetadataContract = {
  ...SPONSOR_METADATA_CONTRACT,
  id: "fictional-technical-test",
  namingProfileId: "safe-filename",
  fields: {
    ...SPONSOR_METADATA_CONTRACT.fields,
    albumArtist: { ...SPONSOR_METADATA_CONTRACT.fields.albumArtist, requirement: "OPTIONAL" },
    album: { ...SPONSOR_METADATA_CONTRACT.fields.album, requirement: "OPTIONAL" },
    isrc: { ...SPONSOR_METADATA_CONTRACT.fields.isrc, requirement: "OPTIONAL" },
    year: { ...SPONSOR_METADATA_CONTRACT.fields.year, requirement: "OPTIONAL" },
    genre: { ...SPONSOR_METADATA_CONTRACT.fields.genre, requirement: "OPTIONAL" },
    publisher: { ...SPONSOR_METADATA_CONTRACT.fields.publisher, requirement: "OPTIONAL" },
    comments: { ...SPONSOR_METADATA_CONTRACT.fields.comments, requirement: "OPTIONAL" },
    contentRating: { ...SPONSOR_METADATA_CONTRACT.fields.contentRating, requirement: "OPTIONAL" }
  }
};
