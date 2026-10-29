import {
  redactResearchText,
  validateMetadataResearchResponse,
  type MetadataResearchFailure,
  type MetadataResearchProposal,
  type MetadataResearchProvider,
  type MetadataResearchResponse,
  type MetadataResearchTask,
  type ResearchField,
  type ResearchSourceCategory,
  type ResearchValidationResult,
  type VerifiedResearchEvidence
} from "../metadata/metadataResearch";
import {
  addUsage,
  emptyUsage,
  isGroundedProvider,
  ResearchProviderError,
  type ResearchGrounding,
  type ResearchUsage
} from "./researchProvider";
import type { EvidenceVerifier, SourceVerificationReport } from "./sourceVerifier";

/**
 * live: a grounded provider (Gemini) is called. mock: any offline provider is called.
 * dry-run: no provider calls; the batch only reports which tasks would be researched.
 */
export type ResearchMode = "live" | "mock" | "dry-run";

export type ResearchLimits = {
  maxTasks: number;
  maxProviderCalls: number;
  /** Extra attempts for rate limits, timeouts, and transient provider errors. */
  maxRetries: number;
  /** Extra attempts after a malformed or schema-invalid response. Kept small on purpose. */
  maxInvalidResponseRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  minRequestIntervalMs: number;
};

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxTasks: 10,
  maxProviderCalls: 20,
  maxRetries: 2,
  maxInvalidResponseRetries: 0,
  initialBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  minRequestIntervalMs: 0
};

const LIMIT_BOUNDS: Record<keyof ResearchLimits, [number, number]> = {
  maxTasks: [0, 500],
  maxProviderCalls: [0, 1_000],
  maxRetries: [0, 5],
  maxInvalidResponseRetries: [0, 2],
  initialBackoffMs: [0, 60_000],
  maxBackoffMs: [0, 300_000],
  minRequestIntervalMs: [0, 60_000]
};

export class ResearchLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchLimitsError";
  }
}

export function validateResearchLimits(limits: Partial<ResearchLimits> = {}): ResearchLimits {
  const merged = { ...DEFAULT_RESEARCH_LIMITS, ...limits };
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS) as [keyof ResearchLimits, [number, number]][]) {
    const value = merged[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ResearchLimitsError(`Research limit ${key} must be an integer from ${min} to ${max}.`);
    }
  }
  if (merged.maxBackoffMs < merged.initialBackoffMs) {
    throw new ResearchLimitsError("Research limit maxBackoffMs must be at least initialBackoffMs.");
  }
  return merged;
}

/** Deterministic exponential backoff; rate limits honor the provider's retry delay up to the cap. */
export function backoffDelayMs(limits: ResearchLimits, retryIndex: number, retryAfterMs: number | null): number {
  const exponential = limits.initialBackoffMs * 2 ** Math.max(0, retryIndex);
  return Math.min(limits.maxBackoffMs, Math.max(exponential, retryAfterMs ?? 0));
}

export type VerificationSummary = {
  /**
   * VERIFIED: every supporting claim was confirmed against retrieved content.
   * PARTIALLY_VERIFIED: some were. UNVERIFIED: none were (claims stay provider claims).
   * NOT_ATTEMPTED: no verifier, no proposal, or nothing to check.
   */
  status: "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED" | "NOT_ATTEMPTED";
  verifiedSupportingCount: number;
  verifiedConflictingCount: number;
  verifiedOfficialSource: boolean;
  reports: SourceVerificationReport[];
};

export type GroundingSummary = {
  status: "GROUNDED" | "NO_GROUNDING" | "NOT_APPLICABLE";
  sourceCount: number;
  searchQueryCount: number;
};

export type ResearchTaskResult = {
  taskId: string;
  recordingId: string;
  gapId: string;
  field: ResearchField;
  status: "PROPOSAL_PENDING_REVIEW" | "FAILED" | "PLANNED_DRY_RUN";
  attempts: number;
  proposal: MetadataResearchProposal | null;
  failure: MetadataResearchFailure | null;
  grounding: GroundingSummary;
  verification: VerificationSummary;
  usage: ResearchUsage;
};

