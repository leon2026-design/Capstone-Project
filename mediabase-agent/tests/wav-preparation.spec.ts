import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInMemoryReviewStorage, ReviewStorageLockedError } from "../src/storage/reviewStorageBackend";
import { createAudioPreparationStore } from "../src/submission/audioPreparationStore";
import { decodeMpegAudio, extractMpegAudioPayload, prepareAudioArtifact } from "../src/submission/audioPreparation";
import { readId3Values } from "../src/submission/audioId3";
import { DEFAULT_MP3_TAG_PROFILE, resolveAudioTagValues } from "../src/submission/audioTagProfile";
import { SAFE_FILENAME_PROFILE, SPONSOR_TITLE_NAMING_PROFILE } from "../src/submission/namingProfile";
import { inspectWave, verifyWaveTags, waveAudioUnchanged } from "../src/submission/wavAudio";
import { createSubmissionLedger } from "../src/submission/submissionLedger";
import { startMockMediabaseServer } from "../src/submission/mockMediabaseServer";
import { createSubmissionCoordinator, localMockDestination } from "../src/workflow/submissionCoordinator";
import { createReviewSessionStore } from "../src/workflow/reviewSessionStore";
import { buildId3Frame, buildId3Tag, buildId3v1Tag, buildMp3, buildWav, riffChunk, writeFixture } from "./support/audioFixtures";
import { approvedAudioRecord, TECHNICAL_TEST_CONTRACT } from "./support/clientContractFixture";
import { MB10_KEY, fullReview, orchardCsv, reviewDesk, workflowOptions } from "./support/mb10Fixture";

const tags = {
  artist: "Fictional Artist", title: "Fictional Song",
  album: "Fictional Album", isrc: "USAAA2600010"
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const artwork = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(140, 0x2a)]);
const artworkFrame = buildId3Frame("APIC", Buffer.concat([
  Buffer.from([0]), Buffer.from("image/png\0", "latin1"), Buffer.from([3]),
  Buffer.from("fictional cover\0", "latin1"), artwork
]), 4);
const unknownFrame = buildId3Frame("PRIV", Buffer.concat([
  Buffer.from("fictional-owner\0", "latin1"), Buffer.from([1, 2, 3, 4, 5])
]), 4);

function wavInput(sourceAudioPath: string, outputDirectory: string) {
  return {
    recording: approvedAudioRecord(),
    sourceAudioPath,
    outputDirectory,
    clientContract: TECHNICAL_TEST_CONTRACT,
    namingProfile: SAFE_FILENAME_PROFILE
  };
}

