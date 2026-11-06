import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MetadataReviewAction } from "../metadata/metadataResearch";
import { redactResearchText } from "../metadata/metadataResearch";
import {
  ReviewStorageLockedError,
  type ReviewStorageBackend
} from "../storage/reviewStorageBackend";
import {
  applyHumanReviewDecision,
  reviewBasisFor,
  startHumanReview,
  type HumanReviewDecision,
  type HumanReviewSource,
  type HumanReviewState,
  type ReviewAuditEntry,
  type ReviewRejection,
  type ReviewRejectionCode
} from "./humanReview";
import {
  applyHumanGapDecision,
  applyResearchReviewDecision,
  HUMAN_GAP_ACTIONS,
  HUMAN_GAP_SETTABLE_FIELDS,
  startHumanGapReview,
  type CombinedReviewItem,
  type HumanGapAction,
  type HumanGapAuditEntry,
  type HumanGapDecision,
  type HumanGapRejection,
  type HumanGapRejectionCode,
  type HumanGapReviewState
} from "./humanGapReview";

/**
 * MB-08: persistent review sessions on top of MB-07.
 *
 * A saved session is the MB-07 `HumanReviewState`. It is only accepted (on save
 * and on load) if replaying its audit trail through the unchanged MB-07 rules,
 * starting from its own original snapshot and pending decisions, reproduces it
 * exactly. Saved values therefore always went through human review, unrelated
 * fields and approval status cannot be edited in storage, and an audit trail
 * cannot be shortened or rewritten. Decisions MB-07 refused are kept in a
 * separate append-only refusal log next to the state. Revisions prevent an
 * older session from overwriting newer decisions. Nothing here approves,
 * submits, or contacts Mediabase or any network service.
 */

export const REVIEW_SESSION_FORMAT = "mediabase-agent.human-review-session";
/** MB-08 sessions (MB-07 research review only). Still read, verified, and written by `load`/`save`. */
export const REVIEW_SESSION_SCHEMA_VERSION = 1;
/**
 * MB-09 combined sessions: research and human-only gap decisions in one
 * ordered event history. Read and written by `loadCombined`/`saveCombined`;
 * version-1 sessions become version 2 only through an explicit `upgrade`.
 */
export const COMBINED_REVIEW_SESSION_SCHEMA_VERSION = 2;

/**
 * A review decision MB-07 refused (stale, duplicate, conflicting, invalid
 * value, ...). The state is unchanged by it, so it is not an audit entry, but
 * it is persisted so the attempt and its reason survive a restart. Free text
 * is redacted (emails, local paths, control characters) before it is stored.
 */
export type RefusedReviewDecision = {
  sequence: number;
  /** When the refusal was recorded by this application. */
  recordedAt: string;
  reviewId: string | null;
  decisionId: string | null;
  source: HumanReviewDecision["source"] | null;
  action: MetadataReviewAction["action"] | null;
  field: string | null;
  proposalId: string | null;
  reviewer: { reviewerId: string; displayName: string | null } | null;
  reviewedAt: string | null;
  /** The edited value the reviewer submitted, if any (redacted). */
  submittedValue: string | null;
  note: string | null;
  code: ReviewRejectionCode;
  message: string;
};

/** A review state together with its refusal log; what a session works on between saves. */
export type ReviewSessionProgress = {
  state: HumanReviewState;
  refusedDecisions: readonly RefusedReviewDecision[];
};

export type StoredReviewSession = {
  recordingId: string;
  /** Starts at 1 and increases by one with every saved change. */
  revision: number;
  savedAt: string;
  savedBy: string | null;
  state: HumanReviewState;
  refusedDecisions: readonly RefusedReviewDecision[];
};

export type StoredReviewSummary = {
  recordingId: string;
  /** 1 for MB-08 research-only sessions, 2 for MB-09 combined sessions. */
  schemaVersion: number;
  revision: number;
  savedAt: string;
  savedBy: string | null;
  auditEntries: number;
  /** MB-09 manual audit entries (0 for version-1 sessions). */
  manualAuditEntries: number;
  refusedDecisions: number;
  researchReview: HumanReviewState["researchReview"];
  approvalStatus: HumanReviewState["recording"]["approvalStatus"];
};

/**
 * An MB-09 decision that was refused. Like MB-07 refusals it never changed the
 * state, and its free text is redacted; contact values are never stored here.
 */
export type RefusedHumanGapDecision = {
  kind: "MANUAL";
  sequence: number;
  recordedAt: string;
  reviewId: string | null;
  gapId: string | null;
  action: HumanGapAction["action"] | null;
  /** The SET_FIELD target field, if any. */
  field: string | null;
  reviewer: { reviewerId: string; displayName: string | null } | null;
  reviewedAt: string | null;
  /** Redacted submitted value: contact values are masked and audio appears as an opaque id. */
  submittedValue: string | null;
  note: string | null;
  code: HumanGapRejectionCode;
  message: string;
};

/** A version-2 refusal log holds MB-07 and MB-09 refusals in one append-only sequence. */
export type CombinedRefusedDecision = RefusedReviewDecision | RefusedHumanGapDecision;

export type CombinedReviewProgress = {
  state: HumanGapReviewState;
  refusedDecisions: readonly CombinedRefusedDecision[];
};

/** Where an upgraded session came from; the version-1 digest links it to the original document. */
export type ReviewUpgradeProvenance = {
  schemaVersion: 1;
  revision: number;
  contentDigest: string;
};

export type StoredCombinedReviewSession = {
  recordingId: string;
  schemaVersion: typeof COMBINED_REVIEW_SESSION_SCHEMA_VERSION;
  revision: number;
  savedAt: string;
  savedBy: string | null;
  upgradedFrom: ReviewUpgradeProvenance | null;
  state: HumanGapReviewState;
  refusedDecisions: readonly CombinedRefusedDecision[];
};

export type ReviewStoreErrorCode =
  | "NOT_FOUND"
  | "CORRUPTED_DATA"
  | "INCOMPATIBLE_VERSION"
  | "UPGRADE_REQUIRED"
  | "INTEGRITY_CHECK_FAILED"
  | "INVALID_STATE"
  | "INVALID_REQUEST"
  | "REVISION_CONFLICT"
  | "HISTORY_REWRITE"
  | "LOCKED"
  | "STORAGE_ERROR";

export type ReviewStoreError = { code: ReviewStoreErrorCode; message: string };

export type ReviewLoadResult =
  | { ok: true; session: StoredReviewSession }
  | ({ ok: false } & ReviewStoreError);

export type ReviewSaveResult =
  | { ok: true; session: StoredReviewSession; unchanged: boolean }
  | ({ ok: false; currentRevision: number | null } & ReviewStoreError);

export type ReviewSaveOptions = {
  /** The revision this session loaded, or 0 when creating the first save. */
  expectedRevision: number;
  /** Optional identifier of the saving review session (not a person). */
  sessionId?: string;
  /**
   * The complete refusal log for this session (the loaded log plus new
   * refusals). It is append-only like the audit trail. When omitted, the
   * stored log is kept as is (an empty log for a first save).
   */
  refusedDecisions?: readonly RefusedReviewDecision[];
};

export type ReviewListEntry =
  | ({ ok: true } & StoredReviewSummary)
  | ({ ok: false; key: string } & ReviewStoreError);

export type CombinedReviewLoadResult =
  | { ok: true; session: StoredCombinedReviewSession }
  | ({ ok: false } & ReviewStoreError);

export type CombinedReviewSaveResult =
  | { ok: true; session: StoredCombinedReviewSession; unchanged: boolean }
  | ({ ok: false; currentRevision: number | null } & ReviewStoreError);

