
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import {
  createSubmissionCoordinator,
  localMockDestination,
  type SubmitOutcome
} from "../src/workflow/submissionCoordinator";

import {
  fullReview,
  manual,
  orchardCsv,
  reviewDesk,
  stores,
  workflowOptions,
  writeWav,
  type OrchardRow
} from "../tests/support/mb10Fixture";

/**
 * Offline MB-10 demonstration.
 *
 * Workflow:
 * Orchard import
 * -> Audio matching
 * -> Research and human review
 * -> Explicit final approval
 * -> Validation
 * -> Playwright form filling
 * -> Mock audio submission
 * -> Receipt verification
 * -> Persisted confirmation
 *
 * Three fictional recordings:
 * 1. Clean submission succeeds.
 * 2. Recoverable submission retries after a simulated HTTP 503.
 * 3. Flagged submission is blocked by unresolved human review.
 *
 * All submission traffic is restricted to the local mock.
 * No production Mediabase submissions or paid API calls.
 */

const ROWS: Record<"clean" | "recoverable" | "flagged", OrchardRow> = {
  clean: {
    track: "Fictional Morning",
    artist: "Fictional Artist",
    isrc: "USAAA2600021"
  },
  recoverable: {
    track: "Fictional Noon",
    artist: "Fictional Artist",
    isrc: "USAAA2600022"
  },
  flagged: {
    track: "Fictional Night",
    artist: "Fictional Artist",
    isrc: "USAAA2600023"
  }
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function summarize(outcome: SubmitOutcome) {
  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code
    };
  }

  return {
    status: outcome.status,
    alreadySubmitted: outcome.alreadySubmitted,
    networkAttempts: outcome.attempts,
    confirmationId: outcome.confirmation?.confirmationId ?? null,
    exceptions: outcome.exceptions.map((item) => ({
      code: item.code,
      kind: item.kind,
      field: item.field
    })),
    preflightFailures: outcome.preflightFailures.map((item) => item.code),
    timingsMs: outcome.timingsMs
  };
}

