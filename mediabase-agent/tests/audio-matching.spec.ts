import { expect, test, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractAudioMetadataBatch } from "../src/audio/audioMetadata";
import {
  applyAudioMatch,
  confirmAudioSelection,
  matchAudioToRecording,
  matchAudioToRecordings
} from "../src/audio/audioMatcher";
import {
  prepareMediabaseForm,
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DemoRecording
} from "../src/browser/mediabaseForm";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import { buildMp3, buildWav, writeFixture, type FixtureTags } from "./support/audioFixtures";

const RADIO_ISRC = "USAAA2600010";
const radioTags: FixtureTags = {
  artist: "Mara Quill",
  title: "Glass Coast",
  album: "Low Tide Atlas",
  isrc: RADIO_ISRC,
  version: "Radio Edit"
};
const reviewData = {
  submitterName: "Casey Morgan",
  email: "casey@example.test",
  officialReleaseDate: "11/15/2026"
};

function recording(overrides: Partial<DemoRecording> = {}): DemoRecording {
  return {
    recordingId: "ORCHARD-RADIO",
    artist: "Mara Quill",
    title: "Glass Coast",
    version: "Radio Edit",
    isrc: RADIO_ISRC,
    isrcValidation: { status: "valid", originalValue: RADIO_ISRC, reviewed: true },
    audioFilePath: null,
    approvalStatus: "DRAFT",
    ...overrides
  };
}

function wav(testInfo: TestInfo, name: string, id3?: FixtureTags): string {
  return writeFixture(testInfo.outputPath("audio", name), buildWav(id3 ? { id3 } : {}));
}

function mp3(testInfo: TestInfo, name: string, tags?: FixtureTags): string {
  return writeFixture(testInfo.outputPath("audio", name), buildMp3(tags));
}

test("automatically matches a single file with a matching ISRC and no conflicts", async ({}, testInfo) => {
  const radio = wav(testInfo, "master-0042.wav", radioTags);
  const extractions = await extractAudioMetadataBatch([radio, wav(testInfo, "unrelated-demo.wav")]);

  const result = matchAudioToRecording(recording(), extractions);
  expect(result).toMatchObject({ status: "MATCHED", selectedFilePath: radio, basis: "ISRC" });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ autoEligible: true, conflicts: [] });

  const applied = applyAudioMatch(recording(), result);
  expect(applied).toMatchObject({
    audioFilePath: radio,
    approvalStatus: "DRAFT",
    audioMatch: { status: "AUTO_MATCHED", filePath: radio, basis: "ISRC", humanConfirmed: false }
  });
});

test("blocks automatic matching when an embedded ISRC contradicts Orchard", async ({}, testInfo) => {
  const contradictory = wav(testInfo, "glass-coast-radio-edit.wav", { ...radioTags, isrc: "USAAA2600099" });
  const mixed = mp3(testInfo, "glass-coast-two-isrcs.mp3", { ...radioTags, isrc: [RADIO_ISRC, "USAAA2600099"] });
  const extractions = await extractAudioMetadataBatch([contradictory]);

  const result = matchAudioToRecording(recording(), extractions);
  expect(result).toMatchObject({ status: "NEEDS_REVIEW", selectedFilePath: null });
  expect(result.candidates[0]).toMatchObject({ basis: "EXACT_METADATA", autoEligible: false });
  expect(result.candidates[0].conflicts).toContain(
    `Embedded ISRC USAAA2600099 contradicts Orchard ISRC ${RADIO_ISRC}.`
  );
  expect(applyAudioMatch(recording(), result).audioFilePath).toBeNull();

  const mixedResult = matchAudioToRecording(recording(), await extractAudioMetadataBatch([mixed]));
  expect(mixedResult).toMatchObject({ status: "NEEDS_REVIEW", selectedFilePath: null });
  expect(mixedResult.candidates[0]).toMatchObject({ basis: "ISRC", autoEligible: false });

  const malformed = wav(testInfo, "glass-coast-bad-isrc.wav", { ...radioTags, isrc: "not-an-isrc" });
  const malformedResult = matchAudioToRecording(recording(), await extractAudioMetadataBatch([malformed]));
  expect(malformedResult.status).toBe("NEEDS_REVIEW");
  expect(malformedResult.candidates[0].conflicts).toContain("Embedded ISRC is malformed.");
});

