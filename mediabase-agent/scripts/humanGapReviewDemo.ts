import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFileReviewStorage } from "../src/storage/reviewStorageBackend";
import {
  humanGapReviewSummary,
  humanOnlyGapQueue,
  publicHumanGapAuditTrail,
  type HumanGapReviewState
} from "../src/workflow/humanGapReview";
import { applyHumanReviewDecision } from "../src/workflow/humanReview";
import {
  applyCombinedReviewDecisionsWithRefusalLog,
  createReviewSessionStore,
  type ReviewSessionStore
} from "../src/workflow/reviewSessionStore";
// Shared fictional MB-06/MB-07 fixture: mock providers, a fictional verifier, and simulated audio metadata.
import { conflictingAudio, decide, gapDecide, setup } from "../tests/support/reviewFixture";

/**
 * Offline MB-09 demonstration: MB-06 analysis, MB-07 research review, MB-08
 * persistence, then MB-09 human-only gap resolution interleaved with research
 * review, saved, "restarted", and verified by replay. Fictional data in a
 * temporary folder (removed unless --keep). No network, paid API, or Mediabase
 * access; no audio is uploaded; nothing is approved or submitted.
 */
const DEMO_KEY = "fictional-offline-demo-key-not-a-secret";

function openStore(directory: string): ReviewSessionStore {
  return createReviewSessionStore(createJsonFileReviewStorage(directory), { integrityKey: DEMO_KEY });
}

function audioCandidates(state: HumanGapReviewState) {
  const item = humanOnlyGapQueue(state).find((entry) => entry.allowedActions.includes("CONFIRM_AUDIO"));
  assert.ok(item, "The simulated audio should need a human selection.");
  return item.audioCandidates;
}

