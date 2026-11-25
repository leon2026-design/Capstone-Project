import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { MPEGDecoder } from "mpg123-decoder";
import { extractAudioMetadata, normalizeIsrcValue, type AudioFormat, type AudioMetadata } from "../audio/audioMetadata";
import { getArtistAttributionProblem, isValidDate, type DemoRecording } from "../metadata/recordValidation";
import { ReviewStorageLockedError } from "../storage/reviewStorageBackend";
import {
  findNamingCollisions,
  SPONSOR_TITLE_NAMING_PROFILE,
  type NamingInput,
  type UploadNamingProfile
} from "./namingProfile";
import {
  resolveClientMetadata,
  type ClientMetadataContract
} from "./clientMetadataContract";
import {
  DEFAULT_MP3_TAG_PROFILE,
  resolveAudioTagValues,
  unsupportedTagFields,
  type AudioTagField,
  type AudioTagProfile,
  type ExplicitTagValues
} from "./audioTagProfile";
import { AudioTagFormatError, readId3Values, readId3v1Values, updateId3Values } from "./audioId3";
import { inspectWave, updateWaveTags, verifyWaveTags, waveAudioUnchanged, waveTagAgrees } from "./wavAudio";
import {
  createAudioPreparationStore,
  type AudioPreparationStore,
  type PreparationIssue,
  type PreparationStatus,
  type PreparedAudioManifest
} from "./audioPreparationStore";
import { canonicalJson, sha256Hex } from "./submissionLedger";

export type AudioPreparationTimings = Record<string, number>;

export type AcknowledgedTagConflict = {
  fields: readonly AudioTagField[];
  reviewerId: string;
  note: string;
};

export type PrepareAudioArtifactInput = {
  recording: Readonly<DemoRecording>;
  sourceAudioPath: string;
  tagProfile?: AudioTagProfile;
  namingProfile?: UploadNamingProfile;
  clientContract?: ClientMetadataContract;
  outputDirectory: string;
  explicitValues?: ExplicitTagValues;
  acknowledgedSourceConflicts?: AcknowledgedTagConflict;
  manifestStore?: AudioPreparationStore;
  now?: () => Date;
};

export type PreparedAudioArtifact = {
  path: string;
  fileName: string;
  format: AudioFormat;
  size: number;
  sha256: string;
  uploadFileName: string;
  metadata: AudioMetadata;
};

export type AudioPreparationFailure = {
  code: string;
  recordingId: string;
  stage: string;
  field: string | null;
  category: PreparationIssue["category"];
  recoveryAttempted: boolean;
  recoveryAction: string | null;
  recoverySucceeded: boolean | null;
  humanInterventionRequired: boolean;
  message?: string;
  evidenceReferences?: string[];
  recommendedAction?: string;
};

export type AudioPreparationResult =
  | {
    ok: true;
    artifact: PreparedAudioArtifact;
    manifest: PreparedAudioManifest;
    reused: boolean;
    warnings: string[];
    timingsMs: AudioPreparationTimings;
  }
  | {
    ok: false;
    recordingId: string;
    manifest: PreparedAudioManifest;
    failures: AudioPreparationFailure[];
    timingsMs: AudioPreparationTimings;
  };

const MIME_EXTENSION: Record<AudioFormat, string> = { MP3: ".mp3", WAV: ".wav" };
const ID3_SUPPORTED = new Set<AudioTagField>([
  "title", "artist", "album", "isrc", "version", "genre", "year", "albumArtist", "comments"
]);
const IDENTITY_TAGS = new Set<AudioTagField>(["artist", "title", "isrc"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const TEMP_FILE_PATTERN = /^\.mb11-[a-f0-9]{24}\.tmp$/;

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "recording";
}

function issue(
  recordingId: string,
  code: string,
  stage: string,
  field: string | null,
  category: PreparationIssue["category"],
  recoveryAttempted = false,
  recoveryAction: string | null = null,
  recoverySucceeded: boolean | null = null,
  humanInterventionRequired = category === "SPONSOR_DECISION" || category === "UNSUPPORTED" || category === "INTEGRITY"
): AudioPreparationFailure {
  const messages: Record<string, string> = {
    CONFLICTING_ISRC: "The selected audio contains an invalid or conflicting ISRC.",
    SOURCE_TAG_CONFLICT: "Embedded metadata disagrees with the reviewed value or another tag representation.",
    UNTRUSTED_SOURCE_TAG: "An embedded value has no approved reviewed source.",
    UNSUPPORTED_TAG_MAPPING: "The existing or required metadata cannot be represented safely.",
    UPLOAD_FILENAME_COLLISION: "Multiple recordings would use the same upload filename."
  };
  const actions: Record<PreparationIssue["category"], string> = {
    SPONSOR_DECISION: "Review the affected evidence with an authorized reviewer before preparing again.",
    UNSUPPORTED: "Confirm the format and tag mapping, or use an authorized supported source.",
    INTEGRITY: "Investigate the integrity failure and prepare again from a verified unchanged source.",
    RECOVERABLE: "Resolve the reported storage or workflow condition before retrying."
  };
  const evidenceReferences = stage.startsWith("SOURCE")
    ? ["selected-audio", ...(stage === "SOURCE_TAG_CHECK" ? ["reviewed-record"] : [])]
    : stage === "METADATA_RESOLUTION" || stage === "NAMING_PREFLIGHT" ? ["reviewed-record"]
      : stage === "AUDIO_INTEGRITY" || stage === "TAG_VERIFICATION" ? ["selected-audio", "prepared-artifact"]
        : stage === "LOCK" || stage === "MANIFEST_PERSIST" ? ["preparation-manifest-store"] : [];
  return {
    recordingId, code, stage, field, category, recoveryAttempted, recoveryAction, recoverySucceeded,
    humanInterventionRequired,
    message: messages[code] ?? `Audio preparation reported ${code.replace(/_/g, " ").toLowerCase()} during ${stage.replace(/_/g, " ").toLowerCase()}.`,
    evidenceReferences,
    recommendedAction: actions[category]
  };
}

function issueForManifest(failure: AudioPreparationFailure): PreparationIssue {
  return { ...failure };
}

function id3v2End(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.toString("latin1", 0, 3) !== "ID3") return 0;
  const sizeBytes = bytes.subarray(6, 10);
  if ([...sizeBytes].some((byte) => (byte & 0x80) !== 0)) throw new Error("Malformed ID3 size.");
  const bodySize = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  const footerSize = bytes[3] === 4 && (bytes[5] & 0x10) !== 0 ? 10 : 0;
  const end = 10 + bodySize + footerSize;
  if (end > bytes.length) throw new Error("Truncated ID3 tag.");
  return end;
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000]
};

