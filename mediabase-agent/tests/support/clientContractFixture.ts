import {
  SPONSOR_METADATA_CONTRACT,
  type ClientMetadataContract
} from "../../src/submission/clientMetadataContract";
import { createArtistAttributionDecision, confirmArtistAttribution } from "../../src/metadata/artistAttribution";
import type { DemoRecording } from "../../src/metadata/recordValidation";
import { fixture } from "./reviewFixture";

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

export function approvedAudioRecord(): DemoRecording {
  const { record } = fixture();
  const decision = createArtistAttributionDecision("Fictional Artist", "Fictional Artist");
  return {
    ...record,
    artist: "Fictional Artist",
    artistAttribution: confirmArtistAttribution(decision, {
      exactArtist: "Fictional Artist",
      primaryArtist: "Fictional Artist"
    }),
    officialReleaseDate: "11/15/2026",
    albumTitle: "Fictional Album",
    comments: "Approved fictional comment",
    approvalStatus: "DRAFT"
  };
}
