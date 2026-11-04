import { createHash } from "node:crypto";
import { basename } from "node:path";
import { confirmAudioSelection, matchAudioToRecording } from "../audio/audioMatcher";
import type { AudioExtractionResult } from "../audio/audioMetadata";
import { confirmArtistAttribution } from "../metadata/artistAttribution";
import {
  analyzeMetadataGaps,
  audioFileId,
  type GapEvidence,
  type MetadataGap
} from "../metadata/metadataGapAnalyzer";
import { recordingIdentityFingerprint, redactResearchText } from "../metadata/metadataResearch";
import { isValidDate, type DemoRecording } from "../metadata/recordValidation";
import {
  applyHumanReviewDecision,
  type HumanReviewDecision,
  type HumanReviewState,
  type ReviewAuditEntry,
  type ReviewRejection,
  type ReviewerIdentity
} from "./humanReview";

/**
 * MB-09: human-only metadata gap resolution on top of MB-07.
 *
 * MB-06 marks some gaps as human-only (`resolvedBy === "human"` and not
 * research-eligible): submitter details, Exact Artist confirmation,
 * declarations, audio selection, and similar. MB-07 only reviews research
 * proposals, so these gaps need their own explicit human actions. This module
 * applies them to the same review state MB-07 uses, so research and manual
 * decisions share one recording snapshot and one chronological event history
 * that MB-08 can replay and verify.
 *
 * Every function is pure and returns deeply frozen snapshots. Nothing here
 * approves a recording, submits anything, uploads audio, or contacts
 * Mediabase; approval stays `reviewAndApproveRecord`.
 */

export const DECLARATION_FIELDS = [
  "generativeAiAudioDeclaration",
  "independentLabelDeclaration",
  "christmasHanukkahDeclaration",
  "canadianContentDeclaration"
] as const;

/** Recording fields SET_FIELD may change, and only when the active gap names them. */
export const HUMAN_GAP_SETTABLE_FIELDS = [
  "submitterName",
  "email",
  "title",
  "featuredArtist",
  "officialReleaseDate",
  "albumReleaseDate",
  ...DECLARATION_FIELDS
] as const;

export type HumanGapSettableField = (typeof HUMAN_GAP_SETTABLE_FIELDS)[number];

export const HUMAN_GAP_ACTIONS = ["SET_FIELD", "CONFIRM_ARTIST", "CONFIRM_AUDIO", "ACKNOWLEDGE", "DEFER"] as const;

export type HumanGapAction =
  | { action: "SET_FIELD"; field: HumanGapSettableField; value: string }
  | {
      action: "CONFIRM_ARTIST";
      /** The Exact Artist the reviewer explicitly selected. */
      exactArtist: string;
      primaryArtist?: string | null;
      secondaryArtist?: string | null;
      tertiaryArtist?: string | null;
    }
  | {
      action: "CONFIRM_AUDIO";
      /** Opaque `audioFileId` of an evaluated candidate, or null to confirm that no audio is attached. */
      audioFileId: string | null;
      /** Required (with a note) when the selected file has conflicting metadata. */
      acknowledgeConflicts?: boolean;
    }
  | { action: "ACKNOWLEDGE" }
  | { action: "DEFER" };

/** What the reviewer saw; any difference from the current state makes a decision stale. */
export type HumanGapBasis = {
  identityFingerprint: string;
  gapDigest: string;
};

export type HumanGapDecision = {
  /** Unique across research and manual decisions; replaying an id is rejected. */
  reviewId: string;
  recordingId: string;
  gapId: string;
  action: HumanGapAction;
  reviewer: ReviewerIdentity;
  /** ISO 8601 UTC timestamp supplied by the review interface. */
  reviewedAt: string;
  basis: HumanGapBasis;
  note?: string;
};

export type HumanGapOutcome =
  | "VALUE_APPLIED"
  | "ARTIST_CONFIRMED"
  | "AUDIO_CONFIRMED"
  | "NO_AUDIO_CONFIRMED"
  | "FINDING_ACKNOWLEDGED"
  | "DECISION_DEFERRED";

