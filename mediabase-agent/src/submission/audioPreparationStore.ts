import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ReviewStorageLockedError, type ReviewStorageBackend } from "../storage/reviewStorageBackend";
import type { ClientMetadataResolution } from "./clientMetadataContract";
import { canonicalJson } from "./submissionLedger";

export const AUDIO_PREPARATION_SCHEMA_VERSION = 1;
export const AUDIO_PREPARATION_FORMAT = "mediabase-agent.audio-preparation";

export type PreparationStatus =
  | "PREPARED"
  | "REUSED"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_TAG_WRITE"
  | "MISSING_SPONSOR_DATA"
  | "FAILED_VERIFICATION"
  | "RECOVERABLE_FAILURE"
  | "FAILED";

export type PreparationIssue = {
  code: string;
  recordingId: string;
  stage: string;
  field: string | null;
  category: "SPONSOR_DECISION" | "RECOVERABLE" | "INTEGRITY" | "UNSUPPORTED";
  recoveryAttempted: boolean;
  recoveryAction: string | null;
  recoverySucceeded: boolean | null;
  humanInterventionRequired: boolean;
  message?: string;
  evidenceReferences?: string[];
  recommendedAction?: string;
};

export type PreparedAudioManifest = {
  recordingId: string;
  eventId: string;
  preparationId: string;
  sourceSha256: string | null;
  preparedSha256: string | null;
  sourceFileName: string | null;
  artifactFileName: string | null;
  /** Private local path required for resume; public summaries must omit it. */
  artifactPath: string | null;
  sourceFormat: "MP3" | "WAV" | null;
  preparedFormat: "MP3" | "WAV" | null;
  tagProfileId: string;
  tagProfileVersion: string;
  namingProfileId: string;
  namingProfileVersion: string;
  /** Private evidence record; summaries must not print its raw catalog values. */
  clientMetadata?: ClientMetadataResolution;
  tagProfileDigest?: string;
  uploadFileName: string | null;
  tagVerificationStatus: "MATCH" | "FAILED" | "NOT_RUN";
  audioIntegrityVerified: boolean;
  preparationStatus: PreparationStatus;
  corrections: Array<{ code: string; field: string; rule: string }>;
  issues: PreparationIssue[];
  createdAt: string;
};

export type PreparationStoreErrorCode =
  | "NOT_FOUND"
  | "CORRUPTED_DATA"
  | "INTEGRITY_CHECK_FAILED"
  | "HISTORY_REWRITE"
  | "UPLOAD_FILENAME_COLLISION"
  | "LOCKED"
  | "STORAGE_ERROR";

export type PreparationStoreResult =
  | { ok: true; manifests: PreparedAudioManifest[]; revision: number }
  | { ok: false; code: PreparationStoreErrorCode; message: string };

type PreparationDocument = {
  format: typeof AUDIO_PREPARATION_FORMAT;
  schemaVersion: typeof AUDIO_PREPARATION_SCHEMA_VERSION;
  revision: number;
  contentDigest: string;
  signature: string | null;
  manifests: PreparedAudioManifest[];
};

export interface AudioPreparationStore {
  load(recordingId: string): Promise<PreparationStoreResult>;
  append(manifest: PreparedAudioManifest): Promise<PreparationStoreResult>;
  withLock<T>(recordingId: string, task: () => Promise<T>): Promise<T>;
}

export type AudioPreparationStoreOptions = { integrityKey?: string };

function documentKey(recordingId: string): string {
  return `audio-prep-${createHash("sha256").update(recordingId).digest("hex").slice(0, 40)}`;
}

function lockKey(recordingId: string): string {
  return `audio-prep-run-${createHash("sha256").update(recordingId).digest("hex").slice(0, 36)}`;
}

function unsigned(document: PreparationDocument): Omit<PreparationDocument, "contentDigest" | "signature"> {
  const { contentDigest: _digest, signature: _signature, ...body } = document;
  return body;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function signature(value: unknown, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function isManifest(value: unknown): value is PreparedAudioManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.recordingId === "string" &&
    typeof item.eventId === "string" &&
    typeof item.preparationId === "string" &&
    typeof item.tagProfileId === "string" &&
    typeof item.tagProfileVersion === "string" &&
    typeof item.namingProfileId === "string" &&
    typeof item.namingProfileVersion === "string" &&
    typeof item.tagVerificationStatus === "string" &&
    typeof item.audioIntegrityVerified === "boolean" &&
    typeof item.preparationStatus === "string" &&
    Array.isArray(item.corrections) && Array.isArray(item.issues) &&
    typeof item.createdAt === "string";
}

function validDocument(value: unknown): value is PreparationDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  return document.format === AUDIO_PREPARATION_FORMAT &&
    document.schemaVersion === AUDIO_PREPARATION_SCHEMA_VERSION &&
    Number.isInteger(document.revision) && (document.revision as number) >= 1 &&
    typeof document.contentDigest === "string" &&
    (document.signature === null || typeof document.signature === "string") &&
    Array.isArray(document.manifests) && document.manifests.every(isManifest);
}

