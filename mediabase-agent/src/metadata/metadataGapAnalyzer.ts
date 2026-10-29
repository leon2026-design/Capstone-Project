import { resolve } from "node:path";
import {
  matchAudioToRecording,
  type AudioMatchDecisionStatus,
  type AudioMatchResult
} from "../audio/audioMatcher";
import { normalizeIsrcValue, type AudioExtractionResult, type AudioMetadata } from "../audio/audioMetadata";
import {
  isValidDate,
  normalizeDeclarationValue,
  validateRecordForPreparation,
  type DemoRecording
} from "../browser/mediabaseForm";

/**
 * Read-only metadata gap analysis run before any research agent is invoked.
 * The analyzer never mutates its inputs, never touches the filesystem or
 * network, and never approves records. Research-eligible gaps only mean an
 * external agent may *propose* evidence; a human must confirm every change.
 */

export type GapSeverity = "blocking" | "warning" | "informational";
export type GapCategory = "missing" | "invalid" | "conflicting" | "needs-human-review";
export type GapArea =
  | "submission"
  | "identifiers"
  | "artist-attribution"
  | "audio"
  | "release"
  | "declarations"
  | "approval";
/** How a gap should be resolved. External research never confirms on its own. */
export type GapResolution = "deterministic" | "external-research" | "human-review";
export type ReadinessStatus = "READY" | "AWAITING_APPROVAL" | "BLOCKED";
export type ArtistRole = "primary" | "secondary" | "tertiary";

export type MetadataGapCode =
  | "missing-required-field"
  | "invalid-field-format"
  | "missing-isrc"
  | "invalid-isrc"
  | "isrc-confirmed-absent"
  | "isrc-validation-inconsistent"
  | "audio-isrc-conflict"
  | "audio-isrc-malformed"
  | "missing-album-upc"
  | "invalid-album-upc"
  | "artist-unconfirmed"
  | "artist-conflict"
  | "artist-confirmation-mismatch"
  | "artist-role-missing"
  | "featured-artist-unavailable"
  | "featured-artist-unverified"
  | "audio-not-evaluated"
  | "audio-no-match"
  | "audio-ambiguous"
  | "audio-needs-review"
  | "audio-selection-mismatch"
  | "audio-file-unverified"
  | "audio-file-unreadable"
  | "audio-metadata-conflict"
  | "audio-conflict-acknowledged"
  | "missing-label"
  | "missing-album-title"
  | "missing-album-release-date"
  | "release-date-order"
  | "declaration-unanswered"
  | "approval-pending"
  | "preparation-validation-failed";

export type GapEvidenceSource =
  | "record"
  | "orchard"
  | "artist-attribution"
  | "audio-metadata"
  | "audio-match";

export type GapEvidence = { source: GapEvidenceSource; field: string; value: string | null };

export type MetadataGap = {
  /** Stable identifier: `<recordingId>:<code>:<fields>`. */
  gapId: string;
  code: MetadataGapCode;
  area: GapArea;
  /** Affected `DemoRecording` properties. */
  fields: string[];
  severity: GapSeverity;
  category: GapCategory;
  description: string;
  resolution: GapResolution;
  /** True when an external research agent could reasonably propose evidence. */
  researchEligible: boolean;
  /** False only for deterministic fixes; research output always needs a human. */
  requiresHumanConfirmation: boolean;
  /** Deterministically derived replacement value, never applied automatically. */
  suggestedValue: string | null;
  evidence: GapEvidence[];
  recommendedAction: string;
};

export type MetadataGapReport = {
  recordingId: string;
  approvalStatus: DemoRecording["approvalStatus"];
  readiness: ReadinessStatus;
  summary: { blocking: number; warning: number; informational: number; researchEligible: number };
  gaps: MetadataGap[];
};

export type MetadataGapContext = {
  /** Local audio extraction results; matched to the selected file by resolved path. */
  audioExtractions?: readonly AudioExtractionResult[];
  /** Matcher results, matched to recordings by `recordingId`. */
  audioMatchResults?: readonly AudioMatchResult[];
  /** Artist roles the workflow explicitly expects Brad to supply. Default: none. */
  expectedArtistRoles?: readonly ArtistRole[];
};

type GapInput = Omit<MetadataGap, "gapId" | "requiresHumanConfirmation" | "suggestedValue" | "evidence"> & {
  suggestedValue?: string | null;
  evidence?: GapEvidence[];
};

