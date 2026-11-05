import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { applyAudioMatch, matchAudioToRecording, type AudioMatchResult } from "../audio/audioMatcher";
import { extractAudioMetadata, type AudioExtractionResult, type AudioMetadata } from "../audio/audioMetadata";
import { analyzeMetadataGaps } from "../metadata/metadataGapAnalyzer";
import { redactResearchText } from "../metadata/metadataResearch";
import {
  getArtistAttributionProblem,
  normalizeDeclarationValue,
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DemoRecording
} from "../metadata/recordValidation";
import { DECLARATION_FIELDS, humanOnlyGapQueue, type HumanGapReviewState } from "../workflow/humanGapReview";
import { verifyAudioTags, type AudioTagVerification } from "./audioTagVerification";
import { DEFAULT_MP3_TAG_PROFILE, type AudioTagProfile, type ExplicitTagValues } from "./audioTagProfile";
import { extractMpegAudioPayload } from "./audioPreparation";
import type { PreparedAudioManifest } from "./audioPreparationStore";
import { SAFE_FILENAME_PROFILE, type UploadNamingProfile } from "./namingProfile";
import { canonicalJson, sha256Hex, type AutomaticCorrection, type FinalApprovalRecord, type SubmissionException } from "./submissionLedger";

/**
 * MB-10 pre-submission validation. Runs before any browser is opened, against
 * the verified MB-08/MB-09 review state and the audio file as it exists now.
 * It never invents metadata or declarations: anything missing or conflicting
 * becomes a structured exception. The only corrections it may make are those
 * the policy explicitly permits and that a deterministic rule fully determines.
 */

export type DeclarationField = (typeof DECLARATION_FIELDS)[number];

export type SubmissionPolicy = {
  /** Sponsor-required recording fields that must be non-empty. */
  requiredFields: ReadonlyArray<keyof DemoRecording>;
  /** Declarations that need an explicit yes/no answer; acknowledging a finding does not answer it. */
  requiredDeclarations: readonly DeclarationField[];
  requireAudio: boolean;
  /** Permits uploading under the naming profile's deterministic name (the local file is never renamed). */
  allowUploadRename: boolean;
  /** Permits applying a conflict-free automatic audio match (MATCHED by ISRC or exact metadata) at import. */
  autoApplyConflictFreeAudioMatch: boolean;
  /** When true, approval and submission require a verified MB-11 prepared artifact. */
  requirePreparedAudio: boolean;
  /** Attempts per submit call, counting the first; only explicitly retryable failures are retried. */
  maxAttempts: number;
  retryDelaysMs: readonly number[];
  /** How long the page waits for the destination's reply before the outcome becomes unknown. */
  responseTimeoutMs: number;
};

export const DEFAULT_SUBMISSION_POLICY: SubmissionPolicy = Object.freeze({
  requiredFields: ["submitterName", "email", "artist", "title", "officialReleaseDate"] as Array<keyof DemoRecording>,
  requiredDeclarations: [...DECLARATION_FIELDS],
  requireAudio: true,
  allowUploadRename: false,
  autoApplyConflictFreeAudioMatch: true,
  requirePreparedAudio: false,
  maxAttempts: 3,
  retryDelaysMs: [250, 1000],
  responseTimeoutMs: 15000
});

export type ApprovalBasis = {
  recordingId: string;
  reviewRevision: number;
  /** Binds an approval to the reviewed recording and the exact audio bytes. */
  contentFingerprint: string;
};

export type PreparedUpload = {
  path: string;
  sourceFileName: string;
  uploadFileName: string;
  size: number;
  sha256: string;
  mimeType: string;
  format: AudioMetadata["format"];
};

export type PreparedSubmission = {
  approvedRecord: DemoRecording;
  currentMatch: AudioMatchResult;
  upload: PreparedUpload | null;
  submissionId: string;
  contentFingerprint: string;
};

export type ReadinessReport = {
  basis: ApprovalBasis | null;
  exceptions: SubmissionException[];
  warnings: SubmissionException[];
  corrections: Array<Omit<AutomaticCorrection, "sequence" | "at">>;
  tagVerification: AudioTagVerification | null;
  /** Present only when there are no exceptions. */
  prepared: PreparedSubmission | null;
};