export type CombinedReviewSaveOptions = {
  /** The revision this session loaded, or 0 when creating the first save. */
  expectedRevision: number;
  sessionId?: string;
  /** The complete (append-only) combined refusal log; omitted keeps the stored log. */
  refusedDecisions?: readonly CombinedRefusedDecision[];
};

export type ReviewUpgradeOptions = {
  /** The version-1 revision the caller loaded; a newer save makes the upgrade a revision conflict. */
  expectedRevision: number;
  sessionId?: string;
};

export interface ReviewSessionStore {
  /** Version-1 (MB-08) sessions. A version-2 session is reported as INCOMPATIBLE_VERSION. */
  load(recordingId: string): Promise<ReviewLoadResult>;
  /** Writes version-1 sessions; never overwrites a version-2 session. */
  save(state: Readonly<HumanReviewState>, options: ReviewSaveOptions): Promise<ReviewSaveResult>;
  /** Summaries only; recording contents, contact details, and paths are not included. */
  list(): Promise<ReviewListEntry[]>;
  /** Version-2 (MB-09) sessions. A version-1 session is reported as UPGRADE_REQUIRED. */
  loadCombined(recordingId: string): Promise<CombinedReviewLoadResult>;
  saveCombined(state: Readonly<HumanGapReviewState>, options: CombinedReviewSaveOptions): Promise<CombinedReviewSaveResult>;
  /**
   * Explicitly converts a verified version-1 session into a version-2 session
   * at the next revision. Its snapshot, audit trail, and refusal log are kept
   * unchanged; its MB-07 decisions become the first events, in their order.
   */
  upgrade(recordingId: string, options: ReviewUpgradeOptions): Promise<CombinedReviewSaveResult>;
}

type Envelope = {
  format: typeof REVIEW_SESSION_FORMAT;
  schemaVersion: typeof REVIEW_SESSION_SCHEMA_VERSION;
  recordingId: string;
  revision: number;
  savedAt: string;
  savedBy: string | null;
  auditEntries: number;
  refusedDecisionCount: number;
  /** Covers both the state and the refusal log. */
  contentDigest: string;
  /** HMAC-SHA256 over the header and digest when the store has an integrity key. */
  signature: string | null;
  state: HumanReviewState;
  refusedDecisions: RefusedReviewDecision[];
};

type EnvelopeV2 = {
  format: typeof REVIEW_SESSION_FORMAT;
  schemaVersion: typeof COMBINED_REVIEW_SESSION_SCHEMA_VERSION;
  recordingId: string;
  revision: number;
  savedAt: string;
  savedBy: string | null;
  /** MB-07 audit entries. */
  auditEntries: number;
  manualAuditEntries: number;
  reviewEvents: number;
  refusedDecisionCount: number;
  upgradedFrom: ReviewUpgradeProvenance | null;
  contentDigest: string;
  signature: string | null;
  state: HumanGapReviewState;
  refusedDecisions: CombinedRefusedDecision[];
};

type Verified<T> = { ok: true; value: T } | ({ ok: false } & ReviewStoreError);

const MAX_ID_LENGTH = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/** Key-order independent JSON used for digests and equality. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function digest(value: unknown): string {
  return `SHA256-${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Checksum stored with a saved session to detect accidental corruption (not a signature). */
export function reviewSessionDigest(
  state: Readonly<HumanReviewState>,
  refusedDecisions: readonly RefusedReviewDecision[]
): string {
  return digest({ state, refusedDecisions });
}

/** Stable, path-safe storage key for a recording; the raw identifier never becomes a file name. */
export function reviewStorageKey(recordingId: string): string {
  return `review-${createHash("sha256").update(recordingId, "utf8").digest("hex").slice(0, 40)}`;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH &&
    !CONTROL.test(value) && redactResearchText(value) === value;
}

function fail(code: ReviewStoreErrorCode, message: string): { ok: false } & ReviewStoreError {
  return { ok: false, code, message };
}

const REJECTION_CODES: Record<ReviewRejectionCode, true> = {
  INVALID_DECISION: true,
  DUPLICATE_REVIEW: true,
  UNKNOWN_DECISION: true,
  MISMATCHED_DECISION: true,
  STALE_DECISION: true,
  ALREADY_DECIDED: true,
  CONFLICT_REQUIRES_EXPLICIT_RESOLUTION: true,
  NOTE_REQUIRED: true,
  NO_VERIFIED_SUGGESTION: true,
  INVALID_VALUE: true
};
const REVIEW_ACTIONS: Record<MetadataReviewAction["action"], true> = {
  APPROVE_SUGGESTED_VALUE: true,
  EDIT_SUGGESTED_VALUE: true,
  REJECT_SUGGESTION: true,
  DEFER_DECISION: true
};
const REVIEW_SOURCES: Record<HumanReviewDecision["source"], true> = { MUSICBRAINZ: true, RESEARCH: true };
const MAX_REFUSAL_TEXT = 1000;
const MAX_REFUSAL_VALUE = 500;
const REFUSAL_KEYS = [
  "action", "code", "decisionId", "field", "message", "note", "proposalId", "recordedAt",
  "reviewId", "reviewedAt", "reviewer", "sequence", "source", "submittedValue"
].join();

function hasKey<T extends string>(table: Record<T, true>, value: unknown): value is T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

/** Redacted, length-limited text; null when the input is not a string. */
function redactedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = redactResearchText(value).slice(0, max);
  return redactResearchText(text) === text ? text : "[redacted]";
}

function storedText(value: unknown, max: number, nullable = true): boolean {
  if (value === null) return nullable;
  return typeof value === "string" && value.length <= max && redactResearchText(value) === value;
}

/**
 * Appends a decision MB-07 refused to a refusal log and returns the new
 * (deep-frozen) log. Only identifiers, the reviewer, timestamps, the submitted
 * value, the note, and the MB-07 rejection are kept, all redacted.
 */
export function recordRefusedDecision(
  log: readonly RefusedReviewDecision[],
  decision: unknown,
  rejection: ReviewRejection,
  recordedAt: Date = new Date()
): readonly RefusedReviewDecision[] {
  if (!isObject(rejection) || !hasKey(REJECTION_CODES, rejection.code)) {
    throw new Error("A refused decision needs an MB-07 rejection.");
  }
  const submitted = isObject(decision) ? decision : {};
  const action = isObject(submitted.action) ? submitted.action : {};
  const reviewer = isObject(submitted.reviewer) && typeof submitted.reviewer.reviewerId === "string"
    ? {
      reviewerId: redactedText(submitted.reviewer.reviewerId, MAX_ID_LENGTH) as string,
      displayName: redactedText(submitted.reviewer.displayName, MAX_ID_LENGTH)
    }
    : null;
  const entry: RefusedReviewDecision = {
    sequence: log.length + 1,
    recordedAt: recordedAt.toISOString(),
    reviewId: redactedText(rejection.reviewId ?? submitted.reviewId, MAX_ID_LENGTH),
    decisionId: redactedText(submitted.decisionId, MAX_ID_LENGTH),
    source: hasKey(REVIEW_SOURCES, submitted.source) ? submitted.source : null,
    action: hasKey(REVIEW_ACTIONS, action.action) ? action.action : null,
    field: redactedText(action.field, MAX_ID_LENGTH),
    proposalId: redactedText(action.proposalId, MAX_ID_LENGTH),
    reviewer,
    reviewedAt: typeof submitted.reviewedAt === "string" && ISO_UTC.test(submitted.reviewedAt)
      ? submitted.reviewedAt
      : null,
    submittedValue: action.action === "EDIT_SUGGESTED_VALUE"
      ? redactedText(action.editedValue, MAX_REFUSAL_VALUE)
      : null,
    note: redactedText(typeof action.note === "string" ? action.note.trim() : null, MAX_REFUSAL_TEXT),
    code: rejection.code,
    message: redactedText(rejection.message, MAX_REFUSAL_TEXT) ?? ""
  };
  return deepFreeze([...log, entry]);
}

