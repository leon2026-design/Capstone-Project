import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extractAudioMetadata, extractAudioMetadataBatch } from "../src/audio/audioMetadata";
import { buildMp3, buildWav, writeFixture } from "./support/audioFixtures";

const tags = {
  artist: "Mara Quill",
  title: "Glass Coast",
  album: "Low Tide Atlas",
  isrc: "USAAA2600010",
  version: "Radio Edit"
};

function fingerprint(path: string) {
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    mtimeMs: statSync(path).mtimeMs,
    size: statSync(path).size
  };
}

test("extracts WAV technical data and embedded tags without modifying the file", async ({}, testInfo) => {
  const path = writeFixture(
    testInfo.outputPath("glass-coast.wav"),
    buildWav({ sampleRate: 44100, bitDepth: 24, channels: 2, durationSeconds: 0.25, riffInfo: tags, id3: tags })
  );
  const before = fingerprint(path);

  const result = await extractAudioMetadata(path);

  expect(result).toEqual({
    status: "OK",
    filePath: path,
    fileName: "glass-coast.wav",
    metadata: {
      filePath: path,
      fileName: "glass-coast.wav",
      format: "WAV",
      extensionMatchesFormat: true,
      durationSeconds: 0.25,
      sampleRate: 44100,
      bitDepth: 24,
      channels: 2,
      artist: "Mara Quill",
      title: "Glass Coast",
      album: "Low Tide Atlas",
      isrc: "USAAA2600010",
      rawIsrcs: ["USAAA2600010"],
      version: "Radio Edit"
    }
  });
  expect(fingerprint(path)).toEqual(before);
});

test("returns null for metadata missing from a WAV file", async ({}, testInfo) => {
  const path = writeFixture(testInfo.outputPath("untagged.wav"), buildWav());
  const result = await extractAudioMetadata(path);

  expect(result.status).toBe("OK");
  if (result.status !== "OK") return;
  expect(result.metadata).toMatchObject({
    format: "WAV",
    durationSeconds: 0.5,
    sampleRate: 8000,
    bitDepth: 16,
    channels: 1,
    artist: null,
    title: null,
    album: null,
    isrc: null,
    rawIsrcs: [],
    version: null
  });
});

test("reads RIFF INFO artist, title, and album tags without inventing an ISRC or version", async ({}, testInfo) => {
  const path = writeFixture(testInfo.outputPath("info-only.wav"), buildWav({ riffInfo: tags }));
  const result = await extractAudioMetadata(path);
  expect(result.status === "OK" && result.metadata).toMatchObject({
    artist: "Mara Quill",
    title: "Glass Coast",
    album: "Low Tide Atlas",
    isrc: null,
    version: null
  });
});

test("extracts MP3 metadata and leaves bit depth null for compressed audio", async ({}, testInfo) => {
  const path = writeFixture(testInfo.outputPath("glass-coast.mp3"), buildMp3({ ...tags, isrc: "us-aaa-26-00010" }));
  const before = fingerprint(path);
  const result = await extractAudioMetadata(path);

  expect(result.status).toBe("OK");
  if (result.status !== "OK") return;
  expect(result.metadata).toMatchObject({
    format: "MP3",
    extensionMatchesFormat: true,
    sampleRate: 44100,
    bitDepth: null,
    channels: 2,
    artist: "Mara Quill",
    title: "Glass Coast",
    album: "Low Tide Atlas",
    isrc: "USAAA2600010",
    rawIsrcs: ["us-aaa-26-00010"],
    version: "Radio Edit"
  });
  expect(result.metadata.durationSeconds).toBeCloseTo((40 * 1152) / 44100, 3);
  expect(fingerprint(path)).toEqual(before);

  const untagged = await extractAudioMetadata(writeFixture(testInfo.outputPath("plain.mp3"), buildMp3()));
  expect(untagged.status === "OK" && untagged.metadata).toMatchObject({
    format: "MP3",
    artist: null,
    title: null,
    album: null,
    isrc: null,
    version: null
  });
});

test("detects the actual format from content and keeps malformed ISRCs raw only", async ({}, testInfo) => {
  const mislabeled = await extractAudioMetadata(
    writeFixture(testInfo.outputPath("actually-wav.mp3"), buildWav({ id3: { isrc: "bad-isrc" } }))
  );
  expect(mislabeled.status === "OK" && mislabeled.metadata).toMatchObject({
    format: "WAV",
    extensionMatchesFormat: false,
    isrc: null,
    rawIsrcs: ["bad-isrc"]
  });
});

test("reports invalid, unsupported, and missing audio files without throwing", async ({}, testInfo) => {
  const results = await extractAudioMetadataBatch([
    writeFixture(testInfo.outputPath("text.wav"), "fictional text, not audio"),
    writeFixture(testInfo.outputPath("truncated.wav"), buildWav().subarray(0, 30)),
    writeFixture(testInfo.outputPath("tag-only.mp3"), Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00junk", "latin1")),
    testInfo.outputPath("does-not-exist.wav"),
    testInfo.outputDir
  ]);

  expect(results.map((result) => [result.fileName, result.status === "ERROR" ? result.error : "OK"])).toEqual([
    [results[0].fileName, "MISSING_FILE"],
    ["does-not-exist.wav", "MISSING_FILE"],
    ["tag-only.mp3", "INVALID_AUDIO"],
    ["text.wav", "UNSUPPORTED_FORMAT"],
    ["truncated.wav", "INVALID_AUDIO"]
  ]);
});
