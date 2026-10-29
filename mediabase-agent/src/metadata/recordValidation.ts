import { assessAudioDecision, type AudioMatchDecision, type AudioMatchResult } from "../audio/audioMatcher";
import {
  confirmArtistAttribution,
  createArtistAttributionDecision,
  findArtistAttributionProblem,
  type ArtistAttributionDecision,
  type ArtistAttributionProblem,
  type ArtistAttributionSelection
} from "./artistAttribution";
import { isOrchardRecordingId } from "./orchardImporter";

/**
 * Runtime-neutral record types, validation, and approval rules shared by the
 * browser form helper and the metadata gap analyzer. Must not import Playwright.
 */

export type DeclarationValue = "yes" | "no" | "unanswered" | null;

export type IsrcValidation = {
  status: "valid" | "missing" | "invalid";
  originalValue: string | null;
  reviewed: boolean;
};

/**
 * Where a recording came from. The Orchard importer stamps `ORCHARD`. Only an
 * explicit `MANUAL` marker exempts a record from the artist-attribution
 * decision; a missing value is treated as Orchard-derived (fail closed).
 */
export type RecordSource = "ORCHARD" | "MANUAL";

export type DemoRecording = {
  recordingId: string;
  recordSource?: RecordSource;
  submitterName?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  rememberInformation?: boolean;
  /** Mediabase Exact Artist. */
  artist: string;
  artistAttribution?: ArtistAttributionDecision;
  featuredArtist?: string | null;
  title: string;
  version?: string | null;
  isrc?: string | null;
  isrcValidation?: IsrcValidation;
  label?: string | null;
  officialReleaseDate?: string | null;
  albumTitle?: string | null;
  albumUPC?: string | null;
  albumReleaseDate?: string | null;
  generativeAiAudioDeclaration?: DeclarationValue;
  independentLabelDeclaration?: DeclarationValue;
  christmasHanukkahDeclaration?: DeclarationValue;
  canadianContentDeclaration?: DeclarationValue;
  artistWebsite?: string | null;
  comments?: string | null;
  hideUntil?: string | null;
  /** Local audio path only; it is never uploaded automatically. */
  audioFilePath?: string | null;
  audioMatch?: AudioMatchDecision;
  approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED";
};

export function normalizeDeclarationValue(
  value: DeclarationValue | string | undefined | null
): DeclarationValue {
  if (value === undefined || value === null || value === "") {
    return "unanswered";
  }

  const normalized = String(value).trim().toLowerCase();

  if (normalized === "yes" || normalized === "true") {
    return "yes";
  }

  if (normalized === "no" || normalized === "false") {
    return "no";
  }

  if (normalized === "unanswered") {
    return "unanswered";
  }

  throw new Error(`Unsupported declaration value: ${value}`);
}

export function isValidDate(value: string): boolean {
  const match = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(\d{4})$/.exec(
    value
  );
  if (!match) {
    return false;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (year === 0) {
    return false;
  }

  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];

  return day <= daysInMonth[month - 1];
}

const NORMALIZED_ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

/**
 * The only exception to the artist-attribution decision: a record explicitly
 * marked `recordSource: "MANUAL"` (such as fixtures/example-record.json) whose
 * ID is not in the importer's format. Provenance does not depend on the
 * recording ID alone, and omitting `recordSource` never grants the exception.
 */
export function isLegacyManualRecord(record: DemoRecording): boolean {
  return record.recordSource === "MANUAL" && !isOrchardRecordingId(record.recordingId);
}

/** Every non-legacy recording needs a confirmed attribution decision. */
export function getArtistAttributionProblem(record: DemoRecording): ArtistAttributionProblem | null {
  return findArtistAttributionProblem(record.artist, record.artistAttribution, !isLegacyManualRecord(record));
}

export type PreparationContext = {
  /**
   * Current matcher result for this recording. When supplied, a stored
   * automatic match that no longer agrees with current evidence, or a human
   * selection that predates new candidates or conflicts, blocks preparation.
   */
  audioMatchResult?: AudioMatchResult | null;
};

export type RecordReviewOptions = PreparationContext & {
  confirmMissingIsrc?: boolean;
  /** Explicit human artist selection; required for every Orchard artist-attribution decision. */
  confirmArtistAttribution?: ArtistAttributionSelection;
};

