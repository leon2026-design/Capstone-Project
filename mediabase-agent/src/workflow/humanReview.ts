import { createHash } from "node:crypto";
import { matchAudioToRecording, type AudioMatchResult } from "../audio/audioMatcher";
import { normalizeIsrcValue, type AudioExtractionResult } from "../audio/audioMetadata";
import {
  analyzeMetadataGaps,
  isValidUpc,
  type MetadataGapReport
} from "../metadata/metadataGapAnalyzer";
import {
  RESEARCH_FIELDS,
  recordingIdentityFingerprint,
  redactResearchText,
  type MetadataReviewAction,
  type ProposalEvidence,
  type ResearchField
} from "../metadata/metadataResearch";
import { isValidDate, type DemoRecording } from "../metadata/recordValidation";
import type { PendingMetadataDecision, WorkflowFinding } from "./consolidateProposals";
import type { RecordingWorkflowResult } from "./recordingWorkflow";

/**
 * MB-07: human review of MB-06 pending metadata decisions.
 *
 * Every function is pure: inputs are never mutated and every returned state is
 * a new deeply frozen snapshot. Research review only changes the reviewed
 * field; it never approves a recording, submits anything, or contacts
 * Mediabase. Final approval remains `reviewAndApproveRecord`.
 */

/** The parts of an MB-06 result review starts from; a full `RecordingWorkflowResult` satisfies it. */
export type HumanReviewSource = Pick<RecordingWorkflowResult, "recording" | "metadataDecisions"> & {
  researchTasks: readonly Pick<RecordingWorkflowResult["researchTasks"][number], "taskId" | "identityFingerprint">[];
};

export type ReviewerIdentity = {
  reviewerId: string;
  displayName?: string | null;
};

/** What the reviewer saw; any difference from the current state makes a decision stale. */
export type ReviewBasis = {
  identityFingerprint: string;
  currentValue: string | null;
  findingsDigest: string;
};

export type HumanReviewDecision = {
  /** Unique per submitted decision; replaying the same id is rejected. */
  reviewId: string;
  /** MB-06 `PendingMetadataDecision.decisionId`. */
  decisionId: string;
  /** MusicBrainz and research proposals for one task share a proposalId. */
  source: WorkflowFinding["source"];
  action: MetadataReviewAction;
  reviewer: ReviewerIdentity;
  /** ISO 8601 UTC timestamp supplied by the review interface. */
  reviewedAt: string;
  basis: ReviewBasis;
};

export type FindingReviewStatus = "PENDING_REVIEW" | "DEFERRED" | "REJECTED" | "APPROVED" | "EDITED";

export type DecisionReviewStatus =
  | "PENDING_REVIEW"
  | "DEFERRED"
  | "VALUE_ACCEPTED"
  | "ALL_SUGGESTIONS_REJECTED";

export type FindingReview = {
  source: WorkflowFinding["source"];
  proposalId: string;
  status: FindingReviewStatus;
};

export type MetadataDecisionReview = {
  /** The MB-06 decision exactly as produced, including all evidence and source URLs. */
  decision: PendingMetadataDecision;
  status: DecisionReviewStatus;
  acceptedValue: string | null;
  findingReviews: FindingReview[];
};

export type ReviewAuditEvidence = ProposalEvidence & {
  source: WorkflowFinding["source"];
  proposalId: string;
  role: "SUPPORTING" | "CONFLICTING";
};

export type ReviewAuditEntry = {
  sequence: number;
  reviewId: string;
  reviewer: { reviewerId: string; displayName: string | null };
  reviewedAt: string;
  action: MetadataReviewAction["action"];
  outcome: "VALUE_APPLIED" | "SUGGESTION_REJECTED" | "DECISION_DEFERRED";
  recordingId: string;
  decisionId: string;
  proposalId: string;
  source: WorkflowFinding["source"];
  taskId: string;
  gapId: string;
  field: ResearchField;
  assessment: PendingMetadataDecision["assessment"];
  candidateValues: string[];
  suggestedValue: string | null;
  editedValue: string | null;
  /** Where an applied value came from; null when nothing was applied. */
  valueOrigin: "SUGGESTED_VALUE" | "EVIDENCE_CANDIDATE" | "REVIEWER_ENTERED" | null;
  previousValue: string | null;
  resultingValue: string | null;
  previousApprovalStatus: DemoRecording["approvalStatus"];
  resultingApprovalStatus: DemoRecording["approvalStatus"];
  identityFingerprint: string;
  /** Every evidence item of the decision the reviewer considered, across all findings. */
  evidence: ReviewAuditEvidence[];
  note: string | null;
};

