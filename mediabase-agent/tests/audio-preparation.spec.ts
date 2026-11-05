import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import NodeID3 = require("node-id3");
import { createArtistAttributionDecision, confirmArtistAttribution } from "../src/metadata/artistAttribution";
import type { DemoRecording } from "../src/metadata/recordValidation";
import { BASIC_MP3_TAG_PROFILE, DEFAULT_MP3_TAG_PROFILE, type AudioTagProfile } from "../src/submission/audioTagProfile";
import {
  prepareAudioArtifact,
  prepareAudioArtifactsBatch,
  extractMpegAudioPayload
} from "../src/submission/audioPreparation";
import { createAudioPreparationStore } from "../src/submission/audioPreparationStore";
import {
  BASIC_FILENAME_PROFILE,
  createConfigurableNamingProfile,
  findNamingCollisions,
  type NamingInput
} from "../src/submission/namingProfile";
import { createInMemoryReviewStorage } from "../src/storage/reviewStorageBackend";
import { createSubmissionLedger } from "../src/submission/submissionLedger";
import { createSubmissionCoordinator, localMockDestination } from "../src/workflow/submissionCoordinator";
import { createReviewSessionStore } from "../src/workflow/reviewSessionStore";
import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import { chromium } from "@playwright/test";
import { fixture } from "./support/reviewFixture";
import { buildMp3, buildWav, writeFixture } from "./support/audioFixtures";
import { MB10_KEY, fullReview, orchardCsv, reviewDesk, workflowOptions } from "./support/mb10Fixture";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvedRecord(): DemoRecording {
  const { record } = fixture();
  const decision = createArtistAttributionDecision("Fictional Artist", "Fictional Artist");
  return {
    ...record,
    artist: "Fictional Artist",
    artistAttribution: confirmArtistAttribution(decision, {
      exactArtist: "Fictional Artist",
      primaryArtist: "Fictional Artist"
    }),
    officialReleaseDate: "11/15/2026",
    albumTitle: "Fictional Album",
    comments: "Approved fictional comment",
    approvalStatus: "DRAFT"
  };
}

test("writes and independently verifies trusted MP3 tags in a separate artifact", async ({}, testInfo) => {
  const root = testInfo.outputPath("prepare");
  const source = writeFixture(testInfo.outputPath("source.mp3"), buildMp3());
  const before = await fs.readFile(source);
  const result = await prepareAudioArtifact({
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: root,
    tagProfile: DEFAULT_MP3_TAG_PROFILE
  });

  expect(result.ok, !result.ok ? JSON.stringify(result.failures) : "").toBe(true);
  if (!result.ok) return;
  expect(result.artifact.path).not.toBe(source);
  expect(result.manifest.preparationStatus).toBe("PREPARED");
  expect(result.manifest.tagVerificationStatus).toBe("MATCH");
  expect(result.manifest.audioIntegrityVerified).toBe(true);
  expect(await fs.readFile(source)).toEqual(before);
  expect(extractMpegAudioPayload(await fs.readFile(result.artifact.path)))
    .toEqual(extractMpegAudioPayload(before));
  expect(result.artifact.metadata).toMatchObject({
    artist: "Fictional Artist",
    title: "Fictional Song",
    album: "Fictional Album",
    isrc: "USAAA2600010",
    year: "2026"
  });
  expect(result.manifest.preparedSha256).toBe(digest(await fs.readFile(result.artifact.path)));
});

