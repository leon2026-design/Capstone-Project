import { expect, test, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAudioMatch,
  confirmAudioSelection,
  matchAudioToRecording,
  matchAudioToRecordings
} from "../src/audio/audioMatcher";
import { extractAudioMetadata, extractAudioMetadataBatch } from "../src/audio/audioMetadata";
import { validateRecordForPreparation, type DemoRecording } from "../src/browser/mediabaseForm";
import { confirmArtistAttribution, createArtistAttributionDecision } from "../src/metadata/artistAttribution";
import {
  analyzeMetadataGaps,
  analyzeMetadataGapsBatch,
  METADATA_GAP_SHEET_COLUMNS,
  toMetadataGapSheetRows,
  type MetadataGapReport
} from "../src/metadata/metadataGapAnalyzer";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import { buildWav, writeFixture, type FixtureTags } from "./support/audioFixtures";

const ISRC = "USAAA2600010";
const tags: FixtureTags = {
  artist: "Mara Quill",
  title: "Glass Coast",
  album: "Low Tide Atlas",
  isrc: ISRC,
  version: "Radio Edit"
};

function wav(testInfo: TestInfo, name: string, id3?: FixtureTags): string {
  return writeFixture(testInfo.outputPath("audio", name), buildWav(id3 ? { id3 } : {}));
}

function confirmedAttribution() {
  return confirmArtistAttribution(createArtistAttributionDecision("Mara Quill", "Mara Quill"), {
    exactArtist: "Mara Quill",
    primaryArtist: "Mara Quill"
  });
}

/** A fully reviewed, approved fictional recording. */
function completeRecord(audioFilePath: string | null = null, overrides: Partial<DemoRecording> = {}): DemoRecording {
  return {
    recordingId: "ORCHARD-COMPLETE",
    submitterName: "Casey Morgan",
    email: "casey@example.test",
    artist: "Mara Quill",
    artistAttribution: confirmedAttribution(),
    featuredArtist: null,
    title: "Glass Coast",
    version: "Radio Edit",
    isrc: ISRC,
    isrcValidation: { status: "valid", originalValue: ISRC, reviewed: true },
    label: "Low Tide Records",
    officialReleaseDate: "11/15/2026",
    albumTitle: "Low Tide Atlas",
    albumUPC: "123456789012",
    albumReleaseDate: "11/15/2026",
    generativeAiAudioDeclaration: "no",
    independentLabelDeclaration: "yes",
    christmasHanukkahDeclaration: "no",
    canadianContentDeclaration: "no",
    audioFilePath,
    audioMatch: {
      status: audioFilePath ? "CONFIRMED" : "NO_AUDIO_CONFIRMED",
      filePath: audioFilePath,
      basis: audioFilePath ? "ISRC" : null,
      candidateFilePaths: audioFilePath ? [audioFilePath] : [],
      humanConfirmed: true,
      acknowledgedConflicts: []
    },
    approvalStatus: "APPROVED",
    ...overrides
  };
}

function codes(report: MetadataGapReport): string[] {
  return report.gaps.map((gap) => gap.code);
}

function gap(report: MetadataGapReport, code: string, field?: string) {
  const found = report.gaps.find((entry) => entry.code === code && (field === undefined || entry.fields.includes(field)));
  if (!found) throw new Error(`Expected gap ${code}${field ? ` on ${field}` : ""}; got ${codes(report).join(", ")}`);
  return found;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("reports a complete approved record as ready with only informational notes", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", tags);
  const record = completeRecord(path);
  const report = analyzeMetadataGaps(record, { audioExtractions: [await extractAudioMetadata(path)] });

  expect(report).toMatchObject({
    recordingId: "ORCHARD-COMPLETE",
    approvalStatus: "APPROVED",
    readiness: "READY",
    summary: { blocking: 0, warning: 0, informational: 1, researchEligible: 0 }
  });
  expect(codes(report)).toEqual(["featured-artist-unavailable"]);
  expect(report.gaps[0]).toMatchObject({
    gapId: "ORCHARD-COMPLETE:featured-artist-unavailable:featuredArtist",
    severity: "informational",
    researchEligible: false
  });
  expect(() => validateRecordForPreparation(record)).not.toThrow();
});

