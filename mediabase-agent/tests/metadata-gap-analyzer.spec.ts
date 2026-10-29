import { expect, test, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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
  audioFileId,
  METADATA_GAP_SHEET_COLUMNS,
  RESEARCH_AGENT_POLICY,
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
    resolvedBy: "human",
    researchEligible: true,
    requiresHumanConfirmation: true
  });
  expect(gap(report, "missing-label")).toMatchObject({ severity: "warning", researchEligible: true });
  expect(gap(report, "approval-pending")).toMatchObject({ resolvedBy: "human", researchEligible: false });
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
    resolvedBy: "human",
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
    resolvedBy: "human",
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
    resolvedBy: "deterministic-rule",
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
    resolvedBy: "human",
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
    resolvedBy: "human",
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
  expect(gap(unverified, "audio-file-unverified")).toMatchObject({ severity: "warning", resolvedBy: "deterministic-rule" });
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
    resolvedBy: "human",
    researchEligible: false
  });
  expect(gap(report, "audio-ambiguous").evidence.filter((item) => item.field === "candidateFile")).toEqual([
    { source: "audio-match", field: "candidateFile", value: "glass-coast-a.wav", fileId: audioFileId(first) },
    { source: "audio-match", field: "candidateFile", value: "glass-coast-b.wav", fileId: audioFileId(second) }
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
    expect(entry).toMatchObject({ severity: "warning", resolvedBy: "human", researchEligible: false });
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
    resolvedBy: "deterministic-rule",
    suggestedValue: "11/15/2026",
    requiresHumanConfirmation: false
  });

  const impossible = analyzeMetadataGaps(completeRecord(null, { officialReleaseDate: "02/30/2026", albumReleaseDate: "13/01/2026" }));
  expect(gap(impossible, "invalid-field-format", "officialReleaseDate")).toMatchObject({
    resolvedBy: "human",
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

function importOrchardRecord(): DemoRecording {
  const csv = `TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,VERSION/MIX\n"Glass Coast","Mara Quill","Mara Quill",${ISRC},Radio Edit\n`;
  return importOrchardCsv(csv, "single.csv").records[0];
}

function readyFromOrchard(draft: DemoRecording, overrides: Partial<DemoRecording> = {}): DemoRecording {
  const { recordingId, artistAttribution, isrcValidation, title, version, isrc } = draft;
  return completeRecord(null, { recordingId, artistAttribution, isrcValidation, title, version, isrc, ...overrides });
}

test("blocks Orchard recordings whose attribution decision is omitted, forged, or stale", () => {
  const draft = importOrchardRecord();
  const confirmed = confirmArtistAttribution(draft.artistAttribution!, { exactArtist: "Mara Quill" });
  const ready = readyFromOrchard(draft, { artistAttribution: confirmed });
  expect(analyzeMetadataGaps(ready).readiness).toBe("READY");
  expect(() => validateRecordForPreparation(ready)).not.toThrow();

  const { artistAttribution, ...omitted } = ready;
  void artistAttribution;
  const cases: Array<[DemoRecording, string]> = [
    [omitted, "artist-attribution-missing"],
    [{ ...ready, artistAttribution: undefined }, "artist-attribution-missing"],
    [{ ...ready, artistAttribution: { ...draft.artistAttribution!, confirmed: true, confirmedExactArtist: "Mara Quill" } }, "artist-attribution-inconsistent"],
    [{ ...ready, artistAttribution: { ...confirmed, trackArtist: "Juniper Vale" } }, "artist-confirmation-stale"]
  ];
  for (const [record, code] of cases) {
    const report = analyzeMetadataGaps(record);
    expect(gap(report, code)).toMatchObject({ severity: "blocking", resolvedBy: "human", researchEligible: false });
    expect(report.readiness).toBe("BLOCKED");
    expect(() => validateRecordForPreparation(record)).toThrow();
  }
  // Changing the mutable recording ID does not grant the legacy exception.
  for (const recordingId of ["TEST-001", "MANUAL-42"]) {
    const renamed = analyzeMetadataGaps({ ...omitted, recordingId });
    expect(codes(renamed)).toContain("artist-attribution-missing");
    expect(renamed.readiness).toBe("BLOCKED");
  }
  // Only the explicit legacy marker keeps the documented exception, and not with an importer-format ID.
  expect(analyzeMetadataGaps({ ...omitted, recordingId: "TEST-001", recordSource: "MANUAL" }).readiness).toBe("READY");
  expect(analyzeMetadataGaps({ ...omitted, recordSource: "MANUAL" }).readiness).toBe("BLOCKED");
});

test("detects a stale automatic audio match and agrees with form validation", async ({}, testInfo) => {
  const radio = wav(testInfo, "glass-coast.wav", tags);
  const base = completeRecord(null, { audioMatch: undefined });
  const original = matchAudioToRecording(base, await extractAudioMetadataBatch([radio]));
  const approved = applyAudioMatch(base, original);
  expect(approved.audioMatch?.status).toBe("AUTO_MATCHED");
  expect(analyzeMetadataGaps(approved, { audioMatchResults: [original] }).readiness).toBe("READY");

  const extra = wav(testInfo, "glass-coast-alt.wav", tags);
  const extractions = await extractAudioMetadataBatch([radio, extra]);
  const current = matchAudioToRecording(base, extractions);
  const report = analyzeMetadataGaps(approved, { audioExtractions: extractions, audioMatchResults: [current] });
  expect(codes(report)).toEqual(expect.arrayContaining(["audio-ambiguous", "audio-match-stale"]));
  expect(gap(report, "audio-match-stale")).toMatchObject({ severity: "blocking", resolvedBy: "deterministic-rule" });
  expect(report.readiness).toBe("BLOCKED");
  expect(() => validateRecordForPreparation(approved, { audioMatchResult: current })).toThrow();

  const corrected = confirmAudioSelection(applyAudioMatch(approved, current), current, radio);
  const fixed = analyzeMetadataGaps(corrected, { audioExtractions: extractions, audioMatchResults: [current] });
  expect(fixed.readiness).toBe("READY");
  expect(() => validateRecordForPreparation(corrected, { audioMatchResult: current })).not.toThrow();

  const newCandidate = analyzeMetadataGaps(confirmAudioSelection(approved, original, radio), {
    audioExtractions: extractions,
    audioMatchResults: [current]
  });
  expect(gap(newCandidate, "audio-selection-new-candidates")).toMatchObject({ severity: "blocking", resolvedBy: "human" });
});

test("keeps research-eligible gaps under mandatory human resolution", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", { ...tags, isrc: "USAAA2699999" });
  const extraction = await extractAudioMetadata(path);
  const report = analyzeMetadataGaps(completeRecord(path, { audioMatch: undefined, label: null }), {
    audioExtractions: [extraction]
  });
  expect(gap(report, "audio-isrc-conflict")).toMatchObject({
    severity: "blocking",
    researchEligible: true,
    agentMayResolve: false,
    resolvedBy: "human",
    requiresHumanConfirmation: true,
    suggestedValue: null
  });
  expect(report.readiness).toBe("BLOCKED");

  // Once a human acknowledges the conflict it is resolved and no longer open for research.
  const result = matchAudioToRecording(completeRecord(path, { audioMatch: undefined }), [extraction]);
  const acknowledged = analyzeMetadataGaps(
    confirmAudioSelection(completeRecord(path, { audioMatch: undefined }), result, path, { acknowledgeConflicts: true }),
    { audioExtractions: [extraction], audioMatchResults: [result] }
  );
  expect(gap(acknowledged, "audio-isrc-conflict")).toMatchObject({ severity: "informational", researchEligible: false });
  // Research eligibility never changes the stored ISRC or suggests an authoritative value.
  expect(gap(report, "audio-isrc-conflict").evidence).toEqual(
    expect.arrayContaining([
      { source: "record", field: "isrc", value: ISRC },
      { source: "audio-metadata", field: "ISRC", value: "USAAA2699999" }
    ])
  );
  const drafts = importOrchardCsv(
    "TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,PRODUCT,PRODUCT TYPE\nSalt Lines,Tidewater Collective,Mara Quill,,Low Tide Atlas,Album\n",
    "draft.csv"
  ).records;
  for (const entry of [...report.gaps, ...drafts.flatMap((draft) => analyzeMetadataGaps(draft).gaps)]) {
    expect(entry.agentMayResolve).toBe(false);
    if (entry.researchEligible) expect(entry).toMatchObject({ resolvedBy: "human", requiresHumanConfirmation: true });
  }
  expect(RESEARCH_AGENT_POLICY.mustNot.join(" ")).toMatch(/approve/i);
});

test("redacts submitter emails and local audio paths from exported reports", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", { ...tags, isrc: "USAAA2699999" });
  const second = wav(testInfo, "glass-coast-b.wav", tags);
  const extractions = await extractAudioMetadataBatch([path, second]);
  const missingPath = join(testInfo.outputPath("audio"), "deleted.wav");
  const records = [
    completeRecord(path, { audioMatch: undefined, email: "casey@example" }),
    completeRecord(missingPath, { recordingId: "ORCHARD-MISSING", comments: "Contact casey@example.test about C:\\private\\take.wav" }),
    completeRecord(null, { recordingId: "ORCHARD-AMBIGUOUS", audioMatch: undefined })
  ];
  const results = matchAudioToRecordings(records, extractions);
  const reports = analyzeMetadataGapsBatch(records, {
    audioExtractions: [...extractions, await extractAudioMetadata(missingPath)],
    audioMatchResults: results
  });
  const serialized = JSON.stringify({ reports, rows: toMetadataGapSheetRows(reports) });
  const audioDirectory = testInfo.outputPath("audio");

  expect(serialized).not.toContain("casey@example");
  expect(serialized).not.toContain(JSON.stringify(audioDirectory).slice(1, -1));
  expect(serialized).not.toContain(audioDirectory);
  expect(gap(reports.find((report) => report.recordingId === "ORCHARD-COMPLETE")!, "invalid-field-format", "email").evidence).toEqual([
    { source: "record", field: "email", value: "[redacted email]" }
  ]);
  const unreadable = gap(reports.find((report) => report.recordingId === "ORCHARD-MISSING")!, "audio-file-unreadable");
  expect(unreadable.evidence[0]).toEqual({
    source: "record",
    field: "audioFilePath",
    value: "deleted.wav",
    fileId: audioFileId(missingPath)
  });
  expect(audioFileId(missingPath)).toMatch(/^AUDIO-[0-9A-F]{12}$/);
  // The original records keep full paths for matching and file attachment.
  expect(records[1].audioFilePath).toBe(missingPath);
});