test("WAV preserves PCM, ID3v2.4 artwork and unknown frames, INFO and ancillary chunks", async ({}, testInfo) => {
  const id3 = buildId3Tag(tags, 4, [artworkFrame, unknownFrame]);
  const original = buildWav({
    sampleRate: 44100, bitDepth: 24, channels: 2,
    riffInfo: { artist: tags.artist, title: tags.title, album: tags.album },
    extraInfo: [{ id: "ICOP", data: Buffer.from("fictional copyright\0", "latin1") }],
    id3Bytes: id3,
    ancillaryChunks: [
      { id: "bext", data: Buffer.alloc(602) },
      { id: "cue ", data: Buffer.alloc(4) },
      { id: "LIST", data: Buffer.from("adtlodd", "latin1") },
      { id: "JUNK", data: Buffer.from([3, 1, 4]) }
    ]
  });
  const paddingOffset = original.indexOf(Buffer.from("JUNK")) + 8 + 3;
  original[paddingOffset] = 0x7f;
  const source = writeFixture(testInfo.outputPath("fictional.wav"), original);
  const store = createAudioPreparationStore(createInMemoryReviewStorage(), { integrityKey: "fictional-test-key" });
  const input = { ...wavInput(source, testInfo.outputPath("prepared")), manifestStore: store };
  const result = await prepareAudioArtifact(input);
  expect(result.ok, !result.ok ? JSON.stringify(result.failures) : "").toBe(true);
  if (!result.ok) return;
  const prepared = await fs.readFile(result.artifact.path);
  const before = inspectWave(original);
  const after = inspectWave(prepared);
  expect(await fs.readFile(source)).toEqual(original);
  expect(after.pcm).toEqual(before.pcm);
  expect(after.format).toEqual(before.format);
  expect(after.format).toMatchObject({ codec: "PCM", channels: 2, sampleRate: 44100, bitDepth: 24 });
  expect(waveAudioUnchanged(original, prepared)).toBe(true);
  const outputId3 = after.chunks.find((item) => item.id === "id3 ")!.data;
  expect(outputId3[3]).toBe(4);
  expect(outputId3.includes(artworkFrame)).toBe(true);
  expect(outputId3.includes(unknownFrame)).toBe(true);
  expect(after.info?.find((item) => item.id === "ICOP")?.data).toEqual(Buffer.from("fictional copyright\0", "latin1"));
  expect(await verifyWaveTags(prepared, resolveAudioTagValues(input.recording, DEFAULT_MP3_TAG_PROFILE).values)).toBe(true);
  expect(result.manifest).toMatchObject({
    sourceFormat: "WAV", preparedFormat: "WAV", sourceSha256: sha256(original),
    preparedSha256: sha256(prepared), audioIntegrityVerified: true, tagVerificationStatus: "MATCH"
  });
  expect(result.manifest.issues.length).toBeGreaterThan(0);
  expect(result.manifest.issues.every((item) =>
    item.recordingId === input.recording.recordingId && !!item.field && !!item.stage &&
    !!item.message && Array.isArray(item.evidenceReferences) && !!item.recommendedAction &&
    typeof item.recoveryAttempted === "boolean" && typeof item.humanInterventionRequired === "boolean"
  )).toBe(true);
  const reused = await prepareAudioArtifact(input);
  expect(reused.ok && reused.reused).toBe(true);
  if (reused.ok) {
    expect(reused.artifact.sha256).toBe(result.artifact.sha256);
    expect(reused.manifest.corrections).toEqual(result.manifest.corrections);
    expect(reused.manifest.issues).toEqual(result.manifest.issues);
  }
});

test("conflicting ID3 and RIFF INFO values require field-level review and are then both corrected", async ({}, testInfo) => {
  const original = buildWav({
    id3: tags,
    riffInfo: { artist: tags.artist, title: "Other Fictional Song", album: tags.album }
  });
  const source = writeFixture(testInfo.outputPath("conflict.wav"), original);
  const input = wavInput(source, testInfo.outputPath("prepared"));
  const refused = await prepareAudioArtifact(input);
  expect(refused).toMatchObject({
    ok: false, failures: [expect.objectContaining({
      code: "SOURCE_TAG_CONFLICT", field: "title", stage: "SOURCE_TAG_CHECK",
      message: expect.any(String), evidenceReferences: ["selected-audio", "reviewed-record"],
      recoveryAttempted: false, recoverySucceeded: null, humanInterventionRequired: true,
      recommendedAction: expect.any(String)
    })]
  });
  const reviewed = await prepareAudioArtifact({
    ...input,
    acknowledgedSourceConflicts: {
      fields: ["title"], reviewerId: "fictional-reviewer", note: "The INFO title was stale."
    }
  });
  expect(reviewed.ok, !reviewed.ok ? JSON.stringify(reviewed.failures) : "").toBe(true);
  if (!reviewed.ok) return;
  const prepared = await fs.readFile(reviewed.artifact.path);
  const inspected = inspectWave(prepared);
  expect(inspected.id3.title).toBe(tags.title);
  expect(inspected.infoValues.title).toEqual([tags.title]);
  expect(reviewed.manifest.corrections).toContainEqual(expect.objectContaining({
    code: "ACKNOWLEDGED_TAG_CORRECTED", field: "title"
  }));
  expect(await fs.readFile(source)).toEqual(original);
});

