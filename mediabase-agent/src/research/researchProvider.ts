import type { MetadataResearchProvider, MetadataResearchTask } from "../metadata/metadataResearch";

/** A web source that the provider's search grounding actually returned (not a model-written citation). */
export type GroundingSource = {
  uri: string;
  title: string | null;
  domain: string | null;
};

export type ResearchGrounding = {
  searchEnabled: boolean;
  sources: GroundingSource[];
  searchQueryCount: number;
};

export type ResearchUsage = {
  providerCalls: number;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  toolUsePromptTokens: number;
  totalTokens: number;
  searchQueries: number;
};

export type GroundedResearchResult = {
  /** Untrusted model output; always passed through validateMetadataResearchResponse. */
  response: unknown;
  grounding: ResearchGrounding;
  usage: ResearchUsage | null;
};

export interface GroundedMetadataResearchProvider extends MetadataResearchProvider {
  readonly model: string;
  researchWithGrounding(task: Readonly<MetadataResearchTask>): Promise<GroundedResearchResult>;
}

export function isGroundedProvider(provider: MetadataResearchProvider): provider is GroundedMetadataResearchProvider {
  return typeof (provider as Partial<GroundedMetadataResearchProvider>).researchWithGrounding === "function";
}

export type ResearchProviderErrorCode =
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "TRANSIENT"
  | "AUTHENTICATION_ERROR"
  | "CONFIGURATION_ERROR"
  | "INVALID_RESPONSE"
  | "PROVIDER_ERROR";

const SAFE_MESSAGES: Record<ResearchProviderErrorCode, string> = {
  RATE_LIMITED: "The research provider rate-limited the request.",
  QUOTA_EXHAUSTED: "The research provider confirmed that the available quota is exhausted.",
  TIMEOUT: "The research provider request timed out.",
  TRANSIENT: "The research provider was temporarily unavailable.",
  AUTHENTICATION_ERROR: "The research provider rejected the configured credentials.",
  CONFIGURATION_ERROR: "The research provider rejected the request configuration (model, schema, or tools).",
  INVALID_RESPONSE: "The research provider returned output that is not a structured research response.",
  PROVIDER_ERROR: "The research provider failed."
};

/**
 * Carries only a fixed, safe message. The original provider error (which may echo
 * prompts, credentials, or request details) is intentionally never stored.
 */
export class ResearchProviderError extends Error {
  readonly code: ResearchProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;

  constructor(code: ResearchProviderErrorCode, options: {
    retryable?: boolean;
    retryAfterMs?: number | null;
    httpStatus?: number;
  } = {}) {
    super(SAFE_MESSAGES[code]);
    this.name = "ResearchProviderError";
    this.code = code;
    this.retryable = code !== "QUOTA_EXHAUSTED" && (options.retryable ??
      (code === "RATE_LIMITED" || code === "TIMEOUT" || code === "TRANSIENT"));
    this.retryAfterMs = options.retryAfterMs ?? null;
    const status = options.httpStatus;
    this.httpStatus = typeof status === "number" && Number.isInteger(status) &&
      status >= 100 && status <= 599 ? status : null;
  }
}

export function emptyUsage(): ResearchUsage {
  return {
    providerCalls: 0,
    promptTokens: 0,
    candidatesTokens: 0,
    thoughtsTokens: 0,
    toolUsePromptTokens: 0,
    totalTokens: 0,
    searchQueries: 0
  };
}

export function addUsage(total: ResearchUsage, usage: ResearchUsage | null): void {
  if (!usage) return;
  for (const key of Object.keys(total) as (keyof ResearchUsage)[]) total[key] += usage[key];
}