function mpegLayer3FrameLength(bytes: Buffer, offset: number): number | null {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const bitrate = (version === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version]?.[sampleIndex];
  if (!bitrate || !sampleRate) return null;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return offset + length <= bytes.length ? length : null;
}

/** Removes ID3 wrappers and compares the complete, parsed MPEG Layer III frame stream. */
export function extractMpegAudioPayload(bytes: Buffer): Buffer {
  const start = id3v2End(bytes);
  let end = bytes.length;
  if (end >= 128 && bytes.toString("latin1", end - 128, end - 125) === "TAG") end -= 128;
  const frames: Buffer[] = [];
  let offset = start;
  while (offset < end) {
    const length = mpegLayer3FrameLength(bytes.subarray(0, end), offset);
    if (length === null) throw new Error("MP3 contains an invalid or unsupported frame sequence.");
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (frames.length === 0) throw new Error("MP3 contains no MPEG Layer III audio frames.");
  return Buffer.concat(frames);
}

export async function decodeMpegAudio(bytes: Buffer): Promise<{
  samplesDecoded: number;
  sampleRate: number;
  channels: number;
}> {
  const decoder = new MPEGDecoder({ enableGapless: true });
  try {
    await decoder.ready;
    const decoded = decoder.decode(bytes);
    if (decoded.errors.length > 0 || decoded.samplesDecoded <= 0 ||
      decoded.channelData.length === 0 || !decoded.sampleRate) {
      throw new Error("MP3 decoder reported invalid or undecodable audio.");
    }
    return {
      samplesDecoded: decoded.samplesDecoded,
      sampleRate: decoded.sampleRate,
      channels: decoded.channelData.length
    };
  } finally {
    decoder.free();
  }
}

function sourceTagMatches(field: AudioTagField, expected: string, metadata: AudioMetadata): boolean {
  if (field === "isrc") {
    return metadata.rawIsrcs.length > 0 &&
      metadata.rawIsrcs.every((item) => normalizeIsrcValue(item) === normalizeIsrcValue(expected));
  }
  const actual: string | null | undefined = field === "contentRating" ? null : metadata[field];
  if (field === "year") return actual === expected || metadata.date?.slice(0, 4) === expected;
  return typeof actual === "string" && actual.normalize("NFKC").trim().toLowerCase() === expected.normalize("NFKC").trim().toLowerCase();
}

function createManifest(
  input: PrepareAudioArtifactInput,
  recordingId: string,
  preparationId: string,
  sourceFileName: string | null,
  status: PreparationStatus,
  createdAt: string,
  options: Partial<PreparedAudioManifest> = {}
): PreparedAudioManifest {
  const tags = input.tagProfile ?? DEFAULT_MP3_TAG_PROFILE;
  const naming = input.namingProfile ?? SPONSOR_TITLE_NAMING_PROFILE;
  return {
    recordingId,
    eventId: `PREP-EVENT-${randomBytes(12).toString("hex").toUpperCase()}`,
    preparationId,
    sourceSha256: null,
    preparedSha256: null,
    sourceFileName,
    artifactFileName: null,
    artifactPath: null,
    sourceFormat: null,
    preparedFormat: null,
    tagProfileId: tags.id,
    tagProfileVersion: tags.version,
    namingProfileId: naming.id,
    namingProfileVersion: naming.version ?? "1",
    tagProfileDigest: sha256Hex(canonicalJson(tags)),
    uploadFileName: null,
    tagVerificationStatus: "NOT_RUN",
    audioIntegrityVerified: false,
    preparationStatus: status,
    corrections: [],
    issues: [],
    createdAt,
    ...options
  };
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishWithoutOverwrite(tempPath: string, targetPath: string): Promise<void> {
  await fs.link(tempPath, targetPath);
  await fs.unlink(tempPath);
}

async function removeStaleTemporaryArtifacts(directory: string): Promise<void> {
  const now = Date.now();
  for (const entry of await fs.readdir(directory)) {
    if (!TEMP_FILE_PATTERN.test(entry)) continue;
    const path = join(directory, entry);
    const info = await fs.lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
      await fs.unlink(path);
    }
  }
}

function collisionSafeTarget(outputDirectory: string, recordingId: string, preparationId: string, format: AudioFormat): string {
  return join(outputDirectory, `${safeId(recordingId)}-${preparationId.slice(0, 16)}${MIME_EXTENSION[format]}`);
}

async function persistManifest(store: AudioPreparationStore | undefined, manifest: PreparedAudioManifest): Promise<void> {
  if (!store) return;
  const result = await store.append(manifest);
  if (!result.ok) {
    throw new Error(`PREPARATION_MANIFEST_${result.code}`);
  }
}

async function validateExistingArtifact(
  path: string,
  expectedHash: string,
  sourceBytes: Buffer,
  format: AudioFormat,
  record: Readonly<DemoRecording>,
  profile: AudioTagProfile,
  explicitValues: ExplicitTagValues
): Promise<{ artifact: PreparedAudioArtifact; metadata: AudioMetadata } | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch {
    return null;
  }
  if (hash(bytes) !== expectedHash) return null;
  const extracted = await extractAudioMetadata(path);
  if (extracted.status !== "OK" || extracted.metadata.format !== format) return null;
  if (format === "MP3" && !extractMpegAudioPayload(bytes).equals(extractMpegAudioPayload(sourceBytes))) return null;
  if (format === "WAV" && !waveAudioUnchanged(sourceBytes, bytes)) return null;
  const values = resolveAudioTagValues(record, profile, explicitValues);
  if (format === "WAV" && !await verifyWaveTags(bytes, values.values)) return null;
  for (const [field, expected] of Object.entries(values.values) as Array<[AudioTagField, string]>) {
    if (!sourceTagMatches(field, expected, extracted.metadata)) return null;
  }
  return {
    artifact: {
      path,
      fileName: extracted.fileName,
      format,
      size: bytes.length,
      sha256: expectedHash,
      uploadFileName: extracted.fileName,
      metadata: extracted.metadata
    },
    metadata: extracted.metadata
  };
}