export type HumanReviewState = {
  recordingId: string;
  /** Snapshot reviewed by MB-06; never changed by review. */
  originalRecording: DemoRecording;
  /** Latest snapshot with accepted values applied. */
  recording: DemoRecording;
  identityFingerprint: string;
  audioMatch: AudioMatchResult;
  /** Recalculated after every applied value. */
  gapReport: MetadataGapReport;
  decisions: MetadataDecisionReview[];
  auditTrail: ReviewAuditEntry[];
  researchReview: {
    status: "IN_PROGRESS" | "COMPLETE";
    pending: number;
    deferred: number;
    accepted: number;
    rejected: number;
  };
  /** Research review never approves; final approval is a separate explicit step. */
  recordingApprovalRequired: boolean;
  /** Local evidence needed to recalculate the audio match and gaps. */
  audioExtractions: AudioExtractionResult[];
  /** Identity snapshot each research task (and its proposals) was produced for. */
  taskFingerprints: Record<string, string>;
};

export type ReviewRejectionCode =
  | "INVALID_DECISION"
  | "DUPLICATE_REVIEW"
  | "UNKNOWN_DECISION"
  | "MISMATCHED_DECISION"
  | "STALE_DECISION"
  | "ALREADY_DECIDED"
  | "CONFLICT_REQUIRES_EXPLICIT_RESOLUTION"
  | "NOTE_REQUIRED"
  | "NO_VERIFIED_SUGGESTION"
  | "INVALID_VALUE";

export type ReviewRejection = {
  reviewId: string | null;
  code: ReviewRejectionCode;
  message: string;
};

export type HumanReviewResult =
  | { ok: true; state: HumanReviewState; auditEntry: ReviewAuditEntry }
  | { ok: false; state: HumanReviewState; rejection: ReviewRejection };

export type PendingReviewBatchResult = {
  state: HumanReviewState;
  applied: ReviewAuditEntry[];
  rejected: ReviewRejection[];
};

const ACTIONS = ["APPROVE_SUGGESTED_VALUE", "EDIT_SUGGESTED_VALUE", "REJECT_SUGGESTION", "DEFER_DECISION"] as const;
const SOURCES = ["MUSICBRAINZ", "RESEARCH"] as const;
const MAX_ID_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;
const MAX_VALUE_LENGTH = 500;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH && !CONTROL.test(value);
}

function fieldValue(record: DemoRecording, field: ResearchField): string | null {
  return record[field] ?? null;
}

function findingKey(source: string, proposalId: string): string {
  return JSON.stringify([source, proposalId]);
}

function findingsDigest(decision: PendingMetadataDecision): string {
  const content = JSON.stringify([decision.decisionId, decision.candidateValues, decision.findings]);
  return `FINDINGS-${createHash("sha256").update(content).digest("hex").slice(0, 16).toUpperCase()}`;
}

/** Applies the existing ISRC, date, and UPC rules. Returns an error message or null. */
export function validateReviewedValue(field: ResearchField, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    return `A ${field} value is required.`;
  }
  if (value !== value.trim() || value.length > MAX_VALUE_LENGTH || CONTROL.test(value)) {
    return `The ${field} value has surrounding whitespace, control characters, or is too long.`;
  }
  if (field === "isrc" && normalizeIsrcValue(value) !== value) {
    return "ISRC must have a valid normalized 12-character format (for example USAAA2600010).";
  }
  if ((field === "officialReleaseDate" || field === "albumReleaseDate") && !isValidDate(value)) {
    return `${field} must be a valid mm/dd/yyyy date.`;
  }
  if (field === "albumUPC" && !isValidUpc(value)) {
    return "Album UPC must be 12 or 13 digits with a valid check digit.";
  }
  if (redactResearchText(value) !== value) {
    return `The ${field} value must not contain email addresses or local paths.`;
  }
  return null;
}

