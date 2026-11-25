import { promises as fs } from "node:fs";
import type { Page } from "@playwright/test";
import { applyAudioMatch, matchAudioToRecording, matchAudioToRecordings, type AudioMatchResult } from "../audio/audioMatcher";
import { extractAudioMetadata, type AudioExtractionResult } from "../audio/audioMetadata";
import { prepareMediabaseForm } from "../browser/mediabaseForm";
import { redactResearchText } from "../metadata/metadataResearch";
import { importOrchardCsv } from "../metadata/orchardImporter";
import type { DemoRecording } from "../metadata/recordValidation";
import {
  FORM_RADIO_FIELDS,
  FORM_TEXT_FIELDS,
  expectedFormState,
  runFormPreflight,
  type DiscrepancyExplainer,
  type ExpectedFormState,
  type PreflightFailure
} from "../submission/formPreflight";
import type { UploadNamingProfile } from "../submission/namingProfile";
import type { ClientMetadataContract } from "../submission/clientMetadataContract";
import type { AudioTagProfile, ExplicitTagValues } from "../submission/audioTagProfile";
import type { AudioPreparationStore, PreparedAudioManifest } from "../submission/audioPreparationStore";
import { assertLocalDestination, installLoopbackNetworkGuard } from "../submission/submissionSafety";
import {
  canonicalJson,
  sha256Hex,
  type AttemptStatus,
  type AutomaticCorrection,
  type FinalApprovalRecord,
  type LedgerError,
  type LedgerTransaction,
  type ReceiptCheck,
  type SubmissionAttemptEvent,
  type SubmissionException,
  type SubmissionLedger,
  type SubmissionLedgerEntry,
  type SubmissionStatus
} from "../submission/submissionLedger";
import {
  DEFAULT_SUBMISSION_POLICY,
  assessSubmissionReadiness,
  type ApprovalBasis,
  type PreparedSubmission,
  type ReadinessReport,
  type SubmissionPolicy
} from "../submission/submissionReadiness";
import { startHumanGapReview } from "./humanGapReview";
import { startHumanReview, type ReviewerIdentity } from "./humanReview";
import { runRecordingWorkflow, type RecordingWorkflowOptions } from "./recordingWorkflow";
import type { ReviewSessionStore, StoredCombinedReviewSession } from "./reviewSessionStore";

/**
 * MB-10 end-to-end coordinator. It connects the existing stages without
 * re-implementing them:
 *
 *   Orchard import -> audio extraction/matching -> MB-06 workflow ->
 *   MB-07/MB-09 review session (persisted by MB-08, schema v2) ->
 *   explicit final approval -> pre-submission validation -> form filling ->
 *   independent DOM preflight -> local mock upload -> receipt verification.
 *
 * Review decisions are made through the MB-07/MB-09 APIs and saved with the
 * MB-08 store; the coordinator only reads and verifies them. Submission state
 * lives in a separate ledger, so review replay and signatures are unaffected.
 * Destinations must be loopback: there is no live Mediabase code path.
 */

export type ReceivedSubmission = {
  submissionId: string;
  confirmationId: string;
  receivedAt: string;
  fields: Record<string, string>;
  files: Array<{ fieldName: string; fileName: string; size: number; sha256: string }>;
};

export type ReceiptLookup =
  | { status: "FOUND"; receipt: ReceivedSubmission }
  | { status: "NOT_FOUND" }
  | { status: "UNAVAILABLE" };

export type SubmissionDestination = {
  id: string;
  /** Loopback URL of the form page; anything else is refused. */
  formUrl: string;
  /** Asks the destination what it received for a submission id (verification and reconciliation). */
  lookupReceipt(submissionId: string): Promise<ReceiptLookup>;
};

/** A destination backed by the local mock server's receipt endpoint. */
export function localMockDestination(baseUrl: string, id = "local-mock-mediabase"): SubmissionDestination {
  const base = assertLocalDestination(baseUrl);
  return {
    id,
    formUrl: new URL("/mock-mediabase/form", base).href,
    async lookupReceipt(submissionId) {
      const url = new URL(`/mock-mediabase/receipts/${encodeURIComponent(submissionId)}`, base);
      assertLocalDestination(url.href);
      try {
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (response.status === 404) return { status: "NOT_FOUND" };
        if (!response.ok) return { status: "UNAVAILABLE" };
        const body = (await response.json()) as { found?: boolean; receipt?: ReceivedSubmission };
        return body.found && body.receipt ? { status: "FOUND", receipt: body.receipt } : { status: "NOT_FOUND" };
      } catch {
        return { status: "UNAVAILABLE" };
      }
    }
  };
}

export type FinalApprovalDecision = {
  recordingId: string;
  /** Unique per approval; replaying an id is refused. */
  approvalId: string;
  approvedBy: ReviewerIdentity;
  approvedAt: string;
  /** From `approvalBasis`; a basis that no longer matches the recording or audio is stale. */
  basis: ApprovalBasis;
  /** Required when the Orchard ISRC is missing and the approver confirms it is absent. */
  confirmMissingIsrc?: boolean;
  note?: string;
};

export type CoordinatorTimings = Record<string, number>;

export type CoordinatorError = { ok: false; recordingId: string; code: string; message: string };

export type ImportOutcome =
  | { ok: true; recordingId: string; status: SubmissionStatus; resumed: boolean; reviewRevision: number; corrections: AutomaticCorrection[]; timingsMs: CoordinatorTimings }
  | CoordinatorError;

export type EvaluationOutcome =
  | {
    ok: true;
    recordingId: string;
    status: SubmissionStatus;
    exceptions: SubmissionException[];
    warnings: SubmissionException[];
    basis: ApprovalBasis | null;
    submissionId: string | null;
    timingsMs: CoordinatorTimings;
  }
  | CoordinatorError;

export type ApprovalOutcome =
  | { ok: true; recordingId: string; status: SubmissionStatus; approval: FinalApprovalRecord }
  | (CoordinatorError & { exceptions?: SubmissionException[] });

