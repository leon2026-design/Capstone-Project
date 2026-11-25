import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createArtistAttributionDecision, confirmArtistAttribution } from "../src/metadata/artistAttribution";
import type { DemoRecording } from "../src/metadata/recordValidation";
import { DEFAULT_MP3_TAG_PROFILE } from "../src/submission/audioTagProfile";
import {
  resolveClientMetadata,
  SPONSOR_METADATA_CONTRACT,
  type ClientMetadataContract
} from "../src/submission/clientMetadataContract";
import { prepareAudioArtifact } from "../src/submission/audioPreparation";
import { findNamingCollisions, SPONSOR_TITLE_NAMING_PROFILE } from "../src/submission/namingProfile";
import { buildMp3, writeFixture } from "./support/audioFixtures";
import { fixture } from "./support/reviewFixture";

function reviewed(overrides: Partial<DemoRecording> = {}): DemoRecording {
  const { record } = fixture();
  return {
    ...record,
    artist: "Fictional Artist",
    artistAttribution: confirmArtistAttribution(
      createArtistAttributionDecision("Fictional Artist", "Fictional Album Artist"),
      { exactArtist: "Fictional Artist", primaryArtist: "Fictional Artist" }
    ),
    officialReleaseDate: "11/15/2026",
    comments: "Fictional reviewed comment",
    ...overrides
  };
}

const approvedValues = {
  genre: { value: "Fictional Genre", sourceReference: "fictional-catalog", approvedBy: "reviewer" },
  publisher: { value: "Rye Music", sourceReference: "fictional-publisher-review", approvedBy: "reviewer" }
};

test("strict sponsor contract reports missing values without inventing them", async ({}, testInfo) => {
  const record = reviewed({ title: "Fictional Song (Radio)", isrc: null, isrcValidation: { status: "missing", originalValue: null, reviewed: true } });
  const source = writeFixture(testInfo.outputPath("source.mp3"), buildMp3());
  const output = testInfo.outputPath("strict-output");
  const result = await prepareAudioArtifact({ recording: record, sourceAudioPath: source, outputDirectory: output });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failures.map((item) => [item.field, item.code])).toEqual(expect.arrayContaining([
    ["isrc", "REQUIRED_TAG_VALUE_MISSING"],
    ["genre", "REQUIRED_TAG_VALUE_MISSING"],
    ["publisher", "REQUIRED_TAG_VALUE_MISSING"],
    ["contentRating", "CLEAN_EXPLICIT_UNKNOWN"]
  ]));
  expect(result.manifest.clientMetadata?.fields.version).toMatchObject({ status: "RECOVERED", value: "Radio" });
  expect(result.failures.every((item) => item.humanInterventionRequired)).toBe(true);
  await expect(fs.access(output)).rejects.toThrow();
});

test("known publisher and clean rating remain blocked when their encodings are unconfirmed", () => {
  const result = resolveClientMetadata(reviewed({ title: "Fictional Song (Clean)" }), "MP3", DEFAULT_MP3_TAG_PROFILE, {
    explicitValues: approvedValues,
    recordedAt: "2026-11-06T12:00:00.000Z"
  });
  expect(result.fields.albumArtist.value).toBe("Fictional Album Artist");
  expect(result.fields.artist.value).toBe("Fictional Artist");
  expect(result.fields.publisher).toMatchObject({ status: "UNSUPPORTED_MAPPING", value: "Rye Music" });
  expect(result.fields.contentRating).toMatchObject({ status: "UNSUPPORTED_MAPPING", value: "CLEAN" });
  expect(result.fields.genre.evidence[0]).toMatchObject({
    source: "REVIEWED_DECISION", sourceReference: "fictional-catalog", reviewerId: "reviewer",
    originalValue: "Fictional Genre", normalizedValue: "Fictional Genre"
  });
  expect(result.problems.filter((item) => item.code === "UNSUPPORTED_TAG_MAPPING").map((item) => item.field))
    .toEqual(expect.arrayContaining(["publisher", "contentRating"]));
});

