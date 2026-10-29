import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeMetadataGaps, type MetadataGapReport } from "../src/metadata/metadataGapAnalyzer";
import {
  buildMetadataResearchTasks,
  researchMetadata,
  validateMetadataResearchResponse,
  type MetadataResearchProposal,
  type MetadataResearchResponse,
  type MetadataResearchTask,
  type MetadataReviewAction,
  type ResearchEvidenceClaim,
  type ResearchField,
  type VerifiedResearchEvidence
} from "../src/metadata/metadataResearch";
import { MockMetadataResearchProvider } from "../src/metadata/mockResearchProvider";
import { importOrchardCsv } from "../src/metadata/orchardImporter";

function draft() {
  return importOrchardCsv(
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE\nGlass Coast,Mara Quill,Tidewater Collective,Low Tide Atlas,Album\n",
    "fictional-research.csv"
  ).records[0];
}

function tasks() {
  const record = draft();
  return buildMetadataResearchTasks(record, analyzeMetadataGaps(record));
}

function taskFor(field: ResearchField): MetadataResearchTask {
  const task = tasks().find((item) => item.field === field);
  if (!task) throw new Error("Missing fictional task.");
  return task;
}

function evidence(supportedValue = "Low Tide Records"): ResearchEvidenceClaim {
  return {
    sourceId: "fictional-label-catalog-001",
    url: "https://catalog.example.test/glass-coast",
    category: "official-label",
    quote: `Fictional Glass Coast Radio Edit catalog entry: ${supportedValue}.`,
    supportedValue
  };
}

function response(task: MetadataResearchTask, suggestedValue = "Low Tide Records"): MetadataResearchResponse {
  return {
    recordingId: task.recordingId,
    gapId: task.gapId,
    field: task.field,
    suggestedValue,
    evidence: [evidence(suggestedValue)],
    explanation: "The fictional catalog explicitly lists this value for the exact recording.",
    confidence: "HIGH",
    conflictingEvidence: [],
    outcome: "PROPOSED"
  };
}

function verified(task: MetadataResearchTask, claim = evidence()): VerifiedResearchEvidence {
  return {
    ...claim,
    recordingId: task.recordingId,
    field: task.field,
    identityFingerprint: task.identityFingerprint,
    verificationId: "fictional-independent-verifier-001"
  };
}