const SEVERITY_RANK: Record<GapSeverity, number> = { blocking: 0, warning: 1, informational: 2 };
const ARTIST_ROLES: ArtistRole[] = ["primary", "secondary", "tertiary"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECLARATIONS = [
  ["generativeAiAudioDeclaration", "Generative AI audio declaration"],
  ["independentLabelDeclaration", "Independent label declaration"],
  ["christmasHanukkahDeclaration", "Christmas/Hanukkah declaration"],
  ["canadianContentDeclaration", "Canadian content declaration"]
] as const;
const AUDIO_ISRC_CONFLICT = /^(Embedded ISRC|File embeds multiple ISRCs)/;

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function ev(source: GapEvidenceSource, field: string, value: string | null | undefined): GapEvidence {
  return { source, field, value: value ?? null };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Converts unambiguous ISO `yyyy-mm-dd` or unpadded `m/d/yyyy` to `mm/dd/yyyy`. */
function suggestDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const parts = iso ? [iso[2], iso[3], iso[1]] : us ? [us[1], us[2], us[3]] : null;
  if (!parts) return null;
  const candidate = `${parts[0].padStart(2, "0")}/${parts[1].padStart(2, "0")}/${parts[2]}`;
  return isValidDate(candidate) ? candidate : null;
}

function dateKey(value: string): string {
  const [month, day, year] = value.split("/");
  return `${year}${month}${day}`;
}

function hasValidGtinCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

function isValidUpc(value: string): boolean {
  return /^\d{12,13}$/.test(value) && hasValidGtinCheckDigit(value);
}

function decisionStatus(result: AudioMatchResult): AudioMatchDecisionStatus {
  return result.status === "MATCHED" ? "AUTO_MATCHED" : result.status;
}

function findMatchResult(
  recordingId: string,
  results: readonly AudioMatchResult[] | undefined
): AudioMatchResult | null {
  const matches = (results ?? []).filter((result) => result.recordingId === recordingId);
  if (matches.length > 1) {
    throw new Error(`Multiple audio match results were supplied for recording ${recordingId}.`);
  }
  return matches[0] ?? null;
}

function findExtraction(
  filePath: string,
  extractions: readonly AudioExtractionResult[] | undefined
): AudioExtractionResult | null {
  const absolutePath = resolve(filePath);
  return (extractions ?? []).find((extraction) => extraction.filePath === absolutePath) ?? null;
}

class GapCollector {
  readonly gaps: MetadataGap[] = [];

  constructor(private readonly recordingId: string) {}

  add(input: GapInput): void {
    const suggestedValue = input.suggestedValue ?? null;
    this.gaps.push({
      gapId: `${this.recordingId}:${input.code}:${input.fields.join("+")}`,
      code: input.code,
      area: input.area,
      fields: [...input.fields],
      severity: input.severity,
      category: input.category,
      description: input.description,
      resolution: input.resolution,
      researchEligible: input.researchEligible,
      requiresHumanConfirmation: input.resolution !== "deterministic",
      suggestedValue,
      evidence: input.evidence ?? [],
      recommendedAction: input.recommendedAction
    });
  }

  hasBlocking(except: MetadataGapCode[] = []): boolean {
    return this.gaps.some((gap) => gap.severity === "blocking" && !except.includes(gap.code));
  }
}

function checkSubmission(record: DemoRecording, gaps: GapCollector): void {
  for (const [field, label] of [["submitterName", "Submitter name"], ["email", "Submitter email"]] as const) {
    if (!text(record[field])) {
      gaps.add({
        code: "missing-required-field",
        area: "submission",
        fields: [field],
        severity: "blocking",
        category: "missing",
        description: `${label} is required for the Mediabase submission.`,
        resolution: "human-review",
        researchEligible: false,
        recommendedAction: `Enter the ${label.toLowerCase()} of the person submitting the form.`
      });
    }
  }
  const email = text(record.email);
  if (email && !EMAIL_PATTERN.test(email)) {
    gaps.add({
      code: "invalid-field-format",
      area: "submission",
      fields: ["email"],
      severity: "warning",
      category: "invalid",
      description: "Submitter email does not look like a valid email address.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "email", record.email)],
      recommendedAction: "Correct the submitter email address."
    });
  }
}

function checkTextFormat(record: DemoRecording, field: "artist" | "title", gaps: GapCollector): void {
  const value = record[field];
  if (!text(value) || (value === value.trim() && !CONTROL_CHARACTERS.test(value))) return;
  const label = field === "artist" ? "Exact Artist" : "Exact Title";
  gaps.add({
    code: "invalid-field-format",
    area: field === "artist" ? "artist-attribution" : "submission",
    fields: [field],
    severity: "warning",
    category: "invalid",
    description: `${label} has surrounding whitespace or control characters.`,
    resolution: "deterministic",
    researchEligible: false,
    suggestedValue: value.replace(/[\u0000-\u001f\u007f]/g, "").trim(),
    evidence: [ev("record", field, value)],
    recommendedAction: `Remove surrounding whitespace and control characters from the ${label}.`
  });
}

function checkArtistAttribution(
  record: DemoRecording,
  expectedRoles: readonly ArtistRole[],
  gaps: GapCollector
): void {
  const attribution = record.artistAttribution;
  const sourceEvidence = attribution
    ? [
        ev("orchard", "TRACK ARTIST", attribution.trackArtist),
        ev("orchard", "PRODUCT ARTIST", attribution.productArtist),
        ev("artist-attribution", "status", attribution.status)
      ]
    : [];

  if (attribution && !attribution.confirmed) {
    if (attribution.status === "CONFLICT") {
      gaps.add({
        code: "artist-conflict",
        area: "artist-attribution",
        fields: ["artist", "artistAttribution"],
        severity: "blocking",
        category: "conflicting",
        description:
          "Orchard TRACK ARTIST (track performer) differs from PRODUCT ARTIST (main release entity); the Exact Artist is unconfirmed.",
        resolution: "human-review",
        researchEligible: false,
        evidence: sourceEvidence,
        recommendedAction:
          "Brad selects the Mediabase Exact Artist and artist hierarchy with confirmArtistAttribution."
      });
    } else if (attribution.status === "MISSING") {
      gaps.add({
        code: "missing-required-field",
        area: "artist-attribution",
        fields: ["artist"],
        severity: "blocking",
        category: "missing",
        description: "Orchard supplied neither TRACK ARTIST nor PRODUCT ARTIST; the Exact Artist is unknown.",
        resolution: "human-review",
        researchEligible: false,
        evidence: sourceEvidence,
        recommendedAction: "Brad supplies and confirms the Mediabase Exact Artist."
      });
    } else {
      gaps.add({
        code: "artist-unconfirmed",
        area: "artist-attribution",
        fields: ["artist", "artistAttribution"],
        severity: "blocking",
        category: "needs-human-review",
        description: "The Mediabase Exact Artist has not been explicitly confirmed from the Orchard artist values.",
        resolution: "human-review",
        researchEligible: false,
        evidence: sourceEvidence,
        recommendedAction: "Brad confirms the Exact Artist with confirmArtistAttribution; candidates are suggestions only."
      });
    }
  } else if (attribution?.confirmed && record.artist !== attribution.confirmedExactArtist) {
    gaps.add({
      code: "artist-confirmation-mismatch",
      area: "artist-attribution",
      fields: ["artist", "artistAttribution"],
      severity: "blocking",
      category: "conflicting",
      description: "Exact Artist differs from the confirmed artist attribution.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "artist", record.artist), ev("artist-attribution", "confirmedExactArtist", attribution.confirmedExactArtist)],
      recommendedAction: "Restore the confirmed Exact Artist or record a new explicit confirmation."
    });
  } else if (!text(record.artist)) {
    gaps.add({
      code: "missing-required-field",
      area: "artist-attribution",
      fields: ["artist"],
      severity: "blocking",
      category: "missing",
      description: "Exact Artist is required.",
      resolution: "human-review",
      researchEligible: false,
      recommendedAction: "Brad supplies and confirms the Mediabase Exact Artist."
    });
  } else {
    checkTextFormat(record, "artist", gaps);
  }

  for (const role of ARTIST_ROLES.filter((entry) => expectedRoles.includes(entry))) {
    const field = `${role}Artist` as const;
    if (!text(attribution?.[field])) {
      gaps.add({
        code: "artist-role-missing",
        area: "artist-attribution",
        fields: [`artistAttribution.${field}`],
        severity: "blocking",
        category: "missing",
        description: `The workflow expects a ${role} artist, but none has been recorded.`,
        resolution: "human-review",
        researchEligible: false,
        evidence: sourceEvidence,
        recommendedAction: `Brad records the ${role} artist; it is never inferred from Orchard columns.`
      });
    }
  }

  if (!text(record.featuredArtist)) {
    gaps.add({
      code: "featured-artist-unavailable",
      area: "artist-attribution",
      fields: ["featuredArtist"],
      severity: "informational",
      category: "missing",
      description: "No Featured Artist is recorded. A featured artist is not assumed to be required.",
      resolution: "human-review",
      researchEligible: false,
      recommendedAction: "No action unless Vydia lists a featured artist for this recording."
    });
  } else if (record.approvalStatus !== "APPROVED") {
    gaps.add({
      code: "featured-artist-unverified",
      area: "artist-attribution",
      fields: ["featuredArtist"],
      severity: "informational",
      category: "needs-human-review",
      description: "Featured Artist has not been verified during approval.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "featuredArtist", record.featuredArtist)],
      recommendedAction: "Verify the Featured Artist against Vydia before approval."
    });
  }
}

function checkTitle(record: DemoRecording, audio: AudioMetadata | null, gaps: GapCollector): void {
  if (!text(record.title)) {
    gaps.add({
      code: "missing-required-field",
      area: "submission",
      fields: ["title"],
      severity: "blocking",
      category: "missing",
      description: "Exact Title is required.",
      resolution: "human-review",
      researchEligible: false,
      evidence: audio?.title ? [ev("audio-metadata", "title", audio.title)] : [],
      recommendedAction: "Supply the exact title from the Orchard source or the label."
    });
  } else {
    checkTextFormat(record, "title", gaps);
  }
}

function checkIdentifiers(record: DemoRecording, audio: AudioMetadata | null, gaps: GapCollector): void {
  const validation = record.isrcValidation;
  const isrc = text(record.isrc);
  const orchardEvidence = validation ? [ev("orchard", "ISRC", validation.originalValue)] : [];
  const embeddedValid = [
    ...new Set((audio?.rawIsrcs ?? []).map(normalizeIsrcValue).filter((value): value is string => value !== null))
  ].sort(compareText);
  const embeddedEvidence = (audio?.rawIsrcs ?? []).map((value) => ev("audio-metadata", "ISRC", value));

  if (validation?.status === "invalid") {
    gaps.add({
      code: "invalid-isrc",
      area: "identifiers",
      fields: ["isrc"],
      severity: "blocking",
      category: "invalid",
      description: "The Orchard ISRC is malformed and must be corrected before approval.",
      resolution: "external-research",
      researchEligible: true,
      evidence: [...orchardEvidence, ...embeddedEvidence],
      recommendedAction:
        "Research the published ISRC for this recording; a reviewer must confirm the corrected value."
    });
  } else if (isrc !== null && normalizeIsrcValue(isrc) !== isrc) {
    const normalized = normalizeIsrcValue(isrc);
    gaps.add({
      code: "invalid-isrc",
      area: "identifiers",
      fields: ["isrc"],
      severity: "blocking",
      category: "invalid",
      description: "ISRC is not in the normalized 12-character format.",
      resolution: normalized ? "deterministic" : "external-research",
      researchEligible: normalized === null,
      suggestedValue: normalized,
      evidence: [ev("record", "isrc", record.isrc), ...orchardEvidence],
      recommendedAction: normalized
        ? `Normalize the ISRC to ${normalized}.`
        : "Research the published ISRC; a reviewer must confirm the corrected value."
    });
  } else if (validation?.status === "valid" && isrc === null) {
    gaps.add({
      code: "isrc-validation-inconsistent",
      area: "identifiers",
      fields: ["isrc", "isrcValidation"],
      severity: "blocking",
      category: "conflicting",
      description: "ISRC validation reports a valid ISRC, but the recording has none.",
      resolution: "human-review",
      researchEligible: false,
      evidence: orchardEvidence,
      recommendedAction: "Re-run the ISRC review for this recording."
    });
  } else if (isrc === null) {
    if (validation?.status === "missing" && validation.reviewed) {
      gaps.add({
        code: "isrc-confirmed-absent",
        area: "identifiers",
        fields: ["isrc"],
        severity: "informational",
        category: "missing",
        description: "A reviewer confirmed that this recording has no ISRC.",
        resolution: "human-review",
        researchEligible: false,
        evidence: [...orchardEvidence, ...embeddedEvidence],
        recommendedAction: "No action; the reviewer decision stands."
      });
    } else {
      const unreviewed = validation?.status === "missing";
      gaps.add({
        code: "missing-isrc",
        area: "identifiers",
        fields: ["isrc"],
        severity: unreviewed ? "blocking" : "warning",
        category: "missing",
        description: unreviewed
          ? "The Orchard ISRC is missing and has not been reviewed."
          : "The recording has no ISRC.",
        resolution: embeddedValid.length === 1 ? "human-review" : "external-research",
        researchEligible: true,
        evidence: [...orchardEvidence, ...embeddedEvidence],
        recommendedAction:
          embeddedValid.length === 1
            ? `Confirm whether the embedded audio ISRC ${embeddedValid[0]} belongs to this recording, or confirm that no ISRC exists.`
            : "Research the published ISRC, or have a reviewer confirm that no ISRC exists."
      });
    }
  }

  const recordIsrc = isrc !== null && normalizeIsrcValue(isrc) === isrc && validation?.status !== "invalid" ? isrc : null;
  const conflicting = embeddedValid.filter((value) => recordIsrc !== null && value !== recordIsrc);
  if (conflicting.length > 0 || embeddedValid.length > 1) {
    const decision = record.audioMatch;
    const acknowledged =
      decision?.humanConfirmed === true &&
      embeddedValid.every(
        (value) => value === recordIsrc || decision.acknowledgedConflicts.some((conflict) => conflict.includes(value))
      );
    gaps.add({
      code: "audio-isrc-conflict",
      area: "identifiers",
      fields: ["isrc", "audioFilePath"],
      severity: acknowledged ? "informational" : "blocking",
      category: "conflicting",
      description: acknowledged
        ? "Embedded audio ISRC differs from the recording ISRC; a reviewer acknowledged the conflict."
        : "Embedded audio ISRC differs from the recording ISRC or the file embeds several ISRCs.",
      resolution: "human-review",
      researchEligible: !acknowledged,
      evidence: [ev("record", "isrc", record.isrc), ...orchardEvidence, ...embeddedEvidence],
      recommendedAction: acknowledged
        ? "No action; the reviewer acknowledged the conflict."
        : "A reviewer decides which ISRC is authoritative or selects a different audio file."
    });
  }
  const malformed = (audio?.rawIsrcs ?? []).filter((value) => normalizeIsrcValue(value) === null);
  if (malformed.length > 0) {
    gaps.add({
      code: "audio-isrc-malformed",
      area: "identifiers",
      fields: ["audioFilePath"],
      severity: "warning",
      category: "invalid",
      description: "The selected audio file embeds a malformed ISRC tag.",
      resolution: "human-review",
      researchEligible: false,
      evidence: malformed.map((value) => ev("audio-metadata", "ISRC", value)),
      recommendedAction: "Ignore the embedded tag or ask the label for a corrected master."
    });
  }

  const upc = text(record.albumUPC);
  if (upc && !isValidUpc(upc)) {
    const digits = upc.replace(/[\s-]/g, "");
    const normalized = isValidUpc(digits) ? digits : null;
    gaps.add({
      code: "invalid-album-upc",
      area: "identifiers",
      fields: ["albumUPC"],
      severity: "warning",
      category: "invalid",
      description: "Album UPC is not a 12- or 13-digit code with a valid check digit.",
      resolution: normalized ? "deterministic" : "external-research",
      researchEligible: normalized === null,
      suggestedValue: normalized,
      evidence: [ev("record", "albumUPC", record.albumUPC)],
      recommendedAction: normalized
        ? `Normalize the Album UPC to ${normalized}.`
        : "Research the published UPC for this release; a reviewer must confirm the value."
    });
  } else if (!upc && text(record.albumTitle)) {
    gaps.add({
      code: "missing-album-upc",
      area: "identifiers",
      fields: ["albumUPC"],
      severity: "warning",
      category: "missing",
      description: "An album title is recorded, but the Album UPC is missing.",
      resolution: "external-research",
      researchEligible: true,
      evidence: [ev("record", "albumTitle", record.albumTitle)],
      recommendedAction: "Research the published album UPC; a reviewer must confirm the value."
    });
  }
}

function checkReleaseMetadata(record: DemoRecording, audio: AudioMetadata | null, gaps: GapCollector): void {
  const official = text(record.officialReleaseDate);
  if (!official) {
    gaps.add({
      code: "missing-required-field",
      area: "release",
      fields: ["officialReleaseDate"],
      severity: "blocking",
      category: "missing",
      description: "Official release date is required.",
      resolution: "external-research",
      researchEligible: true,
      recommendedAction: "Research the published release date; a reviewer must confirm it in mm/dd/yyyy format."
    });
  } else if (!isValidDate(official)) {
    const suggestion = suggestDate(official);
    gaps.add({
      code: "invalid-field-format",
      area: "release",
      fields: ["officialReleaseDate"],
      severity: "blocking",
      category: "invalid",
      description: "Official release date is not a valid mm/dd/yyyy date.",
      resolution: suggestion ? "deterministic" : "external-research",
      researchEligible: suggestion === null,
      suggestedValue: suggestion,
      evidence: [ev("record", "officialReleaseDate", record.officialReleaseDate)],
      recommendedAction: suggestion
        ? `Reformat the official release date as ${suggestion}.`
        : "Research the published release date; a reviewer must confirm it."
    });
  }

  const album = text(record.albumReleaseDate);
  const albumTitle = text(record.albumTitle);
  if (album && !isValidDate(album)) {
    const suggestion = suggestDate(album);
    gaps.add({
      code: "invalid-field-format",
      area: "release",
      fields: ["albumReleaseDate"],
      severity: "blocking",
      category: "invalid",
      description: "Album release date is not a valid mm/dd/yyyy date.",
      resolution: suggestion ? "deterministic" : "external-research",
      researchEligible: suggestion === null,
      suggestedValue: suggestion,
      evidence: [ev("record", "albumReleaseDate", record.albumReleaseDate)],
      recommendedAction: suggestion
        ? `Reformat the album release date as ${suggestion}.`
        : "Research the published album release date; a reviewer must confirm it."
    });
  } else if (!album && albumTitle) {
    gaps.add({
      code: "missing-album-release-date",
      area: "release",
      fields: ["albumReleaseDate"],
      severity: "warning",
      category: "missing",
      description: "An album title is recorded, but the album release date is missing.",
      resolution: "external-research",
      researchEligible: true,
      evidence: [ev("record", "albumTitle", record.albumTitle)],
      recommendedAction: "Research the published album release date; a reviewer must confirm it."
    });
  }

  if (!albumTitle && album) {
    gaps.add({
      code: "missing-album-title",
      area: "release",
      fields: ["albumTitle"],
      severity: "warning",
      category: "missing",
      description: "An album release date is recorded, but the album title is missing.",
      resolution: "external-research",
      researchEligible: true,
      evidence: [
        ev("record", "albumReleaseDate", record.albumReleaseDate),
        ev("record", "albumUPC", record.albumUPC),
        ...(audio?.album ? [ev("audio-metadata", "album", audio.album)] : [])
      ],
      recommendedAction: "Research the album title; a reviewer must confirm it."
    });
  }

  if (official && album && albumTitle && isValidDate(official) && isValidDate(album) && dateKey(official) > dateKey(album)) {
    gaps.add({
      code: "release-date-order",
      area: "release",
      fields: ["officialReleaseDate", "albumReleaseDate"],
      severity: "warning",
      category: "needs-human-review",
      description: "The official release date is later than the album release date.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [
        ev("record", "officialReleaseDate", record.officialReleaseDate),
        ev("record", "albumReleaseDate", record.albumReleaseDate)
      ],
      recommendedAction: "Confirm whether this is a later single release from the album."
    });
  }

  if (!text(record.label)) {
    gaps.add({
      code: "missing-label",
      area: "release",
      fields: ["label"],
      severity: "warning",
      category: "missing",
      description: "Label Listing is empty.",
      resolution: "external-research",
      researchEligible: true,
      recommendedAction: "Research the releasing label; a reviewer must confirm the listing."
    });
  }
}