function decisionStatus(reviews: readonly FindingReview[]): DecisionReviewStatus {
  if (reviews.some((item) => item.status === "APPROVED" || item.status === "EDITED")) return "VALUE_ACCEPTED";
  if (reviews.every((item) => item.status === "REJECTED")) return "ALL_SUGGESTIONS_REJECTED";
  if (reviews.some((item) => item.status === "DEFERRED")) return "DEFERRED";
  return "PENDING_REVIEW";
}

function summarize(decisions: readonly MetadataDecisionReview[]): HumanReviewState["researchReview"] {
  const count = (status: DecisionReviewStatus) => decisions.filter((item) => item.status === status).length;
  const pending = count("PENDING_REVIEW");
  const deferred = count("DEFERRED");
  return {
    status: pending + deferred === 0 ? "COMPLETE" : "IN_PROGRESS",
    pending,
    deferred,
    accepted: count("VALUE_ACCEPTED"),
    rejected: count("ALL_SUGGESTIONS_REJECTED")
  };
}

function analyze(recording: DemoRecording, audioExtractions: AudioExtractionResult[]) {
  const audioMatch = matchAudioToRecording(recording, audioExtractions);
  const gapReport = analyzeMetadataGaps(recording, {
    audioExtractions,
    audioMatchResults: [audioMatch]
  });
  return { audioMatch, gapReport };
}

/**
 * Starts review from an MB-06 result. Pass the same audio extractions given to
 * `runRecordingWorkflow` so recalculated gaps keep the same audio evidence.
 * `currentRecording` lets review start from a later snapshot of the same
 * recording; proposals researched for a different identity are then stale.
 */
export function startHumanReview(
  workflow: Readonly<HumanReviewSource>,
  audioExtractions: readonly AudioExtractionResult[],
  options: { currentRecording?: Readonly<DemoRecording> } = {}
): HumanReviewState {
  const source = structuredClone(workflow);
  const recording = structuredClone(options.currentRecording ?? source.recording) as DemoRecording;
  if (recording.recordingId !== source.recording.recordingId) {
    throw new Error("The current recording does not belong to this workflow result.");
  }
  const decisionIds = new Set<string>();
  for (const decision of source.metadataDecisions) {
    if (decision.recordingId !== recording.recordingId) {
      throw new Error("A pending decision does not belong to this recording.");
    }
    if (decisionIds.has(decision.decisionId)) throw new Error("Duplicate pending decision identifier.");
    decisionIds.add(decision.decisionId);
    const keys = decision.findings.map((item) => findingKey(item.source, item.proposal.proposalId));
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate finding within a pending decision.");
  }

  const audio = structuredClone([...audioExtractions]);
  const decisions: MetadataDecisionReview[] = source.metadataDecisions.map((decision) => {
    const findingReviews: FindingReview[] = decision.findings.map((item) => ({
      source: item.source,
      proposalId: item.proposal.proposalId,
      status: "PENDING_REVIEW"
    }));
    return { decision, status: decisionStatus(findingReviews), acceptedValue: null, findingReviews };
  });

  return deepFreeze({
    recordingId: recording.recordingId,
    originalRecording: structuredClone(recording),
    recording,
    identityFingerprint: recordingIdentityFingerprint(recording),
    ...analyze(recording, audio),
    decisions,
    auditTrail: [],
    researchReview: summarize(decisions),
    recordingApprovalRequired: recording.approvalStatus !== "APPROVED",
    audioExtractions: audio,
    taskFingerprints: Object.fromEntries(
      source.researchTasks.map((task) => [task.taskId, task.identityFingerprint])
    )
  });
}