export type HumanGapAuditEntry = {
  sequence: number;
  /** Position of this decision in the combined MB-07/MB-09 review history; binds the chronology. */
  eventSequence: number;
  reviewId: string;
  reviewer: { reviewerId: string; displayName: string | null };
  reviewedAt: string;
  action: HumanGapAction["action"];
  outcome: HumanGapOutcome;
  recordingId: string;
  gapId: string;
  gapCode: MetadataGap["code"];
  gapArea: MetadataGap["area"];
  gapSeverity: MetadataGap["severity"];
  gapDigest: string;
  identityFingerprint: string;
  /** Recording properties the action changed (excluding approval status). */
  changedFields: string[];
  /** Redacted: contact details and local paths never appear here. */
  previousValues: Record<string, string | null>;
  resultingValues: Record<string, string | null>;
  previousApprovalStatus: DemoRecording["approvalStatus"];
  resultingApprovalStatus: DemoRecording["approvalStatus"];
  /** The (already sanitized) evidence of the gap the reviewer resolved. */
  evidence: GapEvidence[];
  note: string | null;
  /**
   * The exact validated action, persisted so MB-08 can replay it. It may hold a
   * contact value; use `publicHumanGapAuditTrail` for anything shown or exported.
   */
  replay: HumanGapAction;
};

export type PublicHumanGapAuditEntry = Omit<HumanGapAuditEntry, "replay">;

/** One entry per accepted decision, in the order decisions were applied. */
export type ReviewEvent = {
  sequence: number;
  kind: "RESEARCH" | "MANUAL";
  reviewId: string;
  /** Sequence of the entry in the MB-07 audit trail (RESEARCH) or the manual audit trail (MANUAL). */
  auditSequence: number;
};

export type HumanGapReviewState = {
  recordingId: string;
  /** The MB-07 state. Its `recording` reflects research and manual changes alike. */
  research: HumanReviewState;
  manualAuditTrail: HumanGapAuditEntry[];
  reviewEvents: ReviewEvent[];
};

export type HumanGapRejectionCode =
  | "INVALID_DECISION"
  | "DUPLICATE_REVIEW"
  | "MISMATCHED_DECISION"
  | "STALE_DECISION"
  | "ALREADY_DECIDED"
  | "ACTION_NOT_ALLOWED"
  | "NOTE_REQUIRED"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "INVALID_VALUE"
  | "PROVENANCE_REQUIRED";

export type HumanGapRejection = {
  reviewId: string | null;
  code: HumanGapRejectionCode;
  message: string;
};

export type HumanGapResult =
  | { ok: true; state: HumanGapReviewState; auditEntry: PublicHumanGapAuditEntry }
  | { ok: false; state: HumanGapReviewState; rejection: HumanGapRejection };

export type ResearchReviewResult =
  | { ok: true; state: HumanGapReviewState; auditEntry: ReviewAuditEntry }
  | { ok: false; state: HumanGapReviewState; rejection: ReviewRejection };

export type HumanGapStatus = "OPEN" | "DEFERRED" | "ACKNOWLEDGED";

export type HumanGapQueueItem = {
  gap: MetadataGap;
  status: HumanGapStatus;
  allowedActions: HumanGapAction["action"][];
  settableFields: HumanGapSettableField[];
  lastReview: { reviewId: string; action: HumanGapAction["action"]; reviewedAt: string } | null;
  /** Orchard artist values offered for CONFIRM_ARTIST; suggestions only. */
  artistCandidates: string[];
  /** Evaluated audio candidates for CONFIRM_AUDIO, identified by opaque id (no paths). */
  audioCandidates: Array<{ audioFileId: string; fileName: string; basis: string; conflicts: string[] }>;
};

export type CombinedReviewItem =
  | { kind: "RESEARCH"; decision: HumanReviewDecision }
  | { kind: "MANUAL"; decision: HumanGapDecision };

export type CombinedReviewBatchResult = {
  state: HumanGapReviewState;
  applied: Array<{ kind: "RESEARCH" | "MANUAL"; reviewId: string; eventSequence: number }>;
  rejected: Array<
    | { kind: "RESEARCH"; decision: unknown; rejection: ReviewRejection }
    | { kind: "MANUAL"; decision: unknown; rejection: HumanGapRejection }
  >;
};

const MAX_ID_LENGTH = 200;
const MAX_GAP_ID_LENGTH = 600;
const MAX_NOTE_LENGTH = 2000;
const MAX_VALUE_LENGTH = 500;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Same rule the gap analyzer uses to flag an invalid submitter email. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_FIELDS = new Set(["submitterName", "email", "company", "phone"]);
const REDACTED_CONTACT = "[redacted contact information]";
const DATE_FIELDS = new Set<string>(["officialReleaseDate", "albumReleaseDate"]);
const DECLARATIONS = new Set<string>(DECLARATION_FIELDS);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return values.some((entry) => entry === value);
}