test("INFO-only and IEEE float WAVs gain independently verified ID3 without changing samples", async ({}, testInfo) => {
  const cases = [
    { name: "info-only", bytes: buildWav({ riffInfo: tags }) },
    { name: "float", bytes: buildWav({ codec: "IEEE_FLOAT", bitDepth: 32, id3: tags }) },
    { name: "extensible-float", bytes: buildWav({ codec: "IEEE_FLOAT", bitDepth: 32, extensible: true, id3: tags }) }
  ];
  for (const item of cases) {
    const source = writeFixture(testInfo.outputPath(`${item.name}.wav`), item.bytes);
    const input = wavInput(source, testInfo.outputPath(`${item.name}-prepared`));
    const result = await prepareAudioArtifact(input);
    expect(result.ok, `${item.name}: ${!result.ok ? JSON.stringify(result.failures) : ""}`).toBe(true);
    if (!result.ok) continue;
    const prepared = await fs.readFile(result.artifact.path);
    const before = inspectWave(item.bytes);
    const after = inspectWave(prepared);
    expect(after.format).toEqual(before.format);
    expect(after.pcm).toEqual(before.pcm);
    expect(after.id3).toMatchObject(tags);
    if (item.name === "info-only") {
      expect(after.infoValues.title).toEqual([tags.title]);
      expect(after.infoValues.artist).toEqual([tags.artist]);
      expect(after.infoValues.album).toEqual([tags.album]);
    } else {
      expect(after.format.codec).toBe("IEEE_FLOAT");
      expect(after.info).toBeNull();
    }
    expect(await verifyWaveTags(prepared, resolveAudioTagValues(input.recording, DEFAULT_MP3_TAG_PROFILE).values)).toBe(true);
    expect(await fs.readFile(source)).toEqual(item.bytes);
  }
});