test("rating resolution distinguishes explicit labels from radio, AI, and weak filename evidence", () => {
  for (const title of ["Fictional Song (Radio)", "Fictional Song (DJ Version)", "Fictional Song (AI)", "Clean Slate"]) {
    const result = resolveClientMetadata(reviewed({ title }), "MP3", DEFAULT_MP3_TAG_PROFILE);
    expect(result.fields.contentRating).toMatchObject({ status: "MISSING", value: null });
    expect(result.problems.map((item) => item.code)).toContain("CLEAN_EXPLICIT_UNKNOWN");
  }
  const explicit = resolveClientMetadata(reviewed({ title: "Fictional Song (Explicit)" }), "MP3", DEFAULT_MP3_TAG_PROFILE);
  expect(explicit.fields.contentRating.value).toBe("EXPLICIT");

  const audio = fixture().audio[0];
  if (audio.status !== "OK") throw new Error("Fictional audio fixture must be readable.");
  const weak = resolveClientMetadata(reviewed(), "MP3", DEFAULT_MP3_TAG_PROFILE, {
    sourceMetadata: { ...audio.metadata, format: "MP3", fileName: "Fictional Song CLEAN.mp3" }
  });
  expect(weak.fields.contentRating).toMatchObject({ status: "MISSING", value: null });
  const conflict = resolveClientMetadata(reviewed({ title: "Fictional Song (Explicit)" }), "MP3", DEFAULT_MP3_TAG_PROFILE, {
    sourceMetadata: { ...audio.metadata, format: "MP3", fileName: "Fictional Song CLEAN.mp3" }
  });
  expect(conflict.fields.contentRating.status).toBe("CONFLICT");
  expect(conflict.problems.map((item) => item.code)).toContain("CONTENT_RATING_CONFLICT");
  const acknowledged = resolveClientMetadata(reviewed({ title: "Fictional Song (Explicit)" }), "MP3", DEFAULT_MP3_TAG_PROFILE, {
    sourceMetadata: { ...audio.metadata, format: "MP3", fileName: "Fictional Song CLEAN.mp3" },
    explicitValues: {
      contentRating: {
        value: "Explicit", sourceReference: "reviewed-rating", approvedBy: "reviewer",
        acknowledgedEvidence: ["selected-audio.filename"], note: "The filename was incorrectly labelled."
      }
    }
  });
  expect(acknowledged.fields.contentRating).toMatchObject({ status: "UNSUPPORTED_MAPPING", value: "EXPLICIT" });
  expect(acknowledged.fields.contentRating.evidence).toContainEqual(expect.objectContaining({
    resolutionRule: "human-acknowledged-conflicting-rating-evidence", reviewerId: "reviewer"
  }));
});

test("publisher aliases are not assumed and only an individually approved mapping is applied", () => {
  const explicitValues = {
    ...approvedValues,
    publisher: { ...approvedValues.publisher, value: "Rye 51 Music, LLC" }
  };
  const original = resolveClientMetadata(reviewed(), "MP3", DEFAULT_MP3_TAG_PROFILE, { explicitValues });
  expect(original.fields.publisher.value).toBe("Rye 51 Music, LLC");
  const contract: ClientMetadataContract = {
    ...SPONSOR_METADATA_CONTRACT,
    version: "2",
    publisherAliases: [{
      original: "Rye 51 Music, LLC",
      canonical: "Fictional Approved Publisher",
      approvedBy: "fictional-reviewer",
      sourceReference: "fictional-alias-decision"
    }]
  };
  const mapped = resolveClientMetadata(reviewed(), "MP3", DEFAULT_MP3_TAG_PROFILE, { contract, explicitValues });
  expect(mapped.fields.publisher.value).toBe("Fictional Approved Publisher");
  expect(mapped.fields.publisher.evidence).toContainEqual(expect.objectContaining({
    originalValue: "Rye 51 Music, LLC", normalizedValue: "Fictional Approved Publisher",
    resolutionRule: "approved-publisher-alias", reviewerId: "fictional-reviewer"
  }));
  expect(mapped.contractDigest).not.toBe(original.contractDigest);
});

test("reviewed title versions are recovered without treating download counters as versions", () => {
  const fromTitle = resolveClientMetadata(reviewed({ title: "Fictional Song (Larry Peace Rerub)" }), "MP3", DEFAULT_MP3_TAG_PROFILE);
  expect(fromTitle.fields.version).toMatchObject({ status: "RECOVERED", value: "Larry Peace Rerub" });
  const download = resolveClientMetadata(reviewed({ title: "Fictional Song (1)" }), "MP3", DEFAULT_MP3_TAG_PROFILE);
  expect(download.fields.version.status).toBe("NOT_APPLICABLE");
  const conflicting = resolveClientMetadata(reviewed({ title: "Fictional Song (Radio)", version: "Extended Mix" }), "MP3", DEFAULT_MP3_TAG_PROFILE);
  expect(conflicting.fields.version.status).toBe("CONFLICT");
  expect(conflicting.problems.map((item) => item.code)).toContain("VERSION_CONFLICT");
});

test("title naming preserves versions and Unicode, rejects reserved and overly long names, and finds collisions", () => {
  const profile = SPONSOR_TITLE_NAMING_PROFILE;
  const record = reviewed({ title: "Café (Radio)", version: "Radio" });
  const input = { fileName: "downloaded (1).mp3", format: "MP3" as const, record };
  expect(profile.check(input).suggestedName).toBe("Café (Radio).mp3");
  expect(profile.check({ ...input, record: { ...record, title: "Café", version: "Extended Mix" } }).suggestedName)
    .toBe("Café (Extended Mix).mp3");
  expect(profile.check({ ...input, format: "WAV" }).suggestedName).toBe("Café (Radio).wav");
  expect(profile.check({ ...input, record: { ...record, title: "A/B", version: null } }).suggestedName).toBe("A-B.mp3");
  expect(profile.check({ ...input, record: { ...record, title: "CON", version: null } }).suggestedName).toBeNull();
  expect(profile.check({ ...input, record: { ...record, title: "COM\u00b9", version: null } }).suggestedName).toBeNull();
  expect(profile.check({ ...input, record: { ...record, title: "A".repeat(181), version: null } }).suggestedName).toBeNull();
  expect(findNamingCollisions([
    input,
    { ...input, record: { ...record, recordingId: "other", title: "Cafe\u0301 (radio)" } }
  ], profile)).toHaveLength(1);
});
