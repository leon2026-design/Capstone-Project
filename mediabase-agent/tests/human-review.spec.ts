import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type { AudioExtractionResult } from "../src/audio/audioMetadata";
import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  MetadataReviewAction,
  ResearchField,
  VerifiedResearchEvidence
} from "../src/metadata/metadataResearch";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import type { DemoRecording } from "../src/metadata/recordValidation";
import type { EvidenceVerifier } from "../src/research/sourceVerifier";
import {
  applyHumanReviewDecision,
  processPendingReviews,
  reviewBasisFor,
  startHumanReview,
  validateReviewedValue,
  type HumanReviewDecision,
  type HumanReviewState
} from "../src/workflow/humanReview";
import type { WorkflowMusicBrainzProvider } from "../src/workflow/musicBrainzWorkflow";
import { runRecordingWorkflow, type RecordingWorkflowResult } from "../src/workflow/recordingWorkflow";

const MB_RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const MB_RELEASE_ID = "33333333-3333-4333-8333-333333333333";
const REVIEWED_AT = "2026-11-04T15:30:00.000Z";

const RESEARCH_VALUES: Record<ResearchField, string> = {
  isrc: "USAAA2600010",
  label: "Fictional Label",
  officialReleaseDate: "11/15/2026",
  albumTitle: "Fictional Album",
  albumUPC: "0012345678905",
  // Deliberately differs from the MusicBrainz date (11/15/2026).
  albumReleaseDate: "11/16/2026"
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fixture(withIsrc = true) {
  const csv = withIsrc
    ? "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC\nFictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album,USAAA2600010"
    : "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE\nFictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album";
  const record = importOrchardCsv(csv, "fictional-review.csv").records[0];
  const filePath = resolve("fictional-audio", "fictional-song.wav");
  record.audioFilePath = filePath;
  const isrc = withIsrc ? "USAAA2600010" : null;
  const audio: AudioExtractionResult[] = [{
    status: "OK",
    filePath,
    fileName: "fictional-song.wav",
    metadata: {
      filePath,
      fileName: "fictional-song.wav",
      format: "WAV",
      extensionMatchesFormat: true,
      durationSeconds: 180,
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      artist: "Fictional Artist",
      title: "Fictional Song",
      album: "Fictional Album",
      version: null,
      isrc,
      rawIsrcs: isrc ? [isrc] : []
    }
  }];
  return { record, audio };
}

const musicBrainz: WorkflowMusicBrainzProvider = {
  async lookupRecording(record) {
    return {
      recordingId: record.recordingId,
      queriedIsrc: record.isrc ?? null,
      status: "NEEDS_REVIEW",
      requiresHumanReview: true,
      error: null,
      candidates: [{
        musicBrainzId: MB_RECORDING_ID,
        title: "Fictional Song",
        artistCredit: "Fictional Artist",
        sourceUrl: `https://musicbrainz.org/recording/${MB_RECORDING_ID}`,
        releases: [],
        releaseListMayBeIncomplete: true
      }]
    };
  },
  async lookupReleases(recordingId) {
    return {
      musicBrainzId: recordingId,
      status: "NEEDS_REVIEW",
      requiresHumanReview: true,
      releaseListMayBeIncomplete: true,
      error: null,
      releases: [{
        musicBrainzId: MB_RELEASE_ID,
        title: "Fictional Album",
        date: "2026-11-15",
        country: "US",
        barcode: "0012345678905",
        sourceUrl: `https://musicbrainz.org/release/${MB_RELEASE_ID}`
      }]
    };
  }
};

const research: MetadataResearchProvider = {
  async research(task): Promise<MetadataResearchResponse> {
    const value = RESEARCH_VALUES[task.field];
    return {
      recordingId: task.recordingId,
      gapId: task.gapId,
      field: task.field,
      suggestedValue: value,
      evidence: [{
        sourceId: "Fictional research catalog",
        url: "https://catalog.example.test/release",
        category: "published-catalog",
        quote: `Published value: ${value}`,
        supportedValue: value
      }],
      explanation: "Fictional offline research result.",
      confidence: "HIGH",
      conflictingEvidence: [],
      outcome: "PROPOSED"
    };
  }
};

/** Fictional stand-in for the independent source verifier; no network access. */
const verifier: EvidenceVerifier = {
  async verify(task, claims) {
    const attestations: VerifiedResearchEvidence[] = claims.evidence
      .filter((claim) => claim.supportedValue === claims.suggestedValue)
      .map((claim) => ({
        ...claim,
        recordingId: task.recordingId,
        field: task.field,
        identityFingerprint: task.identityFingerprint,
        verificationId: "fictional-offline-verifier-001"
      }));
    return { attestations, reports: [] };
  }
};

type Setup = {
  record: DemoRecording;
  audio: AudioExtractionResult[];
  workflow: RecordingWorkflowResult;
  state: HumanReviewState;
};

async function setup(
  options: { verify?: boolean; withIsrc?: boolean; current?: (record: DemoRecording) => void } = {}
): Promise<Setup> {
  const { record, audio } = fixture(options.withIsrc ?? true);
  const workflow = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: research, ...(options.verify === false ? {} : { verifier }) },
    musicBrainz: {
      provider: musicBrainz,
      selection: { musicBrainzRecordingId: MB_RECORDING_ID, musicBrainzReleaseId: MB_RELEASE_ID }
    }
  });
  let currentRecording: DemoRecording | undefined;
  if (options.current) {
    currentRecording = structuredClone(workflow.recording);
    options.current(currentRecording);
  }
  const state = startHumanReview(workflow, audio, currentRecording ? { currentRecording } : {});
  return { record, audio, workflow, state };
}

