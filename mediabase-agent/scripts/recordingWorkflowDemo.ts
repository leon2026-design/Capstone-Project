import assert from "node:assert/strict";
import { resolve } from "node:path";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import type { AudioExtractionResult } from "../src/audio/audioMetadata";
import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  ResearchField
} from "../src/metadata/metadataResearch";
import type {
  WorkflowMusicBrainzProvider
} from "../src/workflow/musicBrainzWorkflow";
import { runRecordingWorkflow } from "../src/workflow/recordingWorkflow";

async function main() {
  const csv = [
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC",
    "Fictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album,USAAA2600010"
  ].join("\n");

  const record = importOrchardCsv(csv, "fictional-demo.csv").records[0];
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

  const recordingId = "11111111-1111-4111-8111-111111111111";
  const releaseId = "33333333-3333-4333-8333-333333333333";
  let musicBrainzCalls = 0;

  const musicBrainz: WorkflowMusicBrainzProvider = {
    async lookupRecording(input) {
      musicBrainzCalls++;

      return {
        recordingId: input.recordingId,
        queriedIsrc: input.isrc ?? null,
        status: "NEEDS_REVIEW",
        requiresHumanReview: true,
        error: null,
        candidates: [{
          musicBrainzId: recordingId,
          title: "Fictional Song",
          artistCredit: "Fictional Artist",
          sourceUrl: `https://musicbrainz.org/recording/${recordingId}`,
          releases: [],
          releaseListMayBeIncomplete: true
        }]
      };
    },

    async lookupReleases(id) {
      musicBrainzCalls++;

      return {
        musicBrainzId: id,
        status: "NEEDS_REVIEW",
        requiresHumanReview: true,
        releaseListMayBeIncomplete: true,
        error: null,
        releases: [{
          musicBrainzId: releaseId,
          title: "Fictional Album",
          date: "2026-11-15",
          country: "US",
          barcode: "0012345678905",
          sourceUrl: `https://musicbrainz.org/release/${releaseId}`
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
        // Intentional disagreement to demonstrate conflict detection.
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
        confidence: "UNKNOWN",
        conflictingEvidence: [],
        outcome: "PROPOSED"
      };
    }
  };

  const before = JSON.stringify({ record, audio });

  const result = await runRecordingWorkflow(record, audio, {
    research: {
      mode: "mock",
      provider: research,
      limits: { maxTasks: 10, maxProviderCalls: 10 }
    },
    musicBrainz: {
      provider: musicBrainz,
      maxCalls: 2,
      // Explicit demo selections, not choices made by the workflow.
      selection: {
        musicBrainzRecordingId: recordingId,
        musicBrainzReleaseId: releaseId
      }
    }
  });

  assert.deepEqual(result.recording, record);
  assert.equal(JSON.stringify({ record, audio }), before);
  assert.equal(result.recording.approvalStatus, "DRAFT");
  assert.ok(result.metadataDecisions.some(
    (decision) => decision.assessment === "CONFLICTING"
  ));

  console.log(JSON.stringify({
    mode: "OFFLINE_MOCK_DEMO",
    recordingId: result.recording.recordingId,
    recordSource: result.recording.recordSource,
    audioMatch: result.audioMatch.status,
    gapCount: result.gapReport.gaps.length,
    researchTaskCount: result.researchTasks.length,
    musicBrainzStatus: result.musicBrainz?.status,
    mockMusicBrainzCalls: musicBrainzCalls,
    mockResearchCalls: result.researchResults.usage.providerCalls,
    researchFailures: result.researchResults.failures.length,
    decisions: result.metadataDecisions.map((decision) => ({
      field: decision.field,
      status: decision.status,
      assessment: decision.assessment,
      candidateValues: decision.candidateValues,
      findings: decision.findings.map((finding) => ({
        source: finding.source,
        outcome: finding.proposal.outcome,
        suggestedValue: finding.proposal.suggestedValue,
        evidence: finding.proposal.evidence
      }))
    })),
    pendingGapCount: result.gapDecisions.length,
    originalInputsUnchanged: JSON.stringify({ record, audio }) === before,
    approvalStatus: result.recording.approvalStatus,
    liveNetworkCalls: 0
  }, null, 2));
}

main().catch(() => {
  console.error("The offline workflow demonstration failed.");
  process.exitCode = 1;
});