test("loads the gap analyzer without importing Playwright or browser modules", () => {
  const visited = new Set<string>();
  const external: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
      if (match[1]) continue;
      const specifier = match[2];
      if (specifier.startsWith(".")) visit(join(dirname(file), `${specifier}.ts`));
      else external.push(specifier);
    }
  };
  visit(join(__dirname, "..", "src", "metadata", "metadataGapAnalyzer.ts"));

  expect([...visited].some((file) => file.includes(`${sep}browser${sep}`))).toBe(false);
  expect(external.filter((specifier) => specifier.includes("playwright"))).toEqual([]);
  expect(visited.has(join(__dirname, "..", "src", "metadata", "recordValidation.ts"))).toBe(true);
});

test("reports READY only when form validation also accepts the record", async ({}, testInfo) => {
  const path = wav(testInfo, "glass-coast.wav", tags);
  const extraction = await extractAudioMetadata(path);
  const variants: DemoRecording[] = [
    completeRecord(path),
    completeRecord(path, { approvalStatus: "DRAFT" }),
    completeRecord(path, { email: "not-an-email" }),
    completeRecord(path, { officialReleaseDate: "02/30/2026" }),
    completeRecord(path, { artist: "Someone Else" }),
    completeRecord(path, { audioFilePath: null }),
    completeRecord(null, { isrc: "bad", isrcValidation: undefined }),
    readyFromOrchard(importOrchardRecord())
  ];
  for (const record of variants) {
    const result = matchAudioToRecording(record, [extraction]);
    const report = analyzeMetadataGaps(record, { audioExtractions: [extraction], audioMatchResults: [result] });
    let accepted = true;
    try {
      validateRecordForPreparation(record, { audioMatchResult: result });
    } catch {
      accepted = false;
    }
    expect(report.readiness === "READY", `${record.recordingId}: ${codes(report).join(", ")}`).toBe(accepted);
  }
});
