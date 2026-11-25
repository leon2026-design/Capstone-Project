import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createJsonFileReviewStorage } from "../src/storage/reviewStorageBackend";
import { createAudioPreparationStore } from "../src/submission/audioPreparationStore";
import { prepareAudioArtifact, type AudioPreparationResult, type PreparedAudioArtifact } from "../src/submission/audioPreparation";
import { SPONSOR_TITLE_NAMING_PROFILE } from "../src/submission/namingProfile";
import { createSubmissionCoordinator, localMockDestination } from "../src/workflow/submissionCoordinator";
import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import {
  MB10_KEY, fullReview, orchardCsv, reviewDesk, stores, workflowOptions, type OrchardRow
} from "../tests/support/mb10Fixture";
import { buildId3Tag, buildMp3, buildWav, writeFixture } from "../tests/support/audioFixtures";
import { TECHNICAL_TEST_CONTRACT } from "../tests/support/clientContractFixture";

const ROWS: OrchardRow[] = [
  { track: "Fictional Fully Tagged", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600111" },
  { track: "Fictional WAV Recovery", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600112" },
  { track: "Fictional Unknown (Radio)", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600113" },
  { track: "Fictional Identity Conflict", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600114" },
  { track: "Fictional Missing ISRC", artist: "Fictional Artist", product: "Fictional Album" }
];

const technicalContract = {
  ...TECHNICAL_TEST_CONTRACT,
  id: "fictional-demo-technical",
  namingProfileId: SPONSOR_TITLE_NAMING_PROFILE.id
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const directory = await fs.mkdtemp(join(tmpdir(), "mediabase-mb11-demo-"));
  const server = await startMockMediabaseServer();
  const browser = await chromium.launch();
  const started = performance.now();
  try {
    const storage = stores("json", directory);
    const preparationStore = createAudioPreparationStore(
      createJsonFileReviewStorage(join(directory, "preparations")), { integrityKey: MB10_KEY }
    );
    const openCoordinator = () => {
      const { reviewStore, ledger } = storage.open();
      return createSubmissionCoordinator({
        reviewStore, ledger, audioPreparationStore: preparationStore,
        clientMetadataContract: technicalContract,
        namingProfile: SPONSOR_TITLE_NAMING_PROFILE,
        policy: { allowUploadRename: true },
        destination: localMockDestination(server.baseUrl), workflow: workflowOptions
      });
    };

    const sourcePaths = ROWS.map((row, index) => {
      const tags = { artist: row.artist, title: row.track, album: row.product, isrc: row.isrc };
      if (index === 1) {
        return writeFixture(join(directory, "source-2.wav"), buildWav({
          id3Bytes: buildId3Tag({ artist: row.artist, title: row.track, isrc: row.isrc }, 4),
          riffInfo: { artist: row.artist, title: row.track }
        }));
      }
      return writeFixture(join(directory, `source-${index + 1}.mp3`), buildMp3(
        index === 3 ? { ...tags, isrc: "USZZZ2600999" } : tags
      ));
    });
    const sourceHashes = await Promise.all(sourcePaths.map(async (path) => sha256(await fs.readFile(path))));
    const coordinator = openCoordinator();
    const imported = await coordinator.importRecordings({
      csv: orchardCsv(ROWS), sourceName: "fictional-mb11-orchard.csv", audioPaths: sourcePaths
    });
    const recordingIds = imported.map((item) => {
      assert.ok(item.ok, !item.ok ? item.message : "");
      return item.recordingId;
    });
    const { reviewStore } = storage.open();
    for (let index = 0; index < recordingIds.length; index += 1) {
      await reviewDesk(reviewStore, recordingIds[index], fullReview(ROWS[index].artist));
    }

    const preparations: AudioPreparationResult[] = [];
    const artifacts = new Map<string, PreparedAudioArtifact>();
    for (let index = 0; index < recordingIds.length; index += 1) {
      const loaded = await reviewStore.loadCombined(recordingIds[index]);
      assert.ok(loaded.ok, !loaded.ok ? loaded.message : "");
      const result = await prepareAudioArtifact({
        recording: loaded.session.state.research.recording,
        sourceAudioPath: sourcePaths[index],
        outputDirectory: join(directory, "prepared"),
        namingProfile: SPONSOR_TITLE_NAMING_PROFILE,
        manifestStore: preparationStore,
        ...(index === 0 || index === 1 || index === 3 ? { clientContract: technicalContract } : {})
      });
      preparations.push(result);
      if (index < 2) {
        assert.ok(result.ok, !result.ok ? JSON.stringify(result.failures) : "");
        artifacts.set(recordingIds[index], result.artifact);
        if (index === 1) assert.ok(result.manifest.corrections.some((item) => item.field === "album"));
      } else {
        assert.ok(!result.ok);
        const expected = index === 2 ? "CLEAN_EXPLICIT_UNKNOWN" :
          index === 3 ? "CONFLICTING_ISRC" : "REQUIRED_TAG_VALUE_MISSING";
        assert.ok(result.failures.some((item) => item.code === expected && (index !== 4 || item.field === "isrc")));
      }
    }

    const approvals: Record<string, string> = {};
    for (const recordingId of recordingIds.slice(0, 2)) {
      const basis = await coordinator.approvalBasis(recordingId);
      assert.ok(basis.ok, !basis.ok ? basis.message : "");
      const approved = await coordinator.approve({
        recordingId, approvalId: `fictional-approval-${recordingId}`,
        approvedBy: { reviewerId: "fictional-human-approver", displayName: "Fictional Approver" },
        approvedAt: "2026-11-06T12:00:00.000Z", basis: basis.basis
      });
      assert.ok(approved.ok, !approved.ok ? JSON.stringify(approved) : "");
      approvals[recordingId] = approved.status;
    }

    const resumed = openCoordinator();
    const outcomes = await resumed.processQueue(recordingIds, { openPage: () => browser.newPage() });
    assert.ok(outcomes.slice(0, 2).every((item) => item.ok && item.status === "SUBMITTED"));
    const receipts = await Promise.all(server.receipts().map(async (receipt) => {
      const match = [...artifacts.entries()].find(([, artifact]) => artifact.uploadFileName === receipt.files[0]?.fileName);
      assert.ok(match);
      const [recordingId, artifact] = match;
      const preparedHash = sha256(await fs.readFile(artifact.path));
      return {
        recordingId, confirmationId: receipt.confirmationId,
        fileName: receipt.files[0].fileName, size: receipt.files[0].size,
        sha256MatchesPrepared: receipt.files.length === 1 &&
          receipt.files[0].sha256 === artifact.sha256 && artifact.sha256 === preparedHash
      };
    }));
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((receipt) => receipt.sha256MatchesPrepared));
    const repeated = await resumed.processQueue(recordingIds, { openPage: () => browser.newPage() });
    assert.ok(repeated.slice(0, 2).every((item) => item.ok && item.alreadySubmitted));
    assert.equal(server.receipts().length, 2);
    assert.equal(server.requests().length, 2);
    for (let index = 0; index < sourcePaths.length; index += 1) {
      assert.equal(sha256(await fs.readFile(sourcePaths[index])), sourceHashes[index]);
    }

    console.log(JSON.stringify({
      mode: "OFFLINE_MB11_AUDIO_PREPARATION_AND_MOCK_SUBMISSION",
      destination: "loopback-only local mock",
      storage: keep ? directory : "temporary folder (removed; pass --keep to inspect)",
      technicalFixtureContract: "Fictional test policy for supported encodings, not the strict sponsor contract.",
      strictSponsorContract: "Missing values and unconfirmed publisher/content-rating mappings remain blocking.",
      records: recordingIds.map((recordingId, index) => {
        const preparation = preparations[index];
        const artifact = artifacts.get(recordingId);
        return {
          recordingId, title: ROWS[index].track,
          contract: index === 0 || index === 1 || index === 3 ? technicalContract.id : "sponsor-recording-metadata",
          preparation: preparation.ok ? preparation.manifest.preparationStatus : "BLOCKED",
          failures: preparation.ok ? [] : preparation.failures.map((item) => ({
            code: item.code, field: item.field, stage: item.stage, message: item.message,
            evidenceReferences: item.evidenceReferences, recoveryAttempted: item.recoveryAttempted,
            recoveryAction: item.recoveryAction, recoverySucceeded: item.recoverySucceeded,
            humanInterventionRequired: item.humanInterventionRequired, recommendedAction: item.recommendedAction
          })),
          recoveredFields: preparation.ok ? preparation.manifest.corrections.map((item) => item.field) : [],
          sourceSha256: sourceHashes[index], preparedSha256: artifact?.sha256 ?? null,
          sourceUnchanged: true, approval: approvals[recordingId] ?? "NOT_APPROVED",
          submission: outcomes[index].ok ? outcomes[index].status : outcomes[index].code
        };
      }),
      mockReceipts: receipts,
      secondQueueRunDidNotResubmit: true,
      workflowMetrics: { ...resumed.metrics(), totalMs: Math.round(performance.now() - started) },
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