export type ReviewProgressBatchResult = ReviewSessionProgress & {
  applied: ReviewAuditEntry[];
  rejected: ReviewRejection[];
};

/**
 * Applies decisions in order through MB-07 (`applyHumanReviewDecision`,
 * unchanged) and records every refused decision in the refusal log.
 */
export function applyReviewDecisionsWithRefusalLog(
  progress: ReviewSessionProgress,
  decisions: readonly HumanReviewDecision[],
  options: { now?: () => Date } = {}
): ReviewProgressBatchResult {
  const now = options.now ?? (() => new Date());
  let state = progress.state;
  let refusedDecisions = progress.refusedDecisions;
  const applied: ReviewAuditEntry[] = [];
  const rejected: ReviewRejection[] = [];
  for (const decision of decisions) {
    const result = applyHumanReviewDecision(state, decision);
    if (result.ok) {
      state = result.state;
      applied.push(result.auditEntry);
    } else {
      refusedDecisions = recordRefusedDecision(refusedDecisions, decision, result.rejection, now());
      rejected.push(result.rejection);
    }
  }
  return { state, refusedDecisions, applied, rejected };
}

function validResearchRefusal(entry: unknown, index: number): boolean {
  const reviewer = isObject(entry) ? entry.reviewer : undefined;
  return isObject(entry) && Object.keys(entry).sort().join() === REFUSAL_KEYS &&
    entry.sequence === index + 1 &&
    typeof entry.recordedAt === "string" && ISO_UTC.test(entry.recordedAt) &&
    storedText(entry.reviewId, MAX_ID_LENGTH) && storedText(entry.decisionId, MAX_ID_LENGTH) &&
    (entry.source === null || hasKey(REVIEW_SOURCES, entry.source)) &&
    (entry.action === null || hasKey(REVIEW_ACTIONS, entry.action)) &&
    storedText(entry.field, MAX_ID_LENGTH) && storedText(entry.proposalId, MAX_ID_LENGTH) &&
    validStoredReviewer(reviewer) &&
    (entry.reviewedAt === null || (typeof entry.reviewedAt === "string" && ISO_UTC.test(entry.reviewedAt))) &&
    storedText(entry.submittedValue, MAX_REFUSAL_VALUE) && storedText(entry.note, MAX_REFUSAL_TEXT) &&
    hasKey(REJECTION_CODES, entry.code) && storedText(entry.message, MAX_REFUSAL_TEXT, false);
}

function validStoredReviewer(reviewer: unknown): boolean {
  return reviewer === null || (isObject(reviewer) && Object.keys(reviewer).sort().join() === "displayName,reviewerId" &&
    storedText(reviewer.reviewerId, MAX_ID_LENGTH, false) && storedText(reviewer.displayName, MAX_ID_LENGTH));
}

/** Structural and privacy checks for a stored refusal log; returns a frozen copy. */
export function verifyRefusalLog(input: unknown): Verified<RefusedReviewDecision[]> {
  if (!Array.isArray(input)) return fail("INVALID_STATE", "The refused decision log must be a list.");
  for (const [index, entry] of input.entries()) {
    if (!validResearchRefusal(entry, index)) {
      return fail("INVALID_STATE", `Refused decision ${index + 1} is malformed or out of sequence.`);
    }
  }
  return { ok: true, value: deepFreeze(JSON.parse(JSON.stringify(input)) as RefusedReviewDecision[]) };
}

const GAP_REJECTION_CODES: Record<HumanGapRejectionCode, true> = {
  INVALID_DECISION: true,
  DUPLICATE_REVIEW: true,
  MISMATCHED_DECISION: true,
  STALE_DECISION: true,
  ALREADY_DECIDED: true,
  ACTION_NOT_ALLOWED: true,
  NOTE_REQUIRED: true,
  ACKNOWLEDGEMENT_REQUIRED: true,
  INVALID_VALUE: true,
  PROVENANCE_REQUIRED: true
};
const GAP_ACTIONS = Object.fromEntries(HUMAN_GAP_ACTIONS.map((action) => [action, true])) as
  Record<HumanGapAction["action"], true>;
const GAP_FIELDS = Object.fromEntries(HUMAN_GAP_SETTABLE_FIELDS.map((field) => [field, true])) as
  Record<string, true>;
const CONTACT_FIELDS = new Set(["submitterName", "email", "company", "phone"]);
const MAX_GAP_ID_LENGTH = 600;
const MANUAL_REFUSAL_KEYS = [
  "action", "code", "field", "gapId", "kind", "message", "note", "recordedAt",
  "reviewId", "reviewedAt", "reviewer", "sequence", "submittedValue"
].join();

function refusedSubmittedValue(action: Record<string, unknown>): string | null {
  switch (action.action) {
    case "SET_FIELD":
      if (typeof action.value !== "string") return null;
      return typeof action.field === "string" && CONTACT_FIELDS.has(action.field)
        ? "[redacted contact information]"
        : redactedText(action.value, MAX_REFUSAL_VALUE);
    case "CONFIRM_ARTIST":
      return redactedText(action.exactArtist, MAX_REFUSAL_VALUE);
    case "CONFIRM_AUDIO":
      // Audio is identified by an opaque id, never by its local path.
      return action.audioFileId === null ? "NO_AUDIO" : redactedText(action.audioFileId, MAX_ID_LENGTH);
    default:
      return null;
  }
}

/**
 * Appends a decision MB-09 refused to a combined refusal log and returns the
 * new (deep-frozen) log. Contact values are masked and audio paths never appear.
 */
export function recordRefusedHumanGapDecision(
  log: readonly CombinedRefusedDecision[],
  decision: unknown,
  rejection: HumanGapRejection,
  recordedAt: Date = new Date()
): readonly CombinedRefusedDecision[] {
  if (!isObject(rejection) || !hasKey(GAP_REJECTION_CODES, rejection.code)) {
    throw new Error("A refused gap decision needs an MB-09 rejection.");
  }
  const submitted = isObject(decision) ? decision : {};
  const action = isObject(submitted.action) ? submitted.action : {};
  const reviewer = isObject(submitted.reviewer) && typeof submitted.reviewer.reviewerId === "string"
    ? {
      reviewerId: redactedText(submitted.reviewer.reviewerId, MAX_ID_LENGTH) as string,
      displayName: redactedText(submitted.reviewer.displayName, MAX_ID_LENGTH)
    }
    : null;
  const entry: RefusedHumanGapDecision = {
    kind: "MANUAL",
    sequence: log.length + 1,
    recordedAt: recordedAt.toISOString(),
    reviewId: redactedText(rejection.reviewId ?? submitted.reviewId, MAX_ID_LENGTH),
    gapId: redactedText(submitted.gapId, MAX_GAP_ID_LENGTH),
    action: hasKey(GAP_ACTIONS, action.action) ? action.action : null,
    field: action.action === "SET_FIELD" && hasKey(GAP_FIELDS, action.field) ? action.field : null,
    reviewer,
    reviewedAt: typeof submitted.reviewedAt === "string" && ISO_UTC.test(submitted.reviewedAt)
      ? submitted.reviewedAt
      : null,
    submittedValue: refusedSubmittedValue(action),
    note: redactedText(typeof submitted.note === "string" ? submitted.note.trim() : null, MAX_REFUSAL_TEXT),
    code: rejection.code,
    message: redactedText(rejection.message, MAX_REFUSAL_TEXT) ?? ""
  };
  return deepFreeze([...log, entry]);
}