function verify(document: PreparationDocument, key?: string): boolean {
  if (digest(unsigned(document)) !== document.contentDigest) return false;
  if (key) {
    if (!document.signature) return false;
    const expected = Buffer.from(signature(unsigned(document), key), "hex");
    const actual = Buffer.from(document.signature, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  return document.signature === null;
}

function error(code: PreparationStoreErrorCode, message: string): PreparationStoreResult {
  return { ok: false, code, message };
}

export function createAudioPreparationStore(
  backend: ReviewStorageBackend,
  options: AudioPreparationStoreOptions = {}
): AudioPreparationStore {
  const key = options.integrityKey;
  const read = async (recordingId: string): Promise<PreparationStoreResult> => {
    let raw: string | null;
    try {
      raw = await backend.read(documentKey(recordingId));
    } catch {
      return error("STORAGE_ERROR", "Could not read the preparation manifest.");
    }
    if (raw === null) return { ok: true, manifests: [], revision: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return error("CORRUPTED_DATA", "Preparation manifest is not valid JSON.");
    }
    if (!validDocument(parsed)) return error("CORRUPTED_DATA", "Preparation manifest is incompatible or malformed.");
    if (!verify(parsed, key)) return error("INTEGRITY_CHECK_FAILED", "Preparation manifest integrity verification failed.");
    if (parsed.manifests.some((item) => item.recordingId !== recordingId) ||
      new Set(parsed.manifests.map((item) => item.eventId)).size !== parsed.manifests.length) {
      return error("CORRUPTED_DATA", "Preparation manifest contains mismatched or duplicate identifiers.");
    }
    return { ok: true, manifests: structuredClone(parsed.manifests), revision: parsed.revision };
  };
  const findNameConflict = async (manifest: PreparedAudioManifest): Promise<PreparationStoreResult | null> => {
    if (!manifest.uploadFileName) return error("CORRUPTED_DATA", "A prepared manifest must include its upload filename.");
    const wanted = manifest.uploadFileName.normalize("NFKC").toUpperCase();
    for (const storageKey of await backend.keys()) {
      if (!storageKey.startsWith("audio-prep-") || storageKey === documentKey(manifest.recordingId)) continue;
      const raw = await backend.read(storageKey);
      if (raw === null) continue;
      let document: unknown;
      try {
        document = JSON.parse(raw);
      } catch {
        return error("CORRUPTED_DATA", "A preparation manifest used for collision checking is invalid.");
      }
      if (!validDocument(document) || !verify(document, key)) {
        return error("INTEGRITY_CHECK_FAILED", "A preparation manifest used for collision checking is unverified.");
      }
      if (document.manifests.some((item) => documentKey(item.recordingId) !== storageKey)) {
        return error("CORRUPTED_DATA", "A preparation manifest has a mismatched recording identifier.");
      }
      if (document.manifests.some((item) =>
        (item.preparationStatus === "PREPARED" || item.preparationStatus === "REUSED") &&
        item.uploadFileName?.normalize("NFKC").toUpperCase() === wanted)) {
        return error("UPLOAD_FILENAME_COLLISION", "Another recording already uses this upload filename; review the collision.");
      }
    }
    return null;
  };
  return {
    load: read,
    async withLock(recordingId, task) {
      return backend.withLock(lockKey(recordingId), task);
    },
    async append(manifest) {
      try {
        const appendDocument = (): Promise<PreparationStoreResult> => backend.withLock(documentKey(manifest.recordingId), async () => {
          const current = await read(manifest.recordingId);
          if (!current.ok) return current;
          if (current.manifests.some((item) => item.eventId === manifest.eventId)) {
            return error("HISTORY_REWRITE", "Preparation event IDs must be unique; this event was already recorded.");
          }
          const body: Omit<PreparationDocument, "contentDigest" | "signature"> = {
            format: AUDIO_PREPARATION_FORMAT,
            schemaVersion: AUDIO_PREPARATION_SCHEMA_VERSION,
            revision: current.revision + 1,
            manifests: [...current.manifests, structuredClone(manifest)]
          };
          const document: PreparationDocument = {
            ...body,
            contentDigest: digest(body),
            signature: key ? signature(body, key) : null
          };
          await backend.replace(documentKey(manifest.recordingId), JSON.stringify(document));
          return { ok: true, manifests: document.manifests, revision: document.revision };
        });
        if (manifest.preparationStatus !== "PREPARED" && manifest.preparationStatus !== "REUSED") {
          return await appendDocument();
        }
        return await backend.withLock("audio-prep-upload-names", async () => {
          const collision = await findNameConflict(manifest);
          return collision ?? await appendDocument();
        });
      } catch (failure) {
        if (failure instanceof ReviewStorageLockedError) return error("LOCKED", "Another preparation is writing this recording.");
        return error("STORAGE_ERROR", "Could not persist the preparation manifest.");
      }
    }
  };
}
