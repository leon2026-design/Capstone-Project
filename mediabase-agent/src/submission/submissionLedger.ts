import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ReviewStorageLockedError, type ReviewStorageBackend } from "../storage/reviewStorageBackend";

/**
 * MB-10 submission ledger: per recording and destination, the current
 * submission status plus append-only histories of status changes, explicit
 * final approvals, automatic corrections, and submission attempts.
 *
 * It reuses the MB-08 storage backend interface (atomic replace, per-key
 * locks) but must use its own backend instance or directory: review sessions
 * and their schema-v1/v2 replay signatures are never touched. Documents carry a
 * SHA-256 checksum and, with an integrity key, an HMAC-SHA256 signature.
 */

export const SUBMISSION_LEDGER_FORMAT = "mediabase-agent.submission-ledger";
export const SUBMISSION_LEDGER_SCHEMA_VERSION = 1;

export const SUBMISSION_STATUSES = [
  "IMPORTED",
  "VALIDATING",
  "NEEDS_ATTENTION",
  "READY",
  "FILLING_FORM",
  "PREFLIGHT_FAILED",
  "SUBMITTING",
  "SUBMITTED",
  "FAILED",
  "OUTCOME_UNKNOWN"
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * SPONSOR_DECISION: a person must supply or decide something (metadata,
 * declarations, approval). RECOVERABLE: an operational problem that can be
 * fixed or retried without changing reviewed data. INTEGRITY: stored or
 * received data failed verification.
 */
export type ExceptionKind = "SPONSOR_DECISION" | "RECOVERABLE" | "INTEGRITY";

export type SubmissionException = {
  code: string;
  kind: ExceptionKind;
  field: string | null;
  /** Sanitized: no contact details or local paths. */
  message: string;
};

export type StatusChange = {
  sequence: number;
  status: SubmissionStatus;
  at: string;
  reason: string | null;
  exceptionCodes: string[];
};

export type FinalApprovalRecord = {
  sequence: number;
  approvalId: string;
  approvedBy: { reviewerId: string; displayName: string | null };
  approvedAt: string;
  recordedAt: string;
  reviewRevision: number;
  contentFingerprint: string;
  confirmMissingIsrc: boolean;
  note: string | null;
};

export type AutomaticCorrection = {
  sequence: number;
  at: string;
  code: "AUDIO_AUTO_MATCH_APPLIED" | "UPLOAD_FILENAME_APPLIED";
  /** The explicitly permitted deterministic rule that justified the correction. */
  rule: string;
  field: string;
  previous: string | null;
  resulting: string | null;
};

export type ReceiptCheck = {
  confirmationId: string;
  receivedAt: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  fileCount: number;
  verified: boolean;
  mismatches: string[];
};

export type AttemptStatus =
  | "STARTED"
  | "PREFLIGHT_FAILED"
  | "SUBMITTED"
  | "REJECTED"
  | "RETRYABLE_FAILURE"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "RECONCILED_FOUND"
  | "RECONCILED_NOT_FOUND";

/** One append-only event per attempt step; a network attempt has a STARTED event followed by its outcome. */
export type SubmissionAttemptEvent = {
  sequence: number;
  attemptId: string;
  submissionId: string;
  recordingId: string;
  destinationId: string;
  audioSha256: string | null;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  networkRequestSent: boolean;
  validationSummary: { exceptions: number; warnings: number; preflightFailures: string[] };
  errorCode: string | null;
  /** What the destination must have received; contact values are covered by a digest only. */
  expected: { fileName: string; fileSize: number; fileSha256: string; fieldsDigest: string } | null;
  receipt: ReceiptCheck | null;
};

export type UsageCounters = Record<string, number>;

export type SubmissionLedgerEntry = {
  recordingId: string;
  destinationId: string;
  revision: number;
  updatedAt: string;
  status: SubmissionStatus;
  submissionId: string | null;
  confirmation: { confirmationId: string; receivedAt: string; attemptId: string } | null;
  source: { sourceName: string | null; importedAt: string; resumedFromReview: boolean };
  usage: UsageCounters | null;
  exceptions: SubmissionException[];
  warnings: SubmissionException[];
  statusHistory: StatusChange[];
  approvals: FinalApprovalRecord[];
  corrections: AutomaticCorrection[];
  attempts: SubmissionAttemptEvent[];
};

type LedgerDocument = {
  format: typeof SUBMISSION_LEDGER_FORMAT;
  schemaVersion: typeof SUBMISSION_LEDGER_SCHEMA_VERSION;
  contentDigest: string;
  signature: string | null;
  entry: SubmissionLedgerEntry;
};

export type LedgerErrorCode =
  | "NOT_FOUND"
  | "CORRUPTED_DATA"
  | "INCOMPATIBLE_VERSION"
  | "INTEGRITY_CHECK_FAILED"
  | "REVISION_CONFLICT"
  | "HISTORY_REWRITE"
  | "INVALID_STATE"
  | "LOCKED"
  | "STORAGE_ERROR";

export type LedgerError = { ok: false; code: LedgerErrorCode; message: string };
export type LedgerLoadResult = { ok: true; entry: SubmissionLedgerEntry } | LedgerError;
export type LedgerWriteResult = { ok: true; entry: SubmissionLedgerEntry } | LedgerError;

export type LedgerTransaction = {
  /** The entry as loaded under the lock (null when none exists), or the error that prevented loading it. */
  readonly loaded: LedgerLoadResult;
  /** Writes the next revision; append-only histories must extend the previous ones exactly. */
  write(next: Omit<SubmissionLedgerEntry, "revision" | "updatedAt">): Promise<LedgerWriteResult>;
};

export interface SubmissionLedger {
  load(recordingId: string, destinationId: string): Promise<LedgerLoadResult>;
  /** Runs `task` while holding the per-recording lock; every write happens inside a transaction. */
  transact<T>(recordingId: string, destinationId: string, task: (tx: LedgerTransaction) => Promise<T>): Promise<T | LedgerError>;
  keys(): Promise<string[]>;
}

export type SubmissionLedgerOptions = {
  integrityKey?: string;
  now?: () => Date;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function submissionLedgerKey(recordingId: string, destinationId: string): string {
  return `submission-${sha256Hex(`${recordingId}\u0000${destinationId}`).slice(0, 40)}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HISTORY_KEYS = ["statusHistory", "approvals", "corrections", "attempts"] as const;

function sequenced(value: unknown): value is Array<{ sequence: number }> {
  return Array.isArray(value) && value.every((item, index) => isObject(item) && item.sequence === index + 1);
}

function validEntry(value: unknown): value is SubmissionLedgerEntry {
  if (!isObject(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.recordingId === "string" &&
    typeof entry.destinationId === "string" &&
    Number.isInteger(entry.revision) && (entry.revision as number) >= 1 &&
    typeof entry.updatedAt === "string" && ISO_UTC.test(entry.updatedAt) &&
    SUBMISSION_STATUSES.includes(entry.status as SubmissionStatus) &&
    (entry.submissionId === null || typeof entry.submissionId === "string") &&
    (entry.confirmation === null || isObject(entry.confirmation)) &&
    isObject(entry.source) &&
    Array.isArray(entry.exceptions) && Array.isArray(entry.warnings) &&
    HISTORY_KEYS.every((key) => sequenced(entry[key])) &&
    (entry.statusHistory as StatusChange[]).length > 0 &&
    (entry.statusHistory as StatusChange[]).every((change) => SUBMISSION_STATUSES.includes(change.status)) &&
    (entry.statusHistory as StatusChange[]).at(-1)?.status === entry.status;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && "code" in error ? String(error.code) : undefined;
}

export function createSubmissionLedger(backend: ReviewStorageBackend, options: SubmissionLedgerOptions = {}): SubmissionLedger {
  const now = options.now ?? (() => new Date());
  const key = options.integrityKey;

  const digestOf = (entry: SubmissionLedgerEntry) => `SHA256-${sha256Hex(canonicalJson(entry))}`;
  const signatureOf = (digest: string, entry: SubmissionLedgerEntry) =>
    key
      ? `HMAC-SHA256-${createHmac("sha256", key).update(canonicalJson({
        format: SUBMISSION_LEDGER_FORMAT,
        schemaVersion: SUBMISSION_LEDGER_SCHEMA_VERSION,
        recordingId: entry.recordingId,
        destinationId: entry.destinationId,
        revision: entry.revision,
        contentDigest: digest
      })).digest("hex")}`
      : null;

  function decode(text: string, recordingId: string, destinationId: string): LedgerLoadResult {
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return { ok: false, code: "CORRUPTED_DATA", message: "Stored submission ledger is not valid JSON." };
    }
    if (!isObject(document) || document.format !== SUBMISSION_LEDGER_FORMAT) {
      return { ok: false, code: "CORRUPTED_DATA", message: "Stored document is not a submission ledger." };
    }
    if (document.schemaVersion !== SUBMISSION_LEDGER_SCHEMA_VERSION) {
      return { ok: false, code: "INCOMPATIBLE_VERSION", message: "Submission ledger schema version is not supported." };
    }
    const entry = document.entry;
    if (!validEntry(entry)) {
      return { ok: false, code: "CORRUPTED_DATA", message: "Submission ledger entry is malformed." };
    }
    if (document.contentDigest !== digestOf(entry)) {
      return { ok: false, code: "CORRUPTED_DATA", message: "Submission ledger checksum does not match its contents." };
    }
    if (key) {
      const expected = signatureOf(document.contentDigest, entry) ?? "";
      const actual = typeof document.signature === "string" ? document.signature : "";
      if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
        return { ok: false, code: "INTEGRITY_CHECK_FAILED", message: "Submission ledger signature is missing or invalid." };
      }
    }
    if (entry.recordingId !== recordingId || entry.destinationId !== destinationId) {
      return { ok: false, code: "CORRUPTED_DATA", message: "Submission ledger belongs to a different recording or destination." };
    }
    return { ok: true, entry: structuredClone(entry) };
  }

  async function read(recordingId: string, destinationId: string): Promise<LedgerLoadResult> {
    let text: string | null;
    try {
      text = await backend.read(submissionLedgerKey(recordingId, destinationId));
    } catch {
      return { ok: false, code: "STORAGE_ERROR", message: "Submission ledger could not be read." };
    }
    if (text === null) return { ok: false, code: "NOT_FOUND", message: "No submission ledger entry exists for this recording." };
    return decode(text, recordingId, destinationId);
  }

  return {
    load: read,
    async transact(recordingId, destinationId, task) {
      const storageKey = submissionLedgerKey(recordingId, destinationId);
      try {
        return await backend.withLock(storageKey, async () => {
          const loaded = await read(recordingId, destinationId);
          let current: SubmissionLedgerEntry | null = loaded.ok ? loaded.entry : null;
          const tx: LedgerTransaction = {
            loaded,
            async write(next) {
              if (!current && !loaded.ok && loaded.code !== "NOT_FOUND") {
                return { ok: false, code: loaded.code, message: "Refusing to overwrite an unreadable submission ledger." };
              }
              if (next.recordingId !== recordingId || next.destinationId !== destinationId) {
                return { ok: false, code: "INVALID_STATE", message: "Ledger entry does not match its recording or destination." };
              }
              const entry: SubmissionLedgerEntry = structuredClone({
                ...next,
                revision: (current?.revision ?? 0) + 1,
                updatedAt: now().toISOString()
              }) as SubmissionLedgerEntry;
              if (!validEntry(entry)) {
                return { ok: false, code: "INVALID_STATE", message: "Ledger entry is malformed." };
              }
              if (current) {
                for (const history of HISTORY_KEYS) {
                  const before = current[history] as unknown[];
                  const after = entry[history] as unknown[];
                  if (after.length < before.length ||
                    canonicalJson(after.slice(0, before.length)) !== canonicalJson(before)) {
                    return { ok: false, code: "HISTORY_REWRITE", message: `Ledger ${history} is append-only.` };
                  }
                }
              }
              const contentDigest = digestOf(entry);
              const document: LedgerDocument = {
                format: SUBMISSION_LEDGER_FORMAT,
                schemaVersion: SUBMISSION_LEDGER_SCHEMA_VERSION,
                contentDigest,
                signature: signatureOf(contentDigest, entry),
                entry
              };
              try {
                await backend.replace(storageKey, `${JSON.stringify(document, null, 2)}\n`);
              } catch {
                return { ok: false, code: "STORAGE_ERROR", message: "Submission ledger could not be written; the previous revision is intact." };
              }
              current = entry;
              return { ok: true, entry: structuredClone(entry) };
            }
          };
          return task(tx);
        });
      } catch (error) {
        if (error instanceof ReviewStorageLockedError || errorCode(error) === "EEXIST") {
          return { ok: false, code: "LOCKED", message: "Another process is working on this recording's submission." } as LedgerError;
        }
        throw error;
      }
    },
    keys: () => backend.keys()
  };
}
