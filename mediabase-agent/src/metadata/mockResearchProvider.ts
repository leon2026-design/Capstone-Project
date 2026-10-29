import type {
  MetadataResearchProvider,
  MetadataResearchResponse,
  MetadataResearchTask
} from "./metadataResearch";

/**
 * Offline fixture responses keyed by taskId, not a simulator of verified research.
 * A missing fixture explicitly reports insufficient evidence. No network or SDK.
 */
export class MockMetadataResearchProvider implements MetadataResearchProvider {
  private readonly responses: Readonly<Record<string, unknown>>;

  constructor(responses: Readonly<Record<string, unknown>> = {}) {
    this.responses = structuredClone(responses);
  }

  async research(task: Readonly<MetadataResearchTask>): Promise<unknown> {
    if (Object.prototype.hasOwnProperty.call(this.responses, task.taskId)) {
      return structuredClone(this.responses[task.taskId]);
    }
    return {
      recordingId: task.recordingId,
      gapId: task.gapId,
      field: task.field,
      suggestedValue: null,
      evidence: [],
      explanation: "The offline fictional mock has no evidence fixture for this task.",
      confidence: "UNKNOWN",
      conflictingEvidence: [],
      outcome: "INSUFFICIENT_EVIDENCE"
    } satisfies MetadataResearchResponse;
  }
}
