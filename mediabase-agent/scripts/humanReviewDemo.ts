import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AudioExtractionResult } from "../src/audio/audioMetadata";
import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  MetadataReviewAction,
  ResearchField,
  VerifiedResearchEvidence
} from "../src/metadata/metadataResearch";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import type { EvidenceVerifier } from "../src/research/sourceVerifier";
import {
  processPendingReviews,
  reviewBasisFor,
  startHumanReview,
  type HumanReviewDecision,
  type HumanReviewState
} from "../src/workflow/humanReview";
import type { WorkflowMusicBrainzProvider } from "../src/workflow/musicBrainzWorkflow";
import { runRecordingWorkflow } from "../src/workflow/recordingWorkflow";

/**
 * Offline MB-07 demonstration: fictional data, mock providers, and a fictional
 * verifier. No network, paid API, or Mediabase access, and nothing is submitted.
 */
async function main() {
  const csv = [
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC",
    "Fictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album,USAAA2600010"
  ].join("\n");
  const record = importOrchardCsv(csv, "fictional-review-demo.csv").records[0];
  const filePath = resolve("fictional-audio", "fictional-song.wav");
  record.audioFilePath = filePath;

  // Fictional extraction data only. No audio file is read.
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
      isrc: "USAAA2600010",
      rawIsrcs: ["USAAA2600010"]
    }
  }];

  const mbRecordingId = "11111111-1111-4111-8111-111111111111";
  const mbReleaseId = "33333333-3333-4333-8333-333333333333";
  const musicBrainz: WorkflowMusicBrainzProvider = {
    async lookupRecording(input) {
      return {
        recordingId: input.recordingId,
        queriedIsrc: input.isrc ?? null,
        status: "NEEDS_REVIEW",
        requiresHumanReview: true,
        error: null,
        candidates: [{
          musicBrainzId: mbRecordingId,
          title: "Fictional Song",
          artistCredit: "Fictional Artist",
          sourceUrl: `https://musicbrainz.org/recording/${mbRecordingId}`,
          releases: [],
          releaseListMayBeIncomplete: true
        }]
      };
    },
    async lookupReleases(id) {
      return {
        musicBrainzId: id,
        status: "NEEDS_REVIEW",
        requiresHumanReview: true,
        releaseListMayBeIncomplete: true,
        error: null,
        releases: [{
          musicBrainzId: mbReleaseId,
          title: "Fictional Album",
          date: "2026-11-15",
          country: "US",
          barcode: "0012345678905",
          sourceUrl: `https://musicbrainz.org/release/${mbReleaseId}`
        }]
      };
    }
  };

  const research: MetadataResearchProvider = {
    async research(task): Promise<MetadataResearchResponse> {
      const values: Record<ResearchField, string> = {
        isrc: "USAAA2600010",
        label: "Fictional Label",
        officialReleaseDate: "11/15/2026",
        albumTitle: "Fictional Album",
        albumUPC: "0012345678905",
        // Intentional disagreement with MusicBrainz to demonstrate conflict handling.
        albumReleaseDate: "11/16/2026"
      };
      const value = values[task.field];
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
        explanation: "Fictional offline demonstration evidence.",
        confidence: "HIGH",
        conflictingEvidence: [],
        outcome: "PROPOSED"
      };
    }
  };

  // Stands in for the independent source verifier; attests without fetching anything.
  const verifier: EvidenceVerifier = {
    async verify(task, claims) {
      const attestations: VerifiedResearchEvidence[] = claims.evidence
        .filter((claim) => claim.supportedValue === claims.suggestedValue)
        .map((claim) => ({
          ...claim,
          recordingId: task.recordingId,
          field: task.field,
          identityFingerprint: task.identityFingerprint,
          verificationId: "fictional-offline-verifier"
        }));
      return { attestations, reports: [] };
    }
  };

  const before = JSON.stringify({ record, audio });
  const workflow = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: research, verifier, limits: { maxTasks: 10, maxProviderCalls: 10 } },
    musicBrainz: {
      provider: musicBrainz,
      maxCalls: 2,
      selection: { musicBrainzRecordingId: mbRecordingId, musicBrainzReleaseId: mbReleaseId }
    }
  });

  const state = startHumanReview(workflow, audio);
  let counter = 0;
  const decide = (
    current: HumanReviewState,
    field: ResearchField,
    kind: MetadataReviewAction["action"],
    extra: { source?: "RESEARCH" | "MUSICBRAINZ"; editedValue?: string; note?: string } = {}
  ): HumanReviewDecision => {
    const review = current.decisions.find((item) => item.decision.field === field);
    const source = extra.source ?? "RESEARCH";
    const proposal = review?.decision.findings.find((item) => item.source === source)?.proposal;
    if (!review || !proposal) throw new Error(`No ${source} proposal for ${field}.`);
    const linkage = {
      proposalId: proposal.proposalId,
      recordingId: proposal.recordingId,
      gapId: proposal.gapId,
      field,
      ...(extra.note ? { note: extra.note } : {})
    };
    return {
      reviewId: `demo-review-${++counter}`,
      decisionId: review.decision.decisionId,
      source,
      action: kind === "EDIT_SUGGESTED_VALUE"
        ? { ...linkage, action: kind, editedValue: extra.editedValue ?? "" }
        : { ...linkage, action: kind },
      reviewer: { reviewerId: "brad", displayName: "Brad (fictional reviewer)" },
      reviewedAt: "2026-11-04T15:30:00.000Z",
      basis: reviewBasisFor(current, review.decision.decisionId)
    };
  };

  const approveLabel = decide(state, "label", "APPROVE_SUGGESTED_VALUE", { note: "Matches the label catalog." });
  const batch = processPendingReviews(state, [
    approveLabel,
    decide(state, "officialReleaseDate", "EDIT_SUGGESTED_VALUE", {
      editedValue: "11/14/2026", note: "Label confirmed the earlier street date."
    }),
    // Rejected: conflicting evidence cannot be approved directly.
    decide(state, "albumReleaseDate", "APPROVE_SUGGESTED_VALUE"),
    // Rejected: invalid UPC check digit.
    decide(state, "albumUPC", "EDIT_SUGGESTED_VALUE", { editedValue: "0012345678906", note: "Typo test." }),
    decide(state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
      source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Release sleeve confirms the MusicBrainz date."
    }),
    decide(state, "albumUPC", "DEFER_DECISION", { note: "Waiting for distributor confirmation." }),
    // Rejected: replaying an already recorded decision.
    approveLabel
  ]);

  const result = batch.state;
  assert.equal(JSON.stringify({ record, audio }), before);
  assert.deepEqual(result.originalRecording, workflow.recording);
  assert.equal(result.recording.approvalStatus, "DRAFT");
  assert.equal(result.recording.label, "Fictional Label");
  assert.deepEqual(batch.rejected.map((item) => item.code), [
    "CONFLICT_REQUIRES_EXPLICIT_RESOLUTION", "INVALID_VALUE", "DUPLICATE_REVIEW"
  ]);

  console.log(JSON.stringify({
    mode: "OFFLINE_MOCK_REVIEW_DEMO",
    recordingId: result.recordingId,
    appliedChanges: Object.fromEntries(batch.applied
      .filter((entry) => entry.outcome === "VALUE_APPLIED")
      .map((entry) => [entry.field, { from: entry.previousValue, to: entry.resultingValue }])),
    rejectedDecisions: batch.rejected,
    decisions: result.decisions.map((item) => ({
      field: item.decision.field,
      assessment: item.decision.assessment,
      status: item.status,
      acceptedValue: item.acceptedValue
    })),
    auditTrail: result.auditTrail.map((entry) => ({
      sequence: entry.sequence,
      reviewer: entry.reviewer.reviewerId,
      reviewedAt: entry.reviewedAt,
      action: entry.action,
      field: entry.field,
      source: entry.source,
      previousValue: entry.previousValue,
      resultingValue: entry.resultingValue,
      evidenceUrls: [...new Set(entry.evidence.map((item) => item.url))],
      note: entry.note
    })),
    gapsBefore: state.gapReport.gaps.length,
    gapsAfter: result.gapReport.gaps.length,
    researchReview: result.researchReview,
    approvalStatus: result.recording.approvalStatus,
    recordingApprovalRequired: result.recordingApprovalRequired,
    originalInputsUnchanged: JSON.stringify({ record, audio }) === before,
    liveNetworkCalls: 0,
    submittedToMediabase: false
  }, null, 2));
}

main().catch(() => {
  console.error("The offline human review demonstration failed.");
  process.exitCode = 1;
});
