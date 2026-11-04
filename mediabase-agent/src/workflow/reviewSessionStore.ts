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
export const REVIEW_SESSION_SCHEMA_VERSION = 1;

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
  revision: number;
  savedAt: string;
  savedBy: string | null;
  auditEntries: number;
  refusedDecisions: number;
  researchReview: HumanReviewState["researchReview"];
  approvalStatus: HumanReviewState["recording"]["approvalStatus"];
};

export type ReviewStoreErrorCode =
  | "NOT_FOUND"
  | "CORRUPTED_DATA"
  | "INCOMPATIBLE_VERSION"
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

export interface ReviewSessionStore {
  load(recordingId: string): Promise<ReviewLoadResult>;
  save(state: Readonly<HumanReviewState>, options: ReviewSaveOptions): Promise<ReviewSaveResult>;
  /** Summaries only; recording contents, contact details, and paths are not included. */
  list(): Promise<ReviewListEntry[]>;
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

/** Structural and privacy checks for a stored refusal log; returns a frozen copy. */
export function verifyRefusalLog(input: unknown): Verified<RefusedReviewDecision[]> {
  if (!Array.isArray(input)) return fail("INVALID_STATE", "The refused decision log must be a list.");
  for (const [index, entry] of input.entries()) {
    const reviewer = isObject(entry) ? entry.reviewer : undefined;
    const valid = isObject(entry) && Object.keys(entry).sort().join() === REFUSAL_KEYS &&
      entry.sequence === index + 1 &&
      typeof entry.recordedAt === "string" && ISO_UTC.test(entry.recordedAt) &&
      storedText(entry.reviewId, MAX_ID_LENGTH) && storedText(entry.decisionId, MAX_ID_LENGTH) &&
      (entry.source === null || hasKey(REVIEW_SOURCES, entry.source)) &&
      (entry.action === null || hasKey(REVIEW_ACTIONS, entry.action)) &&
      storedText(entry.field, MAX_ID_LENGTH) && storedText(entry.proposalId, MAX_ID_LENGTH) &&
      (reviewer === null || (isObject(reviewer) && Object.keys(reviewer).sort().join() === "displayName,reviewerId" &&
        storedText(reviewer.reviewerId, MAX_ID_LENGTH, false) && storedText(reviewer.displayName, MAX_ID_LENGTH))) &&
      (entry.reviewedAt === null || (typeof entry.reviewedAt === "string" && ISO_UTC.test(entry.reviewedAt))) &&
      storedText(entry.submittedValue, MAX_REFUSAL_VALUE) && storedText(entry.note, MAX_REFUSAL_TEXT) &&
      hasKey(REJECTION_CODES, entry.code) && storedText(entry.message, MAX_REFUSAL_TEXT, false);
    if (!valid) return fail("INVALID_STATE", `Refused decision ${index + 1} is malformed or out of sequence.`);
  }
  return { ok: true, value: deepFreeze(JSON.parse(JSON.stringify(input)) as RefusedReviewDecision[]) };
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
  if (parsed.schemaVersion !== REVIEW_SESSION_SCHEMA_VERSION) {
    return fail("INCOMPATIBLE_VERSION", "The saved review session uses an unsupported schema version.");
  }
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
          const decoded = decodeEnvelope(text, null, integrityKey);
          if (!decoded.ok || reviewStorageKey(decoded.value.recordingId) !== key) {
            entries.push(decoded.ok
              ? { ok: false, key, code: "INTEGRITY_CHECK_FAILED", message: "The document is stored under the wrong key." }
              : { ok: false, key, code: decoded.code, message: decoded.message });
            continue;
          }
          const { state, refusedDecisions, ...header } = decoded.value;
          entries.push({
            ok: true,
            ...header,
            auditEntries: state.auditTrail.length,
            refusedDecisions: refusedDecisions.length,
            researchReview: state.researchReview,
            approvalStatus: state.recording.approvalStatus
          });
        } catch (error) {
          entries.push({ ok: false, key, ...storageFailure(error) });
        }
      }
      return entries;
    }
  };
}
