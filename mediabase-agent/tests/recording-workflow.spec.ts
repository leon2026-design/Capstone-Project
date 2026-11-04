import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  ResearchField
} from "../src/metadata/metadataResearch";
import type { AudioExtractionResult } from "../src/audio/audioMetadata";
import type {
  WorkflowMusicBrainzProvider
} from "../src/workflow/musicBrainzWorkflow";
import { runRecordingWorkflow } from "../src/workflow/recordingWorkflow";

const MB_RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const MB_RELEASE_ID = "33333333-3333-4333-8333-333333333333";

const selection = {
  musicBrainzRecordingId: MB_RECORDING_ID,
  musicBrainzReleaseId: MB_RELEASE_ID
};

function fixture() {
  const csv = [
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC",
    "Fictional Song,Fictional Artist,Fictional Artist,Fictional Album,Album,USAAA2600010"
  ].join("\n");

  const record = importOrchardCsv(csv, "fictional-workflow.csv").records[0];
  const filePath = resolve("fictional-audio", "fictional-song.wav");

  // A pre-existing local selection; the workflow must preserve it.
  record.audioFilePath = filePath;

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

  return { record, audio };
}

function providers() {
  const musicBrainzCalls: string[] = [];
  const researchCalls: ResearchField[] = [];

  const musicBrainz: WorkflowMusicBrainzProvider = {
    async lookupRecording(record) {
      musicBrainzCalls.push("recording");

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
      musicBrainzCalls.push("releases");

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

  const research: MetadataResearchProvider = {
    async research(task): Promise<MetadataResearchResponse> {
      researchCalls.push(task.field);

      const values: Record<ResearchField, string> = {
        isrc: "USAAA2600010",
        label: "Fictional Label",
        officialReleaseDate: "11/15/2026",
        albumTitle: "Fictional Album",
        albumUPC: "0012345678905",
        // Deliberately differs from the MusicBrainz date.
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
        explanation: "Fictional offline research result.",
        confidence: "UNKNOWN",
        conflictingEvidence: [],
        outcome: "PROPOSED"
      };
    }
  };

  return { musicBrainz, research, musicBrainzCalls, researchCalls };
}

test("connects an Orchard recording to matching, gaps, and pending findings", async () => {
  const { record, audio } = fixture();
  const before = JSON.stringify({ record, audio });
  const mock = providers();

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  });

  expect(record.recordSource).toBe("ORCHARD");
  expect(result.audioMatch.status).toBe("MATCHED");
  expect(result.researchTasks.length).toBeGreaterThan(0);
  expect(result.musicBrainz?.status).toBe("COMPLETE");
  expect(result.findings.some((item) => item.source === "MUSICBRAINZ"))
    .toBe(true);
  expect(result.findings.some((item) => item.source === "RESEARCH"))
    .toBe(true);
  expect(result.gapDecisions.length).toBeGreaterThan(0);

  expect(result.recording).toEqual(record);
  expect(result.recording.approvalStatus).toBe("DRAFT");
  expect(result.recording.artistAttribution).toEqual(record.artistAttribution);
  expect(result.recording.audioFilePath).toBe(record.audioFilePath);
  expect(JSON.stringify({ record, audio })).toBe(before);

  for (const decision of result.metadataDecisions) {
    expect(decision.status).toBe("PENDING_REVIEW");
    expect(decision.agentMayResolve).toBe(false);
  }
});

test("detects provider disagreement and preserves both sources", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  });

  const decision = result.metadataDecisions.find(
    (item) => item.field === "albumReleaseDate"
  );

  expect(decision?.assessment).toBe("CONFLICTING");
  expect(decision?.candidateValues).toEqual(["11/15/2026", "11/16/2026"]);
  expect(decision?.findings.map((item) => item.source))
    .toEqual(["MUSICBRAINZ", "RESEARCH"]);

  for (const finding of decision?.findings ?? []) {
    expect(finding.proposal.evidence[0].url).toBeTruthy();
    expect(finding.proposal.evidence[0].verification).toBe("PROVIDER_CLAIM");
    expect(finding.proposal.suggestedValue).toBeNull();
  }
});

test("pauses MusicBrainz for selection while other research continues", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz }
  });

  expect(result.musicBrainz?.status).toBe("SELECTION_REQUIRED");
  expect(mock.musicBrainzCalls).toEqual(["recording"]);
  expect(mock.researchCalls.length).toBeGreaterThan(0);
  expect(result.recording).toEqual(record);
});

test("continues research when MusicBrainz fails", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  mock.musicBrainz.lookupRecording = async () => {
    throw new Error("Private MusicBrainz diagnostic");
  };

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  });

  expect(result.musicBrainz?.status).toBe("FAILED");
  expect(result.researchResults.proposals.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("Private MusicBrainz diagnostic");
  expect(result.recording).toEqual(record);
});

test("preserves per-task research failure handling", async () => {
  const { record, audio } = fixture();
  const mock = providers();
  const originalResearch = mock.research.research;

  mock.research.research = async (task) => {
    if (task.field === "label") {
      throw new Error("Private research diagnostic");
    }
    return originalResearch(task);
  };

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "mock", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  });

  expect(result.researchResults.failures.some(
    (item) => item.taskId.includes("missing-label")
  )).toBe(true);
  expect(result.researchResults.proposals.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("Private research diagnostic");
  expect(result.recording.approvalStatus).toBe("DRAFT");
});

test("preserves the research batch request budget", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  const result = await runRecordingWorkflow(record, audio, {
    research: {
      mode: "mock",
      provider: mock.research,
      limits: { maxProviderCalls: 1 }
    },
    musicBrainz: {
      provider: mock.musicBrainz,
      selection,
      maxCalls: 1
    }
  });

  expect(mock.researchCalls).toHaveLength(1);
  expect(result.researchResults.usage.providerCalls).toBe(1);
  expect(result.researchResults.failures.some(
    (item) => item.errorCode === "BUDGET_EXHAUSTED"
  )).toBe(true);
  expect(mock.musicBrainzCalls).toEqual(["recording"]);
  expect(result.musicBrainz?.status).toBe("BUDGET_EXHAUSTED");
});

test("dry-run plans tasks without invoking either provider", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  const result = await runRecordingWorkflow(record, audio, {
    research: { mode: "dry-run", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  });

  expect(mock.musicBrainzCalls).toEqual([]);
  expect(mock.researchCalls).toEqual([]);
  expect(result.musicBrainz).toBeNull();
  expect(result.researchTasks.length).toBeGreaterThan(0);
  expect(result.researchResults.results.every(
    (item) => item.status === "PLANNED_DRY_RUN"
  )).toBe(true);
  expect(result.findings).toEqual([]);
  expect(result.recording).toEqual(record);
});

test("rejects an ungrounded live provider before invoking either provider", async () => {
  const { record, audio } = fixture();
  const mock = providers();

  await expect(runRecordingWorkflow(record, audio, {
    research: { mode: "live", provider: mock.research },
    musicBrainz: { provider: mock.musicBrainz, selection }
  })).rejects.toThrow(/grounded provider/);

  expect(mock.musicBrainzCalls).toEqual([]);
  expect(mock.researchCalls).toEqual([]);
});