export function validateRecordForPreparation(record: DemoRecording, context: PreparationContext = {}): void {
  if (record.approvalStatus !== "APPROVED") {
    throw new Error("Recording must be approved before form preparation.");
  }

  if (!record.submitterName?.trim() || !record.email?.trim()) {
    throw new Error("Name and email are required.");
  }

  const attributionProblem = getArtistAttributionProblem(record);
  if (attributionProblem) {
    throw new Error(attributionProblem.message);
  }

  if (!record.artist.trim() || !record.title.trim()) {
    throw new Error("Artist and title are required.");
  }

  if (!record.officialReleaseDate || !isValidDate(record.officialReleaseDate)) {
    throw new Error("Official release date is required in mm/dd/yyyy format.");
  }

  if (
    record.albumReleaseDate !== null &&
    record.albumReleaseDate !== undefined &&
    record.albumReleaseDate !== "" &&
    !isValidDate(record.albumReleaseDate)
  ) {
    throw new Error("Album release date must be a valid mm/dd/yyyy date.");
  }

  if (record.isrcValidation?.status === "invalid") {
    throw new Error("Invalid Orchard ISRC must be corrected before approval.");
  }

  if (
    record.isrcValidation?.status === "missing" &&
    !record.isrcValidation.reviewed
  ) {
    throw new Error("Missing Orchard ISRC must be explicitly reviewed before approval.");
  }

  if (record.isrc && !NORMALIZED_ISRC_PATTERN.test(record.isrc)) {
    throw new Error("ISRC must have a valid normalized 12-character format.");
  }

  if (record.isrcValidation?.status === "valid" && !record.isrc) {
    throw new Error("Validated ISRC metadata is inconsistent with the recording.");
  }

  const audioProblem = assessAudioDecision(record, context.audioMatchResult ?? null).problems[0];
  if (audioProblem) {
    throw new Error(audioProblem.message);
  }
}

export function reviewAndApproveRecord(
  record: DemoRecording,
  reviewData: Partial<DemoRecording> = {},
  options: RecordReviewOptions = {}
): DemoRecording {
  const {
    isrcValidation: ignoredValidation,
    artistAttribution: ignoredAttribution,
    audioMatch: ignoredAudioMatch,
    recordSource: ignoredSource,
    ...reviewedFields
  } = reviewData;
  void ignoredValidation;
  void ignoredAttribution;
  void ignoredAudioMatch;
  void ignoredSource;

  let artistAttribution = record.artistAttribution;
  const selection = options.confirmArtistAttribution;
  if (selection) {
    artistAttribution = confirmArtistAttribution(
      artistAttribution ?? createArtistAttributionDecision(null, null),
      selection
    );
    if (
      reviewedFields.artist !== undefined &&
      reviewedFields.artist.trim() !== artistAttribution.confirmedExactArtist
    ) {
      throw new Error("Reviewed artist must match the confirmed artist attribution.");
    }
    reviewedFields.artist = artistAttribution.confirmedExactArtist ?? "";
  } else if (
    artistAttribution?.confirmed &&
    reviewedFields.artist !== undefined &&
    reviewedFields.artist !== artistAttribution.confirmedExactArtist
  ) {
    throw new Error("Confirmed artist attribution cannot change without a new explicit confirmation.");
  }
  const candidateIsrc = reviewedFields.isrc !== undefined
    ? reviewedFields.isrc?.trim() || null
    : record.isrc?.trim() || null;
  let isrcValidation = record.isrcValidation;

  if (candidateIsrc !== null) {
    if (!NORMALIZED_ISRC_PATTERN.test(candidateIsrc)) {
      throw new Error("ISRC must have a valid normalized 12-character format.");
    }
    isrcValidation = {
      status: "valid",
      originalValue: record.isrcValidation?.originalValue ?? record.isrc ?? candidateIsrc,
      reviewed: true
    };
  } else if (record.isrcValidation?.status === "invalid") {
    throw new Error("Invalid Orchard ISRC must be corrected before approval.");
  } else if (record.isrcValidation) {
    if (!options.confirmMissingIsrc) {
      throw new Error("Missing Orchard ISRC must be explicitly reviewed before approval.");
    }
    isrcValidation = {
      status: "missing",
      originalValue: record.isrcValidation.originalValue,
      reviewed: true
    };
  }

  const approved: DemoRecording = {
    ...record,
    ...reviewedFields,
    isrc: candidateIsrc,
    isrcValidation,
    ...(artistAttribution ? { artistAttribution } : {}),
    approvalStatus: "APPROVED"
  };

  validateRecordForPreparation(approved, { audioMatchResult: options.audioMatchResult });
  return approved;
}
