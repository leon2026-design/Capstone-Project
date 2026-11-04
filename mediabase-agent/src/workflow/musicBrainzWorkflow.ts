import { normalizeIsrcValue } from "../audio/audioMetadata";
import type { DemoRecording } from "../metadata/recordValidation";
import type {
  MetadataResearchTask
} from "../metadata/metadataResearch";
import {
  lookupMusicBrainzByIsrc,
  lookupMusicBrainzReleases,
  type MusicBrainzLookupResult,
  type MusicBrainzReleaseLookupResult
} from "../research/musicBrainzLookup";
import {
  buildMusicBrainzProposal,
  type MusicBrainzSelection
} from "../research/musicBrainzSuggestions";
import type { WorkflowFinding } from "./consolidateProposals";

/** Tests supply fictional implementations of these two methods. */
export type WorkflowMusicBrainzProvider = {
  lookupRecording(
    record: Readonly<Pick<DemoRecording, "recordingId" | "isrc">>
  ): Promise<MusicBrainzLookupResult>;

  lookupReleases(
    recordingId: string
  ): Promise<MusicBrainzReleaseLookupResult>;
};

/** Explicitly constructed by a caller when live MusicBrainz access is wanted. */
export function createWorkflowMusicBrainzProvider(
  userAgent: string
): WorkflowMusicBrainzProvider {
  return {
    lookupRecording: (record) =>
      lookupMusicBrainzByIsrc(record, { userAgent }),
    lookupReleases: (recordingId) =>
      lookupMusicBrainzReleases(recordingId, { userAgent })
  };
}

export type MusicBrainzWorkflowOptions = {
  provider?: WorkflowMusicBrainzProvider;
  selection?: Partial<MusicBrainzSelection>;
  /** One recording lookup plus one release lookup. No automatic retries. */
  maxCalls?: number;
};

export type MusicBrainzWorkflowResult = {
  status:
    | "SKIPPED"
    | "SELECTION_REQUIRED"
    | "COMPLETE"
    | "FAILED"
    | "BUDGET_EXHAUSTED";
  reason: string;
  callsUsed: number;
  lookup: MusicBrainzLookupResult | null;
  releaseLookup: MusicBrainzReleaseLookupResult | null;
  findings: WorkflowFinding[];
  proposalFailures: Array<{
    taskId: string;
    code: "PROPOSAL_REJECTED";
  }>;
};

/**
 * Connects existing MusicBrainz modules without applying any suggestions.
 * Selection is explicit even when only one candidate is returned.
 */
export async function runMusicBrainzWorkflow(
  record: Readonly<DemoRecording>,
  tasks: readonly MetadataResearchTask[],
  options: MusicBrainzWorkflowOptions = {}
): Promise<MusicBrainzWorkflowResult> {
  const maxCalls = options.maxCalls ?? 2;

  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 2) {
    throw new Error("MusicBrainz maxCalls must be an integer from 0 to 2.");
  }

  // Snapshot before awaiting provider calls.
  const snapshot = structuredClone(record);
  const taskSnapshots = structuredClone([...tasks]);
  const selection = { ...options.selection };

  const result: MusicBrainzWorkflowResult = {
    status: "SKIPPED",
    reason: "",
    callsUsed: 0,
    lookup: null,
    releaseLookup: null,
    findings: [],
    proposalFailures: []
  };

  const finish = (
    status: MusicBrainzWorkflowResult["status"],
    reason: string
  ): MusicBrainzWorkflowResult => ({ ...result, status, reason });

  const isrc = normalizeIsrcValue(snapshot.isrc);

  if (
    !isrc ||
    isrc !== snapshot.isrc ||
    snapshot.isrcValidation?.status === "invalid"
  ) {
    return finish("SKIPPED", "No valid normalized recording ISRC is available.");
  }

  if (!options.provider) {
    return finish("SKIPPED", "No MusicBrainz provider was supplied.");
  }

  if (maxCalls === 0) {
    return finish("BUDGET_EXHAUSTED", "The MusicBrainz request budget is zero.");
  }

  const provider = options.provider;

  try {
    result.callsUsed++;
    result.lookup = structuredClone(await provider.lookupRecording({
      recordingId: snapshot.recordingId,
      isrc
    }));
  } catch {
    return finish("FAILED", "The MusicBrainz recording request failed.");
  }

  const lookup = result.lookup;

  if (
    lookup.recordingId !== snapshot.recordingId ||
    lookup.queriedIsrc !== isrc
  ) {
    return finish("FAILED", "MusicBrainz results do not match this recording.");
  }

  if (lookup.status === "NO_MATCH") {
    return finish("SKIPPED", "MusicBrainz found no recording candidates.");
  }

  if (lookup.status !== "NEEDS_REVIEW" || lookup.error !== null) {
    return finish("FAILED", "The MusicBrainz recording lookup was unsuccessful.");
  }

  if (!selection.musicBrainzRecordingId) {
    return finish(
      "SELECTION_REQUIRED",
      "Explicit MusicBrainz recording selection is required."
    );
  }

  const candidate = lookup.candidates.find(
    (item) =>
      item.musicBrainzId === selection.musicBrainzRecordingId
  );

  if (!candidate) {
    return finish("FAILED", "The selected recording is not a returned candidate.");
  }

  if (result.callsUsed >= maxCalls) {
    return finish("BUDGET_EXHAUSTED", "No budget remains for release retrieval.");
  }

  try {
    result.callsUsed++;
    result.releaseLookup = structuredClone(
      await provider.lookupReleases(candidate.musicBrainzId)
    );
  } catch {
    return finish("FAILED", "The MusicBrainz release request failed.");
  }

  const releaseLookup = result.releaseLookup;

  if (releaseLookup.musicBrainzId !== candidate.musicBrainzId) {
    return finish("FAILED", "Release results belong to a different recording.");
  }

  if (releaseLookup.status === "NO_MATCH") {
    return finish("SKIPPED", "MusicBrainz found no linked releases.");
  }

  if (
    releaseLookup.status !== "NEEDS_REVIEW" ||
    releaseLookup.error !== null
  ) {
    return finish("FAILED", "The MusicBrainz release lookup was unsuccessful.");
  }

  if (!selection.musicBrainzReleaseId) {
    return finish(
      "SELECTION_REQUIRED",
      "Explicit MusicBrainz release selection is required."
    );
  }

  if (!releaseLookup.releases.some(
    (item) => item.musicBrainzId === selection.musicBrainzReleaseId
  )) {
    return finish("FAILED", "The selected release is not a returned candidate.");
  }

  const completeSelection: MusicBrainzSelection = {
    musicBrainzRecordingId: candidate.musicBrainzId,
    musicBrainzReleaseId: selection.musicBrainzReleaseId
  };

  for (const task of taskSnapshots) {
    if (
      task.field !== "albumTitle" &&
      task.field !== "albumUPC" &&
      task.field !== "albumReleaseDate"
    ) {
      continue;
    }

    try {
      const proposal = buildMusicBrainzProposal(
        task,
        lookup,
        releaseLookup,
        completeSelection
      );

      if (proposal.ok) {
        result.findings.push({
          source: "MUSICBRAINZ",
          proposal: proposal.proposal
        });
      } else {
        result.proposalFailures.push({
          taskId: task.taskId,
          code: "PROPOSAL_REJECTED"
        });
      }
    } catch {
      result.proposalFailures.push({
        taskId: task.taskId,
        code: "PROPOSAL_REJECTED"
      });
    }
  }

  return finish(
    "COMPLETE",
    "Selected catalog results were processed; human review is still required."
  );
}