function identifier(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!object(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function validReviewTimestamp(value: string): boolean {
  const match = ISO_UTC.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59;
}

/** Mirrors MB-07's recalculation so both layers derive the same audio match and gaps. */
function analyze(recording: DemoRecording, audioExtractions: AudioExtractionResult[]) {
  const audioMatch = matchAudioToRecording(recording, audioExtractions);
  const gapReport = analyzeMetadataGaps(recording, { audioExtractions, audioMatchResults: [audioMatch] });
  return { audioMatch, gapReport };
}

function topLevel(field: string): string {
  return field.split(".")[0];
}

function recordValue(recording: DemoRecording, key: string): unknown {
  return (recording as Record<string, unknown>)[key];
}

function fileLabel(path: string): string {
  return `${redactResearchText(basename(path))} [${audioFileId(path)}]`;
}

/** Display form of a recording value for audit entries: no contact details or local paths. */
function publicValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (CONTACT_FIELDS.has(key)) return REDACTED_CONTACT;
  if (key === "audioFilePath" && typeof value === "string") return fileLabel(value);
  if (key === "audioMatch" && object(value)) {
    return JSON.stringify({
      status: value.status,
      file: typeof value.filePath === "string" ? fileLabel(value.filePath) : null,
      humanConfirmed: value.humanConfirmed,
      acknowledgedConflicts: Array.isArray(value.acknowledgedConflicts)
        ? value.acknowledgedConflicts.map((item) => redactResearchText(String(item)))
        : []
    });
  }
  if (key === "artistAttribution" && object(value)) {
    return redactResearchText(JSON.stringify({
      status: value.status,
      confirmed: value.confirmed,
      confirmedExactArtist: value.confirmedExactArtist,
      primaryArtist: value.primaryArtist,
      secondaryArtist: value.secondaryArtist,
      tertiaryArtist: value.tertiaryArtist
    }));
  }
  return redactResearchText(typeof value === "string" ? value : JSON.stringify(value));
}

/** MB-09 resolves only these: human-only gaps that are not part of the separate approval step. */
export function isHumanOnlyGap(gap: MetadataGap): boolean {
  return gap.resolvedBy === "human" && !gap.researchEligible && gap.area !== "approval";
}

function settableFieldsFor(gap: MetadataGap): HumanGapSettableField[] {
  return HUMAN_GAP_SETTABLE_FIELDS.filter((field) => gap.fields.includes(field));
}

function allowedActionsFor(gap: MetadataGap): HumanGapAction["action"][] {
  const actions: HumanGapAction["action"][] = [];
  if (settableFieldsFor(gap).length > 0) actions.push("SET_FIELD");
  if (gap.area === "artist-attribution" &&
    gap.fields.some((field) => field === "artist" || topLevel(field) === "artistAttribution")) {
    actions.push("CONFIRM_ARTIST");
  }
  if (gap.area === "audio" && gap.fields.includes("audioFilePath")) actions.push("CONFIRM_AUDIO");
  // Blocking findings can only be resolved, never acknowledged away.
  if (gap.severity !== "blocking") actions.push("ACKNOWLEDGE");
  actions.push("DEFER");
  return actions;
}

function gapDigestFor(research: HumanReviewState, gap: MetadataGap): string {
  const keys = [...new Set(gap.fields.map(topLevel))].sort();
  const values = Object.fromEntries(keys.map((key) => [key, recordValue(research.recording, key) ?? null]));
  const audio = gap.area === "audio" ? research.audioMatch : null;
  return `GAP-${hash({ gap, values, audio }).slice(0, 24).toUpperCase()}`;
}

function gapStatus(state: HumanGapReviewState, gap: MetadataGap, digest: string) {
  const entry = [...state.manualAuditTrail].reverse().find((item) => item.gapId === gap.gapId);
  if (!entry || entry.gapDigest !== digest) return { status: "OPEN" as const, entry: entry ?? null };
  if (entry.action === "ACKNOWLEDGE") return { status: "ACKNOWLEDGED" as const, entry };
  if (entry.action === "DEFER") return { status: "DEFERRED" as const, entry };
  return { status: "OPEN" as const, entry };
}

/** Starts MB-09 on an MB-07 state. Existing MB-07 audit entries become the first events, in order. */
export function startHumanGapReview(research: Readonly<HumanReviewState>): HumanGapReviewState {
  if (!object(research) || typeof research.recordingId !== "string" || !object(research.recording) ||
    !Array.isArray(research.auditTrail)) {
    throw new Error("Human gap review starts from an MB-07 human review state.");
  }
  const copy = structuredClone(research) as HumanReviewState;
  return deepFreeze({
    recordingId: copy.recordingId,
    research: copy,
    manualAuditTrail: [],
    reviewEvents: copy.auditTrail.map((entry, index) => ({
      sequence: index + 1,
      kind: "RESEARCH" as const,
      reviewId: entry.reviewId,
      auditSequence: entry.sequence
    }))
  });
}

/** Human-only gaps of the current snapshot, with what a reviewer may do about each. */
export function humanOnlyGapQueue(state: Readonly<HumanGapReviewState>): HumanGapQueueItem[] {
  const research = state.research;
  const attribution = research.recording.artistAttribution;
  return research.gapReport.gaps.filter(isHumanOnlyGap).map((gap) => {
    const allowedActions = allowedActionsFor(gap);
    const { status, entry } = gapStatus(state as HumanGapReviewState, gap, gapDigestFor(research, gap));
    return deepFreeze({
      gap: structuredClone(gap),
      status,
      allowedActions,
      settableFields: settableFieldsFor(gap),
      lastReview: entry ? { reviewId: entry.reviewId, action: entry.action, reviewedAt: entry.reviewedAt } : null,
      artistCandidates: allowedActions.includes("CONFIRM_ARTIST") ? [...(attribution?.candidateExactArtists ?? [])] : [],
      audioCandidates: allowedActions.includes("CONFIRM_AUDIO")
        ? research.audioMatch.candidates.map((candidate) => ({
          audioFileId: audioFileId(candidate.filePath),
          fileName: redactResearchText(candidate.fileName),
          basis: candidate.basis,
          conflicts: candidate.conflicts.map(redactResearchText)
        }))
        : []
    });
  });
}

/** The basis a review interface must capture when it shows a human-only gap to a reviewer. */
export function humanGapBasisFor(state: Readonly<HumanGapReviewState>, gapId: string): HumanGapBasis {
  const gap = state.research.gapReport.gaps.find((item) => item.gapId === gapId);
  if (!gap || !isHumanOnlyGap(gap)) throw new Error("No open human-only gap has this identifier.");
  return {
    identityFingerprint: recordingIdentityFingerprint(state.research.recording),
    gapDigest: gapDigestFor(state.research, gap)
  };
}

function optionalName(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function shapeError(input: unknown): string | null {
  if (!object(input)) return "Gap decision must be an object.";
  if (!identifier(input.reviewId)) return "A review identifier is required.";
  if (!identifier(input.recordingId)) return "A recording identifier is required.";
  if (!identifier(input.gapId, MAX_GAP_ID_LENGTH)) return "A gap identifier is required.";
  const reviewer = input.reviewer;
  if (!object(reviewer) || !identifier(reviewer.reviewerId)) return "Explicit reviewer identity is required.";
  if (reviewer.displayName !== undefined && reviewer.displayName !== null && !identifier(reviewer.displayName)) {
    return "Reviewer display name is invalid.";
  }
  if (typeof input.reviewedAt !== "string" || !validReviewTimestamp(input.reviewedAt)) {
    return "Review timestamp must be an ISO 8601 UTC timestamp.";
  }
  const basis = input.basis;
  if (!object(basis) || typeof basis.identityFingerprint !== "string" || typeof basis.gapDigest !== "string") {
    return "Review basis (identity fingerprint and gap digest) is required.";
  }
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > MAX_NOTE_LENGTH)) {
    return "Reviewer note must be text of at most 2000 characters.";
  }
  const action = input.action;
  if (!object(action) || !member(action.action, HUMAN_GAP_ACTIONS)) return "Unsupported gap review action.";
  const keys = Object.keys(action).filter((key) => action[key] !== undefined).sort().join();
  switch (action.action) {
    case "SET_FIELD":
      if (keys !== "action,field,value" || !member(action.field, HUMAN_GAP_SETTABLE_FIELDS) ||
        typeof action.value !== "string") {
        return "SET_FIELD requires exactly a supported field and a text value.";
      }
      break;
    case "CONFIRM_ARTIST":
      if (typeof action.exactArtist !== "string" || !optionalName(action.primaryArtist) ||
        !optionalName(action.secondaryArtist) || !optionalName(action.tertiaryArtist) ||
        !keys.split(",").every((key) =>
          ["action", "exactArtist", "primaryArtist", "secondaryArtist", "tertiaryArtist"].includes(key))) {
        return "CONFIRM_ARTIST requires an explicit Exact Artist and optional artist roles.";
      }
      break;
    case "CONFIRM_AUDIO":
      if ((action.audioFileId !== null && typeof action.audioFileId !== "string") ||
        (action.acknowledgeConflicts !== undefined && typeof action.acknowledgeConflicts !== "boolean") ||
        !keys.split(",").every((key) => ["action", "audioFileId", "acknowledgeConflicts"].includes(key)) ||
        !Object.prototype.hasOwnProperty.call(action, "audioFileId")) {
        return "CONFIRM_AUDIO requires an audio file id (or null for no audio) and an optional acknowledgement.";
      }
      break;
    default:
      if (keys !== "action") return `${action.action} carries no values.`;
  }
  return null;
}

