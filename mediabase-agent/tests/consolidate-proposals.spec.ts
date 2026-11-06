import { expect, test } from "@playwright/test";
import type {
  MetadataResearchProposal
} from "../src/metadata/metadataResearch";
import {
  consolidateProposals,
  type WorkflowFinding
} from "../src/workflow/consolidateProposals";

function finding(
  source: WorkflowFinding["source"],
  value: string
): WorkflowFinding {
  const proposal: MetadataResearchProposal = {
    proposalId: "TEST-001:albumTitle:proposal",
    taskId: "TEST-001:albumTitle:research",
    recordingId: "TEST-001",
    gapId: "TEST-001:missing-album-title:albumTitle",
    field: "albumTitle",
    suggestedValue: null,
    evidence: [{
      sourceId: source,
      url: source === "MUSICBRAINZ"
        ? "https://musicbrainz.org/release/fictional"
        : "https://label.example.test/release",
      category: "published-catalog",
      quote: value,
      supportedValue: value,
      verification: "PROVIDER_CLAIM",
      verificationId: null
    }],
    conflictingEvidence: [],
    explanation: "Fictional catalog evidence for testing.",
    confidence: "UNKNOWN",
    outcome: "INSUFFICIENT_EVIDENCE",
    unresolvedReasons: ["Independent verification is still required."],
    reviewStatus: "PENDING_REVIEW",
    requiresHumanReview: true,
    agentMayResolve: false,
    conflictRequiresHumanResolution: false
  };

  return { source, proposal };
}

test("combines matching values without promoting their verification", () => {
  const decisions = consolidateProposals([
    finding("MUSICBRAINZ", "Fictional Album"),
    finding("RESEARCH", "Fictional Album")
  ]);

  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    status: "PENDING_REVIEW",
    assessment: "CANDIDATES_AVAILABLE",
    candidateValues: ["Fictional Album"],
    requiresHumanReview: true,
    agentMayResolve: false
  });
  expect(decisions[0].findings).toHaveLength(2);

  for (const item of decisions[0].findings) {
    expect(item.proposal.suggestedValue).toBeNull();
    expect(item.proposal.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(item.proposal.evidence[0].verification).toBe("PROVIDER_CLAIM");
    expect(item.proposal.evidence[0].verificationId).toBeNull();
  }
});

test("flags different values and preserves both source links", () => {
  const decisions = consolidateProposals([
    finding("MUSICBRAINZ", "Original Album"),
    finding("RESEARCH", "Different Album")
  ]);

  expect(decisions[0].assessment).toBe("CONFLICTING");
  expect(decisions[0].candidateValues)
    .toEqual(["Different Album", "Original Album"]);

  expect(decisions[0].findings.map(
    (item) => item.proposal.evidence[0].url
  )).toEqual([
    "https://musicbrainz.org/release/fictional",
    "https://label.example.test/release"
  ]);
});

test("preserves existing conflicts and their alternative evidence", () => {
  const input = finding("RESEARCH", "Original Album");
  input.proposal.outcome = "CONFLICTING_EVIDENCE";
  input.proposal.conflictRequiresHumanResolution = true;
  input.proposal.conflictingEvidence = [{
    ...input.proposal.evidence[0],
    sourceId: "Alternative catalog",
    url: "https://alternative.example.test/release",
    quote: "Alternative Album",
    supportedValue: "Alternative Album"
  }];

  const decisions = consolidateProposals([input]);

  expect(decisions[0].assessment).toBe("CONFLICTING");
  expect(decisions[0].candidateValues)
    .toEqual(["Alternative Album", "Original Album"]);
  expect(decisions[0].findings[0].proposal.conflictingEvidence)
    .toEqual(input.proposal.conflictingEvidence);
});

test("retains partial-date evidence without treating it as a complete date", () => {
  const input = finding("MUSICBRAINZ", "2026-11");
  input.proposal.field = "albumReleaseDate";

  const decisions = consolidateProposals([input]);

  expect(decisions[0].assessment).toBe("UNRESOLVED");
  expect(decisions[0].candidateValues).toEqual([]);
  expect(decisions[0].findings[0].proposal.evidence[0].supportedValue)
    .toBe("2026-11");
});

test("keeps recordings and fields in separate decisions", () => {
  const first = finding("MUSICBRAINZ", "Album A");
  const otherRecording = finding("RESEARCH", "Album B");
  otherRecording.proposal.recordingId = "TEST-002";

  const otherField = finding("RESEARCH", "Fictional Label");
  otherField.proposal.field = "label";

  const decisions = consolidateProposals([
    first,
    otherRecording,
    otherField
  ]);

  expect(decisions).toHaveLength(3);
  expect(decisions.map((item) => [
    item.recordingId,
    item.field
  ])).toEqual([
    ["TEST-001", "albumTitle"],
    ["TEST-001", "label"],
    ["TEST-002", "albumTitle"]
  ]);
});

test("produces the same result regardless of provider input order", () => {
  const first = finding("MUSICBRAINZ", "Original Album");
  const second = finding("RESEARCH", "Different Album");

  expect(consolidateProposals([first, second]))
    .toEqual(consolidateProposals([second, first]));
});

test("leaves inputs unchanged and returns detached copies", () => {
  const inputs = [finding("MUSICBRAINZ", "Original Album")];
  const before = JSON.stringify(inputs);

  const decisions = consolidateProposals(inputs);

  expect(JSON.stringify(inputs)).toBe(before);

  decisions[0].findings[0].proposal.evidence[0].quote = "Changed copy";

  expect(JSON.stringify(inputs)).toBe(before);
  expect(consolidateProposals([])).toEqual([]);
});