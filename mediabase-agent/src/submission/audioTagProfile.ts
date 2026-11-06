import { normalizeIsrcValue } from "../audio/audioMetadata";
import type { DemoRecording } from "../metadata/recordValidation";
import { reviewedVersionFromTitle } from "../metadata/versionDesignation";

export const AUDIO_TAG_FIELDS = [
  "title",
  "artist",
  "album",
  "isrc",
  "version",
  "genre",
  "year",
  "albumArtist",
  "comments",
  "contentRating"
] as const;

export type AudioTagField = (typeof AUDIO_TAG_FIELDS)[number];
export type WritableAudioTagField = Exclude<AudioTagField, "contentRating">;
export type AudioTagValues = Partial<Record<AudioTagField, string>>;

export type AudioTagProfile = {
  id: string;
  version: string;
  /** Required fields fail closed when no validated value is available. */
  requiredFields: readonly AudioTagField[];
  /** Mapping is explicit, versioned configuration; absent fields are not invented. */
  mappings: readonly AudioTagField[];
  /** Fields whose sponsor meaning is not known. This is informational until configured as required. */
  unresolvedSponsorMappings: readonly string[];
};

export type ExplicitTagValue = {
  value: string;
  /** Opaque reference to the trusted source or sponsor-approved decision. */
  sourceReference: string;
  approvedBy: string;
  /** References to conflicting evidence that the reviewer explicitly considered. */
  acknowledgedEvidence?: readonly string[];
  note?: string;
};

export type ExplicitTagValues = Partial<Record<"genre" | "contentRating" | "publisher", ExplicitTagValue>>;

export type ResolvedAudioTagValues = {
  values: AudioTagValues;
  provenance: Partial<Record<AudioTagField, string>>;
  missingRequired: AudioTagField[];
  unresolvedSponsorMappings: string[];
};

export const DEFAULT_MP3_TAG_PROFILE: AudioTagProfile = Object.freeze<AudioTagProfile>({
  id: "mediabase-mp3-standard",
  version: "1",
  requiredFields: ["title", "artist"],
  mappings: ["title", "artist", "album", "isrc", "version", "genre", "year", "albumArtist", "comments"],
  unresolvedSponsorMappings: ["Rye Music publisher frame", "clean/explicit encoding"]
});

export const BASIC_MP3_TAG_PROFILE: AudioTagProfile = Object.freeze<AudioTagProfile>({
  id: "basic-mp3",
  version: "1",
  requiredFields: ["title", "artist"],
  mappings: ["title", "artist", "isrc"],
  unresolvedSponsorMappings: ["Rye M"]
});

const WRITABLE_FIELDS = new Set<AudioTagField>([
  "title", "artist", "album", "isrc", "version", "genre", "year", "albumArtist", "comments"
]);

export function resolveAudioTagValues(
  recording: Readonly<DemoRecording>,
  profile: AudioTagProfile,
  explicitValues: ExplicitTagValues = {}
): ResolvedAudioTagValues {
  const resolved: AudioTagValues = {};
  const provenance: ResolvedAudioTagValues["provenance"] = {};
  const values: Partial<Record<AudioTagField, string | null>> = {
    title: recording.title,
    artist: recording.artistAttribution?.confirmedExactArtist ??
      (recording.recordSource === "MANUAL" ? recording.artist : null),
    album: recording.albumTitle,
    isrc: recording.isrcValidation?.status === "invalid" || recording.isrcValidation?.status === "missing"
      ? null
      : normalizeIsrcValue(recording.isrc),
    version: recording.version ?? reviewedVersionFromTitle(recording.title),
    year: recording.officialReleaseDate && /^\d{2}\/\d{2}\/\d{4}$/.test(recording.officialReleaseDate)
      ? recording.officialReleaseDate.slice(-4)
      : null,
    albumArtist: recording.artistAttribution?.productArtist,
    comments: recording.comments,
    genre: explicitValues.genre?.value,
    contentRating: explicitValues.contentRating?.value
  };
  const sources: Partial<Record<AudioTagField, string>> = {
    title: "reviewed-record.title",
    artist: "human-confirmed-exact-artist",
    album: "reviewed-record.albumTitle",
    isrc: "validated-record.isrc",
    version: recording.version ? "reviewed-record.version" : "reviewed-record.title-version",
    year: "validated-officialReleaseDate",
    albumArtist: "orchard-product-artist",
    comments: "reviewed-record.comments",
    genre: explicitValues.genre ? `explicit:${explicitValues.genre.sourceReference}` : undefined,
    contentRating: explicitValues.contentRating ? `explicit:${explicitValues.contentRating.sourceReference}` : undefined
  };

  for (const field of profile.mappings) {
    if (!AUDIO_TAG_FIELDS.includes(field)) throw new Error(`Tag profile ${profile.id} contains an unsupported field.`);
    const value = values[field];
    if (typeof value === "string" && value.trim()) {
      if (field === "genre" || field === "contentRating") {
        const approval = explicitValues[field];
        if (!approval?.approvedBy.trim() || !approval.sourceReference.trim()) continue;
        if (/\p{Cc}/u.test(value)) continue;
      }
      resolved[field] = value;
      provenance[field] = sources[field] ?? "explicit-configuration";
    }
  }

  const missingRequired = profile.requiredFields.filter((field) => !resolved[field]);
  return {
    values: resolved,
    provenance,
    missingRequired,
    unresolvedSponsorMappings: [...profile.unresolvedSponsorMappings]
  };
}

export function unsupportedTagFields(profile: AudioTagProfile): AudioTagField[] {
  return profile.mappings.filter((field) => !WRITABLE_FIELDS.has(field));
}