test("extensible PCM retains sample format and rejects unsupported or malformed containers", async ({}, testInfo) => {
  const extensible = buildWav({ extensible: true, bitDepth: 24, channels: 2, id3: tags });
  const source = writeFixture(testInfo.outputPath("extensible.wav"), extensible);
  const valid = await prepareAudioArtifact(wavInput(source, testInfo.outputPath("extensible-out")));
  expect(valid.ok, !valid.ok ? JSON.stringify(valid.failures) : "").toBe(true);
  if (valid.ok) {
    expect(inspectWave(await fs.readFile(valid.artifact.path)).format).toEqual(inspectWave(extensible).format);
  }

  const rf64 = Buffer.from(extensible);
  rf64.write("RF64", 0, "latin1");
  const truncated = extensible.subarray(0, extensible.length - 1);
  const duplicate = Buffer.concat([extensible, riffChunk("data", Buffer.alloc(4))]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  for (const [name, bytes] of [["rf64", rf64], ["truncated", truncated], ["duplicate", duplicate]] as const) {
    const path = writeFixture(testInfo.outputPath(`${name}.wav`), bytes);
    const result = await prepareAudioArtifact(wavInput(path, testInfo.outputPath(`${name}-out`)));
    expect(result.ok, name).toBe(false);
    if (!result.ok && name === "rf64") expect(result.failures[0].code).toBe("UNSUPPORTED_WAV_VARIANT");
    if (!result.ok && name === "duplicate") expect(result.failures[0].code).toBe("AMBIGUOUS_WAV_CHUNKS");
    expect(await fs.readFile(path)).toEqual(bytes);
  }
});

test("ambiguous or unsupported RIFF metadata and compressed audio fail closed", async ({}, testInfo) => {
  const codePage = (value: number) => {
    const chunk = Buffer.alloc(8);
    chunk.writeUInt16LE(value);
    return chunk;
  };
  const compressed = buildWav({ id3: tags });
  compressed.writeUInt16LE(6, 20);
  const cases = [
    {
      name: "unsupported-code-page", code: "UNSUPPORTED_TAG_MAPPING",
      bytes: buildWav({ id3: tags, riffInfo: tags, ancillaryChunks: [{ id: "CSET", data: codePage(932) }] })
    },
    {
      name: "invalid-utf8", code: "MALFORMED_WAV_INFO",
      bytes: buildWav({
        id3: tags, riffInfo: { artist: tags.artist },
        extraInfo: [{ id: "INAM", data: Buffer.from([0xc3, 0x28, 0]) }],
        ancillaryChunks: [{ id: "CSET", data: codePage(65001) }]
      })
    },
    {
      name: "multiple-info-values", code: "MALFORMED_WAV_INFO",
      bytes: buildWav({ id3: tags, extraInfo: [{ id: "INAM", data: Buffer.from("one\0two\0", "latin1") }] })
    },
    {
      name: "duplicate-info", code: "AMBIGUOUS_WAV_CHUNKS",
      bytes: buildWav({ id3: tags, riffInfo: tags, ancillaryChunks: [{ id: "LIST", data: Buffer.from("INFO") }] })
    },
    {
      name: "duplicate-id3", code: "AMBIGUOUS_WAV_CHUNKS",
      bytes: buildWav({ id3: tags, ancillaryChunks: [{ id: "ID3 ", data: buildId3Tag(tags) }] })
    },
    { name: "compressed", code: "UNSUPPORTED_WAV_VARIANT", bytes: compressed }
  ];
  for (const item of cases) {
    let inspectionError: unknown;
    try {
      inspectWave(item.bytes);
    } catch (error) {
      inspectionError = error;
    }
    expect(inspectionError, item.name).toMatchObject({ code: item.code });
    const source = writeFixture(testInfo.outputPath(`${item.name}.wav`), item.bytes);
    const result = await prepareAudioArtifact(wavInput(source, testInfo.outputPath(`${item.name}-out`)));
    expect(result.ok, item.name).toBe(false);
    if (!result.ok) expect(result.manifest.artifactPath).toBeNull();
    expect(await fs.readFile(source)).toEqual(item.bytes);
  }
});

test("MP3 ID3v2.4 updates preserve unknown frames, artwork, exact MPEG frames, and decoding", async ({}, testInfo) => {
  const sourceBytes = Buffer.concat([buildId3Tag(tags, 4, [artworkFrame, unknownFrame]), buildMp3()]);
  const source = writeFixture(testInfo.outputPath("v24.mp3"), sourceBytes);
  const result = await prepareAudioArtifact(wavInput(source, testInfo.outputPath("mp3-out")));
  expect(result.ok, !result.ok ? JSON.stringify(result.failures) : "").toBe(true);
  if (!result.ok) return;
  const prepared = await fs.readFile(result.artifact.path);
  expect(prepared[3]).toBe(4);
  expect(prepared.includes(artworkFrame)).toBe(true);
  expect(prepared.includes(unknownFrame)).toBe(true);
  expect(extractMpegAudioPayload(prepared)).toEqual(extractMpegAudioPayload(sourceBytes));
  expect(await decodeMpegAudio(extractMpegAudioPayload(prepared)))
    .toEqual(await decodeMpegAudio(extractMpegAudioPayload(sourceBytes)));
  expect(await fs.readFile(source)).toEqual(sourceBytes);

  const duplicateTitle = buildId3Frame("TIT2", Buffer.from("\0Another Title", "latin1"), 4);
  const malformed = Buffer.concat([buildId3Tag(tags, 4, [duplicateTitle]), buildMp3()]);
  const badPath = writeFixture(testInfo.outputPath("duplicate.mp3"), malformed);
  const refused = await prepareAudioArtifact(wavInput(badPath, testInfo.outputPath("duplicate-mp3-out")));
  expect(refused).toMatchObject({
    ok: false, failures: [expect.objectContaining({ code: "DUPLICATE_ID3_FRAME", field: "title" })]
  });
});

test("unsupported ID3 flags and malformed frames are rejected without changing sources", async ({}, testInfo) => {
  const flaggedHeader = buildId3Tag(tags, 4);
  flaggedHeader[5] = 0x80;
  const flaggedFrame = buildId3Tag(tags, 4);
  flaggedFrame[18] = 0x40;
  const truncatedFrame = buildId3Tag(tags, 4);
  truncatedFrame.writeUInt32BE(0x7fffffff, 14);
  for (const [name, tag, code] of [
    ["header", flaggedHeader, "UNSUPPORTED_ID3_VARIANT"],
    ["frame", flaggedFrame, "UNSUPPORTED_ID3_FRAME"],
    ["size", truncatedFrame, "MALFORMED_ID3"]
  ] as const) {
    const bytes = Buffer.concat([tag, buildMp3()]);
    let inspectionError: unknown;
    try {
      readId3Values(bytes);
    } catch (error) {
      inspectionError = error;
    }
    expect(inspectionError, name).toMatchObject({ code });
    const source = writeFixture(testInfo.outputPath(`${name}.mp3`), bytes);
    const result = await prepareAudioArtifact(wavInput(source, testInfo.outputPath(`${name}-out`)));
    expect(result.ok, name).toBe(false);
    if (!result.ok) expect(result.manifest.artifactPath).toBeNull();
    expect(await fs.readFile(source)).toEqual(bytes);
  }
});

test("preserved ID3v1 tags, including genre, must agree with the reviewed ID3v2 values", async ({}, testInfo) => {
  const legacy = { ...tags, year: "2026", comments: "Approved fictional comment" };
  const modern = buildMp3({ ...legacy, genre: "Pop" });
  const explicitValues = {
    genre: { value: "Pop", sourceReference: "fictional-review", approvedBy: "fictional-reviewer" }
  };
  const matchingTag = buildId3v1Tag(legacy, 13);
  matchingTag[125] = 0;
  matchingTag[126] = 1;
  const cases = [
    { name: "matching", tag: matchingTag, expected: null },
    { name: "conflicting-title", tag: buildId3v1Tag({ ...legacy, title: "Other Song" }, 13), expected: "title" },
    { name: "conflicting-genre", tag: buildId3v1Tag(legacy, 17), expected: "genre" },
    { name: "unknown-genre", tag: buildId3v1Tag(legacy, 254), expected: "genre" }
  ];
  for (const item of cases) {
    const bytes = Buffer.concat([modern, item.tag]);
    const source = writeFixture(testInfo.outputPath(`${item.name}.mp3`), bytes);
    const result = await prepareAudioArtifact({
      ...wavInput(source, testInfo.outputPath(`${item.name}-out`)), explicitValues
    });
    if (item.expected) {
      expect(result).toMatchObject({
        ok: false, failures: [expect.objectContaining({ code: "UNSUPPORTED_TAG_MAPPING", field: item.expected })]
      });
    } else {
      expect(result.ok, !result.ok ? JSON.stringify(result.failures) : "").toBe(true);
      if (result.ok) expect((await fs.readFile(result.artifact.path)).subarray(-128)).toEqual(item.tag);
    }
    expect(await fs.readFile(source)).toEqual(bytes);
  }
});

test("preparation distinguishes a held lock, storage failure, and failure after locked work starts", async ({}, testInfo) => {
  const source = writeFixture(testInfo.outputPath("lock-source.wav"), buildWav({ id3: tags }));
  const store = createAudioPreparationStore(createInMemoryReviewStorage());
  const cases = [
    { name: "held", error: new ReviewStorageLockedError(), expected: "PREPARATION_LOCKED" },
    { name: "unavailable", error: new Error("storage unavailable"), expected: "PREPARATION_LOCK_FAILED" }
  ];
  for (const item of cases) {
    const failingStore = { ...store, withLock: async () => { throw item.error; } };
    const result = await prepareAudioArtifact({
      ...wavInput(source, testInfo.outputPath(item.name)), manifestStore: failingStore
    });
    expect(result).toMatchObject({
      ok: false, failures: [expect.objectContaining({ code: item.expected, stage: "LOCK" })],
      manifest: { preparationStatus: "RECOVERABLE_FAILURE", issues: [expect.objectContaining({ code: item.expected })] }
    });
  }
  const failingRelease = {
    ...store,
    withLock: async <T>(_recordingId: string, task: () => Promise<T>): Promise<T> => {
      await task();
      throw new Error("lock release failed");
    }
  };
  const result = await prepareAudioArtifact({
    ...wavInput(source, testInfo.outputPath("release")), manifestStore: failingRelease
  });
  expect(result).toMatchObject({
    ok: false,
    failures: [expect.objectContaining({ code: "PREPARATION_LOCK_OR_TASK_FAILED", humanInterventionRequired: true })],
    manifest: { preparationStatus: "FAILED" }
  });
  const persisted = await store.load(approvedAudioRecord().recordingId);
  expect(persisted.ok && persisted.manifests.at(-1)).toMatchObject({
    preparationStatus: "FAILED", issues: [expect.objectContaining({ code: "PREPARATION_LOCK_OR_TASK_FAILED" })]
  });
});

test("MB-10 approves and submits the exact prepared WAV once under the reviewed title", async ({ browser }, testInfo) => {
  const source = writeFixture(testInfo.outputPath("reviewed.wav"), buildWav({
    id3: tags, riffInfo: { artist: tags.artist, title: tags.title, album: tags.album }
  }));
  const reviewBackend = createInMemoryReviewStorage();
  const ledgerBackend = createInMemoryReviewStorage();
  const preparationStore = createAudioPreparationStore(createInMemoryReviewStorage(), { integrityKey: MB10_KEY });
  const server = await startMockMediabaseServer();
  const contract = { ...TECHNICAL_TEST_CONTRACT, namingProfileId: SPONSOR_TITLE_NAMING_PROFILE.id };
  try {
    const coordinator = createSubmissionCoordinator({
      reviewStore: createReviewSessionStore(reviewBackend, { integrityKey: MB10_KEY }),
      ledger: createSubmissionLedger(ledgerBackend, { integrityKey: MB10_KEY }),
      audioPreparationStore: preparationStore,
      clientMetadataContract: contract,
      namingProfile: SPONSOR_TITLE_NAMING_PROFILE,
      policy: { allowUploadRename: true },
      destination: localMockDestination(server.baseUrl),
      workflow: workflowOptions
    });
    const imported = await coordinator.importRecordings({
      csv: orchardCsv([{ track: tags.title, artist: tags.artist, product: tags.album, isrc: tags.isrc }]),
      sourceName: "fictional-wav.csv", audioPaths: [source]
    });
    expect(imported[0].ok).toBe(true);
    if (!imported[0].ok) return;
    const recordingId = imported[0].recordingId;
    const reviewStore = createReviewSessionStore(reviewBackend, { integrityKey: MB10_KEY });
    await reviewDesk(reviewStore, recordingId, fullReview(tags.artist));
    const reviewed = await reviewStore.loadCombined(recordingId);
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    const preparation = await prepareAudioArtifact({
      recording: reviewed.session.state.research.recording, sourceAudioPath: source,
      outputDirectory: testInfo.outputPath("prepared"), manifestStore: preparationStore,
      clientContract: contract, namingProfile: SPONSOR_TITLE_NAMING_PROFILE
    });
    expect(preparation.ok, !preparation.ok ? JSON.stringify(preparation.failures) : "").toBe(true);
    if (!preparation.ok) return;
    const basis = await coordinator.approvalBasis(recordingId);
    expect(basis.ok).toBe(true);
    if (!basis.ok) return;
    const approval = await coordinator.approve({
      recordingId, approvalId: "wav-approval", approvedBy: { reviewerId: "fictional-reviewer" },
      approvedAt: "2026-11-06T12:00:00.000Z", basis: basis.basis
    });
    expect(approval.ok, !approval.ok ? JSON.stringify(approval) : "").toBe(true);
    if (!approval.ok) return;
    const originalPrepared = await fs.readFile(preparation.artifact.path);
    const changed = Buffer.from(originalPrepared);
    changed[changed.length - 1] ^= 1;
    await fs.writeFile(preparation.artifact.path, changed);
    const stale = await coordinator.evaluate(recordingId);
    expect(stale.ok && stale.exceptions.map((item) => item.code)).toContain("PREPARED_ARTIFACT_UNVERIFIED");
    expect(stale.ok && stale.exceptions.map((item) => item.code)).toContain("APPROVAL_STALE");
    await fs.writeFile(preparation.artifact.path, originalPrepared);
    const submitted = await coordinator.submit(recordingId, { openPage: () => browser.newPage() });
    expect(submitted.ok && submitted.status).toBe("SUBMITTED");
    const receipt = server.receipts()[0];
    expect(receipt.files[0]).toMatchObject({ fileName: "Fictional Song.wav", sha256: sha256(originalPrepared) });
    const again = await coordinator.processQueue([recordingId], { openPage: () => browser.newPage() });
    expect(again[0].ok && again[0].alreadySubmitted).toBe(true);
    expect(server.receipts()).toHaveLength(1);
  } finally {
    await server.close();
  }
});
