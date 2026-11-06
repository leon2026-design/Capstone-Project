import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFileReviewStorage } from "../src/storage/reviewStorageBackend";
import { type HumanReviewState } from "../src/workflow/humanReview";
import {
  applyReviewDecisionsWithRefusalLog,
  createReviewSessionStore,
  type ReviewSessionStore
} from "../src/workflow/reviewSessionStore";
// Shared fictional MB-06/MB-07 fixture: mock providers and a fictional verifier, no network access.
import { decide, setup } from "../tests/support/reviewFixture";

/**
 * Offline MB-08 demonstration: review, save, "close", restore, continue.
 * Uses fictional data in a temporary folder (removed afterwards unless --keep
 * is passed). No network, paid API, or Mediabase access; nothing is approved
 * or submitted.
 */
const DEMO_KEY = "fictional-offline-demo-key-not-a-secret";

function openStore(directory: string): ReviewSessionStore {
  return createReviewSessionStore(createJsonFileReviewStorage(directory), { integrityKey: DEMO_KEY });
}

function auditSummary(state: HumanReviewState) {
  return state.auditTrail.map((entry) => ({
    sequence: entry.sequence,
    reviewer: entry.reviewer.reviewerId,
    reviewedAt: entry.reviewedAt,
    action: entry.action,
    field: entry.field,
    source: entry.source,
    previousValue: entry.previousValue,
    resultingValue: entry.resultingValue,
    evidenceUrls: [...new Set(entry.evidence.map((item) => item.url))],
    note: entry.note
  }));
}

async function main() {
  const keep = process.argv.includes("--keep");
  const directory = await fs.mkdtemp(join(tmpdir(), "mediabase-review-demo-"));
  try {
    // 1. Start a review session from the MB-06 result.
    const { state: started, workflow } = await setup();

    // 2. Apply several human decisions. MB-07 refuses approving conflicting evidence; the refusal is logged.
    const first = applyReviewDecisionsWithRefusalLog({ state: started, refusedDecisions: [] }, [
      decide(started, "label", "APPROVE_SUGGESTED_VALUE", { note: "Matches the label catalog." }),
      decide(started, "officialReleaseDate", "EDIT_SUGGESTED_VALUE", {
        editedValue: "11/14/2026", note: "Label confirmed the earlier street date."
      }),
      decide(started, "albumUPC", "REJECT_SUGGESTION", { note: "Research UPC not confirmed by distributor." }),
      decide(started, "albumReleaseDate", "APPROVE_SUGGESTED_VALUE", { note: "Looks right." }),
      decide(started, "albumReleaseDate", "DEFER_DECISION", { note: "Waiting for the label." })
    ]);
    assert.deepEqual(first.rejected.map((item) => item.code), ["CONFLICT_REQUIRES_EXPLICIT_RESOLUTION"]);

    // 3. Save the review state and its refusal log.
    const saved = await openStore(directory).save(first.state, {
      expectedRevision: 0, sessionId: "demo-session-1", refusedDecisions: first.refusedDecisions
    });
    assert.ok(saved.ok, !saved.ok ? saved.message : "");

    // 4. Simulate closing the application: nothing from the first session is reused below.
    const firstAuditTrail = JSON.stringify(first.state.auditTrail);
    const firstRefusals = JSON.stringify(first.refusedDecisions);
    const replayAttempt = decide(first.state, "label", "APPROVE_SUGGESTED_VALUE", {
      reviewId: first.state.auditTrail[0].reviewId
    });

    // 5. Restore the saved state with a fresh store.
    const loaded = await openStore(directory).load(first.state.recordingId);
    assert.ok(loaded.ok, !loaded.ok ? loaded.message : "");
    const restored = loaded.session.state;
    assert.equal(JSON.stringify(restored.auditTrail), firstAuditTrail);
    assert.equal(JSON.stringify(loaded.session.refusedDecisions), firstRefusals);

    // 6. Continue reviewing: a replayed decision is still refused (and logged); the deferred decision is resolved.
    const continued = applyReviewDecisionsWithRefusalLog(loaded.session, [
      replayAttempt,
      decide(restored, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
        source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Release sleeve confirms the MusicBrainz date."
      })
    ]);
    assert.deepEqual(continued.rejected.map((item) => item.code), ["DUPLICATE_REVIEW"]);
    assert.equal(continued.applied.length, 1);
    const second = await openStore(directory).save(continued.state, {
      expectedRevision: loaded.session.revision, sessionId: "demo-session-2", refusedDecisions: continued.refusedDecisions
    });
    assert.ok(second.ok && second.session.revision === 2);

    // An out-of-date session cannot overwrite the newer decisions.
    const outdated = await openStore(directory).save(restored, { expectedRevision: 1 });
    assert.ok(!outdated.ok && outdated.code === "REVISION_CONFLICT");

    // 7. Confirm earlier decisions, refusals, and audit entries are intact.
    const final = await openStore(directory).load(first.state.recordingId);
    assert.ok(final.ok);
    const finalState = final.session.state;
    assert.equal(JSON.stringify(finalState.auditTrail.slice(0, 4)), firstAuditTrail);
    assert.equal(finalState.auditTrail.length, 5);
    assert.equal(JSON.stringify(final.session.refusedDecisions.slice(0, 1)), firstRefusals);
    assert.equal(final.session.refusedDecisions.length, 2);
    assert.deepEqual(finalState.originalRecording, workflow.recording);
    assert.equal(finalState.recording.approvalStatus, "DRAFT");

    console.log(JSON.stringify({
      mode: "OFFLINE_REVIEW_PERSISTENCE_DEMO",
      storage: keep ? directory : "temporary folder (removed; pass --keep to inspect)",
      recordingId: finalState.recordingId,
      revisions: { firstSave: saved.session.revision, afterRestore: second.session.revision },
      afterRestart: {
        replayedDecision: continued.rejected[0]?.code ?? "ACCEPTED",
        outdatedSessionSave: outdated.ok ? "ACCEPTED" : outdated.code
      },
      decisions: finalState.decisions.map((item) => ({
        field: item.decision.field,
        status: item.status,
        acceptedValue: item.acceptedValue,
        findings: item.findingReviews.map((finding) => `${finding.source}:${finding.status}`)
      })),
      auditTrail: auditSummary(finalState),
      refusedDecisions: final.session.refusedDecisions.map((item) => ({
        sequence: item.sequence,
        reviewer: item.reviewer?.reviewerId ?? null,
        action: item.action,
        field: item.field,
        code: item.code,
        note: item.note
      })),
      stored: (await openStore(directory).list()),
      approvalStatus: finalState.recording.approvalStatus,
      recordingApprovalRequired: finalState.recordingApprovalRequired,
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