let reviewCounter = 0;

function decide(
  state: HumanReviewState,
  field: ResearchField,
  kind: MetadataReviewAction["action"],
  extra: {
    source?: "RESEARCH" | "MUSICBRAINZ";
    editedValue?: string;
    note?: string;
    reviewId?: string;
  } = {}
): HumanReviewDecision {
  const review = state.decisions.find((item) => item.decision.field === field);
  if (!review) throw new Error(`No pending decision for ${field}.`);
  const source = extra.source ?? "RESEARCH";
  const finding = review.decision.findings.find((item) => item.source === source);
  if (!finding) throw new Error(`No ${source} finding for ${field}.`);
  const linkage = {
    proposalId: finding.proposal.proposalId,
    recordingId: finding.proposal.recordingId,
    gapId: finding.proposal.gapId,
    field,
    ...(extra.note !== undefined ? { note: extra.note } : {})
  };
  const action: MetadataReviewAction = kind === "EDIT_SUGGESTED_VALUE"
    ? { ...linkage, action: kind, editedValue: extra.editedValue ?? "" }
    : { ...linkage, action: kind };
  return {
    reviewId: extra.reviewId ?? `review-${++reviewCounter}`,
    decisionId: review.decision.decisionId,
    source,
    action,
    reviewer: { reviewerId: "brad", displayName: "Brad (fictional reviewer)" },
    reviewedAt: REVIEWED_AT,
    basis: reviewBasisFor(state, review.decision.decisionId)
  };
}

function applied(state: HumanReviewState, decision: HumanReviewDecision) {
  const result = applyHumanReviewDecision(state, decision);
  if (!result.ok) throw new Error(`${result.rejection.code}: ${result.rejection.message}`);
  return result;
}

function rejectedCode(state: HumanReviewState, decision: unknown) {
  const result = applyHumanReviewDecision(state, decision as HumanReviewDecision);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejection.");
  expect(result.state).toBe(state);
  return result.rejection.code;
}

function changedKeys(left: DemoRecording, right: DemoRecording): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) =>
    JSON.stringify((left as Record<string, unknown>)[key]) !==
    JSON.stringify((right as Record<string, unknown>)[key])).sort();
}

test("starts review from MB-06 pending decisions without changing anything", async () => {
  const { record, audio, workflow, state } = await setup();
  expect(state.recording).toEqual(record);
  expect(state.originalRecording).toEqual(record);
  expect(state.gapReport).toEqual(workflow.gapReport);
  expect(state.audioMatch).toEqual(workflow.audioMatch);
  expect(state.decisions.map((item) => item.decision)).toEqual(workflow.metadataDecisions);
  expect(state.decisions.every((item) => item.status === "PENDING_REVIEW")).toBe(true);
  expect(state.researchReview).toMatchObject({ status: "IN_PROGRESS", pending: state.decisions.length });
  expect(state.recordingApprovalRequired).toBe(true);
  expect(state.auditTrail).toEqual([]);
  expect(Object.isFrozen(state.recording)).toBe(true);
  expect(Object.isFrozen(state.decisions[0].decision.findings[0].proposal.evidence)).toBe(true);
  expect(audio[0].status).toBe("OK");
});

