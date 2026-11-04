import { expect, test } from "@playwright/test";
import {
  analyzeMetadataGaps
} from "../src/metadata/metadataGapAnalyzer";
import {
  buildMetadataResearchTasks
} from "../src/metadata/metadataResearch";
import type {
  DemoRecording
} from "../src/metadata/recordValidation";
import {
  runMusicBrainzWorkflow,
  type WorkflowMusicBrainzProvider
} from "../src/workflow/musicBrainzWorkflow";

const MB_RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const MB_RELEASE_ID = "33333333-3333-4333-8333-333333333333";

function recording(): DemoRecording {
  return {
    recordingId: "TEST-WORKFLOW-001",
    recordSource: "MANUAL",
    artist: "Fictional Artist",
    title: "Fictional Song",
    albumReleaseDate: "11/15/2026",
    isrc: "USAAA2600010",
    isrcValidation: {
      status: "valid",
      originalValue: "USAAA2600010",
      reviewed: true
    },
    approvalStatus: "DRAFT"
  };
}

function mockProvider() {
  const calls: string[] = [];

  const provider: WorkflowMusicBrainzProvider = {
    async lookupRecording(record) {
      calls.push("recording");

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
      calls.push("releases");

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

  return { provider, calls };
}

const selection = {
  musicBrainzRecordingId: MB_RECORDING_ID,
  musicBrainzReleaseId: MB_RELEASE_ID
};

test("requires recording selection even for one candidate", async () => {
  const record = recording();
  const mock = mockProvider();

  const result = await runMusicBrainzWorkflow(record, [], {
    provider: mock.provider
  });

  expect(result.status).toBe("SELECTION_REQUIRED");
  expect(result.lookup?.candidates).toHaveLength(1);
  expect(result.releaseLookup).toBeNull();
  expect(result.findings).toEqual([]);
  expect(mock.calls).toEqual(["recording"]);
});

test("requires release selection before generating proposals", async () => {
  const mock = mockProvider();

  const result = await runMusicBrainzWorkflow(recording(), [], {
    provider: mock.provider,
    selection: { musicBrainzRecordingId: MB_RECORDING_ID }
  });

  expect(result.status).toBe("SELECTION_REQUIRED");
  expect(result.releaseLookup?.releases).toHaveLength(1);
  expect(result.findings).toEqual([]);
  expect(mock.calls).toEqual(["recording", "releases"]);
});

test("connects selected results to existing pending proposals", async () => {
  const record = recording();
  const before = JSON.stringify(record);
  const tasks = buildMetadataResearchTasks(
    record,
    analyzeMetadataGaps(record)
  );
  const tasksBefore = JSON.stringify(tasks);
  const mock = mockProvider();

  const result = await runMusicBrainzWorkflow(record, tasks, {
    provider: mock.provider,
    selection
  });

  expect(result.status).toBe("COMPLETE");
  expect(result.callsUsed).toBe(2);
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.findings.some(
    (item) => item.proposal.field === "albumTitle"
  )).toBe(true);

  for (const finding of result.findings) {
    expect(finding.source).toBe("MUSICBRAINZ");
    expect(finding.proposal.reviewStatus).toBe("PENDING_REVIEW");
    expect(finding.proposal.agentMayResolve).toBe(false);
    expect(finding.proposal.suggestedValue).toBeNull();
    expect(finding.proposal.evidence.every(
      (item) => item.verification === "PROVIDER_CLAIM"
    )).toBe(true);
  }

  expect(JSON.stringify(record)).toBe(before);
  expect(JSON.stringify(tasks)).toBe(tasksBefore);
  expect(record.approvalStatus).toBe("DRAFT");
});

test("respects zero-call and one-call budgets", async () => {
  for (const maxCalls of [0, 1]) {
    const mock = mockProvider();

    const result = await runMusicBrainzWorkflow(recording(), [], {
      provider: mock.provider,
      selection,
      maxCalls
    });

    expect(result.status).toBe("BUDGET_EXHAUSTED");
    expect(result.callsUsed).toBe(maxCalls);
    expect(mock.calls).toHaveLength(maxCalls);
    expect(result.findings).toEqual([]);
  }
});

test("skips invalid or missing ISRCs without calling the provider", async () => {
  for (const isrc of [null, "", "INVALID"]) {
    const record = recording();
    record.isrc = isrc;
    const mock = mockProvider();

    const result = await runMusicBrainzWorkflow(record, [], {
      provider: mock.provider,
      selection
    });

    expect(result.status).toBe("SKIPPED");
    expect(result.callsUsed).toBe(0);
    expect(mock.calls).toEqual([]);
  }
});

test("does not accept a recording outside the returned candidates", async () => {
  const mock = mockProvider();

  const result = await runMusicBrainzWorkflow(recording(), [], {
    provider: mock.provider,
    selection: {
      ...selection,
      musicBrainzRecordingId: "not-a-candidate"
    }
  });

  expect(result.status).toBe("FAILED");
  expect(mock.calls).toEqual(["recording"]);
  expect(result.findings).toEqual([]);
});

test("does not accept a release outside the returned candidates", async () => {
  const mock = mockProvider();

  const result = await runMusicBrainzWorkflow(recording(), [], {
    provider: mock.provider,
    selection: {
      ...selection,
      musicBrainzReleaseId: "not-a-release"
    }
  });

  expect(result.status).toBe("FAILED");
  expect(result.findings).toEqual([]);
});

test("reports provider failures without leaking raw errors", async () => {
  const mock = mockProvider();
  mock.provider.lookupRecording = async () => {
    throw new Error("Private provider diagnostic");
  };

  const result = await runMusicBrainzWorkflow(recording(), [], {
    provider: mock.provider,
    selection
  });

  expect(result.status).toBe("FAILED");
  expect(result.callsUsed).toBe(1);
  expect(JSON.stringify(result)).not.toContain("Private provider diagnostic");
});

test("skips MusicBrainz when no provider is configured", async () => {
  const result = await runMusicBrainzWorkflow(recording(), []);

  expect(result.status).toBe("SKIPPED");
  expect(result.callsUsed).toBe(0);
  expect(result.findings).toEqual([]);
});