function checkDeclarations(record: DemoRecording, gaps: GapCollector): void {
  for (const [field, label] of DECLARATIONS) {
    const value = record[field];
    let normalized: string | null;
    try {
      normalized = normalizeDeclarationValue(value);
    } catch {
      gaps.add({
        code: "invalid-field-format",
        area: "declarations",
        fields: [field],
        severity: "blocking",
        category: "invalid",
        description: `${label} has an unsupported value.`,
        resolution: "human-review",
        researchEligible: false,
        evidence: [ev("record", field, String(value))],
        recommendedAction: `Answer the ${label.toLowerCase()} with yes or no.`
      });
      continue;
    }
    if (normalized === "unanswered") {
      gaps.add({
        code: "declaration-unanswered",
        area: "declarations",
        fields: [field],
        severity: "warning",
        category: "needs-human-review",
        description: `${label} is unanswered.`,
        resolution: "human-review",
        researchEligible: false,
        recommendedAction: `A human answers the ${label.toLowerCase()}; it is never researched or inferred.`
      });
    }
  }
}

function checkAudio(
  record: DemoRecording,
  matchResult: AudioMatchResult | null,
  extraction: AudioExtractionResult | null,
  gaps: GapCollector
): void {
  const decision = record.audioMatch;
  const status = decision?.status ?? (matchResult ? decisionStatus(matchResult) : null);
  const selectedPath = text(record.audioFilePath);
  const candidatePaths = decision?.candidateFilePaths ?? matchResult?.candidates.map((candidate) => candidate.filePath) ?? [];
  const candidateEvidence = candidatePaths.map((path) => ev("audio-match", "candidateFilePath", path));

  if (decision && (decision.filePath ?? null) !== (record.audioFilePath ?? null)) {
    gaps.add({
      code: "audio-selection-mismatch",
      area: "audio",
      fields: ["audioFilePath", "audioMatch"],
      severity: "blocking",
      category: "conflicting",
      description: "Audio file path differs from the reviewed audio match.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "audioFilePath", record.audioFilePath), ev("audio-match", "filePath", decision.filePath)],
      recommendedAction: "Re-confirm the audio selection with confirmAudioSelection."
    });
  }

  if (status === "AMBIGUOUS" || status === "NEEDS_REVIEW") {
    const ambiguous = status === "AMBIGUOUS";
    const conflicts = (matchResult?.candidates ?? []).flatMap((candidate) =>
      candidate.conflicts.map((conflict) => ev("audio-match", candidate.fileName, conflict))
    );
    gaps.add({
      code: ambiguous ? "audio-ambiguous" : "audio-needs-review",
      area: "audio",
      fields: ["audioFilePath", "audioMatch"],
      severity: "blocking",
      category: "needs-human-review",
      description: ambiguous
        ? "Several audio files could match this recording."
        : "One audio file was suggested from partial, filename, or conflicting evidence.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [...candidateEvidence, ...conflicts],
      recommendedAction:
        "A human selects the correct file (or confirms no audio) with confirmAudioSelection."
    });
  } else if (!selectedPath && status === "NO_MATCH") {
    gaps.add({
      code: "audio-no-match",
      area: "audio",
      fields: ["audioFilePath"],
      severity: "warning",
      category: "missing",
      description: "No local audio file matched this recording.",
      resolution: "human-review",
      researchEligible: false,
      evidence: (matchResult?.rejectedFiles ?? []).map((file) => ev("audio-match", "rejectedFile", `${file.filePath} (${file.error})`)),
      recommendedAction: "Locate the audio master or confirm that no audio will be attached."
    });
  } else if (!selectedPath && status === null) {
    gaps.add({
      code: "audio-not-evaluated",
      area: "audio",
      fields: ["audioFilePath"],
      severity: "informational",
      category: "missing",
      description: "Audio matching has not been run for this recording.",
      resolution: "deterministic",
      researchEligible: false,
      recommendedAction: "Run matchAudioToRecordings against the local audio files."
    });
  }

  if (!selectedPath) return;
  if (!extraction) {
    gaps.add({
      code: "audio-file-unverified",
      area: "audio",
      fields: ["audioFilePath"],
      severity: "warning",
      category: "needs-human-review",
      description: "The selected audio file has not been read to confirm it exists and is valid.",
      resolution: "deterministic",
      researchEligible: false,
      evidence: [ev("record", "audioFilePath", record.audioFilePath)],
      recommendedAction: "Run extractAudioMetadata on the selected file and re-analyze."
    });
    return;
  }
  if (extraction.status === "ERROR") {
    gaps.add({
      code: "audio-file-unreadable",
      area: "audio",
      fields: ["audioFilePath"],
      severity: "blocking",
      category: extraction.error === "MISSING_FILE" ? "missing" : "invalid",
      description: `The selected audio file cannot be used: ${extraction.message}`,
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "audioFilePath", record.audioFilePath), ev("audio-metadata", "error", extraction.error)],
      recommendedAction: "Restore the file or select a different audio file."
    });
    return;
  }

  const candidate = matchAudioToRecording(record, [extraction]).candidates[0];
  const conflicts = candidate
    ? candidate.conflicts.filter((conflict) => !AUDIO_ISRC_CONFLICT.test(conflict))
    : ["Selected audio file shares no title, filename, or ISRC evidence with this recording."];
  const acknowledged = decision?.humanConfirmed ? decision.acknowledgedConflicts : [];
  const audioEvidence = [
    ev("audio-metadata", "artist", extraction.metadata.artist),
    ev("audio-metadata", "title", extraction.metadata.title),
    ev("audio-metadata", "version", extraction.metadata.version),
    ev("record", "title", record.title),
    ev("record", "version", record.version)
  ];
  const unacknowledged = conflicts.filter((conflict) => !acknowledged.includes(conflict));
  const resolvedConflicts = conflicts.filter((conflict) => acknowledged.includes(conflict));
  if (unacknowledged.length > 0) {
    gaps.add({
      code: "audio-metadata-conflict",
      area: "audio",
      fields: ["audioFilePath", "artist", "title", "version"],
      severity: "blocking",
      category: "conflicting",
      description: "Selected audio metadata conflicts with the recording artist, title, or version.",
      resolution: "human-review",
      researchEligible: false,
      evidence: [...unacknowledged.map((conflict) => ev("audio-match", "conflict", conflict)), ...audioEvidence],
      recommendedAction: "A human confirms the file with acknowledgeConflicts or selects a different file."
    });
  }
  if (resolvedConflicts.length > 0) {
    gaps.add({
      code: "audio-conflict-acknowledged",
      area: "audio",
      fields: ["audioFilePath"],
      severity: "informational",
      category: "conflicting",
      description: "A reviewer acknowledged conflicting audio metadata for the selected file.",
      resolution: "human-review",
      researchEligible: false,
      evidence: resolvedConflicts.map((conflict) => ev("audio-match", "acknowledgedConflict", conflict)),
      recommendedAction: "No action; the reviewer decision stands."
    });
  }
}