function textValueError(label: string, value: string): string | null {
  if (value.trim().length === 0) return `A ${label} value is required.`;
  if (value !== value.trim() || value.length > MAX_VALUE_LENGTH || CONTROL.test(value)) {
    return `The ${label} value has surrounding whitespace, control characters, or is too long.`;
  }
  return null;
}

/** Applies the existing project rules for a manually entered value. Returns an error message or null. */
export function validateHumanGapValue(field: HumanGapSettableField, value: unknown): string | null {
  if (typeof value !== "string") return `A ${field} value is required.`;
  const text = textValueError(field, value);
  if (text) return text;
  if (DECLARATIONS.has(field)) {
    // Explicit answers only; "unanswered" or truthy spellings are never accepted as a human answer.
    return value === "yes" || value === "no" ? null : `${field} must be answered "yes" or "no".`;
  }
  if (DATE_FIELDS.has(field)) return isValidDate(value) ? null : `${field} must be a valid mm/dd/yyyy date.`;
  if (field === "email") return EMAIL_PATTERN.test(value) ? null : "The submitter email address is not valid.";
  if (redactResearchText(value) !== value) return `The ${field} value must not contain email addresses or local paths.`;
  return null;
}

function artistSelectionError(action: Extract<HumanGapAction, { action: "CONFIRM_ARTIST" }>): string | null {
  const exact = textValueError("Exact Artist", action.exactArtist);
  if (exact) return exact;
  if (redactResearchText(action.exactArtist) !== action.exactArtist) {
    return "The Exact Artist must not contain email addresses or local paths.";
  }
  const roles = [action.primaryArtist, action.secondaryArtist, action.tertiaryArtist];
  for (const role of roles) {
    if (role === undefined || role === null) continue;
    const invalid = textValueError("artist role", role);
    if (invalid) return invalid;
    if (redactResearchText(role) !== role) return "Artist roles must not contain email addresses or local paths.";
  }
  const [primary, secondary, tertiary] = roles.map((role) => role ?? null);
  if ((secondary !== null && primary === null) || (tertiary !== null && secondary === null)) {
    return "Artist roles must be filled in order: primary, then secondary, then tertiary.";
  }
  const named = roles.filter((role): role is string => typeof role === "string").map((role) => role.toUpperCase());
  if (new Set(named).size !== named.length) return "Each artist role must name a different artist.";
  return null;
}