function validManualRefusal(entry: Record<string, unknown>, index: number): boolean {
  return Object.keys(entry).sort().join() === MANUAL_REFUSAL_KEYS && entry.kind === "MANUAL" &&
    entry.sequence === index + 1 &&
    typeof entry.recordedAt === "string" && ISO_UTC.test(entry.recordedAt) &&
    storedText(entry.reviewId, MAX_ID_LENGTH) && storedText(entry.gapId, MAX_GAP_ID_LENGTH) &&
    (entry.action === null || hasKey(GAP_ACTIONS, entry.action)) &&
    (entry.field === null || hasKey(GAP_FIELDS, entry.field)) &&
    validStoredReviewer(entry.reviewer) &&
    (entry.reviewedAt === null || (typeof entry.reviewedAt === "string" && ISO_UTC.test(entry.reviewedAt))) &&
    storedText(entry.submittedValue, MAX_REFUSAL_VALUE) && storedText(entry.note, MAX_REFUSAL_TEXT) &&
    hasKey(GAP_REJECTION_CODES, entry.code) && storedText(entry.message, MAX_REFUSAL_TEXT, false);
}

/** Structural and privacy checks for a version-2 refusal log (MB-07 and MB-09 refusals). */
export function verifyCombinedRefusalLog(input: unknown): Verified<CombinedRefusedDecision[]> {
  if (!Array.isArray(input)) return fail("INVALID_STATE", "The refused decision log must be a list.");
  for (const [index, entry] of input.entries()) {
    const valid = isObject(entry) && Object.prototype.hasOwnProperty.call(entry, "kind")
      ? validManualRefusal(entry, index)
      : validResearchRefusal(entry, index);
    if (!valid) return fail("INVALID_STATE", `Refused decision ${index + 1} is malformed or out of sequence.`);
  }
  return { ok: true, value: deepFreeze(JSON.parse(JSON.stringify(input)) as CombinedRefusedDecision[]) };
}

export type CombinedReviewProgressBatchResult = CombinedReviewProgress & {
  applied: Array<{ kind: "RESEARCH" | "MANUAL"; reviewId: string; eventSequence: number }>;
  rejected: Array<{ kind: "RESEARCH"; rejection: ReviewRejection } | { kind: "MANUAL"; rejection: HumanGapRejection }>;
};

/**
 * Applies research (MB-07) and manual (MB-09) decisions in the given order and
 * records every refused decision, of either kind, in the combined refusal log.
 */
export function applyCombinedReviewDecisionsWithRefusalLog(
  progress: CombinedReviewProgress,
  items: readonly CombinedReviewItem[],
  options: { now?: () => Date } = {}
): CombinedReviewProgressBatchResult {
  const now = options.now ?? (() => new Date());
  let state = progress.state;
  let refusedDecisions = progress.refusedDecisions;
  const applied: CombinedReviewProgressBatchResult["applied"] = [];
  const rejected: CombinedReviewProgressBatchResult["rejected"] = [];
  for (const item of items) {
    if (item.kind === "RESEARCH") {
      const result = applyResearchReviewDecision(state, item.decision);
      if (!result.ok) {
        refusedDecisions = recordRefusedDecision(
          refusedDecisions as readonly RefusedReviewDecision[], item.decision, result.rejection, now()
        );
        rejected.push({ kind: "RESEARCH", rejection: result.rejection });
        continue;
      }
      state = result.state;
    } else {
      const result = applyHumanGapDecision(state, item.decision);
      if (!result.ok) {
        refusedDecisions = recordRefusedHumanGapDecision(refusedDecisions, item.decision, result.rejection, now());
        rejected.push({ kind: "MANUAL", rejection: result.rejection });
        continue;
      }
      state = result.state;
    }
    const event = state.reviewEvents[state.reviewEvents.length - 1];
    applied.push({ kind: event.kind, reviewId: event.reviewId, eventSequence: event.sequence });
  }
  return { state, refusedDecisions, applied, rejected };
}

/** Parts of a state that never change during review. */
function seedOf(state: HumanReviewState) {
  return {
    recordingId: state.recordingId,
    originalRecording: state.originalRecording,
    decisions: state.decisions.map((item) => item.decision),
    taskFingerprints: state.taskFingerprints,
    audioExtractions: state.audioExtractions
  };
}

/**
 * MB-07 trims a note before redacting it, and redaction turns control
 * characters into spaces. A stored note can therefore end in spaces that a
 * replay would trim away; restoring them as control characters makes the
 * replayed note identical to the stored one.
 */
function replayableNote(note: string): string {
  return note.replace(/^ +| +$/g, (spaces) => "\u0001".repeat(spaces.length));
}

function replayDecision(state: HumanReviewState, entry: ReviewAuditEntry): HumanReviewDecision {
  const linkage = {
    proposalId: entry.proposalId,
    recordingId: entry.recordingId,
    gapId: entry.gapId,
    field: entry.field,
    ...(entry.note !== null ? { note: replayableNote(entry.note) } : {})
  };
  const action = (entry.action === "EDIT_SUGGESTED_VALUE"
    ? { ...linkage, action: entry.action, editedValue: entry.editedValue }
    : { ...linkage, action: entry.action }) as MetadataReviewAction;
  return {
    reviewId: entry.reviewId,
    decisionId: entry.decisionId,
    source: entry.source,
    action,
    reviewer: { reviewerId: entry.reviewer.reviewerId, displayName: entry.reviewer.displayName },
    reviewedAt: entry.reviewedAt,
    basis: {
      identityFingerprint: entry.identityFingerprint,
      currentValue: entry.previousValue,
      findingsDigest: reviewBasisFor(state, entry.decisionId).findingsDigest
    }
  };
}

/**
 * Rebuilds a review state from its original snapshot and pending decisions,
 * replays every audit entry through MB-07, and requires an exact match.
 * Returns the freshly replayed (deep-frozen) state.
 */
export function verifyReviewState(input: unknown): Verified<HumanReviewState> {
  let candidate: HumanReviewState;
  try {
    candidate = JSON.parse(JSON.stringify(input)) as HumanReviewState;
  } catch {
    return fail("INVALID_STATE", "The review state is not serializable.");
  }
  if (!isObject(candidate) || typeof candidate.recordingId !== "string" ||
    !isObject(candidate.originalRecording) || !isObject(candidate.recording) ||
    !Array.isArray(candidate.decisions) || !Array.isArray(candidate.auditTrail) ||
    !Array.isArray(candidate.audioExtractions) || !isObject(candidate.taskFingerprints) ||
    !candidate.decisions.every((item) => isObject(item) && isObject(item.decision)) ||
    !candidate.auditTrail.every(isObject)) {
    return fail("INVALID_STATE", "The review state is missing required MB-07 sections.");
  }

  try {
    const source: HumanReviewSource = {
      recording: candidate.originalRecording,
      metadataDecisions: candidate.decisions.map((item) => item.decision),
      researchTasks: Object.entries(candidate.taskFingerprints)
        .map(([taskId, identityFingerprint]) => ({ taskId, identityFingerprint }))
    };
    let replayed = startHumanReview(source, candidate.audioExtractions, {
      currentRecording: candidate.originalRecording
    });
    for (const [index, entry] of candidate.auditTrail.entries()) {
      if (entry.sequence !== index + 1) {
        return fail("INVALID_STATE", `Audit entry ${index + 1} is out of sequence.`);
      }
      const result = applyHumanReviewDecision(replayed, replayDecision(replayed, entry));
      if (!result.ok) {
        return fail("INVALID_STATE",
          `Audit entry ${index + 1} is not a valid MB-07 review decision (${result.rejection.code}).`);
      }
      replayed = result.state;
    }
    if (canonicalJson(replayed) !== canonicalJson(candidate)) {
      return fail("INVALID_STATE", "The review state does not match its own audit history.");
    }
    return { ok: true, value: replayed };
  } catch {
    return fail("INVALID_STATE", "The review state could not be replayed under MB-07 rules.");
  }
}

