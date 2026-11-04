import { resolve } from "node:path";
import type { AudioExtractionResult } from "../../src/audio/audioMetadata";
import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  MetadataReviewAction,
  ResearchField,
  VerifiedResearchEvidence
} from "../../src/metadata/metadataResearch";
import { importOrchardCsv } from "../../src/metadata/orchardImporter";
import type { DemoRecording } from "../../src/metadata/recordValidation";
import type { EvidenceVerifier } from "../../src/research/sourceVerifier";
import {
  reviewBasisFor,
  startHumanReview,
  type HumanReviewDecision,
  type HumanReviewState
} from "../../src/workflow/humanReview";
import type { WorkflowMusicBrainzProvider } from "../../src/workflow/musicBrainzWorkflow";
import {
  humanGapBasisFor,
  humanOnlyGapQueue,
  type HumanGapAction,
  type HumanGapDecision,
  type HumanGapReviewState
} from "../../src/workflow/humanGapReview";
import { runRecordingWorkflow, type RecordingWorkflowResult } from "../../src/workflow/recordingWorkflow";

/** Shared fictional MB-06 -> MB-07 fixture: mock providers and a fictional verifier, fully offline. */

export const MB_RECORDING_ID = "11111111-1111-4111-8111-111111111111";
export const MB_RELEASE_ID = "33333333-3333-4333-8333-333333333333";
export const REVIEWED_AT = "2026-11-04T15:30:00.000Z";

export const RESEARCH_VALUES: Record<ResearchField, string> = {
  isrc: "USAAA2600010",
  label: "Fictional Label",
  officialReleaseDate: "11/15/2026",
  albumTitle: "Fictional Album",
  albumUPC: "0012345678905",
  // Deliberately differs from the MusicBrainz date (11/15/2026).
  albumReleaseDate: "11/16/2026"
};

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function fixture(withIsrc = true, sourceName = "fictional-review.csv") {
  const csv = withIsrc
    ? "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC\nFictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album,USAAA2600010"
    : "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE\nFictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album";
  const record = importOrchardCsv(csv, sourceName).records[0];
  const filePath = resolve("fictional-audio", "fictional-song.wav");
  record.audioFilePath = filePath;
  const isrc = withIsrc ? "USAAA2600010" : null;
  const audio: AudioExtractionResult[] = [{
    status: "OK",
    filePath,
    fileName: "fictional-song.wav",
    metadata: {
      filePath,
      fileName: "fictional-song.wav",
      format: "WAV",
      extensionMatchesFormat: true,
      durationSeconds: 180,
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      artist: "Fictional Artist",
      title: "Fictional Song",
      album: "Fictional Album",
      version: null,
      isrc,
      rawIsrcs: isrc ? [isrc] : []
    }
  }];
  return { record, audio };
}

/** A simulated audio file; by default its embedded artist conflicts with the record. */
export function conflictingAudio(fileName = "fictional-song-alt.wav", artist = "Someone Else Entirely"): AudioExtractionResult {
  const filePath = resolve("fictional-audio", fileName);
  return {
    status: "OK",
    filePath,
    fileName,
    metadata: {
      filePath,
      fileName,
      format: "WAV",
      extensionMatchesFormat: true,
      durationSeconds: 181,
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      artist: artist,
      title: "Fictional Song",
      album: "Fictional Album",
      version: null,
      isrc: null,
      rawIsrcs: []
    }
  };
}