test("lists every gap in an incomplete Orchard draft", () => {
  const csv = "TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,PRODUCT,PRODUCT TYPE\nSalt Lines,Tidewater Collective,Mara Quill,,Low Tide Atlas,Album\n";
  const [draft] = importOrchardCsv(csv, "draft.csv").records;
  const report = analyzeMetadataGaps(draft);

  expect(report.readiness).toBe("BLOCKED");
  expect(report.approvalStatus).toBe("DRAFT");
  expect(codes(report)).toEqual([
    "approval-pending",
    "artist-conflict",
    "missing-isrc",
    "missing-required-field",
    "missing-required-field",
    "missing-required-field",
    "declaration-unanswered",
    "declaration-unanswered",
    "declaration-unanswered",
    "declaration-unanswered",
    "missing-album-release-date",
    "missing-album-upc",
    "missing-label",
    "audio-not-evaluated",
    "featured-artist-unavailable"
  ]);
  expect(gap(report, "missing-required-field", "submitterName")).toMatchObject({ severity: "blocking", researchEligible: false });
  expect(gap(report, "missing-required-field", "officialReleaseDate")).toMatchObject({
    severity: "blocking",
    resolution: "external-research",
    researchEligible: true,
    requiresHumanConfirmation: true
  });
  expect(gap(report, "missing-label")).toMatchObject({ severity: "warning", researchEligible: true });
  expect(gap(report, "approval-pending")).toMatchObject({ resolution: "human-review", researchEligible: false });
  // Optional, empty fields are not reported.
  for (const field of ["company", "phone", "artistWebsite", "comments", "hideUntil", "version"]) {
    expect(report.gaps.some((entry) => entry.fields.includes(field))).toBe(false);
  }
});

test("classifies missing ISRCs by review state and available evidence", async ({}, testInfo) => {
  const unreviewed = analyzeMetadataGaps(
    completeRecord(null, { isrc: null, isrcValidation: { status: "missing", originalValue: null, reviewed: false } })
  );
  expect(gap(unreviewed, "missing-isrc")).toMatchObject({
    severity: "blocking",
    category: "missing",
    resolution: "external-research",
    researchEligible: true,
    requiresHumanConfirmation: true
  });
  expect(unreviewed.readiness).toBe("BLOCKED");

  const reviewed = analyzeMetadataGaps(
    completeRecord(null, { isrc: null, isrcValidation: { status: "missing", originalValue: null, reviewed: true } })
  );
  expect(gap(reviewed, "isrc-confirmed-absent")).toMatchObject({ severity: "informational", researchEligible: false });
  expect(reviewed.readiness).toBe("READY");

  const manual = analyzeMetadataGaps(completeRecord(null, { isrc: null, isrcValidation: undefined }));
  expect(gap(manual, "missing-isrc").severity).toBe("warning");

  const path = wav(testInfo, "embedded.wav", tags);
  const withEmbedded = analyzeMetadataGaps(completeRecord(path, { isrc: null, isrcValidation: undefined }), {
    audioExtractions: [await extractAudioMetadata(path)]
  });
  expect(gap(withEmbedded, "missing-isrc")).toMatchObject({
    resolution: "human-review",
    evidence: [{ source: "audio-metadata", field: "ISRC", value: ISRC }]
  });
  expect(gap(withEmbedded, "missing-isrc").recommendedAction).toContain(ISRC);
});

test("reports invalid ISRCs with deterministic suggestions only when unambiguous", () => {
  const imported = analyzeMetadataGaps(
    completeRecord(null, { isrc: null, isrcValidation: { status: "invalid", originalValue: "US-AAA-26-0001", reviewed: false } })
  );
  expect(gap(imported, "invalid-isrc")).toMatchObject({
    severity: "blocking",
    category: "invalid",
    researchEligible: true,
    suggestedValue: null,
    evidence: [{ source: "orchard", field: "ISRC", value: "US-AAA-26-0001" }]
  });

  const unnormalized = analyzeMetadataGaps(completeRecord(null, { isrc: "usaaa-2600010", isrcValidation: undefined }));
  expect(gap(unnormalized, "invalid-isrc")).toMatchObject({
    resolution: "deterministic",
    researchEligible: false,
    requiresHumanConfirmation: false,
    suggestedValue: ISRC
  });
});