export type SubmitOutcome =
  | {
    ok: true;
    recordingId: string;
    status: SubmissionStatus;
    submissionId: string | null;
    confirmation: SubmissionLedgerEntry["confirmation"];
    alreadySubmitted: boolean;
    /** Network attempts made by this call. */
    attempts: number;
    exceptions: SubmissionException[];
    preflightFailures: PreflightFailure[];
    explanations: string[];
    timingsMs: CoordinatorTimings;
  }
  | CoordinatorError;

export type ReconcileOutcome =
  | { ok: true; recordingId: string; status: SubmissionStatus; result: "FOUND" | "NOT_FOUND" | "MISMATCH" | "UNAVAILABLE" | "NOT_NEEDED"; confirmation: SubmissionLedgerEntry["confirmation"] }
  | CoordinatorError;

export type CoordinatorMetrics = {
  counters: Record<string, number>;
  timingsMs: Record<string, number>;
  /** Research usage reported by the configured providers; zero for mock providers. */
  researchUsage: Record<string, number>;
  /** No prices are configured, so no cost is computed or estimated. */
  cost: null;
};

export type SubmissionCoordinatorOptions = {
  reviewStore: ReviewSessionStore;
  ledger: SubmissionLedger;
  destination: SubmissionDestination;
  /** MB-06 configuration (research and MusicBrainz providers). */
  workflow: RecordingWorkflowOptions;
  namingProfile?: UploadNamingProfile;
  /** When configured, MB-11 prepared artifacts are required before final approval. */
  audioPreparationStore?: AudioPreparationStore;
  audioTagProfile?: AudioTagProfile;
  explicitAudioTagValues?: ExplicitTagValues;
  clientMetadataContract?: ClientMetadataContract;
  policy?: Partial<SubmissionPolicy>;
  explainer?: DiscrepancyExplainer;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: runs after the form is filled and before the independent preflight. */
  afterFormFilled?: (page: Page) => Promise<void>;
};

export interface SubmissionCoordinator {
  importRecordings(input: { csv: string; sourceName: string; audioPaths: readonly string[] }): Promise<ImportOutcome[]>;
  importRecording(record: DemoRecording, audio: readonly AudioExtractionResult[], sourceName?: string | null): Promise<ImportOutcome>;
  /** What a final approver must capture; binds the approval to this exact content. */
  approvalBasis(recordingId: string): Promise<{ ok: true; basis: ApprovalBasis } | CoordinatorError>;
  approve(decision: FinalApprovalDecision): Promise<ApprovalOutcome>;
  evaluate(recordingId: string): Promise<EvaluationOutcome>;
  submit(recordingId: string, options: { openPage: () => Promise<Page> }): Promise<SubmitOutcome>;
  processQueue(recordingIds: readonly string[], options: { openPage: () => Promise<Page> }): Promise<SubmitOutcome[]>;
  reconcile(recordingId: string): Promise<ReconcileOutcome>;
  status(recordingId: string): Promise<{ ok: true; entry: SubmissionLedgerEntry } | CoordinatorError>;
  metrics(): CoordinatorMetrics;
}

class CoordinatorFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function isLedgerError(value: unknown): value is LedgerError {
  return typeof value === "object" && value !== null && (value as LedgerError).ok === false &&
    typeof (value as LedgerError).code === "string" && !("recordingId" in value);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** Digest of everything the form must carry, so receipts can be checked without storing contact values. */
export function formFieldsDigest(text: Record<string, string>, radios: Record<string, string | null>, submissionId: string): string {
  const normalized = Object.fromEntries(Object.entries(text).map(([key, value]) => [key, normalizeNewlines(value)]));
  return `FIELDS-${sha256Hex(canonicalJson({ text: normalized, radios, submissionId }))}`;
}

function receivedFieldsDigest(fields: Record<string, string>): string {
  const text = Object.fromEntries(FORM_TEXT_FIELDS.map((field) => [field, fields[field] ?? ""]));
  const radios = Object.fromEntries(FORM_RADIO_FIELDS.map((field) => [field, fields[field] ?? null]));
  return formFieldsDigest(text, radios, fields.submissionId ?? "");
}

export function verifyReceipt(
  receipt: ReceivedSubmission,
  submissionId: string,
  expected: NonNullable<SubmissionAttemptEvent["expected"]>
): ReceiptCheck {
  const mismatches: string[] = [];
  const file = receipt.files[0];
  if (receipt.submissionId !== submissionId) mismatches.push("SUBMISSION_ID");
  if (receipt.files.length !== 1) mismatches.push("FILE_COUNT");
  if (!file || file.fieldName !== "audioFile") mismatches.push("FILE_FIELD");
  if (file?.fileName !== expected.fileName) mismatches.push("FILE_NAME");
  if (file?.size !== expected.fileSize) mismatches.push("FILE_SIZE");
  if (file?.sha256 !== expected.fileSha256) mismatches.push("FILE_SHA256");
  if (receivedFieldsDigest(receipt.fields) !== expected.fieldsDigest) mismatches.push("FIELDS");
  return {
    confirmationId: redactResearchText(String(receipt.confirmationId)).slice(0, 80),
    receivedAt: String(receipt.receivedAt).slice(0, 40),
    fileName: redactResearchText(String(file?.fileName ?? "")).slice(0, 200),
    fileSize: Number(file?.size ?? 0),
    fileSha256: String(file?.sha256 ?? "").slice(0, 64),
    fileCount: receipt.files.length,
    verified: mismatches.length === 0,
    mismatches
  };
}

function usageCounters(usage: unknown): Record<string, number> | null {
  if (typeof usage !== "object" || usage === null) return null;
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number")) as Record<string, number>;
}

type Commit = {
  status?: SubmissionStatus;
  reason?: string | null;
  exceptions?: SubmissionException[];
  warnings?: SubmissionException[];
  submissionId?: string | null;
  confirmation?: SubmissionLedgerEntry["confirmation"];
  attempts?: Array<Omit<SubmissionAttemptEvent, "sequence">>;
  corrections?: Array<Omit<AutomaticCorrection, "sequence">>;
  approvals?: Array<Omit<FinalApprovalRecord, "sequence">>;
};

type Context = {
  recordingId: string;
  entry: SubmissionLedgerEntry | null;
  commit(change: Commit): Promise<SubmissionLedgerEntry>;
  create(entry: Omit<SubmissionLedgerEntry, "revision" | "updatedAt">): Promise<SubmissionLedgerEntry>;
};

export function createSubmissionCoordinator(options: SubmissionCoordinatorOptions): SubmissionCoordinator {
  const policy: SubmissionPolicy = { ...DEFAULT_SUBMISSION_POLICY, ...options.policy };
  policy.requirePreparedAudio = options.policy?.requirePreparedAudio ?? Boolean(options.audioPreparationStore);
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer from 1 to 10.");
  }
  if (!policy.requireAudio) throw new Error("The Mediabase submission coordinator requires audio uploads.");
  const destination = options.destination;
  assertLocalDestination(destination.formUrl);
  if (!SAFE_ID.test(destination.id)) throw new Error("Destination id must be a short safe identifier.");
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const inFlight = new Set<string>();
  const counters: Record<string, number> = {};
  const timings: Record<string, number> = {};
  const researchUsage: Record<string, number> = {};
  const count = (name: string, amount = 1) => void (counters[name] = (counters[name] ?? 0) + amount);
  const time = async <T>(name: string, local: CoordinatorTimings, task: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await task();
    } finally {
      const elapsed = Math.round(performance.now() - started);
      local[name] = (local[name] ?? 0) + elapsed;
      timings[name] = (timings[name] ?? 0) + elapsed;
    }
  };
  const error = (recordingId: string, code: string, message: string): CoordinatorError =>
    ({ ok: false, recordingId, code, message: redactResearchText(message) });

  async function locked<T>(recordingId: string, task: (ctx: Context) => Promise<T>): Promise<T | CoordinatorError> {
    let result: T | LedgerError;
    try {
      result = await options.ledger.transact(recordingId, destination.id, async (tx: LedgerTransaction) => {
        if (!tx.loaded.ok && tx.loaded.code !== "NOT_FOUND") {
          throw new CoordinatorFailure(`LEDGER_${tx.loaded.code}`, tx.loaded.message);
        }
        const write = async (next: Omit<SubmissionLedgerEntry, "revision" | "updatedAt">) => {
          const written = await tx.write(next);
          if (!written.ok) throw new CoordinatorFailure(`LEDGER_${written.code}`, written.message);
          return written.entry;
        };
        const ctx: Context = {
          recordingId,
          entry: tx.loaded.ok ? tx.loaded.entry : null,
          async create(entry) {
            ctx.entry = await write(entry);
            return ctx.entry;
          },
          async commit(change) {
            const current = ctx.entry;
            if (!current) throw new CoordinatorFailure("NOT_IMPORTED", "This recording has not been imported.");
            const at = now().toISOString();
            const { revision: _revision, updatedAt: _updatedAt, ...base } = structuredClone(current);
            const next = {
              ...base,
              ...(change.exceptions !== undefined ? { exceptions: change.exceptions } : {}),
              ...(change.warnings !== undefined ? { warnings: change.warnings } : {}),
              ...(change.submissionId !== undefined ? { submissionId: change.submissionId } : {}),
              ...(change.confirmation !== undefined ? { confirmation: change.confirmation } : {})
            };
            if (change.status) {
              next.status = change.status;
              next.statusHistory.push({
                sequence: next.statusHistory.length + 1,
                status: change.status,
                at,
                reason: change.reason ?? null,
                exceptionCodes: [...new Set((change.exceptions ?? []).map((item) => item.code))]
              });
            }
            for (const attempt of change.attempts ?? []) next.attempts.push({ ...attempt, sequence: next.attempts.length + 1 });
            for (const correction of change.corrections ?? []) next.corrections.push({ ...correction, sequence: next.corrections.length + 1 });
            for (const approval of change.approvals ?? []) next.approvals.push({ ...approval, sequence: next.approvals.length + 1 });
            ctx.entry = await write(next);
            return ctx.entry;
          }
        };
        return task(ctx);
      });
    } catch (failure) {
      if (failure instanceof CoordinatorFailure) return error(recordingId, failure.code, failure.message);
      throw failure;
    }
    if (isLedgerError(result)) return error(recordingId, `LEDGER_${result.code}`, result.message);
    return result;
  }

  async function loadReview(recordingId: string): Promise<{ ok: true; session: StoredCombinedReviewSession } | { ok: false; exception: SubmissionException }> {
    const loaded = await options.reviewStore.loadCombined(recordingId);
    if (loaded.ok) return loaded;
    const kind: SubmissionException["kind"] =
      loaded.code === "LOCKED" || loaded.code === "STORAGE_ERROR" || loaded.code === "UPGRADE_REQUIRED" || loaded.code === "NOT_FOUND"
        ? "RECOVERABLE"
        : "INTEGRITY";
    return { ok: false, exception: { code: `REVIEW_${loaded.code}`, kind, field: null, message: redactResearchText(loaded.message) } };
  }

  async function loadPreparation(recordingId: string): Promise<{
    manifest: PreparedAudioManifest | null;
    exception: SubmissionException | null;
    errors: SubmissionException[];
  }> {
    if (!options.audioPreparationStore) return { manifest: null, exception: null, errors: [] };
    const loaded = await options.audioPreparationStore.load(recordingId);
    if (!loaded.ok) {
      const kind: SubmissionException["kind"] =
        loaded.code === "LOCKED" || loaded.code === "STORAGE_ERROR" ? "RECOVERABLE" : "INTEGRITY";
      return {
        manifest: null,
        exception: {
          code: `PREPARATION_${loaded.code}`,
          kind,
          field: null,
          message: redactResearchText(loaded.message)
        },
        errors: []
      };
    }
    const latest = loaded.manifests.at(-1) ?? null;
    if (!latest || latest.preparationStatus === "PREPARED" || latest.preparationStatus === "REUSED") {
      return { manifest: latest, exception: null, errors: [] };
    }
    const errors: SubmissionException[] = latest.issues.map((item) => ({
      code: item.code,
      kind: item.category === "INTEGRITY" ? "INTEGRITY" : item.category === "RECOVERABLE" ? "RECOVERABLE" : "SPONSOR_DECISION",
      field: item.field,
      message: redactResearchText(item.message ?? `Audio preparation stopped at ${item.stage}: ${item.code}.`)
    }));
    if (!errors.length) {
      errors.push({ code: "AUDIO_PREPARATION_FAILED", kind: "INTEGRITY", field: null,
        message: "The latest audio preparation did not produce a verified artifact." });
    }
    return { manifest: null, exception: null, errors };
  }

  /** Marks a submission left in SUBMITTING by an interrupted process as an unknown outcome. */
  async function recoverInterrupted(ctx: Context): Promise<void> {
    const entry = ctx.entry;
    if (!entry || entry.status !== "SUBMITTING") return;
    const started = [...entry.attempts].reverse().find((attempt) => attempt.status === "STARTED");
    const at = now().toISOString();
    await ctx.commit({
      status: "OUTCOME_UNKNOWN",
      reason: "INTERRUPTED_SUBMISSION",
      exceptions: [{ code: "RECONCILIATION_REQUIRED", kind: "RECOVERABLE", field: null,
        message: "A submission was interrupted after it may have been sent; reconcile before submitting again." }],
      attempts: started ? [{ ...started, status: "OUTCOME_UNKNOWN", finishedAt: at, errorCode: "INTERRUPTED", receipt: null }] : []
    });
    count("interruptedSubmissionsRecovered");
  }

  async function evaluateLocked(ctx: Context, local: CoordinatorTimings): Promise<{ report: ReadinessReport | null; entry: SubmissionLedgerEntry }> {
    if (!ctx.entry) throw new CoordinatorFailure("NOT_IMPORTED", "This recording has not been imported.");
    await recoverInterrupted(ctx);
    const status = ctx.entry.status;
    if (status === "SUBMITTED" || status === "OUTCOME_UNKNOWN") return { report: null, entry: ctx.entry };
    await ctx.commit({ status: "VALIDATING" });
    count("evaluations");
    return time("validation", local, async () => {
      const review = await loadReview(ctx.recordingId);
      if (!review.ok) {
        const entry = await ctx.commit({ status: "NEEDS_ATTENTION", reason: "REVIEW_UNAVAILABLE", exceptions: [review.exception], warnings: [] });
        return { report: null, entry };
      }
      const preparation = await loadPreparation(ctx.recordingId);
      const report = await assessSubmissionReadiness({
        state: review.session.state,
        reviewRevision: review.session.revision,
        approval: ctx.entry!.approvals.at(-1) ?? null,
        destinationId: destination.id,
        policy,
        namingProfile: options.namingProfile,
        preparedAudio: preparation.manifest,
        audioTagProfile: options.audioTagProfile,
        explicitTagValues: options.explicitAudioTagValues,
        clientContract: options.clientMetadataContract,
        preparationStoreError: preparation.exception,
        preparationErrors: preparation.errors
      });
      const known = ctx.entry!.corrections;
      const corrections = report.corrections
        .filter((item) => !known.some((existing) => existing.code === item.code && existing.resulting === item.resulting && existing.previous === item.previous))
        .map((item) => ({ ...item, at: now().toISOString() }));
      const ready = report.exceptions.length === 0 && report.prepared !== null;
      const entry = await ctx.commit({
        status: ready ? "READY" : "NEEDS_ATTENTION",
        exceptions: report.exceptions,
        warnings: report.warnings,
        submissionId: report.prepared?.submissionId ?? ctx.entry!.submissionId,
        corrections
      });
      return { report, entry };
    });
  }

  async function importLocked(
    record: DemoRecording,
    audio: readonly AudioExtractionResult[],
    sourceName: string | null,
    batchMatch?: AudioMatchResult
  ): Promise<ImportOutcome> {
    const local: CoordinatorTimings = {};
    const outcome = await locked<ImportOutcome>(record.recordingId, async (ctx) => {
      if (ctx.entry) {
        count("importsResumed");
        const review = await options.reviewStore.loadCombined(record.recordingId);
        return {
          ok: true, recordingId: record.recordingId, status: ctx.entry.status, resumed: true,
          reviewRevision: review.ok ? review.session.revision : 0, corrections: ctx.entry.corrections, timingsMs: local
        };
      }
      const importedAt = now().toISOString();
      const existing = await options.reviewStore.loadCombined(record.recordingId);
      if (existing.ok) {
        // A saved review exists (for example from an interrupted import): resume it, never re-run or overwrite it.
        const entry = await ctx.create(newEntry(record.recordingId, sourceName, importedAt, true, null, []));
        count("importsResumed");
        return { ok: true, recordingId: record.recordingId, status: entry.status, resumed: true, reviewRevision: existing.session.revision, corrections: [], timingsMs: local };
      }
      if (existing.code !== "NOT_FOUND") {
        throw new CoordinatorFailure(`REVIEW_${existing.code}`, existing.message);
      }

      let prepared = structuredClone(record);
      const corrections: Array<Omit<AutomaticCorrection, "sequence">> = [];
      const match = batchMatch ?? matchAudioToRecording(prepared, [...audio]);
      if (policy.autoApplyConflictFreeAudioMatch && match.status === "MATCHED" && !prepared.audioFilePath && !prepared.audioMatch) {
        const candidate = match.candidates.find((item) => item.filePath === match.selectedFilePath);
        if (candidate?.autoEligible && candidate.conflicts.length === 0) {
          prepared = applyAudioMatch(prepared, match);
          corrections.push({
            at: importedAt,
            code: "AUDIO_AUTO_MATCH_APPLIED",
            rule: `applyAudioMatch:conflict-free-${String(match.basis).toLowerCase()}`,
            field: "audioFilePath",
            previous: null,
            resulting: redactResearchText(candidate.fileName)
          });
          count("automaticCorrections");
        }
      } else if (
        !prepared.audioFilePath &&
        !prepared.audioMatch &&
        match.status === "AMBIGUOUS" &&
        match.reasons.some((reason) => reason.includes("same file automatically matched more than one Orchard recording"))
      ) {
        prepared = applyAudioMatch(prepared, match);
      }
      const workflow = await time("research", local, () => runRecordingWorkflow(prepared, [...audio], options.workflow));
      const usage = usageCounters(workflow.researchResults.usage);
      for (const [key, value] of Object.entries(usage ?? {})) researchUsage[key] = (researchUsage[key] ?? 0) + value;
      const state = startHumanGapReview(startHumanReview(workflow, [...audio]));
      const saved = await time("reviewPersistence", local, () =>
        options.reviewStore.saveCombined(state, { expectedRevision: 0, sessionId: "mb10-import" }));
      if (!saved.ok) throw new CoordinatorFailure(`REVIEW_${saved.code}`, saved.message);
      const entry = await ctx.create(newEntry(record.recordingId, sourceName, importedAt, false, usage, corrections));
      count("imports");
      return {
        ok: true, recordingId: record.recordingId, status: entry.status, resumed: false,
        reviewRevision: saved.session.revision, corrections: entry.corrections, timingsMs: local
      };
    });
    return outcome;
  }

  function newEntry(
    recordingId: string,
    sourceName: string | null,
    importedAt: string,
    resumedFromReview: boolean,
    usage: Record<string, number> | null,
    corrections: Array<Omit<AutomaticCorrection, "sequence">>
  ): Omit<SubmissionLedgerEntry, "revision" | "updatedAt"> {
    return {
      recordingId,
      destinationId: destination.id,
      status: "IMPORTED",
      submissionId: null,
      confirmation: null,
      source: { sourceName: sourceName ? redactResearchText(sourceName).slice(0, 200) : null, importedAt, resumedFromReview },
      usage,
      exceptions: [],
      warnings: [],
      statusHistory: [{ sequence: 1, status: "IMPORTED", at: importedAt, reason: resumedFromReview ? "RESUMED_FROM_SAVED_REVIEW" : null, exceptionCodes: [] }],
      approvals: [],
      corrections: corrections.map((item, index) => ({ ...item, sequence: index + 1 })),
      attempts: []
    };
  }

  type PageResult = { status: string; httpStatus: number | null; body: Record<string, unknown> | null };

  async function fillAndSubmitOnce(
    page: Page,
    prepared: PreparedSubmission,
    expected: ExpectedFormState,
    local: CoordinatorTimings,
    beforeSend: () => Promise<void>
  ): Promise<{ stage: "FILL"; message: string } | { stage: "PREFLIGHT"; failures: PreflightFailure[]; explanations: string[] } | { stage: "SENT"; result: PageResult }> {
    const guard = await installLoopbackNetworkGuard(page);
    try {
      await time("formFill", local, async () => {
        await page.goto(destination.formUrl);
        await prepareMediabaseForm(page, prepared.approvedRecord, { audioMatchResult: prepared.currentMatch });
        const upload = prepared.upload;
        if (upload && upload.uploadFileName !== upload.sourceFileName) {
          await page.locator("#audio-file").setInputFiles({
            name: upload.uploadFileName,
            mimeType: upload.mimeType,
            buffer: await fs.readFile(upload.path)
          });
        }
        await page.evaluate(({ submissionId, timeoutMs }) => {
          const hidden = document.querySelector<HTMLInputElement>('input[name="submissionId"]');
          const form = document.querySelector<HTMLFormElement>("#mediabase-form");
          if (!hidden || !form) throw new Error("Mock form is missing its submission fields.");
          hidden.value = submissionId;
          form.dataset.timeoutMs = String(timeoutMs);
        }, { submissionId: prepared.submissionId, timeoutMs: policy.responseTimeoutMs });
        await options.afterFormFilled?.(page);
      });
    } catch (failure) {
      return { stage: "FILL", message: failure instanceof Error ? failure.message.split("\n")[0] : String(failure) };
    }
    let preflight;
    try {
      preflight = await time("preflight", local, () => runFormPreflight(page, expected, { explainer: options.explainer }));
    } catch (failure) {
      return { stage: "FILL", message: `Preflight could not read the form: ${failure instanceof Error ? failure.message.split("\n")[0] : String(failure)}` };
    }
    if (!preflight.ok) return { stage: "PREFLIGHT", failures: preflight.failures, explanations: preflight.explanations };
    if (guard.blocked.length > 0) {
      return { stage: "PREFLIGHT", failures: [{ code: "UNEXPECTED_FIELD_VALUE", field: "network", expected: "loopback only", observed: "blocked request" }], explanations: [] };
    }

    await beforeSend();
    return time("network", local, async () => {
      await page.locator("#submit").click();
      try {
        await page.waitForFunction(() => {
          const status = document.querySelector("#submission-result")?.getAttribute("data-status");
          return !!status && status !== "idle" && status !== "pending";
        }, undefined, { timeout: policy.responseTimeoutMs + 5000 });
      } catch {
        return { stage: "SENT" as const, result: { status: "no-result", httpStatus: null, body: null } };
      }
      const raw = await page.locator("#submission-result").evaluate((element) => ({
        status: element.getAttribute("data-status") ?? "",
        httpStatus: element.getAttribute("data-http-status"),
        text: element.textContent ?? ""
      }));
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw.text) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
      return { stage: "SENT" as const, result: { status: raw.status, httpStatus: raw.httpStatus ? Number(raw.httpStatus) : null, body } };
    });
  }

  async function submitLocked(ctx: Context, openPage: () => Promise<Page>, local: CoordinatorTimings): Promise<SubmitOutcome> {
    const done = (extra: Partial<Extract<SubmitOutcome, { ok: true }>> = {}): SubmitOutcome => ({
      ok: true,
      recordingId: ctx.recordingId,
      status: ctx.entry!.status,
      submissionId: ctx.entry!.submissionId,
      confirmation: ctx.entry!.confirmation,
      alreadySubmitted: false,
      attempts: 0,
      exceptions: ctx.entry!.exceptions,
      preflightFailures: [],
      explanations: [],
      timingsMs: local,
      ...extra
    });

    const { report } = await evaluateLocked(ctx, local);
    if (ctx.entry!.status === "SUBMITTED") {
      count("duplicateSubmitsPrevented");
      return done({ alreadySubmitted: true });
    }
    if (ctx.entry!.status === "OUTCOME_UNKNOWN") return done();
    if (!report?.prepared || ctx.entry!.status !== "READY") return done();

    const prepared = report.prepared;
    const upload = prepared.upload;
    const expected = expectedFormState(
      prepared.approvedRecord,
      upload ? { fileName: upload.uploadFileName, size: upload.size, sha256: upload.sha256 } : null,
      prepared.submissionId
    );
    const expectation: SubmissionAttemptEvent["expected"] = upload
      ? { fileName: upload.uploadFileName, fileSize: upload.size, fileSha256: upload.sha256, fieldsDigest: formFieldsDigest(expected.text, expected.radios, prepared.submissionId) }
      : null;
    const summary = (preflightFailures: string[] = []) => ({
      exceptions: report.exceptions.length, warnings: report.warnings.length, preflightFailures
    });
    let networkAttempts = 0;

    for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber += 1) {
      const attemptId = `${prepared.submissionId}:${new Set(ctx.entry!.attempts.map((item) => item.attemptId)).size + 1}`;
      const startedAt = now().toISOString();
      const attempt = (status: AttemptStatus, extra: Partial<Omit<SubmissionAttemptEvent, "sequence">> = {}): Omit<SubmissionAttemptEvent, "sequence"> => ({
        attemptId,
        submissionId: prepared.submissionId,
        recordingId: ctx.recordingId,
        destinationId: destination.id,
        audioSha256: upload?.sha256 ?? null,
        status,
        startedAt,
        finishedAt: status === "STARTED" ? null : now().toISOString(),
        networkRequestSent: false,
        validationSummary: summary(),
        errorCode: null,
        expected: expectation,
        receipt: null,
        ...extra
      });
      await ctx.commit({ status: "FILLING_FORM" });
      const page = await openPage();
      let sent;
      try {
        sent = await fillAndSubmitOnce(page, prepared, expected, local, async () => {
          await ctx.commit({ status: "SUBMITTING", attempts: [attempt("STARTED", { networkRequestSent: true })] });
          networkAttempts += 1;
          count("networkAttempts");
        });
      } finally {
        await page.close().catch(() => undefined);
      }

      if (sent.stage === "FILL") {
        count("formFillFailures");
        await ctx.commit({
          status: "PREFLIGHT_FAILED",
          reason: "FORM_FILL_FAILED",
          exceptions: [{ code: "FORM_FILL_FAILED", kind: "RECOVERABLE", field: null, message: redactResearchText(sent.message) }],
          attempts: [attempt("PREFLIGHT_FAILED", { errorCode: "FORM_FILL_FAILED" })]
        });
        return done({ attempts: networkAttempts });
      }
      if (sent.stage === "PREFLIGHT") {
        count("preflightFailures");
        await ctx.commit({
          status: "PREFLIGHT_FAILED",
          reason: "PREFLIGHT_MISMATCH",
          exceptions: sent.failures.map((failure) => ({
            code: `PREFLIGHT_${failure.code}`, kind: "INTEGRITY" as const, field: failure.field,
            message: `Rendered form does not match the approved record (${failure.code}).`
          })),
          attempts: [attempt("PREFLIGHT_FAILED", { errorCode: "PREFLIGHT_MISMATCH", validationSummary: summary(sent.failures.map((item) => item.code)) })]
        });
        return done({ attempts: networkAttempts, preflightFailures: sent.failures, explanations: sent.explanations });
      }

      const { result } = sent;
      const body = result.body;
      const serverCode = typeof body?.code === "string" && SERVER_CODE.test(body.code) ? body.code : null;
      if (result.status === "responded" && result.httpStatus === 200 && body?.stored === true && body.submissionId === prepared.submissionId) {
        const lookup = await time("receiptVerification", local, () => destination.lookupReceipt(prepared.submissionId));
        const check = lookup.status === "FOUND" && expectation ? verifyReceipt(lookup.receipt, prepared.submissionId, expectation) : null;
        if (check?.verified) {
          count("submitted");
          await ctx.commit({
            status: "SUBMITTED",
            reason: body.duplicate === true ? "DESTINATION_ALREADY_HAD_SUBMISSION" : null,
            exceptions: [],
            confirmation: { confirmationId: check.confirmationId, receivedAt: check.receivedAt, attemptId },
            attempts: [attempt("SUBMITTED", { networkRequestSent: true, receipt: check })]
          });
          return done({ attempts: networkAttempts });
        }
        count("outcomeUnknown");
        await ctx.commit({
          status: "OUTCOME_UNKNOWN",
          reason: check ? "RECEIPT_MISMATCH" : "RECEIPT_UNVERIFIED",
          exceptions: [{
            code: check ? "RECEIPT_MISMATCH" : "RECEIPT_UNVERIFIED", kind: check ? "INTEGRITY" : "RECOVERABLE", field: null,
            message: check ? `Destination receipt differs from the approved submission (${check.mismatches.join(", ")}).` : "The destination confirmed receipt but the receipt could not be verified; reconcile."
          }],
          attempts: [attempt("OUTCOME_UNKNOWN", { networkRequestSent: true, errorCode: check ? "RECEIPT_MISMATCH" : "RECEIPT_UNVERIFIED", receipt: check })]
        });
        return done({ attempts: networkAttempts });
      }
      const explicitlyNotStored = result.status === "responded" && body?.stored === false;
      if (explicitlyNotStored && body?.retryable === true && (result.httpStatus === 503 || result.httpStatus === 429)) {
        count("retryableFailures");
        if (attemptNumber < policy.maxAttempts) {
          await ctx.commit({
            status: "READY",
            reason: "RETRY_SCHEDULED",
            attempts: [attempt("RETRYABLE_FAILURE", { networkRequestSent: true, errorCode: serverCode ?? `HTTP_${result.httpStatus}` })]
          });
          count("retries");
          await sleep(policy.retryDelaysMs[Math.min(attemptNumber - 1, policy.retryDelaysMs.length - 1)] ?? 0);
          continue;
        }
        await ctx.commit({
          status: "FAILED",
          reason: "TRANSPORT_RETRY_EXHAUSTED",
          exceptions: [{ code: "TRANSPORT_RETRY_EXHAUSTED", kind: "RECOVERABLE", field: null,
            message: `The destination was unavailable for ${policy.maxAttempts} attempts and stored nothing; submit again later.` }],
          attempts: [attempt("RETRYABLE_FAILURE", { networkRequestSent: true, errorCode: "TRANSPORT_RETRY_EXHAUSTED" })]
        });
        return done({ attempts: networkAttempts });
      }
      if (explicitlyNotStored) {
        count("rejected");
        const fields = Array.isArray(body?.fields) ? body.fields.filter((item): item is string => typeof item === "string" && SAFE_ID.test(item)) : [];
        await ctx.commit({
          status: "FAILED",
          reason: "DESTINATION_REJECTED",
          exceptions: [{ code: "DESTINATION_REJECTED", kind: "SPONSOR_DECISION", field: fields.join(",") || null,
            message: `The destination refused the submission (${serverCode ?? `HTTP_${result.httpStatus}`}); review the named fields before resubmitting.` }],
          attempts: [attempt("REJECTED", { networkRequestSent: true, errorCode: serverCode ?? `HTTP_${result.httpStatus}` })]
        });
        return done({ attempts: networkAttempts });
      }
      // Anything else may have reached the destination: never resend blindly.
      const code = result.status === "timeout" || result.status === "no-result"
        ? "RESPONSE_TIMEOUT"
        : result.status === "network-error" ? "CONNECTION_LOST" : `UNRECOGNIZED_RESPONSE_${result.httpStatus ?? "NONE"}`;
      count("outcomeUnknown");
      await ctx.commit({
        status: "OUTCOME_UNKNOWN",
        reason: code,
        exceptions: [{ code: "RECONCILIATION_REQUIRED", kind: "RECOVERABLE", field: null,
          message: "The destination may have received this submission; reconcile before submitting again." }],
        attempts: [attempt("OUTCOME_UNKNOWN", { networkRequestSent: true, errorCode: code })]
      });
      return done({ attempts: networkAttempts });
    }
    return done({ attempts: networkAttempts });
  }

  const coordinator: SubmissionCoordinator = {
    async importRecordings({ csv, sourceName, audioPaths }) {
      const local: CoordinatorTimings = {};
      const imported = importOrchardCsv(csv, sourceName);
      const audio = await time("audioExtraction", local, () => Promise.all(audioPaths.map((path) => extractAudioMetadata(path))));
      const matches = matchAudioToRecordings(imported.records, audio);
      const outcomes: ImportOutcome[] = [];
      for (const [index, record] of imported.records.entries()) {
        try {
          outcomes.push(await importLocked(record, audio, sourceName, matches[index]));
        } catch (failure) {
          outcomes.push(error(record.recordingId, "IMPORT_FAILED", failure instanceof Error ? failure.message : String(failure)));
        }
      }
      return outcomes;
    },

    importRecording(record, audio, sourceName = null) {
      return importLocked(record, audio, sourceName);
    },

    async approvalBasis(recordingId) {
      const review = await loadReview(recordingId);
      if (!review.ok) return error(recordingId, review.exception.code, review.exception.message);
      const preparation = await loadPreparation(recordingId);
      const report = await assessSubmissionReadiness({
        state: review.session.state, reviewRevision: review.session.revision, approval: null,
        destinationId: destination.id, policy, namingProfile: options.namingProfile,
        preparedAudio: preparation.manifest,
        audioTagProfile: options.audioTagProfile,
        explicitTagValues: options.explicitAudioTagValues,
        clientContract: options.clientMetadataContract,
        preparationStoreError: preparation.exception,
        preparationErrors: preparation.errors
      });
      return report.basis ? { ok: true, basis: report.basis } : error(recordingId, "BASIS_UNAVAILABLE", "No approval basis is available.");
    },

    async approve(decision) {
      const recordingId = typeof decision?.recordingId === "string" ? decision.recordingId : "";
      if (!recordingId || !SAFE_ID.test(String(decision.approvalId)) || !decision.approvedBy?.reviewerId?.trim() ||
        typeof decision.approvedAt !== "string" || !ISO_UTC.test(decision.approvedAt) || decision.basis?.recordingId !== recordingId) {
        return error(recordingId, "INVALID_APPROVAL", "Approval needs a recording, approval id, approver, ISO timestamp, and matching basis.");
      }
      const outcome = await locked<ApprovalOutcome>(recordingId, async (ctx) => {
        if (!ctx.entry) throw new CoordinatorFailure("NOT_IMPORTED", "This recording has not been imported.");
        await recoverInterrupted(ctx);
        if (ctx.entry.status === "SUBMITTED") throw new CoordinatorFailure("ALREADY_SUBMITTED", "This recording was already submitted.");
        if (ctx.entry.status === "OUTCOME_UNKNOWN") throw new CoordinatorFailure("RECONCILIATION_REQUIRED", "Reconcile the unknown outcome first.");
        if (ctx.entry.approvals.some((item) => item.approvalId === decision.approvalId)) {
          throw new CoordinatorFailure("DUPLICATE_APPROVAL", "This approval id was already recorded.");
        }
        const review = await loadReview(recordingId);
        if (!review.ok) throw new CoordinatorFailure(review.exception.code, review.exception.message);
        const preparation = await loadPreparation(recordingId);
        const provisional: FinalApprovalRecord = {
          sequence: ctx.entry.approvals.length + 1,
          approvalId: decision.approvalId,
          approvedBy: { reviewerId: redactResearchText(decision.approvedBy.reviewerId).slice(0, 200), displayName: decision.approvedBy.displayName ? redactResearchText(decision.approvedBy.displayName).slice(0, 200) : null },
          approvedAt: decision.approvedAt,
          recordedAt: now().toISOString(),
          reviewRevision: decision.basis.reviewRevision,
          contentFingerprint: decision.basis.contentFingerprint,
          confirmMissingIsrc: decision.confirmMissingIsrc === true,
          note: decision.note ? redactResearchText(decision.note).slice(0, 2000) : null
        };
        const report = await assessSubmissionReadiness({
          state: review.session.state, reviewRevision: review.session.revision, approval: provisional,
          destinationId: destination.id, policy, namingProfile: options.namingProfile,
          preparedAudio: preparation.manifest,
          audioTagProfile: options.audioTagProfile,
          explicitTagValues: options.explicitAudioTagValues,
          clientContract: options.clientMetadataContract,
          preparationStoreError: preparation.exception,
          preparationErrors: preparation.errors
        });
        if (report.exceptions.length > 0) {
          count("approvalsRefused");
          const stale = report.exceptions.some((item) => item.code === "APPROVAL_STALE");
          return {
            ...error(recordingId, stale ? "APPROVAL_STALE" : "APPROVAL_REFUSED",
              stale ? "The approval basis no longer matches the reviewed recording or audio." : "The recording has unresolved exceptions and cannot be approved."),
            exceptions: report.exceptions
          };
        }
        const { sequence: _sequence, ...approval } = provisional;
        const entry = await ctx.commit({ status: "READY", reason: "FINAL_APPROVAL_RECORDED", exceptions: [], warnings: report.warnings, approvals: [approval], submissionId: report.prepared?.submissionId ?? null });
        count("approvals");
        return { ok: true, recordingId, status: entry.status, approval: entry.approvals.at(-1)! };
      });
      return outcome;
    },

    async evaluate(recordingId) {
      const local: CoordinatorTimings = {};
      return locked<EvaluationOutcome>(recordingId, async (ctx) => {
        const { report, entry } = await evaluateLocked(ctx, local);
        return {
          ok: true, recordingId, status: entry.status, exceptions: entry.exceptions, warnings: entry.warnings,
          basis: report?.basis ?? null, submissionId: entry.submissionId, timingsMs: local
        };
      });
    },

    async submit(recordingId, { openPage }) {
      if (inFlight.has(recordingId)) {
        count("concurrentSubmitsRefused");
        return error(recordingId, "SUBMISSION_IN_PROGRESS", "A submission for this recording is already in progress.");
      }
      inFlight.add(recordingId);
      const local: CoordinatorTimings = {};
      try {
        return await locked<SubmitOutcome>(recordingId, (ctx) => submitLocked(ctx, openPage, local));
      } finally {
        inFlight.delete(recordingId);
      }
    },

    async processQueue(recordingIds, { openPage }) {
      const outcomes: SubmitOutcome[] = [];
      for (const recordingId of recordingIds) {
        try {
          outcomes.push(await coordinator.submit(recordingId, { openPage }));
        } catch (failure) {
          // One failed record never stops the rest of the queue.
          outcomes.push(error(recordingId, "UNEXPECTED_ERROR", failure instanceof Error ? failure.message : String(failure)));
        }
      }
      return outcomes;
    },

    async reconcile(recordingId) {
      return locked<ReconcileOutcome>(recordingId, async (ctx) => {
        if (!ctx.entry) throw new CoordinatorFailure("NOT_IMPORTED", "This recording has not been imported.");
        await recoverInterrupted(ctx);
        const entry = ctx.entry;
        const outcome = (result: Extract<ReconcileOutcome, { ok: true }>["result"]): ReconcileOutcome =>
          ({ ok: true, recordingId, status: ctx.entry!.status, result, confirmation: ctx.entry!.confirmation });
        if (entry.status !== "OUTCOME_UNKNOWN") return outcome("NOT_NEEDED");
        const started = [...entry.attempts].reverse().find((item) => item.status === "STARTED");
        if (!started) throw new CoordinatorFailure("NO_ATTEMPT", "No sent attempt is recorded for this recording.");
        count("reconciliations");
        const lookup = await destination.lookupReceipt(started.submissionId);
        const event = (status: AttemptStatus, extra: Partial<SubmissionAttemptEvent> = {}) =>
          ({ ...started, status, finishedAt: now().toISOString(), ...extra }) as Omit<SubmissionAttemptEvent, "sequence">;
        if (lookup.status === "UNAVAILABLE") return outcome("UNAVAILABLE");
        if (lookup.status === "NOT_FOUND") {
          await ctx.commit({
            status: "FAILED",
            reason: "RECONCILED_NOT_RECEIVED",
            exceptions: [{ code: "RECONCILED_NOT_RECEIVED", kind: "RECOVERABLE", field: null,
              message: "The destination has no record of the submission; it may be submitted again explicitly." }],
            attempts: [event("RECONCILED_NOT_FOUND")]
          });
          return outcome("NOT_FOUND");
        }
        const check = started.expected ? verifyReceipt(lookup.receipt, started.submissionId, started.expected) : null;
        if (check?.verified) {
          await ctx.commit({
            status: "SUBMITTED",
            reason: "RECONCILED_RECEIVED",
            exceptions: [],
            confirmation: { confirmationId: check.confirmationId, receivedAt: check.receivedAt, attemptId: started.attemptId },
            attempts: [event("RECONCILED_FOUND", { receipt: check })]
          });
          count("submitted");
          return outcome("FOUND");
        }
        await ctx.commit({
          status: "OUTCOME_UNKNOWN",
          reason: "RECEIPT_MISMATCH",
          exceptions: [{ code: "RECEIPT_MISMATCH", kind: "INTEGRITY", field: null,
            message: `The destination received a submission that differs from the approved one (${check?.mismatches.join(", ") ?? "unverifiable"}).` }],
          attempts: [event("RECONCILED_FOUND", { receipt: check, errorCode: "RECEIPT_MISMATCH" })]
        });
        return outcome("MISMATCH");
      });
    },

    async status(recordingId) {
      const loaded = await options.ledger.load(recordingId, destination.id);
      return loaded.ok ? { ok: true, entry: loaded.entry } : error(recordingId, `LEDGER_${loaded.code}`, loaded.message);
    },

    metrics() {
      return { counters: { ...counters }, timingsMs: { ...timings }, researchUsage: { ...researchUsage }, cost: null };
    }
  };
  return coordinator;
}
