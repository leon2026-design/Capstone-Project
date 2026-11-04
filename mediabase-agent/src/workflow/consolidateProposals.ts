import { createHash } from "node:crypto";
import type {
  MetadataResearchProposal,
  ResearchField
} from "../metadata/metadataResearch";
import { isValidUpc } from "../metadata/metadataGapAnalyzer";
import { isValidDate } from "../metadata/recordValidation";
import { normalizeIsrcValue } from "../audio/audioMetadata";

export type WorkflowFinding = {
  source: "MUSICBRAINZ" | "RESEARCH";
  proposal: MetadataResearchProposal;
};

export type PendingMetadataDecision = {
  decisionId: string;
  recordingId: string;
  field: ResearchField;
  status: "PENDING_REVIEW";
  assessment: "CONFLICTING" | "CANDIDATES_AVAILABLE" | "UNRESOLVED";
  candidateValues: string[];
  requiresHumanReview: true;
  agentMayResolve: false;
  /** Complete proposals retain their sources and verification labels. */
  findings: WorkflowFinding[];
};

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Determines whether a value is complete enough to compare.
 * Incomplete or malformed evidence remains in the original proposal.
 */
function usableValue(field: ResearchField, value: string): boolean {
  if (!value.trim()) return false;

  if (field === "albumReleaseDate" || field === "officialReleaseDate") {
    return isValidDate(value);
  }

  if (field === "albumUPC") {
    return isValidUpc(value);
  }

  if (field === "isrc") {
    return normalizeIsrcValue(value) === value;
  }

  return true;
}

function valuesFrom(proposal: MetadataResearchProposal): string[] {
  const values = [
    proposal.suggestedValue,
    ...proposal.evidence.map((item) => item.supportedValue),
    ...proposal.conflictingEvidence.map((item) => item.supportedValue)
  ];

  return values.filter(
    (value): value is string =>
      typeof value === "string" && usableValue(proposal.field, value)
  );
}

/**
 * Groups findings by recording and field.
 *
 * Candidate values are not approved values. Unverified catalog claims can
 * appear here, but their original verification labels remain in findings.
 *
 * Nothing is applied to a recording, and no proposal is promoted to verified.
 */
export function consolidateProposals(
  findings: readonly WorkflowFinding[]
): PendingMetadataDecision[] {
  const groups = new Map<string, WorkflowFinding[]>();

  // Detach returned data from caller-owned objects.
  const snapshots = structuredClone([...findings]);

  for (const finding of snapshots) {
    const proposal = finding.proposal;
    const key = JSON.stringify([proposal.recordingId, proposal.field]);
    const group = groups.get(key) ?? [];

    group.push(finding);
    groups.set(key, group);
  }

  const decisions: PendingMetadataDecision[] = [];

  for (const [key, group] of groups) {
    group.sort((left, right) =>
      compare(left.source, right.source) ||
      compare(left.proposal.taskId, right.proposal.taskId) ||
      compare(
        JSON.stringify(left.proposal),
        JSON.stringify(right.proposal)
      )
    );

    const first = group[0].proposal;
    const candidateValues = [
      ...new Set(group.flatMap((item) => valuesFrom(item.proposal)))
    ].sort(compare);

    const conflicting =
      candidateValues.length > 1 ||
      group.some((item) =>
        item.proposal.outcome === "CONFLICTING_EVIDENCE" ||
        item.proposal.conflictRequiresHumanResolution
      );

    decisions.push({
      decisionId:
        "REVIEW-" +
        createHash("sha256").update(key).digest("hex").slice(0, 16),
      recordingId: first.recordingId,
      field: first.field,
      status: "PENDING_REVIEW",
      assessment: conflicting
        ? "CONFLICTING"
        : candidateValues.length > 0
          ? "CANDIDATES_AVAILABLE"
          : "UNRESOLVED",
      candidateValues,
      requiresHumanReview: true,
      agentMayResolve: false,
      findings: group
    });
  }

  return decisions.sort((left, right) =>
    compare(left.recordingId, right.recordingId) ||
    compare(left.field, right.field)
  );
}