test("blocks conflicting embedded audio ISRCs until a reviewer acknowledges them", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", { ...tags, isrc: "USAAA2699999" });
  const extraction = await extractAudioMetadata(path);
  const base = completeRecord(path, { audioMatch: undefined });

  const conflicting = analyzeMetadataGaps(base, { audioExtractions: [extraction] });
  expect(gap(conflicting, "audio-isrc-conflict")).toMatchObject({
    severity: "blocking",
    category: "conflicting",
    resolution: "human-review",
    requiresHumanConfirmation: true
  });
  expect(gap(conflicting, "audio-isrc-conflict").evidence).toEqual(
    expect.arrayContaining([
      { source: "record", field: "isrc", value: ISRC },
      { source: "audio-metadata", field: "ISRC", value: "USAAA2699999" }
    ])
  );
  expect(conflicting.readiness).toBe("BLOCKED");

  const result = matchAudioToRecording(base, [extraction]);
  const acknowledged = confirmAudioSelection(base, result, path, { acknowledgeConflicts: true });
  const report = analyzeMetadataGaps(acknowledged, { audioExtractions: [extraction], audioMatchResults: [result] });
  expect(gap(report, "audio-isrc-conflict").severity).toBe("informational");
  expect(report.readiness).toBe("READY");
});

test("requires explicit human artist confirmation and never routes it to research", () => {
  const draft = completeRecord(null, {
    artist: "",
    artistAttribution: createArtistAttributionDecision("Mara Quill", "Mara Quill")
  });
  const unconfirmed = analyzeMetadataGaps(draft);
  expect(gap(unconfirmed, "artist-unconfirmed")).toMatchObject({
    severity: "blocking",
    category: "needs-human-review",
    resolution: "human-review",
    researchEligible: false,
    fields: ["artist", "artistAttribution"]
  });
  expect(unconfirmed.gaps.filter((entry) => entry.fields.includes("artist"))).toHaveLength(1);

  const conflict = analyzeMetadataGaps(
    completeRecord(null, { artist: "", artistAttribution: createArtistAttributionDecision("Mara Quill", "Tidewater Collective") })
  );
  expect(gap(conflict, "artist-conflict")).toMatchObject({ category: "conflicting", researchEligible: false });
  expect(codes(conflict)).not.toContain("artist-unconfirmed");

  const mismatch = analyzeMetadataGaps(completeRecord(null, { artist: "Someone Else" }));
  expect(gap(mismatch, "artist-confirmation-mismatch").severity).toBe("blocking");
});

test("accepts confirmed attribution and reports hierarchy only when the workflow expects it", () => {
  const record = completeRecord();
  const report = analyzeMetadataGaps(record);
  expect(report.gaps.some((entry) => entry.area === "artist-attribution" && entry.severity !== "informational")).toBe(false);
  expect(report.readiness).toBe("READY");

  const expected = analyzeMetadataGaps(record, { expectedArtistRoles: ["tertiary", "primary", "secondary"] });
  expect(expected.gaps.filter((entry) => entry.code === "artist-role-missing").map((entry) => entry.fields)).toEqual([
    ["artistAttribution.secondaryArtist"],
    ["artistAttribution.tertiaryArtist"]
  ]);
  expect(expected.readiness).toBe("BLOCKED");

  const featured = analyzeMetadataGaps(completeRecord(null, { featuredArtist: "Juniper Vale", approvalStatus: "NEEDS_REVIEW" }));
  expect(gap(featured, "featured-artist-unverified")).toMatchObject({ severity: "informational", researchEligible: false });
});

test("reports missing, unmatched, unverified, and unreadable audio", async ({}, testInfo) => {
  const other = wav(testInfo, "unrelated-demo.wav", { artist: "Someone", title: "Other Song" });
  const extractions = await extractAudioMetadataBatch([other]);
  const draft = completeRecord(null, { audioMatch: undefined });
  const result = matchAudioToRecording(draft, extractions);
  expect(result.status).toBe("NO_MATCH");

  const unmatched = analyzeMetadataGaps(applyAudioMatch(draft, result), { audioMatchResults: [result] });
  expect(gap(unmatched, "audio-no-match")).toMatchObject({ severity: "warning", category: "missing", researchEligible: false });
  expect(unmatched.readiness).toBe("READY");

  const confirmedNone = analyzeMetadataGaps(completeRecord());
  expect(confirmedNone.gaps.some((entry) => entry.area === "audio")).toBe(false);

  const missingPath = join(testInfo.outputPath("audio"), "deleted.wav");
  const missing = analyzeMetadataGaps(completeRecord(missingPath), {
    audioExtractions: [await extractAudioMetadata(missingPath)]
  });
  expect(gap(missing, "audio-file-unreadable")).toMatchObject({ severity: "blocking", category: "missing" });
  expect(missing.readiness).toBe("BLOCKED");

  const unverified = analyzeMetadataGaps(completeRecord(missingPath));
  expect(gap(unverified, "audio-file-unverified")).toMatchObject({ severity: "warning", resolution: "deterministic" });
});