test("approves an independently verified suggestion and records a complete audit entry", async () => {
  const { workflow, state } = await setup();
  const before = JSON.stringify({ workflow, state });
  const decision = decide(state, "label", "APPROVE_SUGGESTED_VALUE", { note: "Matches the label catalog." });
  const { state: next, auditEntry } = applied(state, decision);

  expect(next.recording.label).toBe("Fictional Label");
  expect(changedKeys(state.recording, next.recording)).toEqual(["label"]);
  expect(next.recording.approvalStatus).toBe("DRAFT");
  expect(next.recordingApprovalRequired).toBe(true);
  expect(next.originalRecording.label).toBeNull();
  expect(state.recording.label).toBeNull();
  expect(JSON.stringify({ workflow, state })).toBe(before);

  // Gaps are recalculated: the missing-label gap is closed, others remain.
  expect(state.gapReport.gaps.some((gap) => gap.code === "missing-label")).toBe(true);
  expect(next.gapReport.gaps.some((gap) => gap.code === "missing-label")).toBe(false);
  expect(next.gapReport.gaps.length).toBe(state.gapReport.gaps.length - 1);

  const review = next.decisions.find((item) => item.decision.field === "label");
  expect(review).toMatchObject({ status: "VALUE_ACCEPTED", acceptedValue: "Fictional Label" });
  expect(review?.decision).toEqual(workflow.metadataDecisions.find((item) => item.field === "label"));

  expect(auditEntry).toMatchObject({
    sequence: 1,
    reviewId: decision.reviewId,
    reviewer: { reviewerId: "brad", displayName: "Brad (fictional reviewer)" },
    reviewedAt: REVIEWED_AT,
    action: "APPROVE_SUGGESTED_VALUE",
    outcome: "VALUE_APPLIED",
    recordingId: state.recordingId,
    decisionId: decision.decisionId,
    proposalId: decision.action.proposalId,
    gapId: decision.action.gapId,
    source: "RESEARCH",
    field: "label",
    suggestedValue: "Fictional Label",
    editedValue: null,
    valueOrigin: "SUGGESTED_VALUE",
    previousValue: null,
    resultingValue: "Fictional Label",
    previousApprovalStatus: "DRAFT",
    resultingApprovalStatus: "DRAFT",
    identityFingerprint: decision.basis.identityFingerprint,
    note: "Matches the label catalog."
  });
  expect(auditEntry.evidence).toEqual([expect.objectContaining({
    url: "https://catalog.example.test/release",
    sourceId: "Fictional research catalog",
    verification: "INDEPENDENTLY_VERIFIED",
    verificationId: "fictional-offline-verifier-001",
    role: "SUPPORTING",
    source: "RESEARCH"
  })]);
  expect(next.auditTrail).toEqual([auditEntry]);
  expect(Object.isFrozen(auditEntry)).toBe(true);
});

test("edits a suggested value, applying only the reviewer's validated value", async () => {
  const { state } = await setup();
  const { state: next, auditEntry } = applied(state, decide(state, "officialReleaseDate", "EDIT_SUGGESTED_VALUE", {
    editedValue: "11/14/2026", note: "Label confirmed an earlier date by phone."
  }));
  expect(next.recording.officialReleaseDate).toBe("11/14/2026");
  expect(changedKeys(state.recording, next.recording)).toEqual(["officialReleaseDate"]);
  expect(auditEntry).toMatchObject({
    action: "EDIT_SUGGESTED_VALUE",
    suggestedValue: "11/15/2026",
    editedValue: "11/14/2026",
    valueOrigin: "REVIEWER_ENTERED",
    previousValue: null,
    resultingValue: "11/14/2026"
  });
  expect(next.decisions.find((item) => item.decision.field === "officialReleaseDate")?.findingReviews[0].status)
    .toBe("EDITED");
});