/** Fails if anything other than the allowed keys differs between two snapshots. */
function assertOnlyAllowedChanges(before: DemoRecording, after: DemoRecording, allowed: ReadonlySet<string>): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (allowed.has(key)) continue;
    if (JSON.stringify(recordValue(before, key)) !== JSON.stringify(recordValue(after, key))) {
      throw new Error(`Gap review attempted to change an unrelated recording field: ${key}.`);
    }
  }
}

function hasReviewId(state: HumanGapReviewState, reviewId: string): boolean {
  return state.research.auditTrail.some((entry) => entry.reviewId === reviewId) ||
    state.manualAuditTrail.some((entry) => entry.reviewId === reviewId);
}

/**
 * Validates and applies one human-only gap decision. A rejected decision
 * returns the unchanged state and a reason; it never partially applies.
 */
export function applyHumanGapDecision(
  state: Readonly<HumanGapReviewState>,
  input: Readonly<HumanGapDecision>
): HumanGapResult {
  const current = state as HumanGapReviewState;
  const reviewId = object(input) && identifier(input.reviewId) ? input.reviewId : null;
  const reject = (code: HumanGapRejectionCode, message: string): HumanGapResult =>
    ({ ok: false, state: current, rejection: deepFreeze({ reviewId, code, message }) });

  const shape = shapeError(input);
  if (shape) return reject("INVALID_DECISION", shape);
  const decision = structuredClone(input) as HumanGapDecision;
  const { action } = decision;
  const research = current.research;
  const before = research.recording;

  if (hasReviewId(current, decision.reviewId)) {
    return reject("DUPLICATE_REVIEW", "This review decision was already recorded.");
  }
  if (decision.recordingId !== current.recordingId || !decision.gapId.startsWith(`${current.recordingId}:`)) {
    return reject("MISMATCHED_DECISION", "The decision does not belong to this recording.");
  }
  const gap = research.gapReport.gaps.find((item) => item.gapId === decision.gapId);
  if (!gap) return reject("STALE_DECISION", "The gap this decision addressed is no longer open.");
  if (!isHumanOnlyGap(gap)) {
    return reject("ACTION_NOT_ALLOWED", gap.area === "approval"
      ? "Approval is a separate explicit step; MB-09 cannot resolve it."
      : gap.researchEligible
        ? "This gap is research-eligible; review its proposals through MB-07."
        : "This gap is resolved by a deterministic rule, not a human decision.");
  }

  const fingerprint = recordingIdentityFingerprint(before);
  const digest = gapDigestFor(research, gap);
  if (decision.basis.identityFingerprint !== fingerprint) {
    return reject("STALE_DECISION", "The recording's identifying metadata changed after this decision was prepared.");
  }
  if (decision.basis.gapDigest !== digest) {
    return reject("STALE_DECISION", "The gap or its current values changed after this decision was prepared.");
  }
  if (!allowedActionsFor(gap).includes(action.action)) {
    return reject("ACTION_NOT_ALLOWED", `${action.action} is not allowed for a ${gap.severity} ${gap.code} gap.`);
  }
  const { status } = gapStatus(current, gap, digest);
  if ((status === "ACKNOWLEDGED" && (action.action === "ACKNOWLEDGE" || action.action === "DEFER")) ||
    (status === "DEFERRED" && action.action === "DEFER")) {
    return reject("ALREADY_DECIDED", `This gap is already ${status.toLowerCase()}.`);
  }

  const note = decision.note?.trim() ? redactResearchText(decision.note.trim()) : null;
  if (note && note.length > MAX_NOTE_LENGTH) {
    return reject("INVALID_DECISION", "Reviewer note must be text of at most 2000 characters after redaction.");
  }
  let recording: DemoRecording = structuredClone(before) as DemoRecording;
  let replay: HumanGapAction;
  let outcome: HumanGapOutcome;
  const allowed = new Set<string>(["approvalStatus"]);

  switch (action.action) {
    case "SET_FIELD": {
      if (!settableFieldsFor(gap).includes(action.field)) {
        return reject("ACTION_NOT_ALLOWED", `${action.field} is not a field of this gap.`);
      }
      const invalid = validateHumanGapValue(action.field, action.value);
      if (invalid) return reject("INVALID_VALUE", invalid);
      if (before[action.field] === action.value) {
        return reject("INVALID_VALUE", `${action.field} already has this value.`);
      }
      (recording as Record<string, unknown>)[action.field] = action.value;
      allowed.add(action.field);
      replay = { action: "SET_FIELD", field: action.field, value: action.value };
      outcome = "VALUE_APPLIED";
      break;
    }
    case "CONFIRM_ARTIST": {
      const attribution = before.artistAttribution;
      if (!attribution) {
        return reject("PROVENANCE_REQUIRED",
          "This recording has no Orchard artist attribution; re-import it rather than confirming an artist without provenance.");
      }
      const invalid = artistSelectionError(action);
      if (invalid) return reject("INVALID_VALUE", invalid);
      if (attribution.status === "CONFLICT" && !note) {
        return reject("NOTE_REQUIRED", "Orchard TRACK ARTIST and PRODUCT ARTIST conflict; explain the selection in a note.");
      }
      if (!attribution.candidateExactArtists.includes(action.exactArtist) && !note) {
        return reject("NOTE_REQUIRED", "An Exact Artist not offered by Orchard requires a note explaining its source.");
      }
      replay = {
        action: "CONFIRM_ARTIST",
        exactArtist: action.exactArtist,
        primaryArtist: action.primaryArtist ?? null,
        secondaryArtist: action.secondaryArtist ?? null,
        tertiaryArtist: action.tertiaryArtist ?? null
      };
      const confirmed = confirmArtistAttribution(attribution, {
        exactArtist: action.exactArtist,
        primaryArtist: replay.primaryArtist,
        secondaryArtist: replay.secondaryArtist,
        tertiaryArtist: replay.tertiaryArtist
      });
      recording.artist = confirmed.confirmedExactArtist as string;
      recording.artistAttribution = confirmed;
      allowed.add("artist").add("artistAttribution");
      outcome = "ARTIST_CONFIRMED";
      break;
    }
    case "CONFIRM_AUDIO": {
      let filePath: string | null = null;
      let acknowledgeConflicts = false;
      if (action.audioFileId !== null) {
        const candidate = research.audioMatch.candidates.find((item) => audioFileId(item.filePath) === action.audioFileId);
        if (!candidate) return reject("INVALID_VALUE", "The selected audio file is not one of the evaluated candidates.");
        if (candidate.conflicts.length > 0) {
          if (action.acknowledgeConflicts !== true) {
            return reject("ACKNOWLEDGEMENT_REQUIRED",
              "The selected audio file has conflicting metadata; set acknowledgeConflicts to confirm it anyway.");
          }
          if (!note) return reject("NOTE_REQUIRED", "Confirming audio with conflicting metadata requires a reviewer note.");
          acknowledgeConflicts = true;
        }
        filePath = candidate.filePath;
      }
      replay = {
        action: "CONFIRM_AUDIO",
        audioFileId: action.audioFileId,
        ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {})
      };
      // Records the human choice only; the file is never read, copied, or uploaded here.
      recording = confirmAudioSelection(recording, research.audioMatch, filePath, { acknowledgeConflicts });
      allowed.add("audioFilePath").add("audioMatch");
      outcome = filePath === null ? "NO_AUDIO_CONFIRMED" : "AUDIO_CONFIRMED";
      break;
    }
    case "ACKNOWLEDGE":
      if (!note) return reject("NOTE_REQUIRED", "Acknowledging a finding requires a reviewer note.");
      replay = { action: "ACKNOWLEDGE" };
      outcome = "FINDING_ACKNOWLEDGED";
      break;
    default:
      replay = { action: "DEFER" };
      outcome = "DECISION_DEFERRED";
  }

  const changedFields = [...new Set([...Object.keys(before), ...Object.keys(recording)])]
    .filter((key) => key !== "approvalStatus" &&
      JSON.stringify(recordValue(before, key)) !== JSON.stringify(recordValue(recording, key)))
    .sort();
  // A changed value invalidates an earlier final approval; gap review never grants one.
  if (changedFields.length > 0 && recording.approvalStatus === "APPROVED") recording.approvalStatus = "NEEDS_REVIEW";
  assertOnlyAllowedChanges(before, recording, allowed);

  const nextResearch = structuredClone(research) as HumanReviewState;
  if (changedFields.length > 0) {
    nextResearch.recording = recording;
    nextResearch.identityFingerprint = recordingIdentityFingerprint(recording);
    Object.assign(nextResearch, analyze(recording, nextResearch.audioExtractions));
    nextResearch.recordingApprovalRequired = recording.approvalStatus !== "APPROVED";
  }

  const shownKeys = [...new Set([...gap.fields.map(topLevel), ...changedFields])].sort();
  const auditEntry: HumanGapAuditEntry = {
    sequence: current.manualAuditTrail.length + 1,
    eventSequence: current.reviewEvents.length + 1,
    reviewId: decision.reviewId,
    reviewer: {
      reviewerId: decision.reviewer.reviewerId.trim(),
      displayName: decision.reviewer.displayName?.trim() || null
    },
    reviewedAt: decision.reviewedAt,
    action: action.action,
    outcome,
    recordingId: current.recordingId,
    gapId: gap.gapId,
    gapCode: gap.code,
    gapArea: gap.area,
    gapSeverity: gap.severity,
    gapDigest: digest,
    identityFingerprint: fingerprint,
    changedFields,
    previousValues: Object.fromEntries(shownKeys.map((key) => [key, publicValue(key, recordValue(before, key))])),
    resultingValues: Object.fromEntries(
      shownKeys.map((key) => [key, publicValue(key, recordValue(nextResearch.recording, key))])
    ),
    previousApprovalStatus: before.approvalStatus,
    resultingApprovalStatus: nextResearch.recording.approvalStatus,
    evidence: structuredClone(gap.evidence),
    note,
    replay
  };

  const next: HumanGapReviewState = {
    recordingId: current.recordingId,
    research: nextResearch,
    manualAuditTrail: [...structuredClone(current.manualAuditTrail), auditEntry],
    reviewEvents: [...structuredClone(current.reviewEvents), {
      sequence: current.reviewEvents.length + 1,
      kind: "MANUAL",
      reviewId: decision.reviewId,
      auditSequence: auditEntry.sequence
    }]
  };
  const frozen = deepFreeze(next);
  return { ok: true, state: frozen, auditEntry: publicHumanGapAuditEntry(auditEntry) };
}