const MIME: Record<AudioMetadata["format"], string> = { WAV: "audio/wav", MP3: "audio/mpeg" };

function message(error: unknown): string {
  return redactResearchText(error instanceof Error ? error.message : String(error));
}

/** Fingerprint of the reviewed recording (approval status excluded) and the audio bytes. */
export function contentFingerprint(
  recording: Readonly<DemoRecording>,
  audioSha256: string | null,
  context?: Record<string, unknown>
): string {
  const { approvalStatus: _ignored, ...content } = recording as DemoRecording;
  return `CONTENT-${sha256Hex(canonicalJson({ content, audioSha256, ...(context ? { context } : {}) })).slice(0, 32).toUpperCase()}`;
}

/** Stable per recording, destination, and approved content: the same content always gets the same id. */
export function stableSubmissionId(recordingId: string, destinationId: string, fingerprint: string, uploadName: string | null): string {
  return `SUB-${sha256Hex(canonicalJson([recordingId, destinationId, fingerprint, uploadName])).slice(0, 32).toUpperCase()}`;
}

async function fileDigest(path: string): Promise<{ size: number; sha256: string } | null> {
  try {
    const bytes = await fs.readFile(path);
    return { size: bytes.length, sha256: sha256Hex(bytes) };
  } catch {
    return null;
  }
}

/** Re-reads every audio file the review evaluated, so changes since review are detected. */
async function currentAudio(state: Readonly<HumanGapReviewState>): Promise<{ extractions: AudioExtractionResult[]; match: AudioMatchResult }> {
  const paths = [...new Set(state.research.audioExtractions.map((item) => item.filePath))];
  const extractions = await Promise.all(paths.map((path) => extractAudioMetadata(path)));
  return { extractions, match: matchAudioToRecording(state.research.recording, extractions) };
}

export async function computeApprovalBasis(state: Readonly<HumanGapReviewState>, reviewRevision: number): Promise<ApprovalBasis> {
  const path = state.research.recording.audioFilePath ?? null;
  const digest = path ? await fileDigest(path) : null;
  return {
    recordingId: state.recordingId,
    reviewRevision,
    contentFingerprint: contentFingerprint(state.research.recording, digest?.sha256 ?? null)
  };
}

export type ReadinessInput = {
  state: Readonly<HumanGapReviewState>;
  reviewRevision: number;
  approval: Readonly<FinalApprovalRecord> | null;
  destinationId: string;
  policy: SubmissionPolicy;
  namingProfile?: UploadNamingProfile;
  preparedAudio?: PreparedAudioManifest | null;
  audioTagProfile?: AudioTagProfile;
  explicitTagValues?: ExplicitTagValues;
  preparationStoreError?: SubmissionException | null;
};