/** The basis a review interface must capture when it shows a decision to a reviewer. */
export function reviewBasisFor(state: Readonly<HumanReviewState>, decisionId: string): ReviewBasis {
  const review = state.decisions.find((item) => item.decision.decisionId === decisionId);
  if (!review) throw new Error("Unknown pending decision.");
  return {
    identityFingerprint: recordingIdentityFingerprint(state.recording),
    currentValue: fieldValue(state.recording, review.decision.field),
    findingsDigest: findingsDigest(review.decision)
  };
}

function shapeError(input: unknown): string | null {
  if (!object(input)) return "Review decision must be an object.";
  if (!identifier(input.reviewId)) return "A review identifier is required.";
  if (!identifier(input.decisionId)) return "A pending decision identifier is required.";
  if (!member(input.source, SOURCES)) return "Finding source must be MUSICBRAINZ or RESEARCH.";
  const reviewer = input.reviewer;
  if (!object(reviewer) || !identifier(reviewer.reviewerId)) {
    return "Explicit reviewer identity is required.";
  }
  if (reviewer.displayName !== undefined && reviewer.displayName !== null && !identifier(reviewer.displayName)) {
    return "Reviewer display name is invalid.";
  }
  if (typeof input.reviewedAt !== "string" || !validReviewTimestamp(input.reviewedAt)) {
    return "Review timestamp must be an ISO 8601 UTC timestamp.";
  }
  const basis = input.basis;
  if (!object(basis) || typeof basis.identityFingerprint !== "string" ||
    typeof basis.findingsDigest !== "string" ||
    (basis.currentValue !== null && typeof basis.currentValue !== "string")) {
    return "Review basis (identity, current value, findings digest) is required.";
  }
  const action = input.action;
  if (!object(action) || !member(action.action, ACTIONS)) return "Unsupported review action.";
  if (!identifier(action.proposalId) || !identifier(action.recordingId) || !identifier(action.gapId) ||
    !member(action.field, RESEARCH_FIELDS)) {
    return "Review action must identify its proposal, recording, gap, and field.";
  }
  if (action.note !== undefined && (typeof action.note !== "string" || action.note.length > MAX_NOTE_LENGTH)) {
    return "Reviewer note must be text of at most 2000 characters.";
  }
  if ((action.action === "EDIT_SUGGESTED_VALUE") !== Object.prototype.hasOwnProperty.call(action, "editedValue")) {
    return "Only EDIT_SUGGESTED_VALUE carries an edited value, and it requires one.";
  }
  return null;
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

/** Fails if anything other than the allowed keys differs between two snapshots. */
function assertOnlyAllowedChanges(
  before: DemoRecording,
  after: DemoRecording,
  allowed: ReadonlySet<string>
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (allowed.has(key)) continue;
    const left = (before as Record<string, unknown>)[key];
    const right = (after as Record<string, unknown>)[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`Review attempted to change an unrelated recording field: ${key}.`);
    }
  }
}

/**
 * Validates and applies one human decision. A rejected decision returns the
 * unchanged state and a reason; it never partially applies.
 */