/**
 * Applies an MB-07 research decision through the unchanged MB-07 rules and
 * records it in the combined history. Review ids are unique across both kinds.
 */
export function applyResearchReviewDecision(
  state: Readonly<HumanGapReviewState>,
  decision: Readonly<HumanReviewDecision>
): ResearchReviewResult {
  const current = state as HumanGapReviewState;
  const reviewId = object(decision) && identifier(decision.reviewId) ? decision.reviewId : null;
  if (reviewId !== null && current.manualAuditTrail.some((entry) => entry.reviewId === reviewId)) {
    return {
      ok: false,
      state: current,
      rejection: deepFreeze({ reviewId, code: "DUPLICATE_REVIEW", message: "This review decision was already recorded." })
    };
  }
  const result = applyHumanReviewDecision(current.research, decision);
  if (!result.ok) return { ok: false, state: current, rejection: result.rejection };
  const next = deepFreeze({
    recordingId: current.recordingId,
    research: result.state,
    manualAuditTrail: structuredClone(current.manualAuditTrail),
    reviewEvents: [...structuredClone(current.reviewEvents), {
      sequence: current.reviewEvents.length + 1,
      kind: "RESEARCH" as const,
      reviewId: result.auditEntry.reviewId,
      auditSequence: result.auditEntry.sequence
    }]
  });
  return { ok: true, state: next, auditEntry: next.research.auditTrail[next.research.auditTrail.length - 1] };
}