function accepted(
  task: MetadataResearchTask,
  value: unknown,
  attestations: readonly VerifiedResearchEvidence[] = []
): MetadataResearchProposal {
  const result = validateMetadataResearchResponse(task, value, attestations);
  if (!result.ok) throw new Error(result.errors.join(" "));
  return result.proposal;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test("builds focused tasks from actual Orchard gap reports, skipping human-only gaps", () => {
  const record = draft();
  const report = analyzeMetadataGaps(record);
  const generated = buildMetadataResearchTasks(record, report);
  expect(generated.map((task) => task.field).sort()).toEqual([
    "albumReleaseDate", "albumUPC", "isrc", "label", "officialReleaseDate"
  ]);
  expect(generated.every((task) => report.gaps.some((gap) =>
    gap.gapId === task.gapId && gap.researchEligible && gap.fields.includes(task.field)))).toBe(true);
  for (const task of generated) {
    expect(task).toMatchObject({
      recordingId: record.recordingId,
      requiresHumanReview: true,
      agentMayResolve: false,
      existingMetadata: { title: "Glass Coast", trackArtist: "Mara Quill", productArtist: "Tidewater Collective" }
    });
    expect(task.allowedSourceCategories).toContain("official-label");
    expect(task.question).toContain("exact recording");
    expect(task.restrictions.join(" ")).toContain("Never change approval status");
  }
  expect(generated.find((task) => task.field === "albumUPC")?.originalEvidence).toEqual([
    { source: "record", field: "albumTitle", value: "Low Tide Atlas" }
  ]);
});

test("skips human-only decisions even when a caller marks every gap research-eligible", () => {
  const record = draft();
  const report = analyzeMetadataGaps(record);
  for (const gap of report.gaps) gap.researchEligible = true;
  const generated = buildMetadataResearchTasks(record, report);
  expect(generated).toHaveLength(5);
  expect(generated.some((task) => /artist|approval|audio|declaration/.test(task.gapCode))).toBe(false);
  for (const gap of report.gaps) gap.researchEligible = false;
  expect(buildMetadataResearchTasks(record, report)).toEqual([]);
});

test("does not research deterministic formatting corrections or confirmed-absent ISRCs", () => {
  const record = draft();
  record.officialReleaseDate = "2026-11-15";
  record.isrcValidation = { status: "missing", originalValue: null, reviewed: true };
  const generated = buildMetadataResearchTasks(record, analyzeMetadataGaps(record));
  expect(generated.some((task) => task.field === "officialReleaseDate" || task.field === "isrc")).toBe(false);
});

test("generates actual malformed-identifier/date and missing-album-title tasks", () => {
  const record = draft();
  record.isrcValidation = { status: "invalid", originalValue: "NOT-AN-ISRC", reviewed: false };
  record.albumUPC = "123456789013";
  record.officialReleaseDate = "not-a-date";
  record.albumReleaseDate = "02/30/2026";
  const generated = buildMetadataResearchTasks(record, analyzeMetadataGaps(record));
  expect(generated.map((task) => [task.gapCode, task.field])).toEqual(expect.arrayContaining([
    ["invalid-isrc", "isrc"], ["invalid-album-upc", "albumUPC"],
    ["invalid-field-format", "officialReleaseDate"], ["invalid-field-format", "albumReleaseDate"]
  ]));
  record.albumTitle = null;
  record.albumReleaseDate = "11/15/2026";
  const titleTask = buildMetadataResearchTasks(record, analyzeMetadataGaps(record))
    .find((task) => task.field === "albumTitle");
  if (!titleTask) throw new Error("Missing album-title task.");
  const value = response(titleTask, "Low Tide Atlas");
  expect(accepted(titleTask, value, [verified(titleTask, value.evidence[0])]).suggestedValue).toBe("Low Tide Atlas");
});

test("sanitizes allowlisted context and original evidence without exporting unrelated fields", () => {
  const record = draft();
  Object.assign(record, {
    email: "private@example.test", submitterName: "Private Person", phone: "555-0101",
    comments: "Unrelated secret", company: "Private Company",
    audioFilePath: "C:\\Private Folder\\masters\\glass.wav",
    title: "Glass Coast private@example.test",
    label: "Label C:/Private/masters/glass.wav",
    version: "at /home/private/glass.wav and file:///Users/private/glass.wav",
    artistWebsite: "https://private.example.test"
  });
  const report = analyzeMetadataGaps(record);
  const gap = report.gaps.find((item) => item.code === "missing-isrc");
  if (!gap) throw new Error("Missing gap.");
  gap.evidence.push(
    { source: "orchard", field: "ISRC", value: "private@example.test \\\\server\\private\\glass.wav" },
    { source: "record", field: "email", value: "private@example.test" },
    { source: "audio-match", field: "audioFilePath", value: "C:\\Private\\glass.wav" }
  );
  const generated = buildMetadataResearchTasks(record, report);
  const json = JSON.stringify(generated);
  for (const secret of ["private@example.test", "Private Person", "555-0101", "Unrelated secret",
    "Private Company", "C:\\\\Private", "C:/Private", "/home/private", "/Users/private", "\\\\\\\\server", "private.example.test"]) {
    expect(json).not.toContain(secret);
  }
  expect(json).toContain("[redacted email]");
  expect(json).toContain("[redacted local path]");
  expect(generated.every((task) => !("approvalStatus" in task.existingMetadata))).toBe(true);
});

test("rejects mismatched reports, sensitive identifiers, and duplicate tasks explicitly", () => {
  const record = draft();
  const report = analyzeMetadataGaps(record);
  expect(() => buildMetadataResearchTasks(record, { ...report, recordingId: "OTHER" })).toThrow("does not belong");
  expect(() => buildMetadataResearchTasks(
    { ...record, recordingId: "secret@example.test" }, { ...report, recordingId: "secret@example.test" }
  )).toThrow("sensitive");
  const gap = report.gaps.find((item) => item.researchEligible);
  if (!gap) throw new Error("Missing gap.");
  gap.gapId = "OTHER:missing-label:label";
  expect(() => buildMetadataResearchTasks(record, report)).toThrow("unrelated");
  const clean = analyzeMetadataGaps(record);
  const researchable = clean.gaps.find((item) => item.researchEligible);
  if (!researchable) throw new Error("Missing gap.");
  clean.gaps.push(researchable);
  expect(() => buildMetadataResearchTasks(record, clean)).toThrow("Duplicate");
});

test("accepts independently evidence-backed suggestions but always leaves human review pending", () => {
  const task = taskFor("label");
  const proposal = accepted(task, response(task), [verified(task)]);
  expect(proposal).toMatchObject({
    suggestedValue: "Low Tide Records", outcome: "PROPOSED", reviewStatus: "PENDING_REVIEW",
    requiresHumanReview: true, agentMayResolve: false, unresolvedReasons: [],
    evidence: [{ verification: "INDEPENDENTLY_VERIFIED", verificationId: "fictional-independent-verifier-001" }]
  });
  const linkage = {
    proposalId: proposal.proposalId, recordingId: proposal.recordingId,
    gapId: proposal.gapId, field: proposal.field
  };
  const intents: MetadataReviewAction[] = [
    { ...linkage, action: "APPROVE_SUGGESTED_VALUE" },
    { ...linkage, action: "EDIT_SUGGESTED_VALUE", editedValue: "Low Tide Imprint" },
    { ...linkage, action: "REJECT_SUGGESTION", note: "Wrong release." },
    { ...linkage, action: "DEFER_DECISION" }
  ];
  expect(intents).toHaveLength(4);
  expect(proposal.reviewStatus).toBe("PENDING_REVIEW");
});

test("high confidence and plausible URLs alone are not verified evidence", () => {
  const task = taskFor("label");
  const proposal = accepted(task, response(task));
  expect(proposal).toMatchObject({
    suggestedValue: null, outcome: "INSUFFICIENT_EVIDENCE", confidence: "HIGH",
    evidence: [{ verification: "PROVIDER_CLAIM", verificationId: null }],
    reviewStatus: "PENDING_REVIEW"
  });
  expect(proposal.unresolvedReasons).not.toEqual([]);
  expect(accepted(task, { ...response(task), evidence: [] }).outcome).toBe("INSUFFICIENT_EVIDENCE");
});

for (const mismatch of ["recordingId", "field", "url", "sourceId", "quote", "supportedValue", "category"] as const) {
  test(`verification is scoped to the exact source claim and recording: ${mismatch}`, () => {
    const task = taskFor("label");
    const attestation = verified(task);
    const invalid = { ...attestation, [mismatch]: mismatch === "field" ? "albumTitle" :
      mismatch === "category" ? "distributor" : "different" };
    const proposal = accepted(task, response(task), [invalid]);
    expect(proposal.evidence[0].verification).toBe("PROVIDER_CLAIM");
    expect(proposal.outcome).not.toBe("PROPOSED");
  });
}

test("preserves conflicting sources even when the provider claims a clean proposal", () => {
  const task = taskFor("label");
  const other = { ...evidence("Harbor Lantern Records"), sourceId: "fictional-second-source" };
  const proposal = accepted(task, response(task), [verified(task), verified(task, other)]);
  expect(proposal).toMatchObject({
    outcome: "CONFLICTING_EVIDENCE", suggestedValue: "Low Tide Records", reviewStatus: "PENDING_REVIEW",
    conflictRequiresHumanResolution: true,
    conflictingEvidence: [{ supportedValue: "Harbor Lantern Records", verification: "INDEPENDENTLY_VERIFIED" }]
  });
  const conflicting = accepted(task, { ...response(task), conflictingEvidence: [other] });
  expect(conflicting.outcome).toBe("CONFLICTING_EVIDENCE");
  expect(conflicting.suggestedValue).toBeNull();
  expect(conflicting.conflictingEvidence[0].verification).toBe("PROVIDER_CLAIM");
});

test("recognizes disagreements hidden in the supporting evidence array", () => {
  const task = taskFor("label");
  const proposal = accepted(task, {
    ...response(task), evidence: [evidence(), evidence("Harbor Lantern Records")]
  }, [verified(task)]);
  expect(proposal.outcome).toBe("CONFLICTING_EVIDENCE");
});

test("researches actual embedded ISRC conflicts without resolving them automatically", () => {
  const record = draft();
  record.isrc = "USAAA2600010";
  record.isrcValidation = { status: "valid", originalValue: record.isrc, reviewed: true };
  record.audioFilePath = "C:\\fictional\\glass.wav";
  const report = analyzeMetadataGaps(record, {
    audioExtractions: [{
      status: "OK", filePath: record.audioFilePath, fileName: "glass.wav",
      metadata: {
        filePath: record.audioFilePath, fileName: "glass.wav", format: "WAV",
        extensionMatchesFormat: true, durationSeconds: 1, sampleRate: 44100, channels: 2, bitDepth: 16,
        artist: "Mara Quill", title: "Glass Coast", album: "Low Tide Atlas",
        version: null, isrc: "USBBB2600020", rawIsrcs: ["USBBB2600020"]
      }
    }]
  });
  const task = buildMetadataResearchTasks(record, report).find((item) => item.gapCode === "audio-isrc-conflict");
  if (!task) throw new Error("Expected an ISRC conflict task.");
  expect(task.question).toContain("do not choose an authoritative ISRC");
  expect(task.originalEvidence.map((item) => item.value)).toContain("USBBB2600020");
  const value = response(task, "USBBB2600020");
  const proposal = accepted(task, value, [verified(task, value.evidence[0])]);
  expect(proposal).toMatchObject({
    outcome: "CONFLICTING_EVIDENCE", conflictRequiresHumanResolution: true,
    agentMayResolve: false, requiresHumanReview: true, reviewStatus: "PENDING_REVIEW"
  });
  expect(record.isrc).toBe("USAAA2600010");
  expect(report.readiness).toBe("BLOCKED");
});

const malformed: Array<[string, (value: MetadataResearchResponse) => unknown]> = [
  ["null", () => null],
  ["JSON string", (value) => JSON.stringify(value)],
  ["array", (value) => [value]],
  ["missing property", (value) => { const { explanation, ...rest } = value; return rest; }],
  ["wrong recording", (value) => ({ ...value, recordingId: "OTHER" })],
  ["wrong gap", (value) => ({ ...value, gapId: "OTHER:missing-label:label" })],
  ["unrequested field", (value) => ({ ...value, field: "albumTitle" })],
  ["approval patch", (value) => ({ ...value, approvalStatus: "APPROVED" })],
  ["artist hierarchy patch", (value) => ({ ...value, artistAttribution: { primaryArtist: "Mara Quill" } })],
  ["automatic resolution", (value) => ({ ...value, agentMayResolve: true })],
  ["review bypass", (value) => ({ ...value, reviewStatus: "APPROVED" })],
  ["false verification flag", (value) => ({ ...value, evidence: [{ ...evidence(), verification: "INDEPENDENTLY_VERIFIED" }] })],
  ["missing suggested value", (value) => ({ ...value, suggestedValue: null })],
  ["invalid confidence", (value) => ({ ...value, confidence: 1 })],
  ["invalid outcome", (value) => ({ ...value, outcome: "RESOLVED" })],
  ["invalid source category", (value) => ({ ...value, evidence: [{ ...evidence(), category: "invented" }] })],
  ["empty quotation", (value) => ({ ...value, evidence: [{ ...evidence(), quote: "" }] })],
  ["email in explanation", (value) => ({ ...value, explanation: "Contact private@example.test" })],
  ["absolute path in value", (value) => ({ ...value, suggestedValue: "C:\\Private\\glass.wav" })],
  ["absolute path in quotation", (value) => ({ ...value, evidence: [{ ...evidence(), quote: "/home/private/glass.wav" }] })],
  ["file URI in explanation", (value) => ({ ...value, explanation: "Read file:///Users/private/glass.wav" })],
  ["local source URL", (value) => ({ ...value, evidence: [{ ...evidence(), url: "file:///C:/private/glass.wav" }] })],
  ["credentialed source URL", (value) => ({ ...value, evidence: [{ ...evidence(), url: "https://private:secret@example.test" }] })],
  ["malformed URL", (value) => ({ ...value, evidence: [{ ...evidence(), url: "not a URL" }] })]
];
for (const [name, transform] of malformed) {
  test(`rejects malformed or prohibited provider output: ${name}`, () => {
    const task = taskFor("label");
    const result = validateMetadataResearchResponse(task, transform(response(task)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
}

for (const [field, valid, invalid] of [
  ["officialReleaseDate", "11/15/2026", "02/30/2026"],
  ["albumReleaseDate", "11/15/2026", "2026-11-15"],
  ["isrc", "USAAA2600010", "US-AAA-26-00010"],
  ["albumUPC", "123456789012", "123456789013"]
] as const) {
  test(`reuses deterministic format validation for ${field}`, () => {
    const task = taskFor(field);
    const value = response(task, valid);
    expect(accepted(task, value, [verified(task, value.evidence[0])]).outcome).toBe("PROPOSED");
    expect(validateMetadataResearchResponse(task, response(task, invalid)).ok).toBe(false);
  });
}

test("supports a source identifier without a URL, but still requires independent verification", () => {
  const task = taskFor("label");
  const value = response(task);
  value.evidence[0].url = null;
  expect(accepted(task, value).outcome).toBe("INSUFFICIENT_EVIDENCE");
  expect(accepted(task, value, [verified(task, value.evidence[0])]).outcome).toBe("PROPOSED");
});

test("the deterministic mock makes no network requests and never loads browser automation", async () => {
  const generated = tasks();
  const task = taskFor("label");
  const fixture = { [task.taskId]: response(task) };
  const provider = new MockMetadataResearchProvider(fixture);
  fixture[task.taskId].suggestedValue = "Changed after construction";
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Network forbidden in offline research tests."); };
  try {
    const first = await researchMetadata(generated, provider, [verified(task)]);
    const second = await researchMetadata([...generated].reverse(), provider, [verified(task)]);
    expect(first).toEqual(second);
    expect(first.failures).toEqual([]);
    expect(first.proposals.find((item) => item.field === "label")?.suggestedValue).toBe("Low Tide Records");
    expect(first.proposals.filter((item) => item.field !== "label").every((item) => item.outcome === "INSUFFICIENT_EVIDENCE")).toBe(true);
    first.proposals[0].explanation = "Edited result";
    expect(await researchMetadata(generated, provider, [verified(task)])).toEqual(second);
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const module of ["metadataResearch.ts", "mockResearchProvider.ts"]) {
    const source = readFileSync(join(__dirname, "..", "src", "metadata", module), "utf8");
    expect(source).not.toMatch(/from ["'].*(?:playwright|browser|https?|net|gemini|generative-ai)["']/);
    expect(source).not.toMatch(/\b(?:fetch|prepareMediabaseForm|submit)\s*\(/);
  }
});

test("freezes source records and reports and isolates tasks from provider mutation", async () => {
  const record = draft();
  record.audioFilePath = "C:\\fictional\\glass.wav";
  record.audioMatch = {
    status: "CONFIRMED", filePath: record.audioFilePath, basis: "ISRC",
    candidateFilePaths: [record.audioFilePath], humanConfirmed: true, acknowledgedConflicts: []
  };
  freeze(record);
  const report: MetadataGapReport = freeze(analyzeMetadataGaps(record));
  const before = JSON.stringify({ record, report });
  const generated = freeze(buildMetadataResearchTasks(record, report));
  const generatedBefore = JSON.stringify(generated);
  const task = generated.find((item) => item.field === "label");
  if (!task) throw new Error("Missing label task.");
  const trusted = freeze([verified(task)]);
  const trustedBefore = JSON.stringify(trusted);
  const proposals = await researchMetadata([task], {
    async research(copy) {
      copy.existingMetadata.title = "Provider changed its isolated copy";
      copy.originalEvidence.push({ source: "record", field: "label", value: "Changed" });
      return response(task);
    }
  }, trusted);
  expect(proposals.proposals[0].outcome).toBe("PROPOSED");
  expect(JSON.stringify({ record, report })).toBe(before);
  expect(JSON.stringify(generated)).toBe(generatedBefore);
  expect(JSON.stringify(trusted)).toBe(trustedBefore);
});

test("snapshots independent verification before calling an asynchronous provider", async () => {
  const task = taskFor("label");
  const attestations: VerifiedResearchEvidence[] = [];
  const proposals = await researchMetadata([task], {
    async research() {
      attestations.push(verified(task));
      return response(task);
    }
  }, attestations);
  expect(proposals.proposals[0].outcome).toBe("INSUFFICIENT_EVIDENCE");
});

test("reports sanitized, retryable task failures without accepting invalid responses", async () => {
  const task = taskFor("label");
  const thrown = await researchMetadata([task], {
    async research() { throw new Error("API_KEY=fictional-secret private@example.test C:\\private\\prompt.txt"); }
  });
  const invalid = await researchMetadata([task], new MockMetadataResearchProvider({
    [task.taskId]: { approvalStatus: "APPROVED" }
  }));
  for (const [result, errorCode] of [[thrown, "PROVIDER_ERROR"], [invalid, "INVALID_RESPONSE"]] as const) {
    expect(result.proposals).toEqual([]);
    expect(result.failures).toEqual([{
      taskId: task.taskId, recordingId: task.recordingId, gapId: task.gapId,
      errorCode, description: expect.any(String), status: "UNRESOLVED", retryEligible: true
    }]);
    expect(JSON.stringify(result)).not.toMatch(/fictional-secret|private@example|prompt\.txt|API_KEY|approvalStatus/);
  }
  const retry = await researchMetadata([task], new MockMetadataResearchProvider({
    [task.taskId]: response(task)
  }), [verified(task)]);
  expect(retry.failures).toEqual([]);
  expect(retry.proposals[0].outcome).toBe("PROPOSED");
  await expect(researchMetadata([task, task], new MockMetadataResearchProvider())).rejects.toThrow("Duplicate");
});

test("isolates mixed task failures and preserves deterministic ordering", async () => {
  const generated = freeze(tasks());
  const before = JSON.stringify(generated);
  const visited: string[] = [];
  const provider = {
    async research(task: Readonly<MetadataResearchTask>) {
      visited.push(task.taskId);
      if (task.field === "albumReleaseDate") throw "fictional-secret";
      if (task.field === "albumUPC") return { rawPrompt: "private@example.test", apiKey: "fictional-secret" };
      return task.field === "label" ? response(task) : new MockMetadataResearchProvider().research(task);
    }
  };
  const first = await researchMetadata(generated, provider, [verified(taskFor("label"))]);
  expect(visited).toEqual(generated.map((task) => task.taskId).sort());
  expect(first.proposals).toHaveLength(generated.length - 2);
  expect(first.proposals.find((item) => item.field === "label")?.outcome).toBe("PROPOSED");
  expect(first.failures.map((item) => item.errorCode).sort()).toEqual(["INVALID_RESPONSE", "PROVIDER_ERROR"]);
  expect(first.failures.every((item) => item.status === "UNRESOLVED" && item.retryEligible)).toBe(true);
  for (const entries of [first.proposals, first.failures]) {
    expect(entries.map((item) => item.taskId)).toEqual(entries.map((item) => item.taskId).sort());
  }
  expect(await researchMetadata([...generated].reverse(), provider, [verified(taskFor("label"))])).toEqual(first);
  expect(JSON.stringify(generated)).toBe(before);
  expect(JSON.stringify(first)).not.toMatch(/fictional-secret|private@example|rawPrompt|apiKey/);
});