export type ResearchRunResult = {
  mode: ResearchMode;
  model: string | null;
  limits: ResearchLimits;
  /** One entry per task, ordered by taskId. */
  results: ResearchTaskResult[];
  proposals: MetadataResearchProposal[];
  failures: MetadataResearchFailure[];
  usage: ResearchUsage;
};

export type ResearchRunOptions = {
  mode: ResearchMode;
  provider?: MetadataResearchProvider;
  verifier?: EvidenceVerifier;
  limits?: Partial<ResearchLimits>;
  /** Injected for tests so backoff never waits on the real clock. */
  sleep?: (ms: number) => Promise<void>;
};

const FAILURE_DESCRIPTIONS: Record<MetadataResearchFailure["errorCode"], string> = {
  PROVIDER_ERROR: "The research provider failed. This task remains unresolved and may be retried.",
  INVALID_RESPONSE: "The provider response failed proposal validation. This task remains unresolved and may be retried.",
  RATE_LIMITED: "The research provider kept rate-limiting requests after the allowed retries. This task remains unresolved and may be retried later.",
  QUOTA_EXHAUSTED: "The research provider confirmed exhausted quota. No automatic retry was made; restore quota before retrying this unresolved task.",
  TIMEOUT: "The research provider timed out after the allowed retries. This task remains unresolved and may be retried.",
  AUTHENTICATION_ERROR: "The research provider rejected the configured credentials. Fix the API key configuration, then retry.",
  CONFIGURATION_ERROR: "The research provider rejected the model, schema, or tool configuration. Fix the configuration, then retry.",
  BUDGET_EXHAUSTED: "The configured task or provider-call budget was reached before this task finished. It remains unresolved and may be retried.",
  BATCH_ABORTED: "The batch stopped after a credential or configuration error. This task was not researched and may be retried."
};

const OFFICIAL_CATEGORIES = new Set<ResearchSourceCategory>([
  "official-artist", "official-label", "distributor", "identifier-registry"
]);

const NO_GROUNDING: ResearchGrounding = { searchEnabled: false, sources: [], searchQueryCount: 0 };

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function notAttempted(): VerificationSummary {
  return {
    status: "NOT_ATTEMPTED",
    verifiedSupportingCount: 0,
    verifiedConflictingCount: 0,
    verifiedOfficialSource: false,
    reports: []
  };
}

function summarizeGrounding(mode: ResearchMode, grounding: ResearchGrounding | null): GroundingSummary {
  if (mode !== "live" || !grounding) return { status: "NOT_APPLICABLE", sourceCount: 0, searchQueryCount: 0 };
  return {
    status: grounding.sources.length > 0 ? "GROUNDED" : "NO_GROUNDING",
    sourceCount: grounding.sources.length,
    searchQueryCount: grounding.searchQueryCount
  };
}

function summarizeVerification(proposal: MetadataResearchProposal, reports: SourceVerificationReport[]): VerificationSummary {
  const supporting = proposal.evidence;
  const verifiedSupporting = supporting.filter((item) => item.verification === "INDEPENDENTLY_VERIFIED");
  const verifiedConflicting = proposal.conflictingEvidence.filter((item) => item.verification === "INDEPENDENTLY_VERIFIED");
  let status: VerificationSummary["status"];
  if (reports.length === 0) status = "NOT_ATTEMPTED";
  else if (supporting.length > 0 && verifiedSupporting.length === supporting.length) status = "VERIFIED";
  else if (verifiedSupporting.length > 0) status = "PARTIALLY_VERIFIED";
  else status = "UNVERIFIED";
  return {
    status,
    verifiedSupportingCount: verifiedSupporting.length,
    verifiedConflictingCount: verifiedConflicting.length,
    verifiedOfficialSource: verifiedSupporting.some((item) => OFFICIAL_CATEGORIES.has(item.category)),
    reports
  };
}

