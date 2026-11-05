import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import { createSubmissionCoordinator, localMockDestination, type SubmitOutcome } from "../src/workflow/submissionCoordinator";
// Shared fictional fixtures: mock research/MusicBrainz providers, a fictional verifier, and real WAV files written locally.
import { fullReview, manual, orchardCsv, reviewDesk, stores, workflowOptions, writeWav, type OrchardRow } from "../tests/support/mb10Fixture";

/**
 * Offline MB-10 demonstration of the complete local lifecycle:
 * Orchard import -> audio matching -> MB-06 -> MB-07/MB-09 review saved by
 * MB-08 -> explicit final approval -> validation -> Playwright form filling ->
 * independent DOM preflight -> multipart upload to a loopback mock ->
 * receipt verification -> persisted confirmation.
 *
 * Three fictional recordings: one succeeds, one hits an automatically
 * recoverable problem (a conflict-free audio match is applied, then a 503 is
 * retried), and one is flagged because a human deferred a declaration.
 * No network beyond 127.0.0.1, no paid API, no real Mediabase.
 */

const ROWS: Record<"clean" | "recoverable" | "flagged", OrchardRow> = {
  clean: { track: "Fictional Morning", artist: "Fictional Artist", isrc: "USAAA2600021" },
  recoverable: { track: "Fictional Noon", artist: "Fictional Artist", isrc: "USAAA2600022" },
  flagged: { track: "Fictional Night", artist: "Fictional Artist", isrc: "USAAA2600023" }
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function summarize(outcome: SubmitOutcome) {
  if (!outcome.ok) return { ok: false, code: outcome.code };
  return {
    status: outcome.status,
    alreadySubmitted: outcome.alreadySubmitted,
    networkAttempts: outcome.attempts,
    confirmationId: outcome.confirmation?.confirmationId ?? null,
    exceptions: outcome.exceptions.map((item) => ({ code: item.code, kind: item.kind, field: item.field })),
    preflightFailures: outcome.preflightFailures.map((item) => item.code),
    timingsMs: outcome.timingsMs
  };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const directory = await fs.mkdtemp(join(tmpdir(), "mediabase-mb10-demo-"));
  const server = await startMockMediabaseServer();
  const browser = await chromium.launch();
  const started = performance.now();
  try {
    const storage = stores("json", directory);
    const open = () => {
      const { reviewStore, ledger } = storage.open();
      return createSubmissionCoordinator({
        reviewStore,
        ledger,
        destination: localMockDestination(server.baseUrl),
        workflow: workflowOptions,
        policy: { retryDelaysMs: [100, 200] }
      });
    };

    // 1. Import: a fictional Orchard CSV and real (silent) WAV files with embedded tags.
    const audioPaths = Object.values(ROWS).map((row) => writeWav(directory, `${row.track.toLowerCase().replace(/ /g, "-")}.wav`, {
      artist: row.artist, title: row.track, album: "Fictional Album", isrc: row.isrc
    }));
    const coordinator = open();
    const imported = await coordinator.importRecordings({ csv: orchardCsv(Object.values(ROWS)), sourceName: "fictional-orchard-export.csv", audioPaths });
    const ids = imported.map((item) => {
      assert.ok(item.ok, !item.ok ? item.message : "");
      return item.recordingId;
    });
    const [cleanId, recoverableId, flaggedId] = ids;
    const beforeReview = await coordinator.evaluate(cleanId);
    assert.ok(beforeReview.ok && beforeReview.status === "NEEDS_ATTENTION");

    // 2. Human review through MB-07 (research) and MB-09 (human-only gaps), saved by MB-08.
    const { reviewStore } = storage.open();
    await reviewDesk(reviewStore, cleanId, fullReview(ROWS.clean.artist));
    await reviewDesk(reviewStore, recoverableId, fullReview(ROWS.recoverable.artist));
    const flaggedSteps = fullReview(ROWS.flagged.artist).slice(0, -1);
    await reviewDesk(reviewStore, flaggedId, [...flaggedSteps,
      manual("declaration-unanswered", { action: "DEFER" }, { field: "canadianContentDeclaration", note: "Waiting for the label's CanCon answer." })]);

    // 3. Explicit final approval by a person, bound to the reviewed content and audio bytes.
    const approvals: Record<string, string> = {};
    for (const id of ids) {
      const basis = await coordinator.approvalBasis(id);
      assert.ok(basis.ok);
      const result = await coordinator.approve({
        recordingId: id, approvalId: `demo-approval-${id}`, approvedBy: { reviewerId: "brad", displayName: "Brad (fictional approver)" },
        approvedAt: "2026-11-05T10:00:00.000Z", basis: basis.basis
      });
      approvals[id] = result.ok ? "APPROVED_FOR_SUBMISSION" : result.code;
    }
    assert.equal(approvals[flaggedId], "APPROVAL_REFUSED");

    // 4. Simulated restart, then the queue: the mock is temporarily unavailable once for the second recording.
    const restarted = open();
    server.enqueue({ kind: "success" }, { kind: "unavailable" }, { kind: "success" });
    const outcomes = await restarted.processQueue(ids, { openPage: () => browser.newPage() });
    const byId = Object.fromEntries(ids.map((id, index) => [id, outcomes[index]]));
    assert.ok(byId[cleanId].ok && byId[cleanId].status === "SUBMITTED");
    assert.ok(byId[recoverableId].ok && byId[recoverableId].status === "SUBMITTED" && byId[recoverableId].attempts === 2);
    assert.ok(byId[flaggedId].ok && byId[flaggedId].status === "NEEDS_ATTENTION");

    // 5. Running the queue again submits nothing twice.
    const again = await open().processQueue(ids, { openPage: () => browser.newPage() });
    assert.equal(server.receipts().length, 2);

    // 6. What the mock actually received, checked against the source files.
    const receipts = await Promise.all(server.receipts().map(async (receipt) => {
      const path = audioPaths.find((item) => item.endsWith(receipt.files[0].fileName))!;
      const bytes = await fs.readFile(path);
      return {
        submissionId: receipt.submissionId,
        confirmationId: receipt.confirmationId,
        files: receipt.files.length,
        fileName: receipt.files[0].fileName,
        size: receipt.files[0].size,
        sha256MatchesSource: receipt.files[0].sha256 === sha256(bytes)
      };
    }));
    assert.ok(receipts.every((item) => item.files === 1 && item.sha256MatchesSource));

    const final = open();
    const ledger = await Promise.all(ids.map(async (id) => {
      const status = await final.status(id);
      assert.ok(status.ok);
      const entry = status.entry;
      return {
        recordingId: id,
        status: entry.status,
        confirmation: entry.confirmation?.confirmationId ?? null,
        statusHistory: entry.statusHistory.map((item) => item.status),
        automaticCorrections: entry.corrections.map((item) => `${item.code} (${item.rule})`),
        attempts: entry.attempts.map((item) => ({ status: item.status, errorCode: item.errorCode, receiptVerified: item.receipt?.verified ?? null })),
        openExceptions: entry.exceptions.map((item) => `${item.code}:${item.field ?? "-"} [${item.kind}]`),
        warnings: entry.warnings.length
      };
    }));

    const metrics = [coordinator.metrics(), restarted.metrics()];
    console.log(JSON.stringify({
      mode: "OFFLINE_MB10_END_TO_END_DEMO",
      destination: "local mock on 127.0.0.1 (real Mediabase is refused by the safety guard)",
      storage: keep ? directory : "temporary folder (removed; pass --keep to inspect)",
      approvals: Object.fromEntries(Object.entries(approvals).map(([id, value]) => [id, value])),
      queue: Object.fromEntries(Object.entries(byId).map(([id, outcome]) => [id, summarize(outcome)])),
      secondRun: again.map((item) => (item.ok ? { status: item.status, alreadySubmitted: item.alreadySubmitted } : { code: item.code })),
      mockReceipts: receipts,
      ledger,
      usage: {
        counters: { import: metrics[0].counters, submission: metrics[1].counters },
        timingsMs: { import: metrics[0].timingsMs, submission: metrics[1].timingsMs, total: Math.round(performance.now() - started) },
        researchUsage: metrics[0].researchUsage,
        cost: "not computed: mock providers, and no API prices are configured"
      },
      liveMediabaseContacted: false,
      note: "SUBMITTED here means the local mock verified the upload; it is not a confirmed live Mediabase submission."
    }, null, 2));
  } finally {
    await browser.close();
    await server.close();
    if (!keep) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