test("writes additional approved fields and preserves unrelated ID3 metadata", async ({}, testInfo) => {
  const artwork = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const source = writeFixture(testInfo.outputPath("existing.mp3"), await NodeID3.Promise.update({
    userDefinedText: [{ description: "EXTERNAL", value: "preserve-this" }],
    image: { mime: "image/png", type: { id: 3 }, description: "Fictional cover", imageBuffer: artwork },
    comment: { language: "eng", text: "Approved fictional comment" }
  }, buildMp3()));
  const profile: AudioTagProfile = {
    id: "fictional-complete-tags",
    version: "2",
    requiredFields: ["title", "artist", "genre"],
    mappings: [...DEFAULT_MP3_TAG_PROFILE.mappings, "genre"],
    unresolvedSponsorMappings: ["Rye M"]
  };
  const result = await prepareAudioArtifact({
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: testInfo.outputPath("prepared"),
    tagProfile: profile,
    explicitValues: { genre: { value: "Fictional Genre", sourceReference: "fictional-catalog", approvedBy: "reviewer-1" } }
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.failures) : "").toBe(true);
  if (!result.ok) return;
  const readTags = await NodeID3.Promise.read(result.artifact.path);
  expect(readTags.userDefinedText).toEqual([{ description: "EXTERNAL", value: "preserve-this" }]);
  expect(readTags.image).toMatchObject({ imageBuffer: artwork, description: "Fictional cover" });
  expect(result.artifact.metadata).toMatchObject({
    comments: "Approved fictional comment",
    genre: "Fictional Genre"
  });
});