async function main() {
  const keep = process.argv.includes("--keep");
  const directory = await fs.mkdtemp(join(tmpdir(), "mediabase-gap-demo-"));
  try {
    // 1. MB-06: a fictional Orchard record with the artist filled in but unconfirmed, and three simulated audio files.
    const { workflow, state: researchState } = await setup({
      prepare: (record) => {
        record.artist = "Fictional Artist";
        delete record.audioFilePath;
      },
      extraAudio: [conflictingAudio("fictional-song-copy.wav", "Fictional Artist"), conflictingAudio()]
    });

    // 2. MB-07: a research review session; the reviewer accepts the verified label.
    const labelReview = applyHumanReviewDecision(researchState,
      decide(researchState, "label", "APPROVE_SUGGESTED_VALUE", { note: "Matches the label catalog." }));
    assert.ok(labelReview.ok);

    // 3. MB-08: save the research session (schema version 1), then upgrade it explicitly for manual review.
    const v1 = await openStore(directory).save(labelReview.state, { expectedRevision: 0, sessionId: "demo-research-desk" });
    assert.ok(v1.ok, !v1.ok ? v1.message : "");
    const needsUpgrade = await openStore(directory).loadCombined(researchState.recordingId);
    assert.ok(!needsUpgrade.ok && needsUpgrade.code === "UPGRADE_REQUIRED");
    const upgraded = await openStore(directory).upgrade(researchState.recordingId, {
      expectedRevision: v1.session.revision, sessionId: "demo-upgrade"
    });
    assert.ok(upgraded.ok, !upgraded.ok ? upgraded.message : "");

    // 4. Load the saved session.
    const loaded = await openStore(directory).loadCombined(researchState.recordingId);
    assert.ok(loaded.ok, !loaded.ok ? loaded.message : "");
    let state = loaded.session.state;
    const candidates = audioCandidates(state);
    const conflicted = candidates.find((candidate) => candidate.conflicts.length > 0);
    const isrcMatch = candidates.find((candidate) => candidate.basis === "ISRC");
    assert.ok(conflicted && isrcMatch);

    // 5-7. MB-09 decisions interleaved with MB-07: confirm the artist, reject the UPC, answer a declaration,
    //      refuse an unacknowledged conflicting audio file, then explicitly select the ISRC-matched file.
    const confirmArtist = gapDecide(state, "artist-unconfirmed", {
      action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist", primaryArtist: "Fictional Artist"
    }, { reviewerId: "dana", reviewId: "demo-manual-artist" });
    const batch = applyCombinedReviewDecisionsWithRefusalLog(loaded.session, [
      { kind: "MANUAL", decision: confirmArtist },
      { kind: "RESEARCH", decision: decide(state.research, "albumUPC", "REJECT_SUGGESTION", {
        note: "Research UPC not confirmed by distributor.", reviewId: "demo-research-upc"
      }) },
      { kind: "MANUAL", decision: gapDecide(state, "declaration-unanswered",
        { action: "SET_FIELD", field: "canadianContentDeclaration", value: "no" },
        { field: "canadianContentDeclaration", note: "Label confirmed: not Canadian content.", reviewId: "demo-manual-cancon" }) },
      { kind: "MANUAL", decision: gapDecide(state, "audio-ambiguous",
        { action: "CONFIRM_AUDIO", audioFileId: conflicted.audioFileId }, { reviewId: "demo-manual-audio-1" }) }
    ]);
    assert.deepEqual(batch.rejected.map((item) => item.rejection.code), ["ACKNOWLEDGEMENT_REQUIRED"]);
    state = batch.state;
    // The audio gap's basis is taken after the earlier decisions, so the selection is current.
    const selectAudio = applyCombinedReviewDecisionsWithRefusalLog(batch, [
      { kind: "MANUAL", decision: gapDecide(state, "audio-ambiguous",
        { action: "CONFIRM_AUDIO", audioFileId: isrcMatch.audioFileId },
        { note: "Selected the master whose embedded ISRC matches Orchard.", reviewId: "demo-manual-audio-2" }) }
    ]);
    assert.equal(selectAudio.rejected.length, 0);
    state = selectAudio.state;
    assert.equal(state.research.recording.audioMatch?.humanConfirmed, true);

    // 8. Save the combined review history and refusal log.
    const saved = await openStore(directory).saveCombined(state, {
      expectedRevision: loaded.session.revision, sessionId: "demo-gap-desk", refusedDecisions: selectAudio.refusedDecisions
    });
    assert.ok(saved.ok, !saved.ok ? saved.message : "");
    const savedEvents = JSON.stringify(state.reviewEvents);
    const savedManualTrail = JSON.stringify(state.manualAuditTrail);

    // 9-10. Simulate a restart: a fresh store reloads and verifies the history by replaying every event in order.
    const restored = await openStore(directory).loadCombined(researchState.recordingId);
    assert.ok(restored.ok, !restored.ok ? restored.message : "");
    const finalState = restored.session.state;
    assert.equal(JSON.stringify(finalState.reviewEvents), savedEvents);
    assert.equal(JSON.stringify(finalState.manualAuditTrail), savedManualTrail);
    assert.deepEqual(finalState.research.originalRecording, workflow.recording);
    assert.equal(finalState.research.recording.approvalStatus, "DRAFT");
    const stale = await openStore(directory).saveCombined(loaded.session.state, { expectedRevision: loaded.session.revision });
    assert.ok(!stale.ok && stale.code === "REVISION_CONFLICT");

    // 11. Outstanding gaps and review status. Counts, codes, redacted values, and opaque ids only.
    const summary = humanGapReviewSummary(finalState);
    console.log(JSON.stringify({
      mode: "OFFLINE_HUMAN_GAP_REVIEW_DEMO",
      storage: keep ? directory : "temporary folder (removed; pass --keep to inspect)",
      recordingId: finalState.recordingId,
      revisions: {
        researchSave: v1.session.revision,
        upgradedToSchema2: upgraded.session.revision,
        combinedSave: saved.session.revision
      },
      upgradedFrom: restored.session.upgradedFrom,
      reviewEvents: finalState.reviewEvents.map((event) => {
        const research = event.kind === "RESEARCH" ? finalState.research.auditTrail[event.auditSequence - 1] : null;
        const manual = event.kind === "MANUAL" ? finalState.manualAuditTrail[event.auditSequence - 1] : null;
        return {
          sequence: event.sequence,
          kind: event.kind,
          reviewId: event.reviewId,
          action: research?.action ?? manual?.action,
          subject: research ? research.field : manual?.gapCode
        };
      }),
      manualAuditTrail: publicHumanGapAuditTrail(finalState).map((entry) => ({
        sequence: entry.sequence,
        eventSequence: entry.eventSequence,
        reviewer: entry.reviewer.reviewerId,
        reviewedAt: entry.reviewedAt,
        action: entry.action,
        outcome: entry.outcome,
        gap: entry.gapCode,
        changedFields: entry.changedFields,
        previousValues: entry.previousValues,
        resultingValues: entry.resultingValues,
        note: entry.note
      })),
      refusedDecisions: restored.session.refusedDecisions.map((item) => ({
        sequence: item.sequence,
        kind: "kind" in item ? item.kind : "RESEARCH",
        code: item.code,
        note: item.note
      })),
      outstandingGaps: summary.outstanding,
      humanOnlyGaps: summary.humanOnlyGaps,
      readiness: summary.readiness,
      approvalStatus: summary.approvalStatus,
      recordingApprovalRequired: summary.recordingApprovalRequired,
      afterRestart: { staleSessionSave: stale.ok ? "ACCEPTED" : stale.code },
      audioUploaded: false,
      submittedToMediabase: false
    }, null, 2));
  } finally {
    if (!keep) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
