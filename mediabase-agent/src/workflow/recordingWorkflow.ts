import {
  matchAudioToRecording,
  type AudioMatchResult
} from "../audio/audioMatcher";
import type { AudioExtractionResult } from "../audio/audioMetadata";
import {
  analyzeMetadataGaps,
  type MetadataGap,
  type MetadataGapReport
} from "../metadata/metadataGapAnalyzer";
import {
  buildMetadataResearchTasks,
  type MetadataResearchTask
} from "../metadata/metadataResearch";
import type { DemoRecording } from "../metadata/recordValidation";
import {
  runMetadataResearch,
  validateResearchLimits,
  type ResearchRunOptions,
  type ResearchRunResult
} from "../research/researchOrchestrator";
import {
  consolidateProposals,
  type PendingMetadataDecision,
  type WorkflowFinding
} from "./consolidateProposals";
import {
  runMusicBrainzWorkflow,
  type MusicBrainzWorkflowOptions,
  type MusicBrainzWorkflowResult
} from "./musicBrainzWorkflow";

export type RecordingWorkflowOptions = {
  /** Explicit research configuration; tests use mock providers. */
  research: ResearchRunOptions;
  musicBrainz?: MusicBrainzWorkflowOptions;
};

export type PendingGapDecision = {
  gap: MetadataGap;
  status: "PENDING_REVIEW";
  requiresHumanReview: true;
  agentMayResolve: false;
};

export type RecordingWorkflowResult = {
  /** Unchanged snapshot of the supplied recording. */
  recording: DemoRecording;
  status: "PENDING_REVIEW";
  audioMatch: AudioMatchResult;
  gapReport: MetadataGapReport;
  researchTasks: MetadataResearchTask[];
  musicBrainz: MusicBrainzWorkflowResult | null;
  researchResults: ResearchRunResult;
  findings: WorkflowFinding[];
  metadataDecisions: PendingMetadataDecision[];
  gapDecisions: PendingGapDecision[];
};

/**
 * MB-06: prepare one recording's findings for human review.
 *
 * Does not apply audio matches or research suggestions.
 * Does not change attribution, approval, or audio selections.
 * Does not import browser automation or contact Mediabase.
 */
export async function runRecordingWorkflow(
  record: Readonly<DemoRecording>,
  audioExtractions: readonly AudioExtractionResult[],
  options: RecordingWorkflowOptions
): Promise<RecordingWorkflowResult> {
  // Preserve the recording and audio evidence as supplied at the start.
  const snapshot = structuredClone(record);
  const audio = structuredClone([...audioExtractions]);

  // Validate configuration before any provider request.
  const limits = validateResearchLimits(options.research.limits);
  const researchOptions = {
    ...options.research,
    limits
  };
    const musicBrainzOptions: MusicBrainzWorkflowOptions = options.musicBrainz
    ? {
        ...options.musicBrainz,
        selection: { ...options.musicBrainz.selection }
      }
    : {};

  if (
    musicBrainzOptions.maxCalls !== undefined &&
    (
      !Number.isInteger(musicBrainzOptions.maxCalls) ||
      musicBrainzOptions.maxCalls < 0 ||
      musicBrainzOptions.maxCalls > 2
    )
  ) {
    throw new Error("MusicBrainz maxCalls must be an integer from 0 to 2.");
  }

  if (researchOptions.mode !== "dry-run" && !researchOptions.provider) {
    throw new Error("A research provider is required outside dry-run mode.");
  }

  const audioMatch = matchAudioToRecording(snapshot, audio);

  // Pass current evidence without applying a new audio selection.
  const gapReport = analyzeMetadataGaps(snapshot, {
    audioExtractions: audio,
    audioMatchResults: [audioMatch]
  });

  const researchTasks = buildMetadataResearchTasks(snapshot, gapReport);

  // Dry runs never invoke MusicBrainz, even if a provider was supplied.
  const musicBrainz = researchOptions.mode === "dry-run"
    ? null
    : await runMusicBrainzWorkflow(
        snapshot,
        researchTasks,
        musicBrainzOptions
      );

  /*
   * MusicBrainz findings currently remain unverified catalog evidence.
   * They do not resolve gaps, so those tasks remain eligible for research.
   *
   * Run one batch to preserve the existing shared request budget,
   * retry rules, and per-task failure handling.
   */
  const researchResults = await runMetadataResearch(
    researchTasks,
    researchOptions
  );

  const findings: WorkflowFinding[] = [
    ...(musicBrainz?.findings ?? []),
    ...researchResults.proposals.map((proposal): WorkflowFinding => ({
      source: "RESEARCH",
      proposal
    }))
  ];

  const metadataDecisions = consolidateProposals(findings);

  const gapDecisions: PendingGapDecision[] = gapReport.gaps
    .filter((gap) => gap.requiresHumanConfirmation)
    .map((gap) => ({
      gap: structuredClone(gap),
      status: "PENDING_REVIEW",
      requiresHumanReview: true,
      agentMayResolve: false
    }));

  return {
    recording: snapshot,
    status: "PENDING_REVIEW",
    audioMatch,
    gapReport,
    researchTasks,
    musicBrainz,
    researchResults,
    findings,
    metadataDecisions,
    gapDecisions
  };
}