function decodeEnvelope(
  text: string,
  expectedRecordingId: string | null,
  integrityKey: Buffer | null
): Verified<StoredReviewSession> {
  const parsed = parseDocument(text);
  if (!parsed.ok) return parsed;
  if (parsed.value.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    return fail("INCOMPATIBLE_VERSION",
      "The saved review session uses schema version 2 (MB-09 combined review); use loadCombined and saveCombined.");
  }
  return decodeV1(parsed.value, expectedRecordingId, integrityKey);
}

function parseDocument(text: string): Verified<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("CORRUPTED_DATA", "The saved review session is not valid JSON.");
  }
  if (!isObject(parsed)) return fail("CORRUPTED_DATA", "The saved review session is not an object.");
  if (parsed.format !== REVIEW_SESSION_FORMAT) {
    return fail("INCOMPATIBLE_VERSION", "The saved document is not a Mediabase review session.");
  }
  if (parsed.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION &&
    parsed.schemaVersion !== COMBINED_REVIEW_SESSION_SCHEMA_VERSION) {
    return fail("INCOMPATIBLE_VERSION", "The saved review session uses an unsupported schema version.");
  }
  return { ok: true, value: parsed };
}

function decodeV1(
  parsed: Record<string, unknown>,
  expectedRecordingId: string | null,
  integrityKey: Buffer | null
): Verified<StoredReviewSession> {
  const envelope = parsed as Partial<Envelope>;
  if (typeof envelope.recordingId !== "string" || !Number.isSafeInteger(envelope.revision) ||
    (envelope.revision as number) < 1 || typeof envelope.savedAt !== "string" || !ISO_UTC.test(envelope.savedAt) ||
    (envelope.savedBy !== null && !safeIdentifier(envelope.savedBy)) ||
    typeof envelope.contentDigest !== "string" || !Number.isSafeInteger(envelope.auditEntries) ||
    !Number.isSafeInteger(envelope.refusedDecisionCount) ||
    !isObject(envelope.state) || !Array.isArray(envelope.refusedDecisions)) {
    return fail("CORRUPTED_DATA", "The saved review session header is incomplete or malformed.");
  }
  if (reviewSessionDigest(envelope.state as HumanReviewState, envelope.refusedDecisions) !== envelope.contentDigest) {
    return fail("CORRUPTED_DATA", "The saved review session failed its checksum.");
  }
  if (integrityKey !== null) {
    const expected = Buffer.from(sign(envelope as Envelope, integrityKey), "utf8");
    const actual = Buffer.from(typeof envelope.signature === "string" ? envelope.signature : "", "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return fail("INTEGRITY_CHECK_FAILED", "The saved review session signature is missing or invalid.");
    }
  }
  if ((expectedRecordingId !== null && envelope.recordingId !== expectedRecordingId) ||
    envelope.state.recordingId !== envelope.recordingId ||
    !Array.isArray(envelope.state.auditTrail) || envelope.state.auditTrail.length !== envelope.auditEntries ||
    envelope.refusedDecisions.length !== envelope.refusedDecisionCount) {
    return fail("INTEGRITY_CHECK_FAILED", "The saved review session does not belong to this recording.");
  }
  const verified = verifyReviewState(envelope.state);
  if (!verified.ok) return fail("INTEGRITY_CHECK_FAILED", verified.message);
  const refusals = verifyRefusalLog(envelope.refusedDecisions);
  if (!refusals.ok) return fail("INTEGRITY_CHECK_FAILED", refusals.message);
  return {
    ok: true,
    value: deepFreeze({
      recordingId: envelope.recordingId,
      revision: envelope.revision as number,
      savedAt: envelope.savedAt,
      savedBy: envelope.savedBy ?? null,
      state: verified.value,
      refusedDecisions: refusals.value
    })
  };
}

function hasResearchSections(candidate: unknown): candidate is HumanReviewState {
  return isObject(candidate) && typeof candidate.recordingId === "string" &&
    isObject(candidate.originalRecording) && isObject(candidate.recording) &&
    Array.isArray(candidate.decisions) && Array.isArray(candidate.auditTrail) &&
    Array.isArray(candidate.audioExtractions) && isObject(candidate.taskFingerprints) &&
    candidate.decisions.every((item) => isObject(item) && isObject(item.decision)) &&
    candidate.auditTrail.every(isObject);
}

function replayGapDecision(entry: HumanGapAuditEntry): HumanGapDecision {
  return {
    reviewId: entry.reviewId,
    recordingId: entry.recordingId,
    gapId: entry.gapId,
    action: entry.replay,
    reviewer: { reviewerId: entry.reviewer.reviewerId, displayName: entry.reviewer.displayName },
    reviewedAt: entry.reviewedAt,
    basis: { identityFingerprint: entry.identityFingerprint, gapDigest: entry.gapDigest },
    ...(entry.note !== null ? { note: replayableNote(entry.note) } : {})
  };
}

const EVENT_KEYS = "auditSequence,kind,reviewId,sequence";

/**
 * Rebuilds a combined (MB-07 + MB-09) review state from its original snapshot
 * and pending decisions, replays every review event in its recorded order
 * through the same MB-07 and MB-09 rules used originally, and requires an exact
 * match. Returns the freshly replayed (deep-frozen) state.
 */
export function verifyHumanGapReviewState(input: unknown): Verified<HumanGapReviewState> {
  let candidate: HumanGapReviewState;
  try {
    candidate = JSON.parse(JSON.stringify(input)) as HumanGapReviewState;
  } catch {
    return fail("INVALID_STATE", "The review state is not serializable.");
  }
  if (!isObject(candidate) || typeof candidate.recordingId !== "string" ||
    !Array.isArray(candidate.manualAuditTrail) || !Array.isArray(candidate.reviewEvents) ||
    !candidate.manualAuditTrail.every(isObject) || !candidate.reviewEvents.every(isObject) ||
    !hasResearchSections(candidate.research) || candidate.research.recordingId !== candidate.recordingId) {
    return fail("INVALID_STATE", "The review state is missing required MB-07 or MB-09 sections.");
  }
  const research = candidate.research;

  try {
    const source: HumanReviewSource = {
      recording: research.originalRecording,
      metadataDecisions: research.decisions.map((item) => item.decision),
      researchTasks: Object.entries(research.taskFingerprints)
        .map(([taskId, identityFingerprint]) => ({ taskId, identityFingerprint }))
    };
    let replayed = startHumanGapReview(startHumanReview(source, research.audioExtractions, {
      currentRecording: research.originalRecording
    }));
    let researchCount = 0;
    let manualCount = 0;
    for (const [index, event] of candidate.reviewEvents.entries()) {
      const where = `Review event ${index + 1}`;
      if (Object.keys(event).sort().join() !== EVENT_KEYS || event.sequence !== index + 1) {
        return fail("INVALID_STATE", `${where} is malformed or out of sequence.`);
      }
      if (event.kind === "RESEARCH") {
        const entry = research.auditTrail[researchCount];
        if (!entry || entry.sequence !== researchCount + 1 || event.auditSequence !== entry.sequence ||
          event.reviewId !== entry.reviewId) {
          return fail("INVALID_STATE", `${where} does not match the next MB-07 audit entry.`);
        }
        const result = applyResearchReviewDecision(replayed, replayDecision(replayed.research, entry));
        if (!result.ok) {
          return fail("INVALID_STATE", `${where} is not a valid MB-07 review decision (${result.rejection.code}).`);
        }
        replayed = result.state;
        researchCount += 1;
      } else if (event.kind === "MANUAL") {
        const entry = candidate.manualAuditTrail[manualCount];
        if (!entry || entry.sequence !== manualCount + 1 || event.auditSequence !== entry.sequence ||
          entry.eventSequence !== event.sequence ||
          event.reviewId !== entry.reviewId || !isObject(entry.replay) || !isObject(entry.reviewer)) {
          return fail("INVALID_STATE", `${where} does not match the next manual audit entry.`);
        }
        const result = applyHumanGapDecision(replayed, replayGapDecision(entry));
        if (!result.ok) {
          return fail("INVALID_STATE", `${where} is not a valid MB-09 gap decision (${result.rejection.code}).`);
        }
        replayed = result.state;
        manualCount += 1;
      } else {
        return fail("INVALID_STATE", `${where} has an unknown kind.`);
      }
    }
    if (researchCount !== research.auditTrail.length || manualCount !== candidate.manualAuditTrail.length) {
      return fail("INVALID_STATE", "Some audit entries are not part of the review event history.");
    }
    if (canonicalJson(replayed) !== canonicalJson(candidate)) {
      return fail("INVALID_STATE", "The review state does not match its own review history.");
    }
    return { ok: true, value: replayed };
  } catch {
    return fail("INVALID_STATE", "The review state could not be replayed under MB-07 and MB-09 rules.");
  }
}