test("uses exact artist, title, and version agreement when ISRCs are missing", async ({}, testInfo) => {
  const untaggedIsrc = wav(testInfo, "track-01.wav", { ...radioTags, isrc: undefined });
  const extractions = await extractAudioMetadataBatch([untaggedIsrc]);

  expect(matchAudioToRecording(recording(), extractions)).toMatchObject({
    status: "MATCHED",
    selectedFilePath: untaggedIsrc,
    basis: "EXACT_METADATA"
  });

  const missingOrchardIsrc = recording({
    isrc: null,
    isrcValidation: { status: "missing", originalValue: null, reviewed: false }
  });
  expect(matchAudioToRecording(missingOrchardIsrc, extractions)).toMatchObject({
    status: "MATCHED",
    basis: "EXACT_METADATA"
  });

  const embeddedOnly = wav(testInfo, "track-02.wav", radioTags);
  const embeddedResult = matchAudioToRecording(missingOrchardIsrc, await extractAudioMetadataBatch([embeddedOnly]));
  expect(embeddedResult).toMatchObject({ status: "MATCHED", basis: "EXACT_METADATA" });
  expect(embeddedResult.candidates[0].evidence).toContain(
    `File embeds ISRC ${RADIO_ISRC}; it was not copied to the recording.`
  );
  expect(applyAudioMatch(missingOrchardIsrc, embeddedResult).isrc).toBeNull();

  const titleVersion = wav(testInfo, "track-03.wav", { artist: "Mara Quill", title: "Glass Coast (Radio Edit)" });
  expect(matchAudioToRecording(recording(), await extractAudioMetadataBatch([titleVersion]))).toMatchObject({
    status: "MATCHED",
    basis: "EXACT_METADATA"
  });
});

test("keeps filename-only and partial metadata matches as review suggestions", async ({}, testInfo) => {
  const filenameOnly = wav(testInfo, "Mara Quill - Glass Coast (Radio Edit).wav");
  const filenameResult = matchAudioToRecording(recording(), await extractAudioMetadataBatch([filenameOnly]));
  expect(filenameResult).toMatchObject({ status: "NEEDS_REVIEW", selectedFilePath: null });
  expect(filenameResult.candidates[0]).toMatchObject({ basis: "FILENAME", autoEligible: false, conflicts: [] });

  const partial = wav(testInfo, "partial.wav", { title: "Glass Coast" });
  const partialResult = matchAudioToRecording(recording(), await extractAudioMetadataBatch([partial]));
  expect(partialResult).toMatchObject({ status: "NEEDS_REVIEW", selectedFilePath: null });
  expect(partialResult.candidates[0]).toMatchObject({ basis: "PARTIAL_METADATA", autoEligible: false });

  const applied = applyAudioMatch(recording(), partialResult);
  expect(applied).toMatchObject({ audioFilePath: null, audioMatch: { status: "NEEDS_REVIEW" } });
  expect(() =>
    reviewAndApproveRecord(applied, reviewData)
  ).toThrow("Audio match requires an explicit human selection before approval.");
});

test("never matches a Radio Edit automatically to a Remix or another version", async ({}, testInfo) => {
  const taggedRemix = wav(testInfo, "glass-coast-a.wav", { ...radioTags, isrc: undefined, version: "Remix" });
  const remixWithRadioIsrc = mp3(testInfo, "glass-coast-b.mp3", { ...radioTags, version: "Club Remix" });
  const filenameRemix = wav(testInfo, "Glass Coast (Remix).wav");
  const titleRemix = wav(testInfo, "glass-coast-c.wav", { artist: "Mara Quill", title: "Glass Coast (Remix)" });
  const extended = wav(testInfo, "glass-coast-d.wav", { artist: "Mara Quill", title: "Glass Coast", version: "Extended Mix" });
  const versionFiles = [taggedRemix, remixWithRadioIsrc, filenameRemix, titleRemix, extended];

  const remixOnly = matchAudioToRecording(recording(), await extractAudioMetadataBatch(versionFiles));
  expect(remixOnly.status).toBe("AMBIGUOUS");
  expect(remixOnly.selectedFilePath).toBeNull();
  expect(remixOnly.candidates.every((candidate) => !candidate.autoEligible)).toBeTruthy();
  expect(remixOnly.candidates.every((candidate) => candidate.conflicts.length > 0)).toBeTruthy();

  const radio = wav(testInfo, "glass-coast-radio.wav", radioTags);
  const withRadio = matchAudioToRecording(recording(), await extractAudioMetadataBatch([...versionFiles, radio]));
  expect(withRadio).toMatchObject({ status: "MATCHED", selectedFilePath: radio, basis: "ISRC" });
  expect(withRadio.candidates[0].filePath).toBe(radio);
});

