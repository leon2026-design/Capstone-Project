import { expect, test } from "@playwright/test";
import {
  researchIdentityFingerprint,
  type MetadataResearchTask
} from "../src/metadata/metadataResearch";
import {
  buildMusicBrainzProposal,
  type MusicBrainzSelection
} from "../src/research/musicBrainzSuggestions";
import type {
  MusicBrainzLookupResult,
  MusicBrainzReleaseLookupResult
} from "../src/research/musicBrainzLookup";

type AlbumField = "albumTitle" | "albumUPC" | "albumReleaseDate";

const MB_RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const MB_RELEASE_ID = "33333333-3333-4333-8333-333333333333";

function fixture(field: AlbumField = "albumTitle") {
  const gapCodes = {
    albumTitle: "missing-album-title",
    albumUPC: "missing-album-upc",
    albumReleaseDate: "missing-album-release-date"
  } as const;

  const gapId = `TEST-001:${gapCodes[field]}:${field}`;

  const task: MetadataResearchTask = {
    taskId: `${gapId}:research:${field}`,
    recordingId: "TEST-001",
    gapId,
    gapCode: gapCodes[field],
    field,
    existingMetadata: {
      artist: "Fictional Artist",
      title: "Fictional Song",
      isrc: "USAAA2600010"
    },
    identityFingerprint: "",
    originalEvidence: [],
    question: "Find the missing album metadata.",
    allowedSourceCategories: ["published-catalog"],
    restrictions: ["Never approve or modify a recording."],
    requiresHumanReview: true,
    agentMayResolve: false,
    conflictRequiresHumanResolution: false
  };

  task.identityFingerprint = researchIdentityFingerprint(
    task.recordingId,
    task.existingMetadata
  );

  const lookup: MusicBrainzLookupResult = {
    recordingId: "TEST-001",
    queriedIsrc: "USAAA2600010",
    status: "NEEDS_REVIEW",
    requiresHumanReview: true,
    error: null,
    candidates: [{
      musicBrainzId: MB_RECORDING_ID,
      title: "Fictional Song",
      artistCredit: "Fictional Artist",
      sourceUrl: `https://musicbrainz.org/recording/${MB_RECORDING_ID}`,
      releases: [],
      releaseListMayBeIncomplete: true
    }]
  };

  const releaseLookup: MusicBrainzReleaseLookupResult = {
    musicBrainzId: MB_RECORDING_ID,
    status: "NEEDS_REVIEW",
    requiresHumanReview: true,
    releaseListMayBeIncomplete: true,
    error: null,
    releases: [{
      musicBrainzId: MB_RELEASE_ID,
      title: "Fictional Album",
      date: "2026-11-15",
      country: "US",
      barcode: "0012345678905",
      sourceUrl: `https://musicbrainz.org/release/${MB_RELEASE_ID}`
    }]
  };

  const selection: MusicBrainzSelection = {
    musicBrainzRecordingId: MB_RECORDING_ID,
    musicBrainzReleaseId: MB_RELEASE_ID
  };

  return { task, lookup, releaseLookup, selection };
}

function build(input: ReturnType<typeof fixture>) {
  return buildMusicBrainzProposal(
    input.task,
    input.lookup,
    input.releaseLookup,
    input.selection
  );
}

test("creates a pending proposal without claiming independent verification", () => {
  const result = build(fixture());

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join("; "));

  expect(result.proposal).toMatchObject({
    recordingId: "TEST-001",
    field: "albumTitle",
    outcome: "INSUFFICIENT_EVIDENCE",
    suggestedValue: null,
    reviewStatus: "PENDING_REVIEW",
    requiresHumanReview: true,
    agentMayResolve: false
  });

  expect(result.proposal.evidence[0]).toMatchObject({
    supportedValue: "Fictional Album",
    quote: "Fictional Album",
    category: "published-catalog",
    url: `https://musicbrainz.org/release/${MB_RELEASE_ID}`,
    verification: "PROVIDER_CLAIM",
    verificationId: null
  });
});

test("preserves barcode leading zeros in proposal evidence", () => {
  const result = build(fixture("albumUPC"));

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join("; "));

  expect(result.proposal.evidence[0].supportedValue)
    .toBe("0012345678905");
  expect(result.proposal.suggestedValue).toBeNull();
});

test("formats a complete date but never invents missing date parts", () => {
  for (const [date, expected] of [
    ["2026-11-15", "11/15/2026"],
    ["2026-11", "2026-11"],
    ["2026", "2026"],
    ["2026-02-31", "2026-02-31"]
  ]) {
    const input = fixture("albumReleaseDate");
    input.releaseLookup.releases[0].date = date;

    const result = build(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));

    expect(result.proposal.evidence).toMatchObject([{
      sourceId: "MusicBrainz",
      url: `https://musicbrainz.org/release/${MB_RELEASE_ID}`,
      quote: date,
      supportedValue: expected,
      verification: "PROVIDER_CLAIM",
      verificationId: null
    }]);
    expect(result.proposal.suggestedValue).toBeNull();
    expect(result.proposal.outcome).toBe("INSUFFICIENT_EVIDENCE");
  }
});

test("keeps a missing release date out of proposal evidence", () => {
  const input = fixture("albumReleaseDate");
  input.releaseLookup.releases[0].date = null;

  const result = build(input);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join("; "));
  expect(result.proposal.evidence).toEqual([]);
  expect(result.proposal.suggestedValue).toBeNull();
  expect(result.proposal.outcome).toBe("INSUFFICIENT_EVIDENCE");
});

test("rejects unrelated records, ISRCs, and release selections", () => {
  const wrongRecord = fixture();
  wrongRecord.lookup.recordingId = "OTHER";
  expect(build(wrongRecord).ok).toBe(false);

  const wrongIsrc = fixture();
  wrongIsrc.lookup.queriedIsrc = "USBBB2600020";
  expect(build(wrongIsrc).ok).toBe(false);

  const wrongRelease = fixture();
  wrongRelease.selection.musicBrainzReleaseId = "not-selected";
  expect(build(wrongRelease).ok).toBe(false);

  const wrongRecording = fixture();
  wrongRecording.releaseLookup.musicBrainzId =
    "22222222-2222-4222-8222-222222222222";
  expect(build(wrongRecording).ok).toBe(false);
});

test("rejects an inconsistent identity snapshot", () => {
  const input = fixture();
  input.task.existingMetadata.title = "Changed Song";

  expect(build(input).ok).toBe(false);
});

test("does not propose replacements for existing metadata", () => {
  const input = fixture();
  input.task.existingMetadata.albumTitle = "Existing Album";

  expect(build(input).ok).toBe(false);
});

test("does not map a release date to the official song release date", () => {
  const input = fixture();
  input.task.field = "officialReleaseDate";
  input.task.gapCode = "missing-required-field";

  expect(build(input).ok).toBe(false);
});

test("leaves all supplied inputs unchanged", () => {
  const input = fixture();
  const before = JSON.stringify(input);

  const result = build(input);

  expect(result.ok).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});