/** Checksum of a version-2 session: the combined state and its refusal log. */
export function combinedReviewSessionDigest(
  state: Readonly<HumanGapReviewState>,
  refusedDecisions: readonly CombinedRefusedDecision[]
): string {
  return digest({ state, refusedDecisions });
}

const DIGEST_PATTERN = /^SHA256-[0-9a-f]{64}$/;

function validProvenance(value: unknown, revision: number): value is ReviewUpgradeProvenance | null {
  return value === null || (isObject(value) && Object.keys(value).sort().join() === "contentDigest,revision,schemaVersion" &&
    value.schemaVersion === REVIEW_SESSION_SCHEMA_VERSION && Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 && (value.revision as number) < revision &&
    typeof value.contentDigest === "string" && DIGEST_PATTERN.test(value.contentDigest));
}

function decodeV2(
  parsed: Record<string, unknown>,
  expectedRecordingId: string | null,
  integrityKey: Buffer | null
): Verified<StoredCombinedReviewSession> {
  const envelope = parsed as Partial<EnvelopeV2>;
  if (typeof envelope.recordingId !== "string" || !Number.isSafeInteger(envelope.revision) ||
    (envelope.revision as number) < 1 || typeof envelope.savedAt !== "string" || !ISO_UTC.test(envelope.savedAt) ||
    (envelope.savedBy !== null && !safeIdentifier(envelope.savedBy)) ||
    typeof envelope.contentDigest !== "string" || !Number.isSafeInteger(envelope.auditEntries) ||
    !Number.isSafeInteger(envelope.manualAuditEntries) || !Number.isSafeInteger(envelope.reviewEvents) ||
    !Number.isSafeInteger(envelope.refusedDecisionCount) ||
    !validProvenance(envelope.upgradedFrom, envelope.revision as number) ||
    !isObject(envelope.state) || !Array.isArray(envelope.refusedDecisions)) {
    return fail("CORRUPTED_DATA", "The saved review session header is incomplete or malformed.");
  }
  if (combinedReviewSessionDigest(envelope.state as HumanGapReviewState, envelope.refusedDecisions) !==
    envelope.contentDigest) {
    return fail("CORRUPTED_DATA", "The saved review session failed its checksum.");
  }
  if (integrityKey !== null) {
    const expected = Buffer.from(signV2(envelope as EnvelopeV2, integrityKey), "utf8");
    const actual = Buffer.from(typeof envelope.signature === "string" ? envelope.signature : "", "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return fail("INTEGRITY_CHECK_FAILED", "The saved review session signature is missing or invalid.");
    }
  }
  const state = envelope.state as Partial<HumanGapReviewState>;
  if ((expectedRecordingId !== null && envelope.recordingId !== expectedRecordingId) ||
    state.recordingId !== envelope.recordingId ||
    !isObject(state.research) || !Array.isArray(state.research.auditTrail) ||
    state.research.auditTrail.length !== envelope.auditEntries ||
    !Array.isArray(state.manualAuditTrail) || state.manualAuditTrail.length !== envelope.manualAuditEntries ||
    !Array.isArray(state.reviewEvents) || state.reviewEvents.length !== envelope.reviewEvents ||
    envelope.refusedDecisions.length !== envelope.refusedDecisionCount) {
    return fail("INTEGRITY_CHECK_FAILED", "The saved review session does not belong to this recording.");
  }
  const verified = verifyHumanGapReviewState(envelope.state);
  if (!verified.ok) return fail("INTEGRITY_CHECK_FAILED", verified.message);
  const refusals = verifyCombinedRefusalLog(envelope.refusedDecisions);
  if (!refusals.ok) return fail("INTEGRITY_CHECK_FAILED", refusals.message);
  return {
    ok: true,
    value: deepFreeze({
      recordingId: envelope.recordingId,
      schemaVersion: COMBINED_REVIEW_SESSION_SCHEMA_VERSION,
      revision: envelope.revision as number,
      savedAt: envelope.savedAt,
      savedBy: envelope.savedBy ?? null,
      upgradedFrom: envelope.upgradedFrom ?? null,
      state: verified.value,
      refusedDecisions: refusals.value
    })
  };
}

type DecodedDocument =
  | { ok: true; schemaVersion: 1; session: StoredReviewSession }
  | { ok: true; schemaVersion: 2; session: StoredCombinedReviewSession }
  | ({ ok: false } & ReviewStoreError);

/** Decodes and fully verifies a stored session of either supported schema version. */
function decodeDocument(text: string, expectedRecordingId: string | null, integrityKey: Buffer | null): DecodedDocument {
  const parsed = parseDocument(text);
  if (!parsed.ok) return parsed;
  if (parsed.value.schemaVersion === REVIEW_SESSION_SCHEMA_VERSION) {
    const decoded = decodeV1(parsed.value, expectedRecordingId, integrityKey);
    return decoded.ok ? { ok: true, schemaVersion: 1, session: decoded.value } : decoded;
  }
  const decoded = decodeV2(parsed.value, expectedRecordingId, integrityKey);
  return decoded.ok ? { ok: true, schemaVersion: 2, session: decoded.value } : decoded;
}

function storageFailure(error: unknown): { code: ReviewStoreErrorCode; message: string } {
  if (error instanceof ReviewStorageLockedError) return { code: "LOCKED", message: error.message };
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "UNKNOWN";
  // Only the error code is reported, so local paths do not leak into results or logs.
  return { code: "STORAGE_ERROR", message: `The review storage operation failed (${code}).` };
}

export type ReviewSessionStoreOptions = {
  now?: () => Date;
  /**
   * Local secret used to sign saved sessions. Without it, a saved file is
   * checksummed and replay-verified, but someone able to edit the file could
   * rewrite free-text audit fields (notes, reviewer, timestamps) undetected.
   */
  integrityKey?: string | Buffer;
};

function sign(envelope: Envelope, key: Buffer): string {
  const header = {
    format: envelope.format,
    schemaVersion: envelope.schemaVersion,
    recordingId: envelope.recordingId,
    revision: envelope.revision,
    savedAt: envelope.savedAt,
    savedBy: envelope.savedBy,
    auditEntries: envelope.auditEntries,
    refusedDecisionCount: envelope.refusedDecisionCount,
    contentDigest: envelope.contentDigest
  };
  return `HMAC-SHA256-${createHmac("sha256", key).update(canonicalJson(header)).digest("hex")}`;
}

