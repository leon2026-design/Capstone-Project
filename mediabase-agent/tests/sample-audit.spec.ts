import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { auditSampleDirectory } from "../scripts/mb11SampleAudit";
import { buildId3v1Tag, buildMp3, buildWav, writeFixture } from "./support/audioFixtures";

test("local audit reports duplicates, pairings and conflicts without changing or exposing files", async ({}, testInfo) => {
  const directory = testInfo.outputPath("private-reference-material");
  const tags = { artist: "Fictional Private Artist", title: "Fictional Private Song", isrc: "USAAA2600010" };
  const mp3 = buildMp3(tags);
  const wav = buildWav({
    durationSeconds: 54,
    id3: tags,
    riffInfo: { artist: tags.artist, title: "Different Private Title" }
  });
  const paths = [
    writeFixture(join(directory, "private-song.mp3"), mp3),
    writeFixture(join(directory, "private-song (1).mp3"), mp3),
    writeFixture(join(directory, "white label.wav"), wav)
  ];
  const result = await auditSampleDirectory(directory);
  expect(result).toMatchObject({ mode: "LOCAL_READ_ONLY_AUDIO_AUDIT", counts: { audioFiles: 3, errors: 0 }, uploaded: false });
  expect(result.exactDuplicates).toHaveLength(1);
  expect(result.exactDuplicates[0].fileIds).toHaveLength(2);
  expect(result.isrcPairings).toHaveLength(1);
  expect(result.isrcPairings[0]).toMatchObject({ conflictingDurations: true, formats: expect.arrayContaining(["MP3", "WAV"]) });
  expect(result.files.some((item) => item.conflicts.includes("ID3_INFO_CONFLICT:title") && item.rightsReviewRequired)).toBe(true);
  expect(result.files.filter((item) => item.format === "MP3").every((item) => item.versionIndicators.length === 0)).toBe(true);
  const output = JSON.stringify(result);
  expect(output).not.toContain(directory);
  expect(output).not.toContain(tags.artist);
  expect(output).not.toContain(tags.title);
  expect(output).not.toContain(tags.isrc);
  expect(await fs.readFile(paths[0])).toEqual(mp3);
  expect(await fs.readFile(paths[1])).toEqual(mp3);
  expect(await fs.readFile(paths[2])).toEqual(wav);
  await expect(auditSampleDirectory("relative-directory")).rejects.toThrow("absolute");
});

test("local audit reports conflicting legacy ID3v1 genres without exposing values", async ({}, testInfo) => {
  const directory = testInfo.outputPath("legacy-audit");
  const tags = { artist: "Fictional Private Artist", title: "Fictional Private Song", genre: "Pop" };
  const bytes = Buffer.concat([buildMp3(tags), buildId3v1Tag(tags, 17)]);
  const path = writeFixture(join(directory, "private.mp3"), bytes);
  const result = await auditSampleDirectory(directory);
  expect(result.files).toHaveLength(1);
  expect(result.files[0].conflicts).toContain("ID3_VERSION_CONFLICT:genre");
  expect(JSON.stringify(result)).not.toContain(tags.artist);
  expect(JSON.stringify(result)).not.toContain(tags.genre);
  expect(await fs.readFile(path)).toEqual(bytes);
});