type Attempt =
  | { ok: true; response: unknown; grounding: ResearchGrounding | null; usage: ResearchUsage | null }
  | { ok: false; error: ResearchProviderError };

async function callProvider(provider: MetadataResearchProvider, task: MetadataResearchTask, mode: ResearchMode): Promise<Attempt> {
  try {
    if (mode === "live" && isGroundedProvider(provider)) {
      const result = await provider.researchWithGrounding(structuredClone(task));
      return { ok: true, response: result.response, grounding: result.grounding, usage: result.usage };
    }
    return { ok: true, response: await provider.research(structuredClone(task)), grounding: null, usage: null };
  } catch (error) {
    // Raw provider errors can echo prompts or credentials; only the safe code survives.
    return {
      ok: false,
      error: error instanceof ResearchProviderError ? error : new ResearchProviderError("PROVIDER_ERROR", { retryable: false })
    };
  }
}

function validate(task: MetadataResearchTask, response: unknown, attestations: readonly VerifiedResearchEvidence[]): ResearchValidationResult {
  try {
    return validateMetadataResearchResponse(task, response, attestations);
  } catch {
    return { ok: false, errors: ["Research response could not be inspected."] };
  }
}

/**
 * Runs research with retries, budgets, grounding, and independent verification while
 * preserving per-task failure isolation. It never receives records, never applies values,
 * and every proposal stays PENDING_REVIEW for Brad.
 */