/** Version-2 signature: covers every header field, including the MB-09 counts and upgrade provenance. */
function signV2(envelope: EnvelopeV2, key: Buffer): string {
  const header = {
    format: envelope.format,
    schemaVersion: envelope.schemaVersion,
    recordingId: envelope.recordingId,
    revision: envelope.revision,
    savedAt: envelope.savedAt,
    savedBy: envelope.savedBy,
    auditEntries: envelope.auditEntries,
    manualAuditEntries: envelope.manualAuditEntries,
    reviewEvents: envelope.reviewEvents,
    refusedDecisionCount: envelope.refusedDecisionCount,
    upgradedFrom: envelope.upgradedFrom,
    contentDigest: envelope.contentDigest
  };
  return `HMAC-SHA256-${createHmac("sha256", key).update(canonicalJson(header)).digest("hex")}`;
}

export function createReviewSessionStore(
  backend: ReviewStorageBackend,
  options: ReviewSessionStoreOptions = {}
): ReviewSessionStore {
  const now = options.now ?? (() => new Date());
  const integrityKey = options.integrityKey === undefined ? null : Buffer.from(options.integrityKey);
  if (integrityKey !== null && integrityKey.length < 16) {
    throw new Error("The review store integrity key must be at least 16 bytes.");
  }

  return {
    async load(recordingId) {
      if (typeof recordingId !== "string" || recordingId.length === 0) {
        return fail("INVALID_REQUEST", "A recording identifier is required.");
      }
      let text: string | null;
      try {
        text = await backend.read(reviewStorageKey(recordingId));
      } catch (error) {
        return { ok: false, ...storageFailure(error) };
      }
      if (text === null) return fail("NOT_FOUND", "No saved review session exists for this recording.");
      const decoded = decodeEnvelope(text, recordingId, integrityKey);
      return decoded.ok ? { ok: true, session: decoded.value } : decoded;
    },

    async save(state, saveOptions) {
      const reject = (code: ReviewStoreErrorCode, message: string, currentRevision: number | null = null) =>
        ({ ok: false as const, code, message, currentRevision });
      if (!isObject(saveOptions) || !Number.isSafeInteger(saveOptions.expectedRevision) ||
        saveOptions.expectedRevision < 0) {
        return reject("INVALID_REQUEST", "expectedRevision must be the loaded revision, or 0 for a new session.");
      }
      if (saveOptions.sessionId !== undefined && !safeIdentifier(saveOptions.sessionId)) {
        return reject("INVALID_REQUEST", "The session identifier is invalid.");
      }
      const verified = verifyReviewState(state);
      if (!verified.ok) return reject(verified.code, verified.message);
      const next = verified.value;
      let submittedRefusals: readonly RefusedReviewDecision[] | null = null;
      if (saveOptions.refusedDecisions !== undefined) {
        const refusals = verifyRefusalLog(saveOptions.refusedDecisions);
        if (!refusals.ok) return reject(refusals.code, refusals.message);
        submittedRefusals = refusals.value;
      }
      const key = reviewStorageKey(next.recordingId);

      try {
        return await backend.withLock(key, async (): Promise<ReviewSaveResult> => {
          const text = await backend.read(key);
          let existing: StoredReviewSession | null = null;
          if (text !== null) {
            const decoded = decodeEnvelope(text, next.recordingId, integrityKey);
            if (!decoded.ok) {
              return reject(decoded.code,
                `${decoded.message} The stored session was left untouched; resolve it before saving.`);
            }
            existing = decoded.value;
          }
          const currentRevision = existing?.revision ?? 0;
          if (saveOptions.expectedRevision !== currentRevision) {
            return reject("REVISION_CONFLICT",
              `This session was loaded at revision ${saveOptions.expectedRevision}, but revision ${currentRevision} ` +
              "is now saved. Load the latest session and re-apply any new decisions.", currentRevision);
          }
          const nextRefusals = submittedRefusals ?? existing?.refusedDecisions ?? deepFreeze([]);
          if (existing) {
            const previous = existing.state;
            const isPrefix = <T>(before: readonly T[], after: readonly T[]) => before.length <= after.length &&
              before.every((entry, index) => canonicalJson(entry) === canonicalJson(after[index]));
            if (canonicalJson(seedOf(previous)) !== canonicalJson(seedOf(next)) ||
              !isPrefix(previous.auditTrail, next.auditTrail) ||
              !isPrefix(existing.refusedDecisions, nextRefusals)) {
              return reject("HISTORY_REWRITE",
                "Saved audit entries and refused decisions are append-only and the original snapshot cannot change.",
                currentRevision);
            }
            if (previous.auditTrail.length === next.auditTrail.length &&
              existing.refusedDecisions.length === nextRefusals.length) {
              return { ok: true, session: existing, unchanged: true };
            }
          }

          const envelope: Envelope = {
            format: REVIEW_SESSION_FORMAT,
            schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
            recordingId: next.recordingId,
            revision: currentRevision + 1,
            savedAt: now().toISOString(),
            savedBy: saveOptions.sessionId ?? null,
            auditEntries: next.auditTrail.length,
            refusedDecisionCount: nextRefusals.length,
            contentDigest: reviewSessionDigest(next, nextRefusals),
            signature: null,
            state: next,
            refusedDecisions: [...nextRefusals]
          };
          if (integrityKey !== null) envelope.signature = sign(envelope, integrityKey);
          await backend.replace(key, `${JSON.stringify(envelope, null, 2)}\n`);
          return {
            ok: true,
            unchanged: false,
            session: deepFreeze({
              recordingId: envelope.recordingId,
              revision: envelope.revision,
              savedAt: envelope.savedAt,
              savedBy: envelope.savedBy,
              state: next,
              refusedDecisions: nextRefusals
            })
          };
        });
      } catch (error) {
        const failure = storageFailure(error);
        return reject(failure.code, failure.message);
      }
    },

    async list() {
      let keys: string[];
      try {
        keys = await backend.keys();
      } catch (error) {
        return [{ ok: false, key: "", ...storageFailure(error) }];
      }
      const entries: ReviewListEntry[] = [];
      for (const key of keys) {
        try {
          const text = await backend.read(key);
          if (text === null) continue;
          const decoded = decodeDocument(text, null, integrityKey);
          if (!decoded.ok || reviewStorageKey(decoded.session.recordingId) !== key) {
            entries.push(decoded.ok
              ? { ok: false, key, code: "INTEGRITY_CHECK_FAILED", message: "The document is stored under the wrong key." }
              : { ok: false, key, code: decoded.code, message: decoded.message });
            continue;
          }
          const session = decoded.session;
          const research = decoded.schemaVersion === 1 ? decoded.session.state : decoded.session.state.research;
          entries.push({
            ok: true,
            recordingId: session.recordingId,
            schemaVersion: decoded.schemaVersion,
            revision: session.revision,
            savedAt: session.savedAt,
            savedBy: session.savedBy,
            auditEntries: research.auditTrail.length,
            manualAuditEntries: decoded.schemaVersion === 1 ? 0 : decoded.session.state.manualAuditTrail.length,
            refusedDecisions: session.refusedDecisions.length,
            researchReview: research.researchReview,
            approvalStatus: research.recording.approvalStatus
          });
        } catch (error) {
          entries.push({ ok: false, key, ...storageFailure(error) });
        }
      }
      return entries;
    },

    async loadCombined(recordingId) {
      if (typeof recordingId !== "string" || recordingId.length === 0) {
        return fail("INVALID_REQUEST", "A recording identifier is required.");
      }
      let text: string | null;
      try {
        text = await backend.read(reviewStorageKey(recordingId));
      } catch (error) {
        return { ok: false, ...storageFailure(error) };
      }
      if (text === null) return fail("NOT_FOUND", "No saved review session exists for this recording.");
      const decoded = decodeDocument(text, recordingId, integrityKey);
      if (!decoded.ok) return decoded;
      if (decoded.schemaVersion === 1) {
        return fail("UPGRADE_REQUIRED",
          `This is a verified version-1 session at revision ${decoded.session.revision}; upgrade it explicitly before manual gap review.`);
      }
      return { ok: true, session: decoded.session };
    },

    async saveCombined(state, saveOptions) {
      const reject = (code: ReviewStoreErrorCode, message: string, currentRevision: number | null = null) =>
        ({ ok: false as const, code, message, currentRevision });
      if (!isObject(saveOptions) || !Number.isSafeInteger(saveOptions.expectedRevision) ||
        saveOptions.expectedRevision < 0) {
        return reject("INVALID_REQUEST", "expectedRevision must be the loaded revision, or 0 for a new session.");
      }
      if (saveOptions.sessionId !== undefined && !safeIdentifier(saveOptions.sessionId)) {
        return reject("INVALID_REQUEST", "The session identifier is invalid.");
      }
      const verified = verifyHumanGapReviewState(state);
      if (!verified.ok) return reject(verified.code, verified.message);
      const next = verified.value;
      let submittedRefusals: readonly CombinedRefusedDecision[] | null = null;
      if (saveOptions.refusedDecisions !== undefined) {
        const refusals = verifyCombinedRefusalLog(saveOptions.refusedDecisions);
        if (!refusals.ok) return reject(refusals.code, refusals.message);
        submittedRefusals = refusals.value;
      }
      const key = reviewStorageKey(next.recordingId);

      try {
        return await backend.withLock(key, async (): Promise<CombinedReviewSaveResult> => {
          const text = await backend.read(key);
          let existing: StoredCombinedReviewSession | null = null;
          if (text !== null) {
            const decoded = decodeDocument(text, next.recordingId, integrityKey);
            if (!decoded.ok) {
              return reject(decoded.code,
                `${decoded.message} The stored session was left untouched; resolve it before saving.`);
            }
            if (decoded.schemaVersion === 1) {
              return reject("UPGRADE_REQUIRED",
                "A version-1 session is stored for this recording; upgrade it explicitly before saving a combined session.",
                decoded.session.revision);
            }
            existing = decoded.session;
          }
          const currentRevision = existing?.revision ?? 0;
          if (saveOptions.expectedRevision !== currentRevision) {
            return reject("REVISION_CONFLICT",
              `This session was loaded at revision ${saveOptions.expectedRevision}, but revision ${currentRevision} ` +
              "is now saved. Load the latest session and re-apply any new decisions.", currentRevision);
          }
          const nextRefusals = submittedRefusals ?? existing?.refusedDecisions ?? deepFreeze([]);
          if (existing) {
            const previous = existing.state;
            if (canonicalJson(seedOf(previous.research)) !== canonicalJson(seedOf(next.research)) ||
              !isPrefix(previous.research.auditTrail, next.research.auditTrail) ||
              !isPrefix(previous.manualAuditTrail, next.manualAuditTrail) ||
              !isPrefix(previous.reviewEvents, next.reviewEvents) ||
              !isPrefix(existing.refusedDecisions, nextRefusals)) {
              return reject("HISTORY_REWRITE",
                "Saved review events, audit entries, and refused decisions are append-only and the original snapshot cannot change.",
                currentRevision);
            }
            if (previous.reviewEvents.length === next.reviewEvents.length &&
              existing.refusedDecisions.length === nextRefusals.length) {
              return { ok: true, session: existing, unchanged: true };
            }
          }
          return writeCombined(key, next, nextRefusals, currentRevision, saveOptions.sessionId ?? null,
            existing?.upgradedFrom ?? null);
        });
      } catch (error) {
        const failure = storageFailure(error);
        return reject(failure.code, failure.message);
      }
    },

    async upgrade(recordingId, upgradeOptions) {
      const reject = (code: ReviewStoreErrorCode, message: string, currentRevision: number | null = null) =>
        ({ ok: false as const, code, message, currentRevision });
      if (typeof recordingId !== "string" || recordingId.length === 0) {
        return reject("INVALID_REQUEST", "A recording identifier is required.");
      }
      if (!isObject(upgradeOptions) || !Number.isSafeInteger(upgradeOptions.expectedRevision) ||
        upgradeOptions.expectedRevision < 1) {
        return reject("INVALID_REQUEST", "expectedRevision must be the loaded version-1 revision.");
      }
      if (upgradeOptions.sessionId !== undefined && !safeIdentifier(upgradeOptions.sessionId)) {
        return reject("INVALID_REQUEST", "The session identifier is invalid.");
      }
      const key = reviewStorageKey(recordingId);
      try {
        return await backend.withLock(key, async (): Promise<CombinedReviewSaveResult> => {
          const text = await backend.read(key);
          if (text === null) return reject("NOT_FOUND", "No saved review session exists for this recording.");
          const decoded = decodeDocument(text, recordingId, integrityKey);
          if (!decoded.ok) {
            return reject(decoded.code, `${decoded.message} The stored session was left untouched.`);
          }
          if (upgradeOptions.expectedRevision !== decoded.session.revision) {
            return reject("REVISION_CONFLICT",
              `This session was loaded at revision ${upgradeOptions.expectedRevision}, but revision ` +
              `${decoded.session.revision} is now saved. Load the latest session before upgrading.`,
              decoded.session.revision);
          }
          if (decoded.schemaVersion === 2) return { ok: true, session: decoded.session, unchanged: true };

          const v1 = decoded.session;
          // The version-1 history becomes the first events; the replay check proves nothing was reinterpreted.
          const combined = verifyHumanGapReviewState(startHumanGapReview(v1.state));
          if (!combined.ok || canonicalJson(combined.value.research) !== canonicalJson(v1.state)) {
            return reject("INVALID_STATE", "The version-1 session could not be upgraded without changing its history.",
              v1.revision);
          }
          return writeCombined(key, combined.value, v1.refusedDecisions, v1.revision,
            upgradeOptions.sessionId ?? null, {
              schemaVersion: REVIEW_SESSION_SCHEMA_VERSION,
              revision: v1.revision,
              contentDigest: reviewSessionDigest(v1.state, v1.refusedDecisions)
            });
        });
      } catch (error) {
        const failure = storageFailure(error);
        return reject(failure.code, failure.message);
      }
    }
  };

  async function writeCombined(
    key: string,
    state: HumanGapReviewState,
    refusedDecisions: readonly CombinedRefusedDecision[],
    currentRevision: number,
    savedBy: string | null,
    upgradedFrom: ReviewUpgradeProvenance | null
  ): Promise<CombinedReviewSaveResult> {
    const envelope: EnvelopeV2 = {
      format: REVIEW_SESSION_FORMAT,
      schemaVersion: COMBINED_REVIEW_SESSION_SCHEMA_VERSION,
      recordingId: state.recordingId,
      revision: currentRevision + 1,
      savedAt: now().toISOString(),
      savedBy,
      auditEntries: state.research.auditTrail.length,
      manualAuditEntries: state.manualAuditTrail.length,
      reviewEvents: state.reviewEvents.length,
      refusedDecisionCount: refusedDecisions.length,
      upgradedFrom,
      contentDigest: combinedReviewSessionDigest(state, refusedDecisions),
      signature: null,
      state,
      refusedDecisions: [...refusedDecisions]
    };
    if (integrityKey !== null) envelope.signature = signV2(envelope, integrityKey);
    await backend.replace(key, `${JSON.stringify(envelope, null, 2)}\n`);
    return {
      ok: true,
      unchanged: false,
      session: deepFreeze({
        recordingId: envelope.recordingId,
        schemaVersion: COMBINED_REVIEW_SESSION_SCHEMA_VERSION,
        revision: envelope.revision,
        savedAt: envelope.savedAt,
        savedBy: envelope.savedBy,
        upgradedFrom,
        state,
        refusedDecisions
      })
    };
  }
}

function isPrefix<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.length <= after.length &&
    before.every((entry, index) => canonicalJson(entry) === canonicalJson(after[index]));
}