async function prepareUnlocked(input: PrepareAudioArtifactInput, batchCollision = false): Promise<AudioPreparationResult> {
  const started = performance.now();
  const timingsMs: AudioPreparationTimings = {};
  const time = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    try {
      return await action();
    } finally {
      timingsMs[name] = Math.round(performance.now() - at);
    }
  };
  const recordingId = input.recording.recordingId;
  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const profile = input.tagProfile ?? DEFAULT_MP3_TAG_PROFILE;
  const namingProfile = input.namingProfile ?? SPONSOR_TITLE_NAMING_PROFILE;
  const clientContract = input.clientContract;
  const sourcePath = resolve(input.sourceAudioPath);
  const recordingIdentity = hash(Buffer.from(recordingId));
  let preparationId = `PREP-${recordingIdentity.slice(0, 12).toUpperCase()}`;
  let sourceName: string | null = null;
  let manifest = createManifest(input, recordingId, preparationId, sourceName, "FAILED", createdAt);
  const failures: AudioPreparationFailure[] = [];
  const warnings: string[] = [];
  const warningIssues: PreparationIssue[] = [];
  let tempPath: string | null = null;
  let newlyPublishedPath: string | null = null;

  const fail = async (
    code: string,
    stage: string,
    field: string | null,
    category: PreparationIssue["category"],
    status: PreparationStatus,
    recoveryAttempted = false,
    recoveryAction: string | null = null,
    recoverySucceeded: boolean | null = null
  ): Promise<AudioPreparationResult> => {
    failures.push(issue(recordingId, code, stage, field, category, recoveryAttempted, recoveryAction, recoverySucceeded));
    manifest = {
      ...manifest,
      preparationStatus: status,
      issues: failures.map(issueForManifest),
      createdAt: now().toISOString()
    };
    await persistManifest(input.manifestStore, manifest);
    return { ok: false, recordingId, manifest, failures, timingsMs };
  };

  try {
    if (batchCollision) {
      return await fail("UPLOAD_FILENAME_COLLISION", "NAMING_PREFLIGHT", "uploadFileName", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }

    const sourceInfo = await time("sourceValidation", async () => {
      const linkInfo = await fs.lstat(sourcePath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("SOURCE_NOT_REGULAR_FILE");
      const fileHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const info = await fileHandle.stat();
        const bytes = await fileHandle.readFile();
        return { info, bytes };
      } finally {
        await fileHandle.close();
      }
    }).catch(async (failure: unknown) => {
      const code = failure instanceof Error && failure.message === "SOURCE_NOT_REGULAR_FILE"
        ? "UNSAFE_SOURCE_PATH"
        : "SOURCE_UNAVAILABLE";
      return await fail(code, "SOURCE_VALIDATION", null, "RECOVERABLE", "RECOVERABLE_FAILURE");
    });
    if ("ok" in sourceInfo) return sourceInfo;
    sourceName = input.sourceAudioPath.split(/[\\/]/).at(-1) ?? null;
    const sourceBytes = sourceInfo.bytes;
    const sourceSha256 = hash(sourceBytes);
    const before = sourceInfo.info;
    const sourceUnchanged = async (): Promise<boolean> => {
      const current = await fs.lstat(sourcePath);
      return !current.isSymbolicLink() && current.isFile() && current.size === before.size &&
        current.mtimeMs === before.mtimeMs && hash(await fs.readFile(sourcePath)) === sourceSha256;
    };
    if (["RF64", "RIFX", "BW64"].includes(sourceBytes.toString("latin1", 0, 4))) {
      return await fail("UNSUPPORTED_WAV_VARIANT", "SOURCE_VALIDATION", null, "UNSUPPORTED", "UNSUPPORTED_FORMAT");
    }
    const extraction = await extractAudioMetadata(sourcePath);
    if (extraction.status !== "OK") {
      return await fail("INVALID_OR_UNSUPPORTED_AUDIO", "SOURCE_VALIDATION", null, "UNSUPPORTED", "UNSUPPORTED_FORMAT");
    }
    manifest = {
      ...manifest,
      sourceSha256,
      sourceFormat: extraction.metadata.format,
      sourceFileName: extraction.fileName
    };
    if (!extraction.metadata.extensionMatchesFormat) {
      return await fail("EXTENSION_MISMATCH", "SOURCE_VALIDATION", null, "INTEGRITY", "FAILED");
    }
    if (!await sourceUnchanged()) {
      return await fail("SOURCE_CHANGED_DURING_PREPARATION", "SOURCE_VALIDATION", null, "INTEGRITY", "FAILED_VERIFICATION");
    }
    const format = extraction.metadata.format;
    const sourceWave = format === "WAV" ? inspectWave(sourceBytes) : null;
    const sourceId3 = format === "MP3" ? readId3Values(sourceBytes) : null;
    const sourceId3v1 = format === "MP3" ? await readId3v1Values(sourceBytes) : null;

    const artistProblem = getArtistAttributionProblem(input.recording as DemoRecording);
    if (artistProblem && profile.mappings.includes("artist")) {
      return await fail("ARTIST_ATTRIBUTION_UNCONFIRMED", "METADATA_RESOLUTION", "artist", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    if (input.recording.isrcValidation?.status === "invalid") {
      return await fail("INVALID_ISRC", "METADATA_RESOLUTION", "isrc", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    if (input.recording.isrc && normalizeIsrcValue(input.recording.isrc) !== input.recording.isrc) {
      return await fail("INVALID_ISRC", "METADATA_RESOLUTION", "isrc", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    if (input.recording.officialReleaseDate && !isValidDate(input.recording.officialReleaseDate)) {
      return await fail("INVALID_RELEASE_DATE", "METADATA_RESOLUTION", "officialReleaseDate", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }

    const clientMetadata = resolveClientMetadata(input.recording, extraction.metadata.format, profile, {
      contract: clientContract,
      explicitValues: input.explicitValues,
      sourceMetadata: extraction.metadata,
      recordedAt: createdAt
    });
    manifest = { ...manifest, clientMetadata };
    if ((clientContract?.namingProfileId ?? "sponsor-title") !== namingProfile.id) {
      return await fail("CONTRACT_NAMING_MISMATCH", "NAMING_PREFLIGHT", "uploadFileName", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    if (clientMetadata.problems.length > 0) {
      failures.push(...clientMetadata.problems.map((problem) => ({
        ...issue(recordingId, problem.code, "METADATA_RESOLUTION", problem.field,
          problem.code === "UNSUPPORTED_TAG_MAPPING" ? "UNSUPPORTED" : "SPONSOR_DECISION"),
        message: problem.message,
        evidenceReferences: problem.evidenceReferences,
        recommendedAction: problem.recommendedAction
      })));
      manifest = {
        ...manifest,
        preparationStatus: "MISSING_SPONSOR_DATA",
        issues: failures.map(issueForManifest),
        createdAt: now().toISOString()
      };
      await persistManifest(input.manifestStore, manifest);
      return { ok: false, recordingId, manifest, failures, timingsMs };
    }
    if (namingProfile.id === SPONSOR_TITLE_NAMING_PROFILE.id && !input.manifestStore) {
      return await fail("UPLOAD_COLLISION_CHECK_REQUIRED", "NAMING_PREFLIGHT", "uploadFileName", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }

    const resolved = resolveAudioTagValues(input.recording, profile, input.explicitValues);
    if (resolved.missingRequired.length > 0) {
      return await fail("REQUIRED_TAG_VALUE_MISSING", "METADATA_RESOLUTION", resolved.missingRequired.join(","), "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    const unsupported = unsupportedTagFields(profile);
    const requiredUnsupported = unsupported.filter((field) => profile.requiredFields.includes(field));
    if (requiredUnsupported.length > 0) {
      return await fail("UNSUPPORTED_TAG_MAPPING", "TAG_WRITE", requiredUnsupported.join(","), "UNSUPPORTED", "UNSUPPORTED_TAG_WRITE");
    }

    const sourcePayload = format === "MP3"
      ? await time("audioIntegrityCheck", async () => extractMpegAudioPayload(sourceBytes))
      : null;
    let sourceDecode: Awaited<ReturnType<typeof decodeMpegAudio>> | null = null;
    if (sourcePayload) {
      try {
        sourceDecode = await time("sourceDecoding", async () => decodeMpegAudio(sourcePayload));
      } catch {
        return await fail("AUDIO_DECODE_FAILED", "SOURCE_DECODING", null, "INTEGRITY", "FAILED_VERIFICATION");
      }
    }
    const sourceMetadata = extraction.metadata;
    const conflicts: AudioTagField[] = [];
    if (sourceWave) {
      for (const [field, infoValues] of Object.entries(sourceWave.infoValues) as Array<[AudioTagField, string[]]>) {
        const values = [sourceWave.id3[field], ...infoValues].filter((value): value is string => !!value);
        if (values.some((value) => !waveTagAgrees(field, value, values[0]))) {
          if (!profile.mappings.includes(field) || !resolved.values[field]) {
            return await fail("SOURCE_TAG_CONFLICT", "SOURCE_TAG_CHECK", field, "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
          }
          conflicts.push(field);
        }
      }
    }
    for (const field of profile.mappings) {
      const expected = resolved.values[field];
      if (!ID3_SUPPORTED.has(field)) continue;
      const legacyValue = sourceId3v1?.[field];
      if (legacyValue && (!expected || !waveTagAgrees(field, legacyValue, expected))) {
        return await fail("UNSUPPORTED_TAG_MAPPING", "SOURCE_TAG_CHECK", field, "UNSUPPORTED", "UNSUPPORTED_TAG_WRITE");
      }
      const embedded = field === "contentRating" ? null : sourceMetadata[field];
      const representations = sourceWave
        ? [sourceWave.id3[field], ...(sourceWave.infoValues[field] ?? [])].filter((value): value is string => !!value)
        : [sourceId3?.[field], typeof embedded === "string" ? embedded : undefined]
          .filter((value): value is string => !!value);
      const isrcs = field === "isrc" ? [...sourceMetadata.rawIsrcs, ...representations] : [];
      const normalizedIsrcs = new Set(isrcs.map(normalizeIsrcValue));
      const invalidIsrc = field === "isrc" && (
        isrcs.some((item) => normalizeIsrcValue(item) === null) ||
        normalizedIsrcs.size > 1
      );
      if (field === "isrc" && (invalidIsrc ||
        (expected && isrcs.some((value) => normalizeIsrcValue(value) !== normalizeIsrcValue(expected))) ||
        (!expected && isrcs.length > 0))) {
        return await fail("CONFLICTING_ISRC", "SOURCE_TAG_CHECK", "isrc", "SPONSOR_DECISION", "FAILED");
      }
      if (!expected && representations.length > 0) {
        return await fail("UNTRUSTED_SOURCE_TAG", "SOURCE_TAG_CHECK", field, "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
      }
      if (expected && representations.some((value) => !waveTagAgrees(field, value, expected)) && !conflicts.includes(field)) {
        conflicts.push(field);
      }
    }
    const unresolvedConflicts = conflicts.filter((field) => {
      if (IDENTITY_TAGS.has(field) && field === "isrc") return true;
      const accepted = input.acknowledgedSourceConflicts;
      return !accepted || !accepted.fields.includes(field) || !accepted.reviewerId.trim() || !accepted.note.trim();
    });
    if (unresolvedConflicts.length > 0) {
      return await fail("SOURCE_TAG_CONFLICT", "SOURCE_TAG_CHECK", unresolvedConflicts.join(","), "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    const corrections = Object.keys(resolved.values)
      .filter((field) => conflicts.includes(field as AudioTagField) || !(sourceMetadata[field as keyof AudioMetadata]))
      .map((field) => ({
        code: conflicts.includes(field as AudioTagField) ? "ACKNOWLEDGED_TAG_CORRECTED" : "MISSING_TAG_WRITTEN",
        field,
        rule: conflicts.includes(field as AudioTagField)
          ? `explicit-human-acknowledgment:${input.acknowledgedSourceConflicts?.reviewerId ?? "unknown"}`
          : `trusted-tag-source:${resolved.provenance[field as AudioTagField] ?? "approved-configuration"}`
      }));

    preparationId = `PREP-${hash(Buffer.from([
      recordingId,
      sourceSha256,
      profile.id,
      profile.version,
      sha256Hex(canonicalJson(profile)),
      clientMetadata.contractDigest,
      clientMetadata.metadataDigest,
      namingProfile.id,
      namingProfile.version ?? "1",
      resolve(input.outputDirectory),
      JSON.stringify(resolved.values)
    ].join("\u0000"))).slice(0, 32).toUpperCase()}`;
    manifest = {
      ...manifest,
      preparationId,
      sourceSha256,
      sourceFormat: format,
      sourceFileName: extraction.fileName
    };
    const finalPath = collisionSafeTarget(resolve(input.outputDirectory), recordingId, preparationId.slice(5), format);
    const taggedBytes = await time("tagWriting", async () => format === "MP3"
      ? updateId3Values(sourceBytes, resolved.values)
      : updateWaveTags(sourceBytes, resolved.values));
    const expectedPreparedHash = hash(taggedBytes);
    const namingInput = { fileName: extraction.fileName, format, record: input.recording };
    const naming = namingProfile.check(namingInput);
    const uploadFileName = naming.suggestedName ?? (naming.ok ? extraction.fileName : null);
    if (!uploadFileName || !namingProfile.check({ ...namingInput, fileName: uploadFileName }).ok) {
      return await fail("FILENAME_POLICY_VIOLATION", "NAMING_PREFLIGHT", "uploadFileName", "SPONSOR_DECISION", "MISSING_SPONSOR_DATA");
    }
    warnings.push(...clientMetadata.warnings.map((item) => `${item.code}:${item.field}`));
    warningIssues.push(...clientMetadata.warnings.map((item) => ({
      ...issue(recordingId, item.code, "METADATA_RESOLUTION", item.field, "SPONSOR_DECISION", false, null, null, false),
      message: item.message, evidenceReferences: item.evidenceReferences, recommendedAction: item.recommendedAction
    })));
    const unsupportedOptional = unsupported.filter((field) => !profile.requiredFields.includes(field));
    if (unsupportedOptional.length > 0) {
      warnings.push(`OPTIONAL_TAG_UNSUPPORTED:${unsupportedOptional.join(",")}`);
      for (const field of unsupportedOptional) {
        warningIssues.push({
          ...issue(recordingId, "OPTIONAL_TAG_UNSUPPORTED", "METADATA_RESOLUTION", field, "UNSUPPORTED", false, null, null, false),
          message: "An optional field has no supported embedded tag mapping.",
          evidenceReferences: [`tag-profile:${profile.id}@${profile.version}`],
          recommendedAction: "Confirm the mapping before making the field mandatory."
        });
      }
    }
    if (resolved.unresolvedSponsorMappings.length > 0) {
      warnings.push(`UNRESOLVED_SPONSOR_MAPPING:${resolved.unresolvedSponsorMappings.join(",")}`);
      for (const mapping of resolved.unresolvedSponsorMappings) {
        warningIssues.push({
          ...issue(recordingId, "UNRESOLVED_SPONSOR_MAPPING", "METADATA_RESOLUTION", mapping, "SPONSOR_DECISION", false, null, null, false),
          message: "A sponsor mapping remains unconfirmed and was not invented.",
          evidenceReferences: [`tag-profile:${profile.id}@${profile.version}`],
          recommendedAction: "Obtain sponsor confirmation before relying on this mapping."
        });
      }
    }

    await fs.mkdir(resolve(input.outputDirectory), { recursive: true, mode: 0o700 });
    const directoryInfo = await fs.lstat(resolve(input.outputDirectory));
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      return await fail("UNSAFE_OUTPUT_DIRECTORY", "PATH_VALIDATION", null, "INTEGRITY", "FAILED");
    }
    const realRoot = await fs.realpath(resolve(input.outputDirectory));
    await removeStaleTemporaryArtifacts(realRoot);
    const relativeTarget = relative(realRoot, finalPath);
    if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === ".." || resolve(finalPath) === realRoot) {
      return await fail("OUTPUT_PATH_ESCAPE", "PATH_VALIDATION", null, "INTEGRITY", "FAILED");
    }
    const existing = await validateExistingArtifact(
      finalPath,
      expectedPreparedHash,
      sourceBytes,
      format,
      input.recording,
      profile,
      input.explicitValues ?? {}
    );
    if (existing) {
      if (!await sourceUnchanged()) {
        return await fail("SOURCE_CHANGED_DURING_PREPARATION", "SOURCE_VALIDATION", null, "INTEGRITY", "FAILED_VERIFICATION");
      }
      manifest = {
        ...manifest, artifactFileName: existing.artifact.fileName, artifactPath: finalPath,
        preparedSha256: existing.artifact.sha256, preparedFormat: format,
        tagVerificationStatus: "MATCH", audioIntegrityVerified: true, preparationStatus: "REUSED",
        uploadFileName, corrections, issues: warningIssues
      };
      await persistManifest(input.manifestStore, manifest);
      return { ok: true, artifact: { ...existing.artifact, uploadFileName }, manifest, reused: true, warnings, timingsMs };
    }
    try {
      await fs.lstat(finalPath);
      return await fail("OUTPUT_COLLISION", "PUBLISH", null, "RECOVERABLE", "RECOVERABLE_FAILURE");
    } catch (failure) {
      if (typeof failure === "object" && failure !== null && "code" in failure && failure.code !== "ENOENT") throw failure;
    }

    const tempName = `.mb11-${randomBytes(12).toString("hex")}.tmp`;
    tempPath = join(realRoot, tempName);
    await writeExclusive(tempPath, taggedBytes);
    const tempInfo = await fs.stat(tempPath);
    if (!tempInfo.isFile()) return await fail("TEMP_OUTPUT_INVALID", "TAG_WRITE", null, "INTEGRITY", "FAILED");
    const tempBytes = await fs.readFile(tempPath);
    if (hash(tempBytes) !== expectedPreparedHash) {
      return await fail("PREPARED_ARTIFACT_UNVERIFIED", "TAG_WRITE", null, "INTEGRITY", "FAILED_VERIFICATION");
    }

    const readback = await time("readBackVerification", async () => extractAudioMetadata(tempPath!));
    if (readback.status !== "OK" || readback.metadata.format !== format) {
      return await fail("READBACK_FAILED", "TAG_VERIFICATION", null, "INTEGRITY", "FAILED_VERIFICATION", true, "independent-readback", false);
    }
    if (format === "MP3" && sourcePayload && sourceDecode) {
      const preparedPayload = await time("audioIntegrityCheck", async () => extractMpegAudioPayload(tempBytes));
      if (!sourcePayload.equals(preparedPayload)) {
        return await fail("AUDIO_PAYLOAD_CHANGED", "AUDIO_INTEGRITY", null, "INTEGRITY", "FAILED_VERIFICATION", true, "compare-mpeg-frame-payload", false);
      }
      let preparedDecode: Awaited<ReturnType<typeof decodeMpegAudio>>;
      try {
        preparedDecode = await time("preparedDecoding", async () => decodeMpegAudio(preparedPayload));
      } catch {
        return await fail("PREPARED_AUDIO_DECODE_FAILED", "PREPARED_DECODING", null, "INTEGRITY", "FAILED_VERIFICATION");
      }
      if (sourceDecode.samplesDecoded !== preparedDecode.samplesDecoded ||
        sourceDecode.sampleRate !== preparedDecode.sampleRate ||
        sourceDecode.channels !== preparedDecode.channels) {
        return await fail("AUDIO_DECODE_PROPERTIES_CHANGED", "AUDIO_INTEGRITY", null, "INTEGRITY", "FAILED_VERIFICATION", true, "compare-decoded-audio-properties", false);
      }
    } else if (format === "WAV") {
      if (!waveAudioUnchanged(sourceBytes, tempBytes)) {
        return await fail("AUDIO_PAYLOAD_CHANGED", "AUDIO_INTEGRITY", null, "INTEGRITY", "FAILED_VERIFICATION", true, "compare-pcm-and-riff-chunks", false);
      }
      if (!await verifyWaveTags(tempBytes, resolved.values)) {
        return await fail("WAV_TAG_READBACK_MISMATCH", "TAG_VERIFICATION", null, "INTEGRITY", "FAILED_VERIFICATION", true, "independent-id3-and-info-readback", false);
      }
    }
    const technicalMismatch =
      Math.abs((sourceMetadata.durationSeconds ?? 0) - (readback.metadata.durationSeconds ?? 0)) > 0.02 ||
      sourceMetadata.sampleRate !== readback.metadata.sampleRate ||
      sourceMetadata.channels !== readback.metadata.channels ||
      format === "WAV" && sourceMetadata.bitDepth !== readback.metadata.bitDepth;
    if (technicalMismatch) {
      return await fail("AUDIO_TECHNICAL_PROPERTIES_CHANGED", "AUDIO_INTEGRITY", null, "INTEGRITY", "FAILED_VERIFICATION", true, "compare-technical-properties", false);
    }
    for (const field of profile.requiredFields) {
      if (!ID3_SUPPORTED.has(field)) continue;
      const expected = resolved.values[field];
      if (!expected || !sourceTagMatches(field, expected, readback.metadata)) {
        return await fail("TAG_READBACK_MISMATCH", "TAG_VERIFICATION", field, "INTEGRITY", "FAILED_VERIFICATION", true, "independent-readback", false);
      }
    }
    for (const field of profile.mappings) {
      if (!ID3_SUPPORTED.has(field)) continue;
      const expected = resolved.values[field];
      if (expected && !sourceTagMatches(field, expected, readback.metadata)) {
        return await fail("TAG_READBACK_MISMATCH", "TAG_VERIFICATION", field, "INTEGRITY", "FAILED_VERIFICATION", true, "independent-readback", false);
      }
    }
    if (!await sourceUnchanged()) {
      return await fail("SOURCE_CHANGED_DURING_PREPARATION", "SOURCE_VALIDATION", null, "INTEGRITY", "FAILED_VERIFICATION");
    }

    try {
      await publishWithoutOverwrite(tempPath, finalPath);
      tempPath = null;
      newlyPublishedPath = finalPath;
    } catch (failure) {
      const code = typeof failure === "object" && failure !== null && "code" in failure
        ? String(failure.code)
        : "";
      if (code === "EEXIST") return await fail("OUTPUT_COLLISION", "PUBLISH", null, "RECOVERABLE", "RECOVERABLE_FAILURE");
      throw failure;
    }
    const preparedBytes = await fs.readFile(finalPath);
    const preparedSha256 = hash(preparedBytes);
    if (preparedSha256 !== expectedPreparedHash) {
      await fs.unlink(finalPath);
      newlyPublishedPath = null;
      return await fail("PREPARED_ARTIFACT_UNVERIFIED", "PUBLISH", null, "INTEGRITY", "FAILED_VERIFICATION");
    }
    const artifact: PreparedAudioArtifact = {
      path: finalPath,
      fileName: basename(finalPath),
      format,
      size: preparedBytes.length,
      sha256: preparedSha256,
      uploadFileName,
      metadata: { ...readback.metadata, filePath: finalPath, fileName: basename(finalPath), extensionMatchesFormat: true }
    };
    const manifestStatus: PreparationStatus = "PREPARED";
    manifest = {
      ...manifest,
      artifactPath: finalPath,
      artifactFileName: artifact.fileName,
      preparedSha256,
      preparedFormat: format,
      uploadFileName,
      tagVerificationStatus: "MATCH",
      audioIntegrityVerified: true,
      preparationStatus: manifestStatus,
      corrections,
      issues: warningIssues
    };
    await persistManifest(input.manifestStore, manifest);
    newlyPublishedPath = null;
    return { ok: true, artifact, manifest, reused: false, warnings, timingsMs };
  } catch (failure) {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    if (newlyPublishedPath) {
      try {
        await fs.unlink(newlyPublishedPath);
      } catch {
        failures.push(issue(recordingId, "ARTIFACT_CLEANUP_FAILED", "PUBLISH", null, "INTEGRITY"));
      }
    }
    const systemCode = typeof failure === "object" && failure !== null && "code" in failure
      ? String(failure.code)
      : null;
    const manifestFailure = failure instanceof Error && failure.message.startsWith("PREPARATION_MANIFEST_");
    const collision = failure instanceof Error && failure.message === "PREPARATION_MANIFEST_UPLOAD_FILENAME_COLLISION";
    const recoverable = manifestFailure || ["ENOSPC", "EACCES", "EPERM", "EIO", "EMFILE", "EBUSY"].includes(systemCode ?? "");
    const code = failure instanceof AudioTagFormatError ? failure.code : collision ? "UPLOAD_FILENAME_COLLISION" : manifestFailure
      ? failure instanceof Error ? failure.message : "PREPARATION_MANIFEST_STORAGE_ERROR"
      : systemCode ? `FILESYSTEM_${systemCode}` : "PREPARATION_FAILED";
    const preparationFailure = issue(recordingId, code, "PREPARATION",
      failure instanceof AudioTagFormatError ? failure.field : collision ? "uploadFileName" : null,
      collision ? "SPONSOR_DECISION" : recoverable ? "RECOVERABLE" : "INTEGRITY",
      false, null, null, collision || !recoverable);
    if (failure instanceof AudioTagFormatError) {
      preparationFailure.message = failure.message;
      preparationFailure.recommendedAction = "Review the source format and conflicting or unsupported tag representation.";
    }
    failures.push(preparationFailure);
    manifest = {
      ...manifest,
      preparationStatus: "FAILED",
      artifactPath: null,
      artifactFileName: null,
      preparedSha256: null,
      preparedFormat: null,
      uploadFileName: null,
      tagVerificationStatus: "NOT_RUN",
      audioIntegrityVerified: false,
      issues: failures.map(issueForManifest),
      createdAt: now().toISOString()
    };
    if (!manifestFailure || collision) {
      try {
        await persistManifest(input.manifestStore, manifest);
      } catch (manifestError) {
        const manifestCode = manifestError instanceof Error && manifestError.message.startsWith("PREPARATION_MANIFEST_")
          ? manifestError.message
          : "PREPARATION_MANIFEST_STORAGE_ERROR";
        failures.push(issue(recordingId, manifestCode, "MANIFEST_PERSIST", null, "INTEGRITY"));
        manifest = { ...manifest, issues: failures.map(issueForManifest) };
      }
    }
    return { ok: false, recordingId, manifest, failures, timingsMs };
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    timingsMs.total = Math.round(performance.now() - started);
  }
}

async function prepareAudioArtifactWithCollision(
  input: PrepareAudioArtifactInput,
  batchCollision: boolean
): Promise<AudioPreparationResult> {
  if (input.manifestStore) {
    let workStarted = false;
    try {
      return await input.manifestStore.withLock(
        input.recording.recordingId,
        () => {
          workStarted = true;
          return prepareUnlocked(input, batchCollision);
        }
      );
    } catch (failure) {
      const recordingId = input.recording.recordingId;
      const createdAt = (input.now ?? (() => new Date()))().toISOString();
      const code = workStarted ? "PREPARATION_LOCK_OR_TASK_FAILED"
        : failure instanceof ReviewStorageLockedError ? "PREPARATION_LOCKED" : "PREPARATION_LOCK_FAILED";
      const category = workStarted ? "INTEGRITY" : "RECOVERABLE";
      const lockIssue = issue(recordingId, code, "LOCK", null, category, false, null, null, workStarted);
      let manifest = createManifest(input, recordingId, `PREP-${hash(Buffer.from(recordingId)).slice(0, 32).toUpperCase()}`,
        basename(input.sourceAudioPath), workStarted ? "FAILED" : "RECOVERABLE_FAILURE", createdAt, {
          issues: [lockIssue]
        });
      const failures = [lockIssue];
      if (workStarted) {
        try {
          await persistManifest(input.manifestStore, manifest);
        } catch (manifestError) {
          const manifestCode = manifestError instanceof Error && manifestError.message.startsWith("PREPARATION_MANIFEST_")
            ? manifestError.message
            : "PREPARATION_MANIFEST_STORAGE_ERROR";
          failures.push(issue(recordingId, manifestCode, "MANIFEST_PERSIST", null, "INTEGRITY"));
          manifest = { ...manifest, issues: failures.map(issueForManifest) };
        }
      }
      return {
        ok: false,
        recordingId,
        manifest,
        failures,
        timingsMs: {}
      };
    }
  }
  return prepareUnlocked(input, batchCollision);
}

export async function prepareAudioArtifact(input: PrepareAudioArtifactInput): Promise<AudioPreparationResult> {
  return prepareAudioArtifactWithCollision(input, false);
}

/** Preflights destination-name collisions, then prepares each record independently. */
export async function prepareAudioArtifactsBatch(
  inputs: readonly PrepareAudioArtifactInput[]
): Promise<AudioPreparationResult[]> {
  const grouped = new Map<string, { profile: UploadNamingProfile; items: NamingInput[] }>();
  const collisionIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();

  const extracted = await Promise.all(inputs.map((input) => extractAudioMetadata(input.sourceAudioPath)));
  inputs.forEach((input, index) => {
    const recordingId = input.recording.recordingId;
    if (seenIds.has(recordingId)) duplicateIds.add(recordingId);
    seenIds.add(recordingId);
    const extraction = extracted[index];
    if (extraction.status !== "OK") return;
    const format = extraction.metadata.format;
    const profile = input.namingProfile ?? SPONSOR_TITLE_NAMING_PROFILE;
    const key = `${profile.id}\u0000${profile.version ?? "1"}`;
    const group = grouped.get(key) ?? { profile, items: [] };
    group.items.push({
      fileName: basename(input.sourceAudioPath),
      format,
      record: input.recording
    });
    grouped.set(key, group);
  });

  for (const { profile, items } of grouped.values()) {
    for (const collision of findNamingCollisions(items, profile)) {
      collision.recordingIds.forEach((recordingId) => collisionIds.add(recordingId));
    }
  }

  return Promise.all(inputs.map((input) => prepareAudioArtifactWithCollision(
    input,
    collisionIds.has(input.recording.recordingId) || duplicateIds.has(input.recording.recordingId)
  )));
}