test("marks multiple possible files as AMBIGUOUS and requires human selection", async ({ page }, testInfo) => {
  const wavCopy = wav(testInfo, "glass-coast.wav", radioTags);
  const mp3Copy = mp3(testInfo, "glass-coast.mp3", radioTags);
  const result = matchAudioToRecording(recording(), await extractAudioMetadataBatch([mp3Copy, wavCopy]));

  expect(result).toMatchObject({ status: "AMBIGUOUS", selectedFilePath: null, basis: null });
  expect(result.candidates.map((candidate) => candidate.filePath)).toEqual([mp3Copy, wavCopy]);

  const pending = applyAudioMatch(recording(), result);
  expect(pending).toMatchObject({ audioFilePath: null, audioMatch: { status: "AMBIGUOUS" } });
  expect(() => reviewAndApproveRecord(pending, reviewData)).toThrow(
    "Audio match requires an explicit human selection before approval."
  );

  const filenameSuggestions = matchAudioToRecording(
    recording(),
    await extractAudioMetadataBatch([wav(testInfo, "glass coast take 1.wav"), wav(testInfo, "glass coast take 2.wav")])
  );
  expect(filenameSuggestions.status).toBe("AMBIGUOUS");

  const selected = confirmAudioSelection(pending, result, wavCopy);
  expect(selected).toMatchObject({
    audioFilePath: wavCopy,
    audioMatch: { status: "CONFIRMED", filePath: wavCopy, basis: "ISRC", humanConfirmed: true }
  });
  const approved = reviewAndApproveRecord(selected, reviewData);
  expect(approved.audioFilePath).toBe(wavCopy);

  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await prepareMediabaseForm(page, approved);
  expect(await page.locator("#audio-file").evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe(
    "glass-coast.wav"
  );
});

test("supports explicit human selection, conflict acknowledgement, and no-audio decisions", async ({}, testInfo) => {
  const contradictory = wav(testInfo, "glass-coast-alt.wav", { ...radioTags, isrc: "USAAA2600099" });
  const unrelated = wav(testInfo, "unrelated.wav");
  const result = matchAudioToRecording(recording(), await extractAudioMetadataBatch([contradictory, unrelated]));
  const draft = applyAudioMatch(recording(), result);

  expect(() => confirmAudioSelection(draft, result, unrelated)).toThrow(
    "Selected audio file is not one of the evaluated match candidates."
  );
  expect(() => confirmAudioSelection(draft, result, contradictory)).toThrow(
    "Selected audio file has conflicting evidence that must be explicitly acknowledged."
  );
  expect(() => confirmAudioSelection({ ...draft, recordingId: "OTHER" }, result, contradictory)).toThrow(
    "Audio match result belongs to a different recording."
  );

  const acknowledged = confirmAudioSelection(draft, result, contradictory, { acknowledgeConflicts: true });
  expect(acknowledged.audioMatch).toMatchObject({
    status: "CONFIRMED",
    humanConfirmed: true,
    acknowledgedConflicts: [`Embedded ISRC USAAA2600099 contradicts Orchard ISRC ${RADIO_ISRC}.`]
  });

  const rematched = applyAudioMatch(acknowledged, matchAudioToRecording(recording(), []));
  expect(rematched).toBe(acknowledged);
  expect(() => validateRecordForPreparation({ ...reviewAndApproveRecord(acknowledged, reviewData), audioFilePath: unrelated })).toThrow(
    "Audio file path differs from the reviewed audio match."
  );

  const noAudio = confirmAudioSelection(draft, result, null);
  expect(noAudio).toMatchObject({ audioFilePath: null, audioMatch: { status: "NO_AUDIO_CONFIRMED", humanConfirmed: true } });
  expect(reviewAndApproveRecord(noAudio, reviewData).approvalStatus).toBe("APPROVED");

  const manual = recording({ audioFilePath: unrelated });
  expect(applyAudioMatch(manual, matchAudioToRecording(manual, []))).toBe(manual);
});

test("ignores invalid and missing files while matching", async ({}, testInfo) => {
  const radio = wav(testInfo, "glass-coast.wav", radioTags);
  const invalid = writeFixture(testInfo.outputPath("audio", "glass-coast-broken.wav"), "not audio");
  const missing = testInfo.outputPath("audio", "glass-coast-missing.wav");

  const result = matchAudioToRecording(recording(), await extractAudioMetadataBatch([invalid, missing, radio]));
  expect(result).toMatchObject({ status: "MATCHED", selectedFilePath: radio });
  expect(result.rejectedFiles).toEqual([
    expect.objectContaining({ filePath: invalid, error: "UNSUPPORTED_FORMAT" }),
    expect.objectContaining({ filePath: missing, error: "MISSING_FILE" })
  ]);
  expect(result.candidates.map((candidate) => candidate.filePath)).toEqual([radio]);

  const onlyBad = matchAudioToRecording(recording(), await extractAudioMetadataBatch([invalid, missing]));
  expect(onlyBad).toMatchObject({ status: "NO_MATCH", selectedFilePath: null, candidates: [] });
});

test("matches Orchard versions independently and flags cross-recording ambiguity", async ({}, testInfo) => {
  const { records } = importOrchardCsv(readFileSync("fixtures/orchard-multiple-versions.csv", "utf8"), "fictional-export.csv");
  const [radioRecord, remixRecord] = records;
  const harbor = { artist: "The Harbor Lights", title: "Signal, Again", album: "Midnight Signals" };
  const radioFile = wav(testInfo, "signal-again-1.wav", { ...harbor, isrc: "USAAA2600001", version: "Radio Edit" });
  const remixFile = wav(testInfo, "signal-again-2.wav", { ...harbor, version: "Remix" });

  const results = matchAudioToRecordings(records, await extractAudioMetadataBatch([remixFile, radioFile]));
  expect(results.map((result) => [result.recordingId, result.status, result.selectedFilePath, result.basis])).toEqual([
    [radioRecord.recordingId, "MATCHED", radioFile, "ISRC"],
    [remixRecord.recordingId, "MATCHED", remixFile, "EXACT_METADATA"]
  ]);
  expect(results[1].candidates.find((candidate) => candidate.filePath === radioFile)?.conflicts).toContain(
    `Embedded ISRC USAAA2600001 belongs to Orchard recording ${radioRecord.recordingId}.`
  );

  const duplicateRow = `"Glass Coast","Mara Quill","Mara Quill",,"Label","Album","1","Radio Edit","Album"`;
  const duplicates = importOrchardCsv(
    `TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,LABEL IMPRINT,PRODUCT,DISPLAY UPC,VERSION/MIX,PRODUCT TYPE\n${duplicateRow}\n${duplicateRow}`
  ).records;
  const shared = wav(testInfo, "shared.wav", { ...radioTags, isrc: undefined });
  const sharedResults = matchAudioToRecordings(duplicates, await extractAudioMetadataBatch([shared]));
  expect(sharedResults.map((result) => [result.status, result.selectedFilePath])).toEqual([
    ["AMBIGUOUS", null],
    ["AMBIGUOUS", null]
  ]);
});

test("audio matching never resolves an artist-attribution conflict", async ({}, testInfo) => {
  const { records } = importOrchardCsv(readFileSync("fixtures/orchard-multiple-versions.csv", "utf8"), "fictional-export.csv");
  const radioFile = wav(testInfo, "signal-again.wav", {
    artist: "The Harbor Lights",
    title: "Signal, Again",
    isrc: "USAAA2600001",
    version: "Radio Edit"
  });
  const matched = applyAudioMatch(records[0], matchAudioToRecording(records[0], await extractAudioMetadataBatch([radioFile])));

  expect(matched).toMatchObject({
    artist: "",
    featuredArtist: null,
    audioFilePath: radioFile,
    approvalStatus: "DRAFT",
    artistAttribution: { status: "CONFLICT", confirmed: false }
  });
  expect(() => reviewAndApproveRecord(matched, reviewData)).toThrow(
    "Conflicting Orchard artist attribution must be explicitly confirmed before approval."
  );
  expect(
    reviewAndApproveRecord(matched, reviewData, { confirmArtistAttribution: { exactArtist: "North Star Music" } })
  ).toMatchObject({ artist: "North Star Music", audioFilePath: radioFile, approvalStatus: "APPROVED" });
});

test("produces identical results regardless of input order", async ({}, testInfo) => {
  const files = [
    wav(testInfo, "glass-coast-x.wav", radioTags),
    mp3(testInfo, "glass-coast-y.mp3", { ...radioTags, version: "Remix", isrc: undefined }),
    wav(testInfo, "glass coast z.wav")
  ];
  const extractions = await extractAudioMetadataBatch(files);
  const forward = matchAudioToRecording(recording(), extractions);
  const reversed = matchAudioToRecording(recording(), [...extractions].reverse());
  expect(reversed).toEqual(forward);
});

test("prepares a matched recording without uploading, submitting, or altering audio", async ({ page }, testInfo) => {
  const radio = wav(testInfo, "glass-coast.wav", radioTags);
  const before = createHash("sha256").update(readFileSync(radio)).digest("hex");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));

  const matched = applyAudioMatch(recording(), matchAudioToRecording(recording(), await extractAudioMetadataBatch([radio])));
  expect(matched.approvalStatus).toBe("DRAFT");
  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await expect(prepareMediabaseForm(page, matched)).rejects.toThrow(
    "Recording must be approved before form preparation."
  );
  expect(await page.locator("#audio-file").evaluate((input: HTMLInputElement) => input.files?.length ?? 0)).toBe(0);

  await prepareMediabaseForm(page, reviewAndApproveRecord(matched, reviewData));
  expect(await page.locator("#audio-file").evaluate((input: HTMLInputElement) => input.files?.length ?? 0)).toBe(1);
  await expect(page.locator("#submit")).toHaveAttribute("data-click-count", "0");
  await expect(page.locator("#mediabase-form")).toHaveAttribute("data-submit-count", "0");
  expect(requests).toEqual([]);
  expect(createHash("sha256").update(readFileSync(radio)).digest("hex")).toBe(before);
});