/**
 * Applies research and manual decisions in the given order. Each is checked
 * against the state left by the previous one, so a manual change that alters
 * the recording identity or a reviewed value makes older research decisions
 * stale (and vice versa).
 */
export function applyCombinedReviewDecisions(
  state: Readonly<HumanGapReviewState>,
  items: readonly CombinedReviewItem[]
): CombinedReviewBatchResult {
  let current = state as HumanGapReviewState;
  const applied: CombinedReviewBatchResult["applied"] = [];
  const rejected: CombinedReviewBatchResult["rejected"] = [];
  for (const item of items) {
    let ok: boolean;
    if (item.kind === "RESEARCH") {
      const result = applyResearchReviewDecision(current, item.decision);
      ok = result.ok;
      if (result.ok) current = result.state;
      else rejected.push({ kind: "RESEARCH", decision: item.decision, rejection: result.rejection });
    } else {
      const result = applyHumanGapDecision(current, item.decision);
      ok = result.ok;
      if (result.ok) current = result.state;
      else rejected.push({ kind: "MANUAL", decision: item.decision, rejection: result.rejection });
    }
    if (ok) {
      const last = current.reviewEvents[current.reviewEvents.length - 1];
      applied.push({ kind: last.kind, reviewId: last.reviewId, eventSequence: last.sequence });
    }
  }
  return { state: current, applied, rejected };
}