test("leaves ambiguous audio candidates and conflicting audio metadata to a human", async ({}, testInfo) => {
  const first = wav(testInfo, "glass-coast-a.wav", tags);
  const second = wav(testInfo, "glass-coast-b.wav", tags);
  const extractions = await extractAudioMetadataBatch([first, second]);
  const draft = completeRecord(null, { audioMatch: undefined, approvalStatus: "DRAFT" });
  const result = matchAudioToRecording(draft, extractions);
  expect(result.status).toBe("AMBIGUOUS");

  const report = analyzeMetadataGaps(applyAudioMatch(draft, result), { audioExtractions: extractions, audioMatchResults: [result] });
  expect(gap(report, "audio-ambiguous")).toMatchObject({
    severity: "blocking",
    category: "needs-human-review",
    resolution: "human-review",
    researchEligible: false
  });
  expect(gap(report, "audio-ambiguous").evidence.filter((item) => item.field === "candidateFilePath").map((item) => item.value)).toEqual([
    first,
    second
  ]);

  const remix = wav(testInfo, "glass-coast-remix.wav", { ...tags, isrc: undefined, version: "Club Remix" });
  const conflicting = analyzeMetadataGaps(completeRecord(remix, { audioMatch: undefined }), {
    audioExtractions: [await extractAudioMetadata(remix)]
  });
  expect(gap(conflicting, "audio-metadata-conflict")).toMatchObject({ severity: "blocking", category: "conflicting" });
  expect(gap(conflicting, "audio-metadata-conflict").evidence[0].value).toContain("Club Remix");
});

test("flags unanswered and unsupported declarations for human answers only", () => {
  const report = analyzeMetadataGaps(
    completeRecord(null, {
      christmasHanukkahDeclaration: null,
      canadianContentDeclaration: "unanswered",
      independentLabelDeclaration: "maybe" as never
    })
  );
  const unanswered = report.gaps.filter((entry) => entry.code === "declaration-unanswered");
  expect(unanswered.map((entry) => entry.fields[0])).toEqual(["canadianContentDeclaration", "christmasHanukkahDeclaration"]);
  for (const entry of unanswered) {
    expect(entry).toMatchObject({ severity: "warning", resolution: "human-review", researchEligible: false });
  }
  expect(gap(report, "invalid-field-format", "independentLabelDeclaration").severity).toBe("blocking");
});

test("distinguishes missing, malformed, reformattable, and inconsistent release dates", () => {
  const missing = analyzeMetadataGaps(completeRecord(null, { officialReleaseDate: null }));
  expect(gap(missing, "missing-required-field", "officialReleaseDate")).toMatchObject({
    severity: "blocking",
    category: "missing",
    researchEligible: true
  });

  const iso = analyzeMetadataGaps(completeRecord(null, { officialReleaseDate: "2026-11-15" }));
  expect(gap(iso, "invalid-field-format", "officialReleaseDate")).toMatchObject({
    category: "invalid",
    resolution: "deterministic",
    suggestedValue: "11/15/2026",
    requiresHumanConfirmation: false
  });

  const impossible = analyzeMetadataGaps(completeRecord(null, { officialReleaseDate: "02/30/2026", albumReleaseDate: "13/01/2026" }));
  expect(gap(impossible, "invalid-field-format", "officialReleaseDate")).toMatchObject({
    resolution: "external-research",
    suggestedValue: null
  });
  expect(gap(impossible, "invalid-field-format", "albumReleaseDate").severity).toBe("blocking");

  const ordered = analyzeMetadataGaps(completeRecord(null, { officialReleaseDate: "12/01/2026", albumReleaseDate: "11/15/2026" }));
  expect(gap(ordered, "release-date-order")).toMatchObject({ severity: "warning", category: "needs-human-review" });

  const noTitle = analyzeMetadataGaps(completeRecord(null, { albumTitle: null }));
  expect(gap(noTitle, "missing-album-title")).toMatchObject({ severity: "warning", researchEligible: true });

  const single = analyzeMetadataGaps(completeRecord(null, { albumTitle: null, albumReleaseDate: null }));
  expect(single.gaps.some((entry) => entry.area === "release")).toBe(false);
});