async function main() {
  console.log("[DEBUG 1] MB-10 demo starting");

  const keep = process.argv.includes("--keep");

  const directory = await fs.mkdtemp(
    join(tmpdir(), "mediabase-mb10-demo-")
  );

  console.log("[DEBUG 2] Temporary directory created:", directory);
  console.log("[DEBUG 3] Starting local mock Mediabase server");

  const server = await startMockMediabaseServer();

  console.log("[DEBUG 4] Mock server started:", server.baseUrl);
  console.log("[DEBUG 5] Launching Chromium");

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  console.log("[DEBUG 6] Chromium launched successfully");

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
        policy: {
          retryDelaysMs: [100, 200]
        }
      });
    };

    // --------------------------------------------------
    // STEP 1: Import fictional Orchard releases
    // --------------------------------------------------

    console.log("[DEMO] Importing fictional Orchard recordings");

    const audioPaths = Object.values(ROWS).map((row) =>
      writeWav(
        directory,
        `${row.track.toLowerCase().replace(/ /g, "-")}.wav`,
        {
          artist: row.artist,
          title: row.track,
          album: "Fictional Album",
          isrc: row.isrc
        }
      )
    );

    const coordinator = open();

    const imported = await coordinator.importRecordings({
      csv: orchardCsv(Object.values(ROWS)),
      sourceName: "fictional-orchard-export.csv",
      audioPaths
    });

    const ids = imported.map((item) => {
      assert.ok(item.ok, !item.ok ? item.message : "");
      return item.recordingId;
    });

    const [cleanId, recoverableId, flaggedId] = ids;

    console.log("[DEMO] Three fictional recordings imported");

    const beforeReview = await coordinator.evaluate(cleanId);

    assert.ok(
      beforeReview.ok &&
      beforeReview.status === "NEEDS_ATTENTION"
    );

    // --------------------------------------------------
    // STEP 2: Simulate human review and metadata research
    // --------------------------------------------------

    console.log("[DEMO] Performing simulated metadata review");

    const { reviewStore } = storage.open();

    await reviewDesk(
      reviewStore,
      cleanId,
      fullReview(ROWS.clean.artist)
    );

    await reviewDesk(
      reviewStore,
      recoverableId,
      fullReview(ROWS.recoverable.artist)
    );

    const flaggedSteps = fullReview(ROWS.flagged.artist).slice(0, -1);

    await reviewDesk(reviewStore, flaggedId, [
      ...flaggedSteps,
      manual(
        "declaration-unanswered",
        { action: "DEFER" },
        {
          field: "canadianContentDeclaration",
          note: "Waiting for the label's CanCon answer."
        }
      )
    ]);

    console.log("[DEMO] Review decisions recorded");

    // --------------------------------------------------
    // STEP 3: Explicit final approval
    // --------------------------------------------------

    console.log("[DEMO] Evaluating final submission approval");

    const approvals: Record<string, string> = {};

    for (const id of ids) {
      const basis = await coordinator.approvalBasis(id);

      assert.ok(basis.ok);

      const result = await coordinator.approve({
        recordingId: id,
        approvalId: `demo-approval-${id}`,
        approvedBy: {
          reviewerId: "brad",
          displayName: "Brad (fictional approver)"
        },
        approvedAt: "2026-11-05T10:00:00.000Z",
        basis: basis.basis
      });

      approvals[id] = result.ok
        ? "APPROVED_FOR_SUBMISSION"
        : result.code;
    }

    assert.equal(approvals[flaggedId], "APPROVAL_REFUSED");

    console.log("[DEMO] Valid releases approved");
    console.log("[DEMO] Incomplete release blocked");

    // --------------------------------------------------
    // STEP 4: Automated browser submission
    // --------------------------------------------------

    console.log("[DEMO] Starting visible browser submissions");

    const restarted = open();

    // First succeeds.
    // Second encounters a temporary 503.
    // Retry succeeds.
    server.enqueue(
      { kind: "success" },
      { kind: "unavailable" },
      { kind: "success" }
    );

    const outcomes = await restarted.processQueue(ids, {
  openPage: async () => {
    const page = await browser.newPage();

    // Recording mode: keep the page visible.
    const originalClose = page.close.bind(page);

    page.close = async (...args) => {
      console.log("[RECORDING] Page close deferred.");
    };

    return page;
  }
});

    const byId = Object.fromEntries(
      ids.map((id, index) => [id, outcomes[index]])
    );

    assert.ok(
      byId[cleanId].ok &&
      byId[cleanId].status === "SUBMITTED"
    );

    assert.ok(
      byId[recoverableId].ok &&
      byId[recoverableId].status === "SUBMITTED" &&
      byId[recoverableId].attempts === 2
    );

    assert.ok(
      byId[flaggedId].ok &&
      byId[flaggedId].status === "NEEDS_ATTENTION"
    );

    console.log("[DEMO] Mock submission workflow completed");

    // --------------------------------------------------
    // STEP 5: Duplicate prevention
    // --------------------------------------------------

    console.log("[DEMO] Checking duplicate submission prevention");

    const again = await open().processQueue(ids, {
      openPage: () => browser.newPage()
    });

    assert.equal(server.receipts().length, 2);

    console.log("[DEMO] Duplicate submissions prevented");

    // --------------------------------------------------
    // STEP 6: Verify uploaded audio and receipts
    // --------------------------------------------------

    console.log("[DEMO] Verifying mock submission receipts");

    const receipts = await Promise.all(
      server.receipts().map(async (receipt) => {
        const path = audioPaths.find((item) =>
          item.endsWith(receipt.files[0].fileName)
        )!;

        const bytes = await fs.readFile(path);

        return {
          submissionId: receipt.submissionId,
          confirmationId: receipt.confirmationId,
          files: receipt.files.length,
          fileName: receipt.files[0].fileName,
          size: receipt.files[0].size,
          sha256MatchesSource:
            receipt.files[0].sha256 === sha256(bytes)
        };
      })
    );

    assert.ok(
      receipts.every(
        (item) =>
          item.files === 1 &&
          item.sha256MatchesSource
      )
    );

    console.log("[DEMO] Audio integrity verified");

    // --------------------------------------------------
    // STEP 7: Inspect persisted submission history
    // --------------------------------------------------

    const final = open();

    const ledger = await Promise.all(
      ids.map(async (id) => {
        const status = await final.status(id);

        assert.ok(status.ok);

        const entry = status.entry;

        return {
          recordingId: id,
          status: entry.status,
          confirmation: entry.confirmation?.confirmationId ?? null,
          statusHistory: entry.statusHistory.map(
            (item) => item.status
          ),
          automaticCorrections: entry.corrections.map(
            (item) => `${item.code} (${item.rule})`
          ),
          attempts: entry.attempts.map((item) => ({
            status: item.status,
            errorCode: item.errorCode,
            receiptVerified: item.receipt?.verified ?? null
          })),
          openExceptions: entry.exceptions.map(
            (item) =>
              `${item.code}:${item.field ?? "-"} [${item.kind}]`
          ),
          warnings: entry.warnings.length
        };
      })
    );

    // --------------------------------------------------
    // STEP 8: Final demonstration results
    // --------------------------------------------------

    const metrics = [
      coordinator.metrics(),
      restarted.metrics()
    ];

    console.log(
      JSON.stringify(
        {
          mode: "OFFLINE_MB10_END_TO_END_DEMO",

          destination:
            "local mock on 127.0.0.1 (real Mediabase is refused by the safety guard)",

          storage: keep
            ? directory
            : "temporary folder (removed; pass --keep to inspect)",

          approvals: Object.fromEntries(
            Object.entries(approvals).map(([id, value]) => [
              id,
              value
            ])
          ),

          queue: Object.fromEntries(
            Object.entries(byId).map(([id, outcome]) => [
              id,
              summarize(outcome)
            ])
          ),

          secondRun: again.map((item) =>
            item.ok
              ? {
                  status: item.status,
                  alreadySubmitted: item.alreadySubmitted
                }
              : {
                  code: item.code
                }
          ),

          mockReceipts: receipts,

          ledger,

          usage: {
            counters: {
              import: metrics[0].counters,
              submission: metrics[1].counters
            },

            timingsMs: {
              import: metrics[0].timingsMs,
              submission: metrics[1].timingsMs,
              total: Math.round(
                performance.now() - started
              )
            },

            researchUsage: metrics[0].researchUsage,

            cost:
              "not computed: mock providers, and no API prices are configured"
          },

          liveMediabaseContacted: false,

          note:
            "SUBMITTED here means the local mock verified the upload; it is not a confirmed live Mediabase submission."
        },
        null,
        2
      )
    );

    // --------------------------------------------------
    // RECORDING PAUSE
    // --------------------------------------------------

    console.log(
      "\n[DEMO COMPLETE] Press Enter to close Chromium."
    );

    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

  } finally {
    console.log("[CLEANUP] Closing browser and mock server");

    await browser.close();
    await server.close();

    if (!keep) {
      await fs.rm(directory, {
        recursive: true,
        force: true
      });
    }
  }
}

// --------------------------------------------------
// ENTRY POINT
// --------------------------------------------------

console.log("[ENTRY] Loading MB-10 demonstration");

main().catch((error) => {
  console.error("[FATAL ERROR]", error);
  process.exitCode = 1;
});
