import { normalizeMatchText, type AudioMatchResult } from "../audio/audioMatcher";
import { normalizeIsrcValue, type AudioMetadata } from "../audio/audioMetadata";
import type { DemoRecording } from "../metadata/recordValidation";
import {
  DEFAULT_MP3_TAG_PROFILE,
  resolveAudioTagValues,
  type AudioTagField,
  type AudioTagProfile,
  type ExplicitTagValues
} from "./audioTagProfile";

/**
 * Compares the tags actually embedded in the selected audio file with the
 * approved recording. The file is read by `extractAudioMetadata`; nothing is
 * rewritten. Missing, incorrect, and unsupported tags are reported separately.
 */
export type TaggedField = AudioTagField;

export type TagStatus =
  /** The embedded tag agrees with the approved value. */
  | "MATCH"
  /** The format can carry the tag, but the file has none. */
  | "MISSING_TAG"
  /** The embedded tag disagrees with the approved value. */
  | "INCORRECT_TAG"
  /** The file's container has no standard place for this field and none was embedded. */
  | "UNSUPPORTED_FIELD"
  /** The approved record has no value to compare. */
  | "NOT_APPLICABLE";

export type TagSeverity = "blocking" | "warning" | "informational";

export type TagFieldResult = {
  field: TaggedField;
  status: TagStatus;
  severity: TagSeverity;
  /** True when a human audio selection explicitly acknowledged this file's conflicts. */
  acknowledged: boolean;
};

export type AudioTagVerification = {
  format: AudioMetadata["format"];
  fields: TagFieldResult[];
  blocking: TagFieldResult[];
};

const RECORD_FIELD: Record<TaggedField, keyof DemoRecording> = {
  artist: "artist",
  title: "title",
  album: "albumTitle",
  isrc: "isrc",
  version: "version",
  genre: "recordingId",
  year: "officialReleaseDate",
  albumArtist: "artistAttribution",
  comments: "comments",
  contentRating: "recordingId"
};

/** Fields that identify the recording; a wrong value blocks unless a human acknowledged the conflict. */
const IDENTITY_FIELDS: ReadonlySet<TaggedField> = new Set(["artist", "title", "isrc"]);

/** WAV RIFF INFO has no ISRC or version field; they exist only in an optional embedded ID3 chunk. */
const UNSUPPORTED_BY_FORMAT: Record<AudioMetadata["format"], ReadonlySet<TaggedField>> = {
  WAV: new Set(["isrc", "version"]),
  MP3: new Set()
};

function tagValue(metadata: AudioMetadata, field: TaggedField): string | null {
  if (field === "isrc") return metadata.rawIsrcs.length > 0 ? metadata.rawIsrcs.join(" ") : null;
  if (field === "contentRating") return null;
  const value = metadata[field];
  return typeof value === "string" ? value : null;
}

function agrees(field: TaggedField, approved: string, metadata: AudioMetadata): boolean {
  if (field === "isrc") {
    const wanted = normalizeIsrcValue(approved);
    return metadata.rawIsrcs.length > 0 && metadata.rawIsrcs.every((value) => normalizeIsrcValue(value) === wanted);
  }
  if (field === "year") {
    return metadata.year === approved || metadata.date?.slice(0, 4) === approved;
  }
  if (field === "contentRating") return false;
  return normalizeMatchText(metadata[field]) === normalizeMatchText(approved);
}

/**
 * A conflict counts as acknowledged only for a human-confirmed selection of
 * this exact file whose current conflicts are all in the acknowledged list.
 */
function conflictsAcknowledged(record: DemoRecording, filePath: string, currentMatch: AudioMatchResult | null): boolean {
  const decision = record.audioMatch;
  if (!decision?.humanConfirmed || decision.filePath !== filePath || decision.acknowledgedConflicts.length === 0) return false;
  const candidate = currentMatch?.candidates.find((entry) => entry.filePath === filePath);
  if (!candidate) return false;
  return candidate.conflicts.every((conflict) => decision.acknowledgedConflicts.includes(conflict));
}

export function verifyAudioTags(
  record: Readonly<DemoRecording>,
  metadata: AudioMetadata,
  currentMatch: AudioMatchResult | null,
  profile?: AudioTagProfile,
  explicitValues?: ExplicitTagValues
): AudioTagVerification {
  const acknowledged = conflictsAcknowledged(record as DemoRecording, metadata.filePath, currentMatch);
  const selectedProfile = profile ?? {
    ...DEFAULT_MP3_TAG_PROFILE,
    mappings: ["artist", "title", "album", "isrc", "version"] as const,
    requiredFields: [] as const
  };
  const resolved = resolveAudioTagValues(record, selectedProfile, explicitValues);
  const fields: TagFieldResult[] = selectedProfile.mappings.map((field) => {
    const approvedText = resolved.values[field] ?? null;
    const embedded = tagValue(metadata, field);
    if (approvedText === null) {
      const required = selectedProfile.requiredFields.includes(field);
      return {
        field,
        status: required ? "MISSING_TAG" : "NOT_APPLICABLE",
        severity: required ? "blocking" : "informational",
        acknowledged: false
      };
    }
    if (embedded === null) {
      const unsupported = UNSUPPORTED_BY_FORMAT[metadata.format].has(field);
      const required = selectedProfile.requiredFields.includes(field);
      return {
        field,
        status: unsupported ? "UNSUPPORTED_FIELD" : "MISSING_TAG",
        severity: required || unsupported ? (required ? "blocking" : "warning") : "warning",
        acknowledged: false
      };
    }
    if (agrees(field, approvedText, metadata)) {
      return { field, status: "MATCH", severity: "informational", acknowledged: false };
    }
    const identity = IDENTITY_FIELDS.has(field);
    return {
      field,
      status: "INCORRECT_TAG",
      severity: profile ? "blocking" : identity && !acknowledged ? "blocking" : "warning",
      acknowledged: !profile && identity && acknowledged
    };
  });
  return { format: metadata.format, fields, blocking: fields.filter((item) => item.severity === "blocking") };
}