test("refuses conflicting ISRC and mismatched artist until the conflict is explicitly reviewed", async ({}, testInfo) => {
  const source = writeFixture(testInfo.outputPath("conflict.mp3"), buildMp3({
    artist: "Another Fictional Artist",
    title: "Fictional Song",
    isrc: "USBBB2600001"
  }));
  const before = await fs.readFile(source);
  const result = await prepareAudioArtifact({
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: testInfo.outputPath("out")
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failures[0].code).toBe("CONFLICTING_ISRC");
  expect(await fs.readFile(source)).toEqual(before);
});

test("allows a human-acknowledged artist mismatch only when read-back verifies the corrected tag", async ({}, testInfo) => {
  const source = writeFixture(testInfo.outputPath("artist-conflict.mp3"), buildMp3({
    artist: "Another Fictional Artist",
    title: "Fictional Song",
    isrc: "USAAA2600010"
  }));
  const result = await prepareAudioArtifact({
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: testInfo.outputPath("out"),
    acknowledgedSourceConflicts: {
      fields: ["artist"],
      reviewerId: "reviewer-1",
      note: "The existing performer tag was confirmed as stale."
    }
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact.metadata.artist).toBe("Fictional Artist");
  expect(result.manifest.corrections).toContainEqual(expect.objectContaining({
    code: "ACKNOWLEDGED_TAG_CORRECTED",
    field: "artist"
  }));
});

test("fails closed for WAV writing and required tag values not present in approved sources", async ({}, testInfo) => {
  const wavSource = writeFixture(testInfo.outputPath("source.wav"), buildWav());
  const wav = await prepareAudioArtifact({
    recording: approvedRecord(), sourceAudioPath: wavSource, outputDirectory: testInfo.outputPath("wav-out")
  });
  expect(wav.ok).toBe(false);
  if (!wav.ok) expect(wav.failures[0].code).toBe("UNSUPPORTED_TAG_WRITE");

  const source = writeFixture(testInfo.outputPath("source.mp3"), buildMp3());
  const requiringGenre: AudioTagProfile = {
    id: "required-genre",
    version: "1",
    requiredFields: ["genre"],
    mappings: ["title", "artist", "genre"],
    unresolvedSponsorMappings: ["Rye M"]
  };
  const missing = await prepareAudioArtifact({
    recording: approvedRecord(), sourceAudioPath: source, outputDirectory: testInfo.outputPath("genre-out"),
    tagProfile: requiringGenre
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.failures[0].code).toBe("REQUIRED_TAG_VALUE_MISSING");
});

test("rejects extension mismatch and output collisions without overwriting existing bytes", async ({}, testInfo) => {
  const mislabeled = writeFixture(testInfo.outputPath("source.wav"), buildMp3());
  const wrongExtension = await prepareAudioArtifact({
    recording: approvedRecord(), sourceAudioPath: mislabeled, outputDirectory: testInfo.outputPath("bad-extension")
  });
  expect(wrongExtension.ok).toBe(false);
  if (!wrongExtension.ok) expect(wrongExtension.failures[0].code).toBe("EXTENSION_MISMATCH");

  const actual = writeFixture(testInfo.outputPath("real.mp3"), buildMp3());
  const outputDirectory = testInfo.outputPath("collision-out");
  const input = { recording: approvedRecord(), sourceAudioPath: actual, outputDirectory };
  const prepared = await prepareAudioArtifact(input);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const sentinel = Buffer.from("preserve existing artifact");
  await fs.writeFile(prepared.artifact.path, sentinel);
  const collision = await prepareAudioArtifact(input);
  expect(collision.ok).toBe(false);
  if (!collision.ok) expect(collision.failures[0].code).toBe("OUTPUT_COLLISION");
  expect(await fs.readFile(prepared.artifact.path)).toEqual(sentinel);
});

test("rejects an unsafe source symlink", async ({}, testInfo) => {
  const actual = writeFixture(testInfo.outputPath("real.mp3"), buildMp3());
  const symlink = testInfo.outputPath("linked.mp3");
  let canCreateSymlink = true;
  try {
    await fs.symlink(actual, symlink);
  } catch {
    canCreateSymlink = false;
  }
  if (!canCreateSymlink) {
    test.skip(true, "This platform does not permit creating symlinks in the test workspace.");
    return;
  }
  const unsafe = await prepareAudioArtifact({
    recording: approvedRecord(), sourceAudioPath: symlink, outputDirectory: testInfo.outputPath("symlink-out")
  });
  expect(unsafe.ok).toBe(false);
  if (!unsafe.ok) expect(unsafe.failures[0].code).toBe("UNSAFE_SOURCE_PATH");
});

test("removes only stale preparation temporary files left by an interrupted run", async ({}, testInfo) => {
  const outputDirectory = testInfo.outputPath("interrupted-output");
  await fs.mkdir(outputDirectory, { recursive: true });
  const stalePath = testInfo.outputPath("interrupted-output", ".mb11-0123456789abcdef01234567.tmp");
  const freshPath = testInfo.outputPath("interrupted-output", ".mb11-abcdef0123456789abcdef.tmp");
  await fs.writeFile(stalePath, "stale partial output");
  await fs.writeFile(freshPath, "active output");
  const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(stalePath, staleTime, staleTime);
  const source = writeFixture(testInfo.outputPath("source.mp3"), buildMp3());
  const result = await prepareAudioArtifact({
    recording: approvedRecord(), sourceAudioPath: source, outputDirectory
  });
  expect(result.ok).toBe(true);
  await expect(fs.access(stalePath)).rejects.toThrow();
  await expect(fs.readFile(freshPath, "utf8")).resolves.toBe("active output");
});

test("reuses identical output, records a durable manifest, and fails closed on tampering", async ({}, testInfo) => {
  const source = writeFixture(testInfo.outputPath("source.mp3"), buildMp3());
  const backend = createInMemoryReviewStorage();
  const store = createAudioPreparationStore(backend, { integrityKey: "fictional-integrity-key" });
  const input = {
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: testInfo.outputPath("prepared"),
    manifestStore: store
  };
  const first = await prepareAudioArtifact(input);
  expect(first.ok).toBe(true);
  const second = await prepareAudioArtifact(input);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.reused).toBe(true);
  expect(second.artifact.path).toBe(first.artifact.path);
  const loaded = await store.load(input.recording.recordingId);
  expect(loaded.ok).toBe(true);
  if (loaded.ok) expect(loaded.manifests[0].preparedSha256).toBe(first.artifact.sha256);
  const key = (await backend.keys())[0];
  await backend.replace(key, JSON.stringify({ tampered: true }));
  const corrupt = await store.load(input.recording.recordingId);
  expect(corrupt).toMatchObject({ ok: false, code: "CORRUPTED_DATA" });
});

test("serializes concurrent preparation and rejects manifests signed with another key", async ({}, testInfo) => {
  const source = writeFixture(testInfo.outputPath("concurrent.mp3"), buildMp3());
  const backend = createInMemoryReviewStorage();
  const store = createAudioPreparationStore(backend, { integrityKey: "fictional-integrity-key" });
  const input = {
    recording: approvedRecord(),
    sourceAudioPath: source,
    outputDirectory: testInfo.outputPath("concurrent-out"),
    manifestStore: store
  };
  const outcomes = await Promise.all([prepareAudioArtifact(input), prepareAudioArtifact(input)]);
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  expect(outcomes.filter((outcome) => outcome.ok && outcome.reused)).toHaveLength(1);
  const wrongKey = createAudioPreparationStore(backend, { integrityKey: "different-fictional-key" });
  expect(await wrongKey.load(input.recording.recordingId)).toMatchObject({
    ok: false,
    code: "INTEGRITY_CHECK_FAILED"
  });
});

test("batch preparation isolates failures and blocks destination filename collisions", async ({}, testInfo) => {
  const firstRecord = approvedRecord();
  const secondRecord = { ...approvedRecord(), recordingId: "ORCHARD-SECOND-FICTIONAL" };
  const thirdRecord = { ...approvedRecord(), recordingId: "ORCHARD-THIRD-FICTIONAL", title: "Another Fictional Song" };
  const profile = createConfigurableNamingProfile({
    id: "fictional-destination",
    version: "1",
    template: "{artist} - {title}{ext}"
  });
  const results = await prepareAudioArtifactsBatch([
    {
      recording: firstRecord,
      sourceAudioPath: writeFixture(testInfo.outputPath("first.mp3"), buildMp3()),
      outputDirectory: testInfo.outputPath("batch"),
      namingProfile: profile
    },
    {
      recording: secondRecord,
      sourceAudioPath: writeFixture(testInfo.outputPath("second.mp3"), buildMp3()),
      outputDirectory: testInfo.outputPath("batch"),
      namingProfile: profile
    },
    {
      recording: thirdRecord,
      sourceAudioPath: writeFixture(testInfo.outputPath("third.mp3"), buildMp3()),
      outputDirectory: testInfo.outputPath("batch"),
      namingProfile: profile
    }
  ]);
  expect(results).toHaveLength(3);
  expect(results[0]).toMatchObject({ ok: false, failures: [expect.objectContaining({ code: "UPLOAD_FILENAME_COLLISION" })] });
  expect(results[1]).toMatchObject({ ok: false, failures: [expect.objectContaining({ code: "UPLOAD_FILENAME_COLLISION" })] });
  expect(results[2].ok).toBe(true);
});

test("rejects malformed or truncated MPEG frame streams", () => {
  expect(() => extractMpegAudioPayload(buildMp3().subarray(0, -1))).toThrow();
});

test("supports versioned optional naming segments, Unicode, length checks and collision detection", () => {
  const { record } = fixture();
  const filenameRecord = {
    ...record,
    artist: "Beyoncé",
    artistAttribution: confirmArtistAttribution(
      createArtistAttributionDecision("Beyoncé", "Beyoncé"),
      { exactArtist: "Beyoncé" }
    ),
    title: "Café",
    version: null
  };
  const profile = createConfigurableNamingProfile({
    id: "fictional-pool",
    version: "1.2",
    template: "{artist} - {title}[ ({version})]{ext}"
  });
  const item: NamingInput = { fileName: "source.mp3", format: "MP3", record: filenameRecord };
  const check = profile.check(item);
  expect(profile.version).toBe("1.2");
  expect(check.suggestedName).toBe("Beyoncé - Café.mp3");
  expect(check.ok).toBe(false);
  expect(profile.check({ ...item, fileName: check.suggestedName! }).ok).toBe(true);
  expect(BASIC_FILENAME_PROFILE.version).toBe("1");
  expect(findNamingCollisions([
    item,
    { ...item, record: { ...filenameRecord, recordingId: "other-record" } }
  ], profile)).toHaveLength(1);
  expect(() => createConfigurableNamingProfile({ id: "bad", version: "1", template: "{unknown}{ext}" })).toThrow();
});

test("MB-10 approves and uploads the verified prepared bytes, then refuses reuse after file mutation", async ({}, testInfo) => {
  const directory = testInfo.outputPath("mb11-integration");
  const source = writeFixture(testInfo.outputPath("integrated.mp3"), buildMp3({
    artist: "Fictional Artist", title: "Fictional Song", isrc: "USAAA2600010"
  }));
  const stateStores = {
    review: createInMemoryReviewStorage(),
    ledger: createInMemoryReviewStorage(),
    preparation: createAudioPreparationStore(createInMemoryReviewStorage(), { integrityKey: MB10_KEY })
  };
  const server = await startMockMediabaseServer();
  const browser = await chromium.launch();
  try {
    const makeCoordinator = () => createSubmissionCoordinator({
      reviewStore: createReviewSessionStore(stateStores.review, { integrityKey: MB10_KEY }),
      ledger: createSubmissionLedger(stateStores.ledger, { integrityKey: MB10_KEY }),
      audioPreparationStore: stateStores.preparation,
      destination: localMockDestination(server.baseUrl),
      workflow: workflowOptions
    });
    const coordinator = makeCoordinator();
    const imported = await coordinator.importRecordings({
      csv: orchardCsv([{ track: "Fictional Song", artist: "Fictional Artist", product: "Fictional Album", isrc: "USAAA2600010" }]),
      sourceName: "fictional-mb11.csv",
      audioPaths: [source]
    });
    expect(imported[0].ok).toBe(true);
    if (!imported[0].ok) return;
    const reviewStore = createReviewSessionStore(stateStores.review, { integrityKey: MB10_KEY });
    await reviewDesk(reviewStore, imported[0].recordingId, fullReview("Fictional Artist"));
    const loaded = await reviewStore.loadCombined(imported[0].recordingId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const prep = await prepareAudioArtifact({
      recording: loaded.session.state.research.recording,
      sourceAudioPath: source,
      outputDirectory: directory,
      manifestStore: stateStores.preparation
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const resumed = makeCoordinator();
    const basis = await resumed.approvalBasis(imported[0].recordingId);
    expect(basis.ok).toBe(true);
    if (!basis.ok) return;
    const approval = await resumed.approve({
      recordingId: imported[0].recordingId,
      approvalId: "mb11-approval-1",
      approvedBy: { reviewerId: "fictional-final-approver", displayName: "Fictional Approver" },
      approvedAt: "2026-11-05T04:00:00.000Z",
      basis: basis.basis
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    const preparedBytes = await fs.readFile(prep.artifact.path);
    const changed = Buffer.from(preparedBytes);
    changed[changed.length - 1] ^= 0x01;
    await fs.writeFile(prep.artifact.path, changed);
    const afterMutation = await resumed.evaluate(imported[0].recordingId);
    expect(afterMutation.ok && afterMutation.exceptions.map((item) => item.code)).toContain("PREPARED_ARTIFACT_UNVERIFIED");
    expect(afterMutation.ok && afterMutation.exceptions.map((item) => item.code)).toContain("APPROVAL_STALE");
    await fs.writeFile(prep.artifact.path, preparedBytes);
    await resumed.evaluate(imported[0].recordingId);

    const submitted = await resumed.submit(imported[0].recordingId, { openPage: () => browser.newPage() });
    expect(submitted.ok && submitted.status).toBe("SUBMITTED");
    const receipt = server.receipts()[0];
    expect(receipt.files[0].sha256).toBe(prep.artifact.sha256);
    expect(receipt.files[0].sha256).not.toBe(digest(await fs.readFile(source)));
  } finally {
    await browser.close();
    await server.close();
  }
});