export async function runMetadataResearch(
  tasks: readonly MetadataResearchTask[],
  options: ResearchRunOptions
): Promise<ResearchRunResult> {
  const limits = validateResearchLimits(options.limits);
  const { mode, provider, verifier } = options;
  if (mode !== "dry-run" && !provider) throw new ResearchLimitsError(`Research mode "${mode}" requires a provider.`);
  if (mode === "live" && provider && !isGroundedProvider(provider)) {
    throw new ResearchLimitsError("Live research requires a grounded provider such as the Gemini provider.");
  }
  const snapshots = structuredClone(tasks);
  if (new Set(snapshots.map((task) => task.taskId)).size !== snapshots.length) {
    throw new Error("Duplicate research task identifier.");
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const results: ResearchTaskResult[] = [];
  const total = emptyUsage();
  let callsUsed = 0;
  let aborted = false;

  for (const [index, task] of [...snapshots].sort((left, right) => compare(left.taskId, right.taskId)).entries()) {
    const usage = emptyUsage();
    const base = {
      taskId: redactResearchText(task.taskId),
      recordingId: redactResearchText(task.recordingId),
      gapId: redactResearchText(task.gapId),
      field: task.field
    };
    let attempts = 0;
    let diagnostics: MetadataResearchFailure["diagnostics"];
    let grounding: ResearchGrounding | null = null;
    const finish = (partial: Pick<ResearchTaskResult, "status" | "proposal" | "failure"> & { verification?: VerificationSummary }): void => {
      addUsage(total, usage);
      results.push({
        ...base,
        attempts,
        grounding: summarizeGrounding(mode, grounding),
        verification: partial.verification ?? notAttempted(),
        usage,
        status: partial.status,
        proposal: partial.proposal,
        failure: partial.failure
      });
    };
    const fail = (errorCode: MetadataResearchFailure["errorCode"]): void => finish({
      status: "FAILED",
      proposal: null,
      failure: {
        taskId: base.taskId,
        recordingId: base.recordingId,
        gapId: base.gapId,
        errorCode,
        description: FAILURE_DESCRIPTIONS[errorCode],
        status: "UNRESOLVED",
        retryEligible: true,
        ...(diagnostics ? { diagnostics } : {})
      }
    });

    if (mode === "dry-run") {
      finish({ status: "PLANNED_DRY_RUN", proposal: null, failure: null });
      continue;
    }
    if (aborted) { fail("BATCH_ABORTED"); continue; }
    if (index >= limits.maxTasks) { fail("BUDGET_EXHAUSTED"); continue; }

    let transientRetries = 0;
    let invalidRetries = 0;
    let outcome: { response: unknown; proposal: MetadataResearchProposal } | null = null;
    let failure: MetadataResearchFailure["errorCode"] | null = null;
    for (;;) {
      if (callsUsed >= limits.maxProviderCalls) { failure = "BUDGET_EXHAUSTED"; break; }
      if (callsUsed > 0 && limits.minRequestIntervalMs > 0) await sleep(limits.minRequestIntervalMs);
      callsUsed++;
      attempts++;
      const attempt = await callProvider(provider as MetadataResearchProvider, task, mode);
      if (attempt.ok) {
        diagnostics = undefined;
        grounding = attempt.grounding ?? (mode === "live" ? NO_GROUNDING : null);
        addUsage(usage, attempt.usage ?? { ...emptyUsage(), providerCalls: 1 });
        let response: unknown;
        try {
          // Detach untrusted output from any provider-held object before inspection.
          response = structuredClone(attempt.response);
        } catch {
          response = undefined;
        }
        const result = validate(task, response, []);
        if (result.ok) { outcome = { response, proposal: result.proposal }; break; }
        if (invalidRetries < limits.maxInvalidResponseRetries) { invalidRetries++; continue; }
        failure = "INVALID_RESPONSE";
        break;
      }
      addUsage(usage, { ...emptyUsage(), providerCalls: 1 });
      const { error } = attempt;
      diagnostics = { httpStatus: error.httpStatus, category: error.code, retryable: error.retryable };
      if (error.code === "AUTHENTICATION_ERROR" || error.code === "CONFIGURATION_ERROR") {
        failure = error.code;
        aborted = true;
        break;
      }
      if (error.code === "INVALID_RESPONSE") {
        if (invalidRetries < limits.maxInvalidResponseRetries) { invalidRetries++; continue; }
        failure = "INVALID_RESPONSE";
        break;
      }
      if (error.retryable && transientRetries < limits.maxRetries) {
        await sleep(backoffDelayMs(limits, transientRetries, error.code === "RATE_LIMITED" ? error.retryAfterMs : null));
        transientRetries++;
        continue;
      }
      failure = error.code === "RATE_LIMITED" || error.code === "QUOTA_EXHAUSTED" ||
        error.code === "TIMEOUT" ? error.code : "PROVIDER_ERROR";
      break;
    }
    if (!outcome) { fail(failure ?? "PROVIDER_ERROR"); continue; }

    let proposal = outcome.proposal;
    let verification = notAttempted();
    const response = outcome.response as MetadataResearchResponse;
    if (verifier && response.evidence.length + response.conflictingEvidence.length > 0) {
      try {
        const verified = await verifier.verify(
          structuredClone(task),
          {
            suggestedValue: response.suggestedValue,
            evidence: structuredClone(response.evidence),
            conflictingEvidence: structuredClone(response.conflictingEvidence)
          },
          grounding ?? NO_GROUNDING
        );
        const revalidated = validate(task, response, verified.attestations);
        if (revalidated.ok) proposal = revalidated.proposal;
        verification = summarizeVerification(proposal, verified.reports);
      } catch {
        // A verifier failure leaves every claim as an unverified provider claim.
        verification = { ...notAttempted(), status: "UNVERIFIED" };
      }
    }
    finish({ status: "PROPOSAL_PENDING_REVIEW", proposal, failure: null, verification });
  }

  return {
    mode,
    model: mode === "live" && provider && isGroundedProvider(provider) ? provider.model : null,
    limits,
    results,
    proposals: results.flatMap((result) => result.proposal ? [result.proposal] : []),
    failures: results.flatMap((result) => result.failure ? [result.failure] : []),
    usage: total
  };
}