export const musicBrainz: WorkflowMusicBrainzProvider = {
  async lookupRecording(record) {
    return {
      recordingId: record.recordingId,
      queriedIsrc: record.isrc ?? null,
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
  },
  async lookupReleases(recordingId) {
    return {
      musicBrainzId: recordingId,
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
  }
};

export const research: MetadataResearchProvider = {
  async research(task): Promise<MetadataResearchResponse> {
    const value = RESEARCH_VALUES[task.field];
    return {
      recordingId: task.recordingId,
      gapId: task.gapId,
      field: task.field,
      suggestedValue: value,
      evidence: [{
        sourceId: "Fictional research catalog",
        url: "https://catalog.example.test/release",
        category: "published-catalog",
        quote: `Published value: ${value}`,
        supportedValue: value
      }],
      explanation: "Fictional offline research result.",
      confidence: "HIGH",
      conflictingEvidence: [],
      outcome: "PROPOSED"
    };
  }
};

/** Fictional stand-in for the independent source verifier; no network access. */
export const verifier: EvidenceVerifier = {
  async verify(task, claims) {
    const attestations: VerifiedResearchEvidence[] = claims.evidence
      .filter((claim) => claim.supportedValue === claims.suggestedValue)
      .map((claim) => ({
        ...claim,
        recordingId: task.recordingId,
        field: task.field,
        identityFingerprint: task.identityFingerprint,
        verificationId: "fictional-offline-verifier-001"
      }));
    return { attestations, reports: [] };
  }
};

export type Setup = {
  record: DemoRecording;
  audio: AudioExtractionResult[];
  workflow: RecordingWorkflowResult;
  state: HumanReviewState;
};

export async function setup(
  options: {
    verify?: boolean;
    withIsrc?: boolean;
    sourceName?: string;
    current?: (record: DemoRecording) => void;
    /** Mutates the imported record before MB-06 runs. */
    prepare?: (record: DemoRecording) => void;
    /** Additional simulated audio extractions offered as candidates. */
    extraAudio?: AudioExtractionResult[];
  } = {}
): Promise<Setup> {
  const base = fixture(options.withIsrc ?? true, options.sourceName);
  const record = base.record;
  const audio = [...base.audio, ...(options.extraAudio ?? [])];
  options.prepare?.(record);
  const workflow = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: research, ...(options.verify === false ? {} : { verifier }) },
    musicBrainz: {
      provider: musicBrainz,
      selection: { musicBrainzRecordingId: MB_RECORDING_ID, musicBrainzReleaseId: MB_RELEASE_ID }
    }
  });
  let currentRecording: DemoRecording | undefined;
  if (options.current) {
    currentRecording = structuredClone(workflow.recording);
    options.current(currentRecording);
  }
  const state = startHumanReview(workflow, audio, currentRecording ? { currentRecording } : {});
  return { record, audio, workflow, state };
}

let reviewCounter = 0;

/** Builds an MB-09 decision for the human-only gap whose code (and optionally field) matches. */
export function gapDecide(
  state: HumanGapReviewState,
  code: string,
  action: HumanGapAction,
  extra: { field?: string; note?: string; reviewId?: string; reviewerId?: string } = {}
): HumanGapDecision {
  const item = humanOnlyGapQueue(state).find((entry) =>
    entry.gap.code === code && (extra.field === undefined || entry.gap.fields.includes(extra.field)));
  if (!item) throw new Error(`No human-only ${code} gap${extra.field ? ` for ${extra.field}` : ""}.`);
  return {
    reviewId: extra.reviewId ?? `gap-review-${++reviewCounter}`,
    recordingId: state.recordingId,
    gapId: item.gap.gapId,
    action,
    reviewer: { reviewerId: extra.reviewerId ?? "dana", displayName: "Dana (fictional reviewer)" },
    reviewedAt: REVIEWED_AT,
    basis: humanGapBasisFor(state, item.gap.gapId),
    ...(extra.note !== undefined ? { note: extra.note } : {})
  };
}

export function decide(
  state: HumanReviewState,
  field: ResearchField,
  kind: MetadataReviewAction["action"],
  extra: {
    source?: "RESEARCH" | "MUSICBRAINZ";
    editedValue?: string;
    note?: string;
    reviewId?: string;
  } = {}
): HumanReviewDecision {
  const review = state.decisions.find((item) => item.decision.field === field);
  if (!review) throw new Error(`No pending decision for ${field}.`);
  const source = extra.source ?? "RESEARCH";
  const finding = review.decision.findings.find((item) => item.source === source);
  if (!finding) throw new Error(`No ${source} finding for ${field}.`);
  const linkage = {
    proposalId: finding.proposal.proposalId,
    recordingId: finding.proposal.recordingId,
    gapId: finding.proposal.gapId,
    field,
    ...(extra.note !== undefined ? { note: extra.note } : {})
  };
  const action: MetadataReviewAction = kind === "EDIT_SUGGESTED_VALUE"
    ? { ...linkage, action: kind, editedValue: extra.editedValue ?? "" }
    : { ...linkage, action: kind };
  return {
    reviewId: extra.reviewId ?? `review-${++reviewCounter}`,
    decisionId: review.decision.decisionId,
    source,
    action,
    reviewer: { reviewerId: "brad", displayName: "Brad (fictional reviewer)" },
    reviewedAt: REVIEWED_AT,
    basis: reviewBasisFor(state, review.decision.decisionId)
  };
}
