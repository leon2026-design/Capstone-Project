import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "@playwright/test";
import { createJsonFileReviewStorage } from "../src/storage/reviewStorageBackend";
import { createAudioPreparationStore } from "../src/submission/audioPreparationStore";
import { prepareAudioArtifact } from "../src/submission/audioPreparation";
import { SAFE_FILENAME_PROFILE } from "../src/submission/namingProfile";
import { createSubmissionCoordinator, localMockDestination } from "../src/workflow/submissionCoordinator";
import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import {
  MB10_KEY,
  fullReview,
  orchardCsv,
  reviewDesk,
  stores,
  workflowOptions,
  type OrchardRow
} from "../tests/support/mb10Fixture";
import { buildMp3, writeFixture } from "../tests/support/audioFixtures";
import { TECHNICAL_TEST_CONTRACT } from "../tests/support/clientContractFixture";

const ROWS: OrchardRow[] = [
  { track: "Fictional Fully Tagged", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600111" },
  { track: "Fictional Tag Recovery", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600112" },
  { track: "Fictional Unresolved", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600113" }
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const directory = await fs.mkdtemp(join(tmpdir(), "mediabase-mb11-demo-"));
  const server = await startMockMediabaseServer();
  const browser = await chromium.launch();
  const started = performance.now();
  try {
    const storage = stores("json", directory);
    const preparationStore = createAudioPreparationStore(
      createJsonFileReviewStorage(join(directory, "preparations")),
      { integrityKey: MB10_KEY }
    );
    const openCoordinator = () => {
      const { reviewStore, ledger } = storage.open();
      return createSubmissionCoordinator({
        reviewStore,
        ledger,
        audioPreparationStore: preparationStore,
        clientMetadataContract: TECHNICAL_TEST_CONTRACT,
        policy: { allowUploadRename: true },
        destination: localMockDestination(server.baseUrl),
        workflow: workflowOptions,
        namingProfile: SAFE_FILENAME_PROFILE
      });
    };

    const sourcePaths = ROWS.map((row, index) => writeFixture(
      join(directory, `source-${index + 1}.mp3`),
      index === 1
        ? buildMp3({ artist: row.artist, title: row.track, isrc: row.isrc })
        : buildMp3({ artist: row.artist, title: row.track, album: row.product, isrc: row.isrc })
    ));
    const coordinator = openCoordinator();
    const imported = await coordinator.importRecordings({
      csv: orchardCsv(ROWS),
      sourceName: "fictional-mb11-orchard.csv",
      audioPaths: sourcePaths
    });
    const recordingIds = imported.map((item) => {
      assert.ok(item.ok, !item.ok ? item.message : "");
      return item.recordingId;
    });
    const { reviewStore } = storage.open();
    for (let index = 0; index < recordingIds.length; index += 1) {
      await reviewDesk(reviewStore, recordingIds[index], fullReview(ROWS[index].artist));
    }

    const preparationTimings: Record<string, Record<string, number>> = {};
    const preparedArtifacts: Record<string, { path: string; sha256: string }> = {};
    for (let index = 0; index < recordingIds.length; index += 1) {
      const loaded = await reviewStore.loadCombined(recordingIds[index]);
      assert.ok(loaded.ok, !loaded.ok ? loaded.message : "");
      if (!loaded.ok) continue;
      const input = {
        recording: loaded.session.state.research.recording,
        sourceAudioPath: sourcePaths[index],
        outputDirectory: join(directory, "prepared"),
        namingProfile: SAFE_FILENAME_PROFILE,
        clientContract: TECHNICAL_TEST_CONTRACT,
        manifestStore: preparationStore
      };
      const prepared = index === 2
        ? await prepareAudioArtifact({
          ...input,
          tagProfile: {
            id: "fictional-required-genre",
            version: "1",
            requiredFields: ["title", "artist", "genre"],
            mappings: ["title", "artist", "genre"],
            unresolvedSponsorMappings: ["genre vocabulary requires sponsor decision"]
          }
        })
        : await prepareAudioArtifact(input);
      preparationTimings[recordingIds[index]] = prepared.timingsMs;
      if (index < 2) {
        assert.ok(prepared.ok, !prepared.ok ? JSON.stringify(prepared.failures) : "");
        if (prepared.ok) preparedArtifacts[recordingIds[index]] = prepared.artifact;
        if (prepared.ok && index === 1) {
          assert.ok(prepared.manifest.corrections.some((correction) => correction.code === "MISSING_TAG_WRITTEN"));
        }
      } else {
        assert.ok(!prepared.ok);
        if (!prepared.ok) assert.equal(prepared.failures[0].code, "REQUIRED_TAG_VALUE_MISSING");
      }
    }

    const approvalResults: Record<string, string> = {};
    for (const recordingId of recordingIds.slice(0, 2)) {
      const basis = await coordinator.approvalBasis(recordingId);
      assert.ok(basis.ok, !basis.ok ? basis.message : "");
      if (!basis.ok) continue;
      const approved = await coordinator.approve({
        recordingId,
        approvalId: `fictional-mb11-approval-${recordingId}`,
        approvedBy: { reviewerId: "fictional-human-approver", displayName: "Fictional Approver" },
        approvedAt: "2026-11-06T12:00:00.000Z",
        basis: basis.basis
      });
      approvalResults[recordingId] = approved.ok ? "APPROVED_FOR_LOCAL_SUBMISSION" : approved.code;
      assert.ok(approved.ok, !approved.ok ? JSON.stringify({
        message: approved.message,
        exceptions: approved.exceptions
      }) : "");
    }

    const resumed = openCoordinator();
    const outcomes = await resumed.processQueue(recordingIds, { openPage: () => browser.newPage() });
    const receipts = await Promise.all(server.receipts().map(async (receipt) => {
      const index = sourcePaths.findIndex((path) => basename(path) === receipt.files[0]?.fileName);
      const recordingId = index >= 0 ? recordingIds[index] : null;
      const artifact = recordingId ? preparedArtifacts[recordingId] : undefined;
      return {
        recordingId,
        confirmationId: receipt.confirmationId,
        fileCount: receipt.files.length,
        fileName: receipt.files[0]?.fileName ?? null,
        size: receipt.files[0]?.size ?? null,
        sha256MatchesPrepared: receipt.files.length === 1 && !!artifact &&
          receipt.files[0].sha256 === artifact.sha256 &&
          artifact.sha256 === sha256(await fs.readFile(artifact.path))
      };
    }));
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((receipt) => receipt.fileCount === 1 && receipt.sha256MatchesPrepared));
    const unresolved = await resumed.evaluate(recordingIds[2]);
    assert.ok(unresolved.ok);

    const metrics = resumed.metrics();
    console.log(JSON.stringify({
      mode: "OFFLINE_MB11_AUDIO_PREPARATION_AND_MOCK_SUBMISSION",
      destination: "loopback-only local mock",
      storage: keep ? directory : "temporary folder (removed; pass --keep to inspect)",
      records: recordingIds.map((recordingId, index) => ({
        recordingId,
        title: ROWS[index].track,
        preparation: index === 2 ? "BLOCKED: required genre needs sponsor decision" :
          index === 1 ? "PREPARED: missing tags deterministically filled from reviewed metadata" : "PREPARED",
        approval: approvalResults[recordingId] ?? "NOT_APPROVED",
        submission: outcomes[index].ok ? outcomes[index].status : outcomes[index].code,
        unresolvedExceptions: index === 2 && unresolved.ok ? unresolved.exceptions.map((item) => item.code) : []
      })),
      mockReceipts: receipts,
      preparationTimingsMs: preparationTimings,
      workflowMetrics: {
        counters: metrics.counters,
        timingsMs: { ...metrics.timingsMs, total: Math.round(performance.now() - started) },
        researchUsage: metrics.researchUsage,
        cost: metrics.cost
      },
      liveMediabaseContacted: false,
      note: "A local mock receipt is not a live Mediabase confirmation."
    }, null, 2));
  } finally {
    await browser.close();
    await server.close();
    if (!keep) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