export function publicHumanGapAuditEntry(entry: Readonly<HumanGapAuditEntry>): PublicHumanGapAuditEntry {
  const { replay: _replay, ...rest } = structuredClone(entry) as HumanGapAuditEntry;
  return deepFreeze(rest);
}

/** The manual audit trail without replay payloads; safe to show or export. */
export function publicHumanGapAuditTrail(state: Readonly<HumanGapReviewState>): PublicHumanGapAuditEntry[] {
  return state.manualAuditTrail.map(publicHumanGapAuditEntry);
}

export type HumanGapReviewSummary = {
  recordingId: string;
  approvalStatus: DemoRecording["approvalStatus"];
  /** Always true until a separate explicit approval; MB-09 never approves. */
  recordingApprovalRequired: boolean;
  readiness: HumanReviewState["gapReport"]["readiness"];
  researchReview: HumanReviewState["researchReview"];
  humanOnlyGaps: { open: number; deferred: number; acknowledged: number; blocking: number };
  outstanding: Array<{ gapId: string; code: MetadataGap["code"]; severity: MetadataGap["severity"]; status: HumanGapStatus }>;
  events: { research: number; manual: number };
};

/** Counts and gap codes only: no recording values, contact details, or paths. */
export function humanGapReviewSummary(state: Readonly<HumanGapReviewState>): HumanGapReviewSummary {
  const queue = humanOnlyGapQueue(state);
  const count = (status: HumanGapStatus) => queue.filter((item) => item.status === status).length;
  return deepFreeze({
    recordingId: state.recordingId,
    approvalStatus: state.research.recording.approvalStatus,
    recordingApprovalRequired: state.research.recordingApprovalRequired,
    readiness: state.research.gapReport.readiness,
    researchReview: structuredClone(state.research.researchReview),
    humanOnlyGaps: {
      open: count("OPEN"),
      deferred: count("DEFERRED"),
      acknowledged: count("ACKNOWLEDGED"),
      blocking: queue.filter((item) => item.gap.severity === "blocking").length
    },
    outstanding: queue.map((item) => ({
      gapId: item.gap.gapId,
      code: item.gap.code,
      severity: item.gap.severity,
      status: item.status
    })),
    events: {
      research: state.reviewEvents.filter((event) => event.kind === "RESEARCH").length,
      manual: state.reviewEvents.filter((event) => event.kind === "MANUAL").length
    }
  });
}