test("analyzes multiple recording versions independently", async ({}, testInfo) => {
  const csv = readFileSync(join(__dirname, "..", "fixtures", "orchard-multiple-versions.csv"), "utf8");
  const { records } = importOrchardCsv(csv, "orchard-multiple-versions.csv");
  const radio = wav(testInfo, "signal-again-radio.wav", {
    artist: "The Harbor Lights",
    title: "Signal, Again",
    isrc: "USAAA2600001",
    version: "Radio Edit"
  });
  const extractions = await extractAudioMetadataBatch([radio]);
  const results = matchAudioToRecordings(records, extractions);
  const applied = records.map((record, index) => applyAudioMatch(record, results[index]));
  const reports = analyzeMetadataGapsBatch(applied, { audioExtractions: extractions, audioMatchResults: results });

  expect(reports).toHaveLength(2);
  const [radioReport, remixReport] = ["Radio Edit", "Remix"].map((version) => {
    const record = applied.find((entry) => entry.version === version)!;
    return reports.find((report) => report.recordingId === record.recordingId)!;
  });
  expect(radioReport.recordingId).not.toBe(remixReport.recordingId);
  expect(codes(radioReport)).not.toContain("missing-isrc");
  expect(codes(radioReport)).not.toContain("audio-needs-review");
  expect(gap(remixReport, "missing-isrc").severity).toBe("blocking");
  expect(gap(remixReport, "audio-needs-review").severity).toBe("blocking");
  for (const report of reports) {
    expect(report.readiness).toBe("BLOCKED");
    expect(gap(report, "artist-conflict").evidence).toEqual(
      expect.arrayContaining([
        { source: "orchard", field: "TRACK ARTIST", value: "The Harbor Lights" },
        { source: "orchard", field: "PRODUCT ARTIST", value: "North Star Music" }
      ])
    );
    expect(gap(report, "invalid-album-upc")).toMatchObject({ severity: "warning", suggestedValue: null });
    expect(report.gaps.every((entry) => entry.gapId.startsWith(`${report.recordingId}:`))).toBe(true);
  }
});

test("never mutates input records or context", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", { ...tags, isrc: "USAAA2699999" });
  const extractions = await extractAudioMetadataBatch([path]);
  const record = completeRecord(path, { audioMatch: undefined, approvalStatus: "DRAFT", officialReleaseDate: "2026-11-15" });
  const results = [matchAudioToRecording(record, extractions)];
  const snapshot = structuredClone({ record, extractions, results });
  deepFreeze({ record, extractions, results });

  const report = analyzeMetadataGaps(record, { audioExtractions: extractions, audioMatchResults: results });
  analyzeMetadataGapsBatch([record], { audioExtractions: extractions, audioMatchResults: results });

  expect({ record, extractions, results }).toEqual(snapshot);
  expect(record.approvalStatus).toBe("DRAFT");
  expect(report.readiness).toBe("BLOCKED");
});

test("produces identical output regardless of record and context order", async ({}, testInfo) => {
  const radio = wav(testInfo, "glass-coast.wav", tags);
  const other = wav(testInfo, "harbor.wav", { artist: "The Harbor Lights", title: "Harbor Song" });
  const extractions = await extractAudioMetadataBatch([radio, other]);
  const records: DemoRecording[] = [
    completeRecord(null, { recordingId: "ORCHARD-C", audioMatch: undefined }),
    completeRecord(null, { recordingId: "ORCHARD-A", title: "Harbor Song", artist: "", audioMatch: undefined, artistAttribution: createArtistAttributionDecision("The Harbor Lights", null) }),
    completeRecord(null, { recordingId: "ORCHARD-B", isrc: null, isrcValidation: undefined, label: null, audioMatch: undefined })
  ];
  const results = matchAudioToRecordings(records, extractions);
  const forward = analyzeMetadataGapsBatch(records, { audioExtractions: extractions, audioMatchResults: results });
  const backward = analyzeMetadataGapsBatch([...records].reverse(), {
    audioExtractions: [...extractions].reverse(),
    audioMatchResults: [...results].reverse(),
    expectedArtistRoles: []
  });

  expect(backward).toEqual(forward);
  expect(forward.map((report) => report.recordingId)).toEqual(["ORCHARD-A", "ORCHARD-B", "ORCHARD-C"]);

  const rows = toMetadataGapSheetRows(forward);
  expect(rows.every((row) => row.length === METADATA_GAP_SHEET_COLUMNS.length)).toBe(true);
  expect(rows.every((row) => row.every((cell) => typeof cell === "string" || typeof cell === "boolean"))).toBe(true);
  expect(toMetadataGapSheetRows([{ ...forward[0], gaps: [] }])[0].slice(0, 3)).toEqual(["ORCHARD-A", forward[0].readiness, ""]);
});