test("rejects a suggestion without changing the recording and refuses repeated decisions", async () => {
  const { state } = await setup();
  const first = applied(state, decide(state, "label", "REJECT_SUGGESTION", { note: "Wrong imprint." }));
  expect(first.state.recording).toEqual(state.recording);
  expect(first.state.gapReport).toEqual(state.gapReport);
  expect(first.auditEntry).toMatchObject({
    action: "REJECT_SUGGESTION", outcome: "SUGGESTION_REJECTED",
    previousValue: null, resultingValue: null, valueOrigin: null, note: "Wrong imprint."
  });
  expect(first.state.decisions.find((item) => item.decision.field === "label")?.status)
    .toBe("ALL_SUGGESTIONS_REJECTED");

  expect(rejectedCode(first.state, decide(first.state, "label", "REJECT_SUGGESTION"))).toBe("ALREADY_DECIDED");
  expect(rejectedCode(first.state, decide(first.state, "label", "APPROVE_SUGGESTED_VALUE"))).toBe("ALREADY_DECIDED");
});

test("defers a decision, which may later be decided", async () => {
  const { state } = await setup();
  const deferred = applied(state, decide(state, "label", "DEFER_DECISION", { note: "Ask the label first." }));
  expect(deferred.state.recording).toEqual(state.recording);
  expect(deferred.auditEntry).toMatchObject({ outcome: "DECISION_DEFERRED", resultingValue: null });
  expect(deferred.state.decisions.find((item) => item.decision.field === "label")?.status).toBe("DEFERRED");
  expect(deferred.state.researchReview.deferred).toBe(1);

  const again = applied(deferred.state, decide(deferred.state, "label", "DEFER_DECISION"));
  const approved = applied(again.state, decide(again.state, "label", "APPROVE_SUGGESTED_VALUE"));
  expect(approved.state.recording.label).toBe("Fictional Label");
  expect(approved.state.auditTrail.map((entry) => entry.action))
    .toEqual(["DEFER_DECISION", "DEFER_DECISION", "APPROVE_SUGGESTED_VALUE"]);
  expect(approved.state.auditTrail.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
});

test("never silently resolves conflicting evidence", async () => {
  const { state } = await setup();
  const review = state.decisions.find((item) => item.decision.field === "albumReleaseDate");
  expect(review?.decision.assessment).toBe("CONFLICTING");

  expect(rejectedCode(state, decide(state, "albumReleaseDate", "APPROVE_SUGGESTED_VALUE")))
    .toBe("CONFLICT_REQUIRES_EXPLICIT_RESOLUTION");
  expect(rejectedCode(state, decide(state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", { editedValue: "11/15/2026" })))
    .toBe("NOTE_REQUIRED");
  expect(rejectedCode(state, decide(state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
    editedValue: "11/15/2026", note: "   "
  }))).toBe("NOTE_REQUIRED");

  const resolved = applied(state, decide(state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
    source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Release sleeve confirms the MusicBrainz date."
  }));
  expect(resolved.state.recording.albumReleaseDate).toBe("11/15/2026");
  expect(resolved.auditEntry).toMatchObject({ assessment: "CONFLICTING", valueOrigin: "EVIDENCE_CANDIDATE" });
  expect(resolved.auditEntry.candidateValues).toEqual(["11/15/2026", "11/16/2026"]);
  // Both providers' evidence and source URLs are retained in the audit trail.
  expect(resolved.auditEntry.evidence.map((item) => [item.source, item.url])).toEqual([
    ["MUSICBRAINZ", `https://musicbrainz.org/release/${MB_RELEASE_ID}`],
    ["RESEARCH", "https://catalog.example.test/release"]
  ]);
});

test("unverified suggestions cannot be approved; an explicit edit needs a note", async () => {
  const { state } = await setup({ verify: false });
  const finding = state.decisions.find((item) => item.decision.field === "label")?.decision.findings[0];
  expect(finding?.proposal.suggestedValue).toBeNull();

  expect(rejectedCode(state, decide(state, "label", "APPROVE_SUGGESTED_VALUE"))).toBe("NO_VERIFIED_SUGGESTION");
  expect(rejectedCode(state, decide(state, "label", "EDIT_SUGGESTED_VALUE", { editedValue: "Fictional Label" })))
    .toBe("NOTE_REQUIRED");
  const edited = applied(state, decide(state, "label", "EDIT_SUGGESTED_VALUE", {
    editedValue: "Fictional Label", note: "Checked the physical release."
  }));
  expect(edited.state.recording.label).toBe("Fictional Label");
  expect(edited.auditEntry.valueOrigin).toBe("EVIDENCE_CANDIDATE");
  expect(edited.auditEntry.evidence[0].verification).toBe("PROVIDER_CLAIM");
});

for (const [field, invalid] of [
  ["officialReleaseDate", "02/30/2026"],
  ["officialReleaseDate", "2026-11-15"],
  ["albumReleaseDate", "13/01/2026"],
  ["albumUPC", "0012345678906"],
  ["albumUPC", "12345"],
  ["label", " Fictional Label "],
  ["label", "contact@label.example.test"]
] as const) {
  test(`rejects an invalid edited ${field}: ${JSON.stringify(invalid)}`, async () => {
    const { state } = await setup();
    const decision = decide(state, field, "EDIT_SUGGESTED_VALUE", {
      editedValue: invalid, note: "Reviewer correction.", source: "RESEARCH"
    });
    expect(rejectedCode(state, decision)).toBe("INVALID_VALUE");
  });
}

test("enforces existing date, ISRC, and UPC rules", () => {
  expect(validateReviewedValue("officialReleaseDate", "02/29/2028")).toBeNull();
  expect(validateReviewedValue("officialReleaseDate", "02/29/2027")).not.toBeNull();
  expect(validateReviewedValue("albumReleaseDate", "11/15/26")).not.toBeNull();
  expect(validateReviewedValue("isrc", "USAAA2600010")).toBeNull();
  expect(validateReviewedValue("isrc", "US-AAA-26-00010")).not.toBeNull();
  expect(validateReviewedValue("isrc", "usaaa2600010")).not.toBeNull();
  expect(validateReviewedValue("isrc", "USAAA260001")).not.toBeNull();
  expect(validateReviewedValue("albumUPC", "0012345678905")).toBeNull();
  expect(validateReviewedValue("albumUPC", "0012345678904")).not.toBeNull();
  expect(validateReviewedValue("label", "")).not.toBeNull();
  expect(validateReviewedValue("albumTitle", "Fictional\nAlbum")).not.toBeNull();
  expect(validateReviewedValue("albumTitle", "C:\\private\\album")).not.toBeNull();
});

test("an accepted ISRC is marked reviewed and recalculates gaps", async () => {
  const { state } = await setup({ withIsrc: false });
  expect(state.recording.isrcValidation).toMatchObject({ status: "missing", reviewed: false });
  expect(rejectedCode(state, decide(state, "isrc", "EDIT_SUGGESTED_VALUE", {
    editedValue: "US-AAA-26-00010", note: "Hyphenated form."
  }))).toBe("INVALID_VALUE");

  const { state: next } = applied(state, decide(state, "isrc", "APPROVE_SUGGESTED_VALUE"));
  expect(next.recording.isrc).toBe("USAAA2600010");
  expect(next.recording.isrcValidation).toEqual({ status: "valid", originalValue: null, reviewed: true });
  expect(changedKeys(state.recording, next.recording)).toEqual(["isrc", "isrcValidation"]);
  expect(next.gapReport.gaps.some((gap) => gap.fields.includes("isrc") && gap.code === "missing-isrc")).toBe(false);
  expect(next.recording.approvalStatus).toBe("DRAFT");
});

test("rejects stale decisions", async () => {
  const { state } = await setup();
  const base = decide(state, "label", "APPROVE_SUGGESTED_VALUE");

  expect(rejectedCode(state, { ...base, basis: { ...base.basis, currentValue: "Other Label" } }))
    .toBe("STALE_DECISION");
  expect(rejectedCode(state, { ...base, basis: { ...base.basis, identityFingerprint: "IDENTITY-0000000000000000" } }))
    .toBe("STALE_DECISION");
  expect(rejectedCode(state, { ...base, basis: { ...base.basis, findingsDigest: "FINDINGS-0000000000000000" } }))
    .toBe("STALE_DECISION");

  // Two decisions prepared against the same value: the second one is stale.
  const second = decide(state, "label", "EDIT_SUGGESTED_VALUE", { editedValue: "Other Label", note: "Alternative." });
  const batch = processPendingReviews(state, [base, second]);
  expect(batch.applied.map((entry) => entry.reviewId)).toEqual([base.reviewId]);
  expect(batch.rejected).toEqual([expect.objectContaining({ reviewId: second.reviewId, code: "STALE_DECISION" })]);
  expect(batch.state.recording.label).toBe("Fictional Label");
});

test("rejects proposals researched for a different recording identity", async () => {
  const { state } = await setup({ current: (record) => { record.title = "Fictional Song (Remix)"; } });
  expect(rejectedCode(state, decide(state, "label", "APPROVE_SUGGESTED_VALUE"))).toBe("STALE_DECISION");
  expect(rejectedCode(state, decide(state, "label", "REJECT_SUGGESTION"))).toBe("STALE_DECISION");
});

test("rejects a value for a gap that has since been closed", async () => {
  const { state } = await setup({ current: (record) => { record.label = "Manually Entered Label"; } });
  expect(state.gapReport.gaps.some((gap) => gap.code === "missing-label")).toBe(false);
  expect(rejectedCode(state, decide(state, "label", "APPROVE_SUGGESTED_VALUE"))).toBe("STALE_DECISION");
  expect(state.recording.label).toBe("Manually Entered Label");
});

test("rejects mismatched review decisions", async () => {
  const { state } = await setup();
  const base = decide(state, "label", "APPROVE_SUGGESTED_VALUE");
  const other = decide(state, "officialReleaseDate", "APPROVE_SUGGESTED_VALUE");

  expect(rejectedCode(state, { ...base, decisionId: "REVIEW-unknown" })).toBe("UNKNOWN_DECISION");
  expect(rejectedCode(state, { ...base, decisionId: other.decisionId })).toBe("MISMATCHED_DECISION");
  expect(rejectedCode(state, { ...base, source: "MUSICBRAINZ" })).toBe("MISMATCHED_DECISION");
  expect(rejectedCode(state, { ...base, action: { ...base.action, recordingId: "ORCHARD-other" } }))
    .toBe("MISMATCHED_DECISION");
  expect(rejectedCode(state, { ...base, action: { ...base.action, gapId: other.action.gapId } }))
    .toBe("MISMATCHED_DECISION");
  expect(rejectedCode(state, { ...base, action: { ...base.action, field: "albumTitle" } }))
    .toBe("MISMATCHED_DECISION");
  expect(rejectedCode(state, { ...base, action: { ...base.action, proposalId: other.action.proposalId } }))
    .toBe("MISMATCHED_DECISION");
});

test("requires explicit reviewer identity and well-formed decisions", async () => {
  const { state } = await setup();
  const base = decide(state, "label", "APPROVE_SUGGESTED_VALUE");
  const { reviewer: _reviewer, ...withoutReviewer } = base;
  void _reviewer;

  for (const invalid of [
    withoutReviewer,
    { ...base, reviewer: { reviewerId: "  " } },
    { ...base, reviewedAt: "yesterday" },
    { ...base, reviewedAt: "2026-11-04 15:30:00" },
    { ...base, reviewedAt: "2026-02-31T15:30:00Z" },
    { ...base, reviewId: "" },
    { ...base, source: "GEMINI" },
    { ...base, basis: undefined },
    { ...base, action: { ...base.action, action: "APPROVE_RECORDING" } },
    { ...base, action: { ...base.action, editedValue: "Smuggled Label" } },
    { ...base, action: { ...base.action, action: "EDIT_SUGGESTED_VALUE" } },
    { ...base, action: { ...base.action, note: "x".repeat(2001) } },
    null
  ]) {
    expect(rejectedCode(state, invalid)).toBe("INVALID_DECISION");
  }
});

test("rejects replayed and repeated decisions", async () => {
  const { state } = await setup();
  const decision = decide(state, "label", "APPROVE_SUGGESTED_VALUE");
  const { state: next } = applied(state, decision);
  expect(rejectedCode(next, decision)).toBe("DUPLICATE_REVIEW");
  expect(rejectedCode(next, { ...decision, basis: reviewBasisFor(next, decision.decisionId) }))
    .toBe("DUPLICATE_REVIEW");
  expect(rejectedCode(next, decide(next, "label", "APPROVE_SUGGESTED_VALUE"))).toBe("ALREADY_DECIDED");
  expect(rejectedCode(next, decide(next, "label", "DEFER_DECISION"))).toBe("ALREADY_DECIDED");
  expect(next.auditTrail).toHaveLength(1);
});

test("processes a batch of pending decisions and keeps final approval separate", async () => {
  const { state } = await setup();
  const decisions = state.decisions.map((review) => {
    const field = review.decision.field;
    return review.decision.assessment === "CONFLICTING"
      ? decide(state, field, "DEFER_DECISION")
      : decide(state, field, "APPROVE_SUGGESTED_VALUE");
  });
  const batch = processPendingReviews(state, decisions);
  expect(batch.rejected).toEqual([]);
  expect(batch.applied).toHaveLength(decisions.length);
  expect(batch.state.researchReview).toMatchObject({ status: "IN_PROGRESS", deferred: 1, pending: 0 });
  expect(batch.state.recording.approvalStatus).toBe("DRAFT");
  expect(batch.state.recordingApprovalRequired).toBe(true);
  expect(batch.state.gapReport.readiness).not.toBe("READY");
  expect(batch.state.gapReport.gaps.some((gap) => gap.fields.includes("approvalStatus"))).toBe(true);

  const finish = processPendingReviews(batch.state, [decide(batch.state, "albumReleaseDate", "REJECT_SUGGESTION", {
    source: "MUSICBRAINZ"
  }), decide(batch.state, "albumReleaseDate", "REJECT_SUGGESTION")]);
  expect(finish.rejected).toEqual([]);
  expect(finish.state.researchReview.status).toBe("COMPLETE");
  expect(finish.state.recording.approvalStatus).toBe("DRAFT");
});

test("a changed value downgrades an earlier final approval and never grants one", async () => {
  const { state } = await setup({ current: (record) => { record.approvalStatus = "APPROVED"; } });
  expect(state.recordingApprovalRequired).toBe(false);
  const { state: next, auditEntry } = applied(state, decide(state, "label", "APPROVE_SUGGESTED_VALUE"));
  expect(next.recording.approvalStatus).toBe("NEEDS_REVIEW");
  expect(next.recordingApprovalRequired).toBe(true);
  expect(auditEntry).toMatchObject({ previousApprovalStatus: "APPROVED", resultingApprovalStatus: "NEEDS_REVIEW" });
  expect(changedKeys(state.recording, next.recording)).toEqual(["approvalStatus", "label"]);
});

test("never mutates frozen inputs or earlier states", async () => {
  const { record, audio } = fixture();
  const workflow = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: research, verifier },
    musicBrainz: {
      provider: musicBrainz,
      selection: { musicBrainzRecordingId: MB_RECORDING_ID, musicBrainzReleaseId: MB_RELEASE_ID }
    }
  });
  deepFreeze(workflow);
  deepFreeze(audio);
  const snapshot = JSON.stringify({ workflow, audio });
  const state = startHumanReview(workflow, audio);
  const stateSnapshot = JSON.stringify(state);
  const decision = deepFreeze(decide(state, "label", "EDIT_SUGGESTED_VALUE", {
    editedValue: "Fictional Label", note: "Confirmed."
  }));
  const { state: next } = applied(state, decision);
  expect(JSON.stringify({ workflow, audio })).toBe(snapshot);
  expect(JSON.stringify(state)).toBe(stateSnapshot);
  expect(Object.isFrozen(next.recording)).toBe(true);
  expect(Object.isFrozen(next.auditTrail)).toBe(true);
  expect(() => { (next.recording as DemoRecording).label = "Tampered"; }).toThrow();
  expect(next.recording.label).toBe("Fictional Label");
});

test("redacts sensitive text from reviewer notes", async () => {
  const { state } = await setup();
  const { auditEntry } = applied(state, decide(state, "label", "REJECT_SUGGESTION", {
    note: "Per brad@label.example.test, see C:\\Users\\brad\\notes.txt"
  }));
  expect(auditEntry.note).not.toContain("brad@label.example.test");
  expect(auditEntry.note).not.toContain("C:\\Users");
  expect(auditEntry.note).toContain("[redacted email]");
});