/**
 * Analyzes one recording. Pure and deterministic: identical inputs always
 * produce identical reports, and inputs are never mutated.
 */
export function analyzeMetadataGaps(
  record: DemoRecording,
  context: MetadataGapContext = {}
): MetadataGapReport {
  const gaps = new GapCollector(record.recordingId);
  const matchResult = findMatchResult(record.recordingId, context.audioMatchResults);
  const selectedPath = text(record.audioFilePath);
  const extraction = selectedPath ? findExtraction(selectedPath, context.audioExtractions) : null;
  const audio = extraction?.status === "OK" ? extraction.metadata : null;

  checkSubmission(record, gaps);
  checkArtistAttribution(record, context.expectedArtistRoles ?? [], gaps);
  checkTitle(record, audio, gaps);
  checkIdentifiers(record, audio, gaps);
  checkReleaseMetadata(record, audio, gaps);
  checkDeclarations(record, gaps);
  checkAudio(record, matchResult, extraction, gaps);

  if (record.approvalStatus !== "APPROVED") {
    gaps.add({
      code: "approval-pending",
      area: "approval",
      fields: ["approvalStatus"],
      severity: "blocking",
      category: "needs-human-review",
      description: `Recording is ${record.approvalStatus}; explicit human approval is required.`,
      resolution: "human-review",
      researchEligible: false,
      evidence: [ev("record", "approvalStatus", record.approvalStatus)],
      recommendedAction: "A reviewer approves the record with reviewAndApproveRecord after resolving blocking gaps."
    });
  }

  // Safety net: the analyzer may be stricter than the preparation gate but never looser.
  if (!gaps.hasBlocking(["approval-pending"])) {
    try {
      validateRecordForPreparation({ ...record, approvalStatus: "APPROVED" });
    } catch (error) {
      gaps.add({
        code: "preparation-validation-failed",
        area: "approval",
        fields: [],
        severity: "blocking",
        category: "invalid",
        description: error instanceof Error ? error.message : String(error),
        resolution: "human-review",
        researchEligible: false,
        recommendedAction: "Resolve the preparation validation error before approval."
      });
    }
  }

  const sorted = [...gaps.gaps].sort(
    (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || compareText(left.gapId, right.gapId)
  );
  const count = (severity: GapSeverity) => sorted.filter((gap) => gap.severity === severity).length;
  const readiness: ReadinessStatus = gaps.hasBlocking(["approval-pending"])
    ? "BLOCKED"
    : record.approvalStatus !== "APPROVED"
      ? "AWAITING_APPROVAL"
      : "READY";

  return {
    recordingId: record.recordingId,
    approvalStatus: record.approvalStatus,
    readiness,
    summary: {
      blocking: count("blocking"),
      warning: count("warning"),
      informational: count("informational"),
      researchEligible: sorted.filter((gap) => gap.researchEligible).length
    },
    gaps: sorted
  };
}

/** Analyzes several recordings; reports are sorted by `recordingId` regardless of input order. */
export function analyzeMetadataGapsBatch(
  records: readonly DemoRecording[],
  context: MetadataGapContext = {}
): MetadataGapReport[] {
  return records
    .map((record) => analyzeMetadataGaps(record, context))
    .map((report) => ({ report, key: JSON.stringify(report) }))
    .sort((left, right) => compareText(left.report.recordingId, right.report.recordingId) || compareText(left.key, right.key))
    .map(({ report }) => report);
}

export const METADATA_GAP_SHEET_COLUMNS = [
  "recordingId",
  "readiness",
  "gapId",
  "severity",
  "category",
  "area",
  "code",
  "fields",
  "resolution",
  "researchEligible",
  "requiresHumanConfirmation",
  "description",
  "recommendedAction",
  "suggestedValue",
  "evidence"
] as const;

export type MetadataGapSheetRow = Array<string | boolean>;

/**
 * Flattens reports into spreadsheet rows matching METADATA_GAP_SHEET_COLUMNS.
 * Recordings without gaps still produce one row so their readiness is visible.
 */
export function toMetadataGapSheetRows(reports: readonly MetadataGapReport[]): MetadataGapSheetRow[] {
  return reports.flatMap((report) =>
    report.gaps.length === 0
      ? [[report.recordingId, report.readiness, "", "", "", "", "", "", "", false, false, "", "", "", ""]]
      : report.gaps.map((gap) => [
          report.recordingId,
          report.readiness,
          gap.gapId,
          gap.severity,
          gap.category,
          gap.area,
          gap.code,
          gap.fields.join(", "),
          gap.resolution,
          gap.researchEligible,
          gap.requiresHumanConfirmation,
          gap.description,
          gap.recommendedAction,
          gap.suggestedValue ?? "",
          gap.evidence.map((item) => `${item.source}.${item.field}=${item.value ?? ""}`).join("; ")
        ])
  );
}