export function applyHumanReviewDecision(
  state: Readonly<HumanReviewState>,
  input: Readonly<HumanReviewDecision>
): HumanReviewResult {
  const current = state as HumanReviewState;
  const reviewId = object(input) && identifier(input.reviewId) ? input.reviewId : null;
  const reject = (code: ReviewRejectionCode, message: string): HumanReviewResult =>
    ({ ok: false, state: current, rejection: deepFreeze({ reviewId, code, message }) });

  const shape = shapeError(input);
  if (shape) return reject("INVALID_DECISION", shape);
  const decision = structuredClone(input) as HumanReviewDecision;
  const { action } = decision;

  if (state.auditTrail.some((entry) => entry.reviewId === decision.reviewId)) {
    return reject("DUPLICATE_REVIEW", "This review decision was already recorded.");
  }
  const reviewIndex = state.decisions.findIndex((item) => item.decision.decisionId === decision.decisionId);
  if (reviewIndex < 0) return reject("UNKNOWN_DECISION", "No pending decision has this identifier.");
  const review = state.decisions[reviewIndex];
  const finding = review.decision.findings.find((item) =>
    item.source === decision.source && item.proposal.proposalId === action.proposalId);
  if (!finding) {
    return reject("MISMATCHED_DECISION", "The proposal and source do not belong to this pending decision.");
  }
  const proposal = finding.proposal;
  if (action.recordingId !== state.recordingId || proposal.recordingId !== state.recordingId ||
    action.gapId !== proposal.gapId || action.field !== proposal.field || action.field !== review.decision.field) {
    return reject("MISMATCHED_DECISION", "The review action's recording, gap, or field does not match the proposal.");
  }

  const fingerprint = recordingIdentityFingerprint(state.recording);
  const field = review.decision.field;
  const previousValue = fieldValue(state.recording, field);
  if (decision.basis.identityFingerprint !== fingerprint) {
    return reject("STALE_DECISION", "The recording's identifying metadata changed after this decision was prepared.");
  }
  if (state.taskFingerprints[proposal.taskId] !== fingerprint) {
    return reject("STALE_DECISION", "This proposal was researched for a different recording identity.");
  }
  if (decision.basis.currentValue !== previousValue) {
    return reject("STALE_DECISION", `The current ${field} changed after this decision was prepared.`);
  }
  if (decision.basis.findingsDigest !== findingsDigest(review.decision)) {
    return reject("STALE_DECISION", "The findings shown to the reviewer differ from the current pending decision.");
  }

  const findingIndex = review.findingReviews.findIndex((item) =>
    item.source === decision.source && item.proposalId === action.proposalId);
  if (review.status === "VALUE_ACCEPTED") {
    return reject("ALREADY_DECIDED", `A ${field} value was already accepted for this decision.`);
  }
  if (review.findingReviews[findingIndex].status === "REJECTED") {
    return reject("ALREADY_DECIDED", "This suggestion was already rejected.");
  }

  const note = action.note?.trim() ? redactResearchText(action.note.trim()) : null;
  const conflicting = review.decision.assessment === "CONFLICTING" ||
    proposal.outcome === "CONFLICTING_EVIDENCE" || proposal.conflictRequiresHumanResolution;
  const verifiedSuggestion = proposal.outcome === "PROPOSED" && proposal.suggestedValue !== null;

  let resultingValue: string | null = previousValue;
  let valueOrigin: ReviewAuditEntry["valueOrigin"] = null;
  if (action.action === "APPROVE_SUGGESTED_VALUE" || action.action === "EDIT_SUGGESTED_VALUE") {
    if (action.action === "APPROVE_SUGGESTED_VALUE") {
      if (conflicting) {
        return reject("CONFLICT_REQUIRES_EXPLICIT_RESOLUTION",
          "Conflicting evidence cannot be approved directly; use EDIT_SUGGESTED_VALUE with a note explaining the resolution.");
      }
      if (!verifiedSuggestion) {
        return reject("NO_VERIFIED_SUGGESTION",
          "This proposal has no independently verified suggested value to approve.");
      }
      resultingValue = proposal.suggestedValue;
      valueOrigin = "SUGGESTED_VALUE";
    } else {
      if ((conflicting || !verifiedSuggestion) && !note) {
        return reject("NOTE_REQUIRED", conflicting
          ? "Resolving conflicting evidence requires a reviewer note."
          : "Entering a value without a verified suggestion requires a reviewer note.");
      }
      resultingValue = action.editedValue;
      valueOrigin = resultingValue === proposal.suggestedValue
        ? "SUGGESTED_VALUE"
        : review.decision.candidateValues.includes(resultingValue)
          ? "EVIDENCE_CANDIDATE"
          : "REVIEWER_ENTERED";
    }
    const invalid = validateReviewedValue(field, resultingValue);
    if (invalid) return reject("INVALID_VALUE", invalid);
    if (!state.gapReport.gaps.some((gap) => gap.gapId === proposal.gapId)) {
      return reject("STALE_DECISION", "The gap this proposal addressed is no longer open.");
    }
  }

  const next = structuredClone(current) as HumanReviewState;
  const nextReview = next.decisions[reviewIndex];
  const findingReview = nextReview.findingReviews[findingIndex];
  const before = state.recording;
  let outcome: ReviewAuditEntry["outcome"];

  if (valueOrigin !== null) {
    const recording = next.recording;
    recording[field] = resultingValue;
    const allowed = new Set<string>([field, "approvalStatus"]);
    if (field === "isrc" && recording.isrcValidation) {
      recording.isrcValidation = {
        status: "valid",
        originalValue: recording.isrcValidation.originalValue,
        reviewed: true
      };
      allowed.add("isrcValidation");
    }
    // A changed value invalidates an earlier final approval; review never grants one.
    if (recording.approvalStatus === "APPROVED" && resultingValue !== previousValue) {
      recording.approvalStatus = "NEEDS_REVIEW";
    }
    assertOnlyAllowedChanges(before, recording, allowed);
    Object.assign(next, analyze(recording, next.audioExtractions));
    findingReview.status = action.action === "APPROVE_SUGGESTED_VALUE" ? "APPROVED" : "EDITED";
    nextReview.acceptedValue = resultingValue;
    outcome = "VALUE_APPLIED";
  } else if (action.action === "REJECT_SUGGESTION") {
    findingReview.status = "REJECTED";
    outcome = "SUGGESTION_REJECTED";
  } else {
    findingReview.status = "DEFERRED";
    outcome = "DECISION_DEFERRED";
  }
  nextReview.status = decisionStatus(nextReview.findingReviews);

  const auditEntry: ReviewAuditEntry = {
    sequence: state.auditTrail.length + 1,
    reviewId: decision.reviewId,
    reviewer: {
      reviewerId: decision.reviewer.reviewerId.trim(),
      displayName: decision.reviewer.displayName?.trim() || null
    },
    reviewedAt: decision.reviewedAt,
    action: action.action,
    outcome,
    recordingId: state.recordingId,
    decisionId: review.decision.decisionId,
    proposalId: proposal.proposalId,
    source: finding.source,
    taskId: proposal.taskId,
    gapId: proposal.gapId,
    field,
    assessment: review.decision.assessment,
    candidateValues: [...review.decision.candidateValues],
    suggestedValue: proposal.suggestedValue,
    editedValue: action.action === "EDIT_SUGGESTED_VALUE" ? action.editedValue : null,
    valueOrigin,
    previousValue,
    resultingValue: fieldValue(next.recording, field),
    previousApprovalStatus: before.approvalStatus,
    resultingApprovalStatus: next.recording.approvalStatus,
    identityFingerprint: fingerprint,
    evidence: review.decision.findings.flatMap((item) => [
      ...item.proposal.evidence.map((evidence) => ({
        ...evidence, source: item.source, proposalId: item.proposal.proposalId, role: "SUPPORTING" as const
      })),
      ...item.proposal.conflictingEvidence.map((evidence) => ({
        ...evidence, source: item.source, proposalId: item.proposal.proposalId, role: "CONFLICTING" as const
      }))
    ]),
    note
  };
  next.auditTrail.push(auditEntry);
  next.researchReview = summarize(next.decisions);
  next.recordingApprovalRequired = next.recording.approvalStatus !== "APPROVED";

  const frozen = deepFreeze(next);
  return { ok: true, state: frozen, auditEntry: frozen.auditTrail[frozen.auditTrail.length - 1] };
}

/**
 * Applies pending decisions in order. Each is checked against the state left
 * by the previous one, so a second decision prepared for the same value is
 * rejected as stale rather than silently overriding the first.
 */
export function processPendingReviews(
  state: Readonly<HumanReviewState>,
  decisions: readonly Readonly<HumanReviewDecision>[]
): PendingReviewBatchResult {
  let current = state as HumanReviewState;
  const applied: ReviewAuditEntry[] = [];
  const rejected: ReviewRejection[] = [];
  for (const decision of decisions) {
    const result = applyHumanReviewDecision(current, decision);
    if (result.ok) {
      current = result.state;
      applied.push(result.auditEntry);
    } else {
      rejected.push(result.rejection);
    }
  }
  return { state: current, applied, rejected };
}