export async function assessSubmissionReadiness(input: ReadinessInput): Promise<ReadinessReport> {
  const { state, policy } = input;
  const profile = input.namingProfile ?? SAFE_FILENAME_PROFILE;
  const originalRecording = state.research.recording;
  let recording = originalRecording;
  const exceptions: SubmissionException[] = [];
  const warnings: SubmissionException[] = [];
  const corrections: ReadinessReport["corrections"] = [];
  const add = (list: SubmissionException[], code: string, kind: SubmissionException["kind"], field: string | null, text: string) => {
    if (!list.some((item) => item.code === code && item.field === field)) {
      list.push({ code, kind, field, message: redactResearchText(text) });
    }
  };

  // Human-only gaps MB-09 has not resolved (open or deferred) block preparation.
  for (const item of humanOnlyGapQueue(state)) {
    if (item.gap.severity === "informational" || item.status === "ACKNOWLEDGED") continue;
    add(exceptions, "HUMAN_GAP_UNRESOLVED", "SPONSOR_DECISION", item.gap.code,
      `Human-only gap ${item.gap.code} is ${item.status.toLowerCase()} (${item.gap.fields.join(", ")}).`);
  }

  const preparedManifest = input.preparedAudio ?? null;
  if (policy.requirePreparedAudio && !preparedManifest) {
    add(exceptions, "AUDIO_PREPARATION_REQUIRED", "SPONSOR_DECISION", "audioFilePath", "A verified prepared audio artifact is required before approval or submission.");
  }
  if (preparedManifest && (
    preparedManifest.recordingId !== state.recordingId ||
    !preparedManifest.artifactPath ||
    !preparedManifest.preparedSha256 ||
    preparedManifest.preparationStatus !== "PREPARED" && preparedManifest.preparationStatus !== "REUSED"
  )) {
    add(exceptions, "PREPARED_ARTIFACT_UNVERIFIED", "INTEGRITY", "audioFilePath", "Prepared artifact manifest is incomplete or belongs to another recording.");
  }
  if (input.preparationStoreError) {
    add(exceptions, input.preparationStoreError.code, input.preparationStoreError.kind,
      input.preparationStoreError.field, input.preparationStoreError.message);
  }
  const preparedMode = preparedManifest !== null;
  const path = preparedManifest?.artifactPath ?? recording.audioFilePath ?? null;
  const digest = path ? await fileDigest(path) : null;
  let metadata: AudioMetadata | null = null;
  let audio: { extractions: AudioExtractionResult[]; match: AudioMatchResult } = {
    extractions: [],
    match: matchAudioToRecording(recording, [])
  };
  if (!path) {
    if (policy.requireAudio) add(exceptions, "AUDIO_NOT_SELECTED", "SPONSOR_DECISION", "audioFilePath", "No audio file is selected for upload.");
  } else if (!digest) {
    add(exceptions, "AUDIO_FILE_MISSING", "RECOVERABLE", "audioFilePath", "The selected audio file no longer exists; restore it without changing its contents.");
  } else {
    const extraction = await extractAudioMetadata(path);
    if (extraction.status === "ERROR") add(exceptions, "AUDIO_FILE_UNREADABLE", "RECOVERABLE", "audioFilePath", `Selected audio file: ${extraction.error}.`);
    else {
      metadata = extraction.metadata;
      if (preparedMode) {
        if (preparedManifest.preparationStatus !== "PREPARED" && preparedManifest.preparationStatus !== "REUSED" ||
          preparedManifest.tagVerificationStatus !== "MATCH" || !preparedManifest.audioIntegrityVerified ||
          preparedManifest.preparedSha256 !== digest.sha256 || preparedManifest.preparedFormat !== metadata.format) {
          add(exceptions, "PREPARED_ARTIFACT_UNVERIFIED", "INTEGRITY", "audioFilePath", "Prepared artifact manifest does not verify this file.");
        }
        const sourcePath = originalRecording.audioFilePath ?? null;
        const sourceDigest = sourcePath ? await fileDigest(sourcePath) : null;
        if (!sourceDigest || sourceDigest.sha256 !== preparedManifest.sourceSha256) {
          add(exceptions, "PREPARED_SOURCE_STALE", "INTEGRITY", "audioFilePath", "The original reviewed audio changed after preparation.");
        } else {
          try {
            const sourceBytes = await fs.readFile(sourcePath!);
            const preparedBytes = await fs.readFile(path);
            if (!extractMpegAudioPayload(sourceBytes).equals(extractMpegAudioPayload(preparedBytes))) {
              add(exceptions, "PREPARED_AUDIO_INTEGRITY_FAILED", "INTEGRITY", "audioFilePath", "Prepared audio frame payload differs from the selected source.");
            }
          } catch {
            add(exceptions, "PREPARED_AUDIO_INTEGRITY_FAILED", "INTEGRITY", "audioFilePath", "Prepared audio payload could not be independently verified.");
          }
        }
        const matchingRecord: DemoRecording = { ...originalRecording, audioFilePath: null, audioMatch: undefined };
        audio = {
          extractions: [extraction],
          match: matchAudioToRecording(matchingRecord, [extraction])
        };
        if (audio.match.status !== "MATCHED" || audio.match.selectedFilePath !== path) {
          add(exceptions, "PREPARED_AUDIO_IDENTITY_MISMATCH", "INTEGRITY", "audioFilePath", "Prepared audio tags do not identify the reviewed recording.");
        } else {
          recording = applyAudioMatch(matchingRecord, audio.match);
        }
      } else {
        audio = await currentAudio(state);
      }
    }
  }
  if (!path || !digest || !metadata) audio = await currentAudio(state);
  const activeTagProfile = input.audioTagProfile ?? (preparedMode ? DEFAULT_MP3_TAG_PROFILE : undefined);
  const activeTagProfileIdentity = preparedMode && preparedManifest
    ? { id: activeTagProfile?.id ?? preparedManifest.tagProfileId, version: activeTagProfile?.version ?? preparedManifest.tagProfileVersion }
    : null;
  const namingProfileIdentity = preparedMode
    ? { id: profile.id, version: profile.version ?? "1" }
    : null;
  const basis: ApprovalBasis = {
    recordingId: state.recordingId,
    reviewRevision: input.reviewRevision,
    contentFingerprint: contentFingerprint(recording, digest?.sha256 ?? null, preparedMode ? {
      preparedArtifactSha256: digest?.sha256 ?? null,
      preparationId: preparedManifest?.preparationId ?? null,
      tagProfile: activeTagProfileIdentity,
      namingProfile: namingProfileIdentity,
      uploadFileName: preparedManifest?.uploadFileName ?? null
    } : undefined)
  };

  // Final approval: explicit, by a person, and bound to exactly this content.
  const approval = input.approval;
  let approved: DemoRecording | null = null;
  if (!approval) {
    add(exceptions, "APPROVAL_REQUIRED", "SPONSOR_DECISION", "approvalStatus", "An explicit final approval of the reviewed recording is required.");
  } else if (approval.contentFingerprint !== basis.contentFingerprint || approval.reviewRevision !== basis.reviewRevision) {
    add(exceptions, "APPROVAL_STALE", "SPONSOR_DECISION", "approvalStatus",
      "The recording, its review history, or its audio changed after final approval; approve again.");
  } else {
    try {
      approved = reviewAndApproveRecord(recording, {}, {
        audioMatchResult: audio.match,
        confirmMissingIsrc: approval.confirmMissingIsrc
      });
    } catch (error) {
      add(exceptions, "PREPARATION_VALIDATION_FAILED", "SPONSOR_DECISION", null, message(error));
    }
  }
  // Report every other problem too, as if approved, without approving anything.
  const target: DemoRecording = approved ?? { ...structuredClone(recording), approvalStatus: "APPROVED" };
  try {
    validateRecordForPreparation(target, { audioMatchResult: audio.match });
  } catch (error) {
    add(exceptions, "PREPARATION_VALIDATION_FAILED", "SPONSOR_DECISION", null, message(error));
  }

  const report = analyzeMetadataGaps(target, { audioExtractions: audio.extractions, audioMatchResults: [audio.match] });
  for (const gap of report.gaps) {
    if (gap.code === "approval-pending" || gap.code === "preparation-validation-failed") continue;
    if (gap.severity === "blocking") {
      add(exceptions, "BLOCKING_GAP", gap.resolvedBy === "deterministic-rule" ? "RECOVERABLE" : "SPONSOR_DECISION", gap.code, gap.description);
    } else if (gap.severity === "warning") {
      add(warnings, "GAP_WARNING", "SPONSOR_DECISION", gap.code, gap.description);
    }
  }

  for (const field of policy.requiredFields) {
    const value = target[field];
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
      add(exceptions, "MISSING_REQUIRED_FIELD", "SPONSOR_DECISION", String(field), `Sponsor-required field ${String(field)} is empty.`);
    }
  }

  const attribution = getArtistAttributionProblem(target);
  if (attribution) add(exceptions, "ARTIST_ATTRIBUTION_UNCONFIRMED", "SPONSOR_DECISION", "artist", attribution.message);

  const isrc = target.isrcValidation;
  const isrcOk = isrc
    ? (isrc.status === "valid" && !!target.isrc) || (isrc.status === "missing" && isrc.reviewed && !target.isrc)
    : !!target.isrc;
  if (!isrcOk) add(exceptions, "ISRC_NOT_VALIDATED", "SPONSOR_DECISION", "isrc", "The ISRC is neither validated nor explicitly confirmed absent.");

  for (const field of policy.requiredDeclarations) {
    let value;
    try {
      value = normalizeDeclarationValue(target[field]);
    } catch {
      value = "invalid";
    }
    if (value !== "yes" && value !== "no") {
      add(exceptions, "DECLARATION_UNANSWERED", "SPONSOR_DECISION", field, `Declaration ${field} needs an explicit yes or no answer.`);
    }
  }

  let tagVerification: AudioTagVerification | null = null;
  let upload: PreparedUpload | null = null;
  if (metadata && digest && path) {
    tagVerification = verifyAudioTags(
      target,
      metadata,
      audio.match,
      activeTagProfile,
      input.explicitTagValues
    );
    if (preparedMode) {
      for (const preparationIssue of preparedManifest?.issues ?? []) {
        add(warnings, "PREPARATION_NOTE", preparationIssue.category === "SPONSOR_DECISION" ? "SPONSOR_DECISION" : "RECOVERABLE",
          preparationIssue.field, preparationIssue.code);
      }
      for (const mapping of activeTagProfile?.unresolvedSponsorMappings ?? []) {
        add(warnings, "UNRESOLVED_SPONSOR_MAPPING", "SPONSOR_DECISION", mapping,
          `Sponsor mapping "${mapping}" is not configured and remains unresolved.`);
      }
    }
    for (const item of tagVerification.fields) {
      if (item.severity === "blocking") {
        add(exceptions, "AUDIO_TAG_CONFLICT", "SPONSOR_DECISION", item.field, `Embedded ${item.field} tag disagrees with the approved recording.`);
      } else if (item.status === "INCORRECT_TAG") {
        add(warnings, item.acknowledged ? "AUDIO_TAG_CONFLICT_ACKNOWLEDGED" : "AUDIO_TAG_MISMATCH", "SPONSOR_DECISION", item.field,
          `Embedded ${item.field} tag disagrees with the approved recording.`);
      } else if (item.status === "MISSING_TAG") {
        add(warnings, "AUDIO_TAG_MISSING", "SPONSOR_DECISION", item.field, `The audio file has no embedded ${item.field} tag.`);
      } else if (item.status === "UNSUPPORTED_FIELD") {
        add(warnings, "AUDIO_TAG_UNSUPPORTED", "SPONSOR_DECISION", item.field, `${metadata.format} files have no standard ${item.field} tag.`);
      }
    }

    const sourceFileName = basename(path);
    let uploadFileName = sourceFileName;
    const naming = profile.check({ fileName: sourceFileName, format: metadata.format, record: target });
    if (!naming.ok) {
      const suggestion = naming.suggestedName;
      const suggestionOk = suggestion !== null &&
        profile.check({ fileName: suggestion, format: metadata.format, record: target }).ok;
      if (policy.allowUploadRename && suggestionOk && suggestion) {
        uploadFileName = suggestion;
        corrections.push({
          code: "UPLOAD_FILENAME_APPLIED",
          rule: `naming-profile:${profile.id}`,
          field: "uploadFileName",
          previous: redactResearchText(sourceFileName),
          resulting: suggestion
        });
      } else {
        for (const problem of naming.problems) {
          add(exceptions, "FILENAME_POLICY_VIOLATION", "SPONSOR_DECISION", problem.code, problem.message);
        }
      }
    }
    upload = {
      path,
      sourceFileName,
      uploadFileName,
      size: digest.size,
      sha256: digest.sha256,
      mimeType: MIME[metadata.format],
      format: metadata.format
    };
  }

  const prepared = exceptions.length === 0 && approved
    ? {
      approvedRecord: approved,
      currentMatch: audio.match,
      upload,
      submissionId: stableSubmissionId(state.recordingId, input.destinationId, basis.contentFingerprint, upload?.uploadFileName ?? null),
      contentFingerprint: basis.contentFingerprint
    }
    : null;
  return { basis, exceptions, warnings, corrections, tagVerification, prepared };
}
