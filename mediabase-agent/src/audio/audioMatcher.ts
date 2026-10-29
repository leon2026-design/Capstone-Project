import { basename, extname, resolve } from "node:path";
import type { DemoRecording } from "../metadata/recordValidation";
import {
  normalizeIsrcValue,
  type AudioExtractionErrorCode,
  type AudioExtractionResult,
  type AudioMetadata
} from "./audioMetadata";

/** Ordered from strongest to weakest evidence. */
export type AudioMatchBasis = "ISRC" | "EXACT_METADATA" | "PARTIAL_METADATA" | "FILENAME";

export type AudioMatchStatus = "MATCHED" | "NEEDS_REVIEW" | "AMBIGUOUS" | "NO_MATCH";

export type AudioMatchCandidate = {
  filePath: string;
  fileName: string;
  basis: AudioMatchBasis;
  /** True only for conflict-free ISRC or exact metadata evidence. */
  autoEligible: boolean;
  evidence: string[];
  conflicts: string[];
};

export type AudioMatchResult = {
  recordingId: string;
  status: AudioMatchStatus;
  /** Set only when status is MATCHED. */
  selectedFilePath: string | null;
  basis: AudioMatchBasis | null;
  candidates: AudioMatchCandidate[];
  rejectedFiles: Array<{ filePath: string; error: AudioExtractionErrorCode; message: string }>;
  reasons: string[];
};

export type AudioMatchDecisionStatus =
  | "AUTO_MATCHED"
  | "NEEDS_REVIEW"
  | "AMBIGUOUS"
  | "NO_MATCH"
  | "CONFIRMED"
  | "NO_AUDIO_CONFIRMED";

/** Reviewable audio decision stored on a recording. Audio is never uploaded automatically. */
export type AudioMatchDecision = {
  status: AudioMatchDecisionStatus;
  filePath: string | null;
  basis: AudioMatchBasis | null;
  candidateFilePaths: string[];
  humanConfirmed: boolean;
  acknowledgedConflicts: string[];
};

const BASIS_RANK: Record<AudioMatchBasis, number> = {
  ISRC: 0,
  EXACT_METADATA: 1,
  PARTIAL_METADATA: 2,
  FILENAME: 3
};

const VERSION_PATTERNS: Array<[string, RegExp]> = [
  ["radio edit", /\bradio (edit|version|mix)\b/],
  ["extended mix", /\bextended( mix| version| edit)?\b/],
  ["club mix", /\bclub (mix|edit)\b/],
  ["original mix", /\boriginal (mix|version)\b/],
  ["remix", /\b(re ?mix(ed)?|rmx)\b/],
  ["instrumental", /\binstrumental\b/],
  ["a cappella", /\ba ?cap?pella\b/],
  ["acoustic", /\bacoustic\b/],
  ["live", /\blive\b/],
  ["clean", /\bclean\b/],
  ["explicit", /\b(explicit|dirty)\b/],
  ["remaster", /\bremaster(ed)?\b/],
  ["sped up", /\bsped up\b/],
  ["slowed", /\bslowed\b/],
  ["edit", /\bedit\b/]
];

export function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function versionLabels(normalizedText: string): Set<string> {
  const labels = new Set<string>();
  let remaining = ` ${normalizedText} `;
  for (const [label, pattern] of VERSION_PATTERNS) {
    const global = new RegExp(pattern.source, "g");
    if (global.test(remaining)) {
      labels.add(label);
      remaining = remaining.replace(global, " ");
    }
  }
  return labels;
}

function withoutPhrase(text: string, phrase: string): string {
  if (!phrase) return text;
  return ` ${text} `.split(` ${phrase} `).join(" ").replace(/\s+/g, " ").trim();
}

function recordIsrc(record: DemoRecording): string | null {
  if (record.isrcValidation?.status === "invalid") return null;
  return normalizeIsrcValue(record.isrc) === record.isrc ? record.isrc ?? null : null;
}

function recordArtistNames(record: DemoRecording): string[] {
  return [
    record.artist,
    record.artistAttribution?.trackArtist,
    record.artistAttribution?.productArtist,
    record.artistAttribution?.confirmedExactArtist
  ]
    .map(normalizeMatchText)
    .filter((name, index, names) => name !== "" && names.indexOf(name) === index);
}

function evaluateFile(
  record: DemoRecording,
  metadata: AudioMetadata,
  isrcOwners: Map<string, string>
): AudioMatchCandidate | null {
  const evidence: string[] = [];
  const conflicts: string[] = [];
  const title = normalizeMatchText(record.title);
  const version = normalizeMatchText(record.version);
  const artists = recordArtistNames(record);
  const expectedIsrc = recordIsrc(record);

  const embeddedIsrcs = metadata.rawIsrcs.map(normalizeIsrcValue);
  if (embeddedIsrcs.some((isrc) => isrc === null)) {
    conflicts.push("Embedded ISRC is malformed.");
  }
  const validEmbeddedIsrcs = [...new Set(embeddedIsrcs.filter((isrc): isrc is string => isrc !== null))];
  if (validEmbeddedIsrcs.length > 1) {
    conflicts.push(`File embeds multiple ISRCs: ${validEmbeddedIsrcs.join(", ")}.`);
  }
  const isrcMatch = expectedIsrc !== null && validEmbeddedIsrcs.includes(expectedIsrc);
  for (const isrc of validEmbeddedIsrcs) {
    if (expectedIsrc !== null && isrc !== expectedIsrc) {
      conflicts.push(`Embedded ISRC ${isrc} contradicts Orchard ISRC ${expectedIsrc}.`);
    }
    const owner = isrcOwners.get(isrc);
    if (owner !== undefined && owner !== record.recordingId) {
      conflicts.push(`Embedded ISRC ${isrc} belongs to Orchard recording ${owner}.`);
    }
  }
  if (isrcMatch) evidence.push(`Embedded ISRC matches ${expectedIsrc}.`);
  if (expectedIsrc === null && validEmbeddedIsrcs.length === 1) {
    evidence.push(`File embeds ISRC ${validEmbeddedIsrcs[0]}; it was not copied to the recording.`);
  }

  const embeddedArtist = normalizeMatchText(metadata.artist);
  const artistAgrees = embeddedArtist !== "" && artists.includes(embeddedArtist);
  if (artistAgrees) evidence.push("Embedded artist matches an Orchard artist.");
  else if (embeddedArtist !== "") conflicts.push(`Embedded artist "${metadata.artist}" does not match Orchard artists.`);

  const embeddedTitle = normalizeMatchText(metadata.title);
  const titleResidual =
    embeddedTitle === title ? "" : embeddedTitle.startsWith(`${title} `) ? embeddedTitle.slice(title.length + 1) : null;
  const titleAgrees = title !== "" && titleResidual !== null;
  if (titleAgrees) evidence.push("Embedded title matches the Orchard title.");
  else if (embeddedTitle !== "") conflicts.push(`Embedded title "${metadata.title}" does not match the Orchard title.`);

  const fileStem = normalizeMatchText(basename(metadata.fileName, extname(metadata.fileName)));
  const filenameHasTitle = title !== "" && ` ${fileStem} `.includes(` ${title} `);
  let filenameResidual = withoutPhrase(fileStem, title);
  for (const artist of artists) filenameResidual = withoutPhrase(filenameResidual, artist);
  if (filenameHasTitle) evidence.push("Filename contains the Orchard title.");

  const embeddedVersion = normalizeMatchText(metadata.version);
  const expectedLabels = versionLabels(version);
  const fileLabels = new Set([
    ...versionLabels(embeddedVersion),
    ...versionLabels(titleResidual ?? ""),
    ...(filenameHasTitle ? versionLabels(filenameResidual) : [])
  ]);
  const unexpectedLabels = [...fileLabels].filter((label) => !expectedLabels.has(label));
  if (embeddedVersion !== "" && embeddedVersion !== version) {
    conflicts.push(`Embedded version "${metadata.version}" differs from Orchard version "${record.version ?? "(none)"}".`);
  } else if (unexpectedLabels.length > 0) {
    conflicts.push(`File indicates ${unexpectedLabels.join(", ")}, but Orchard version is "${record.version ?? "(none)"}".`);
  }
  const versionAgrees =
    version === ""
      ? embeddedVersion === "" && fileLabels.size === 0 && titleResidual === ""
      : embeddedVersion === version || titleResidual === version;
  if (versionAgrees) evidence.push("Version/mix agrees with Orchard.");

  let basis: AudioMatchBasis | null = null;
  if (isrcMatch) basis = "ISRC";
  else if (artistAgrees && titleAgrees && versionAgrees) basis = "EXACT_METADATA";
  else if (titleAgrees) basis = "PARTIAL_METADATA";
  else if (filenameHasTitle) basis = "FILENAME";
  if (basis === null) return null;

  return {
    filePath: metadata.filePath,
    fileName: metadata.fileName,
    basis,
    autoEligible: (basis === "ISRC" || basis === "EXACT_METADATA") && conflicts.length === 0,
    evidence,
    conflicts
  };
}

function compareCandidates(left: AudioMatchCandidate, right: AudioMatchCandidate): number {
  return (
    Number(right.autoEligible) - Number(left.autoEligible) ||
    BASIS_RANK[left.basis] - BASIS_RANK[right.basis] ||
    (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0)
  );
}

function buildResult(
  record: DemoRecording,
  extractions: AudioExtractionResult[],
  isrcOwners: Map<string, string>
): AudioMatchResult {
  const rejectedFiles: AudioMatchResult["rejectedFiles"] = [];
  const candidates: AudioMatchCandidate[] = [];
  for (const extraction of extractions) {
    if (extraction.status === "ERROR") {
      rejectedFiles.push({ filePath: extraction.filePath, error: extraction.error, message: extraction.message });
      continue;
    }
    const candidate = evaluateFile(record, extraction.metadata, isrcOwners);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort(compareCandidates);
  rejectedFiles.sort((left, right) => (left.filePath < right.filePath ? -1 : 1));

  const automatic = candidates.filter((candidate) => candidate.autoEligible);
  const result: AudioMatchResult = {
    recordingId: record.recordingId,
    status: "NO_MATCH",
    selectedFilePath: null,
    basis: null,
    candidates,
    rejectedFiles,
    reasons: []
  };
  if (automatic.length === 1) {
    result.status = "MATCHED";
    result.selectedFilePath = automatic[0].filePath;
    result.basis = automatic[0].basis;
    result.reasons.push(`Automatically matched by ${automatic[0].basis} with no conflicting evidence.`);
  } else if (automatic.length > 1) {
    result.status = "AMBIGUOUS";
    result.reasons.push(`${automatic.length} files could match this recording; human selection is required.`);
  } else if (candidates.length > 1) {
    result.status = "AMBIGUOUS";
    result.reasons.push(`${candidates.length} review-only suggestions; human selection is required.`);
  } else if (candidates.length === 1) {
    result.status = "NEEDS_REVIEW";
    result.reasons.push("Only partial, filename, or conflicting evidence was found; human review is required.");
  } else {
    result.reasons.push("No local audio file matched this recording.");
  }
  return result;
}

export function matchAudioToRecording(
  record: DemoRecording,
  extractions: AudioExtractionResult[]
): AudioMatchResult {
  return matchAudioToRecordings([record], extractions)[0];
}

export function matchAudioToRecordings(
  records: DemoRecording[],
  extractions: AudioExtractionResult[]
): AudioMatchResult[] {
  const isrcOwners = new Map<string, string>();
  for (const record of records) {
    const isrc = recordIsrc(record);
    if (isrc !== null) isrcOwners.set(isrc, isrcOwners.has(isrc) ? "multiple recordings" : record.recordingId);
  }
  const results = records.map((record) => buildResult(record, extractions, isrcOwners));

  const claims = new Map<string, number>();
  for (const result of results) {
    if (result.selectedFilePath) claims.set(result.selectedFilePath, (claims.get(result.selectedFilePath) ?? 0) + 1);
  }
  for (const result of results) {
    if (result.selectedFilePath && (claims.get(result.selectedFilePath) ?? 0) > 1) {
      result.status = "AMBIGUOUS";
      result.reasons.push("The same file automatically matched more than one Orchard recording.");
      result.selectedFilePath = null;
      result.basis = null;
    }
  }
  return results;
}

function decisionStatus(status: AudioMatchStatus): AudioMatchDecisionStatus {
  return status === "MATCHED" ? "AUTO_MATCHED" : status;
}

/**
 * Stores a match result on the recording. Human-confirmed or manually supplied
 * audio selections are preserved.
 */
export function applyAudioMatch(record: DemoRecording, result: AudioMatchResult): DemoRecording {
  if (result.recordingId !== record.recordingId) {
    throw new Error("Audio match result belongs to a different recording.");
  }
  if (record.audioMatch?.humanConfirmed) return record;
  if (record.audioFilePath && !record.audioMatch) return record;

  return {
    ...record,
    audioFilePath: result.selectedFilePath,
    audioMatch: {
      status: decisionStatus(result.status),
      filePath: result.selectedFilePath,
      basis: result.basis,
      candidateFilePaths: result.candidates.map((candidate) => candidate.filePath),
      humanConfirmed: false,
      acknowledgedConflicts: []
    }
  };
}

export type AudioSelectionOptions = {
  /** Required when the chosen candidate has conflicting evidence. */
  acknowledgeConflicts?: boolean;
};

export type AudioDecisionProblemCode =
  | "unresolved"
  | "path-mismatch"
  | "stale-automatic-match"
  | "selection-new-candidates"
  | "selection-new-conflicts"
  | "selection-rejected";

export type AudioDecisionProblem = {
  code: AudioDecisionProblemCode;
  message: string;
  /** Files involved; absolute paths for internal use only. */
  filePaths: string[];
  conflicts: string[];
};

export type AudioDecisionAssessment = {
  /** Effective status after reconciling the stored decision with current evidence. */
  status: AudioMatchDecisionStatus | null;
  /** `automatic` decisions follow current evidence; `human` selections are preserved but may be flagged. */
  source: "human" | "automatic" | "manual-path" | "none";
  filePath: string | null;
  problems: AudioDecisionProblem[];
};

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((value) => set.has(value));
}

/**
 * Reconciles a recording's stored audio decision with the current matcher
 * result (if supplied). Shared by form preparation and gap analysis so both
 * use the same effective audio decision. Never modifies the record.
 */
export function assessAudioDecision(
  record: DemoRecording,
  current: AudioMatchResult | null = null
): AudioDecisionAssessment {
  if (current && current.recordingId !== record.recordingId) {
    throw new Error("Audio match result belongs to a different recording.");
  }
  const decision = record.audioMatch;
  const recordPath = record.audioFilePath ?? null;
  const problems: AudioDecisionProblem[] = [];
  const currentPaths = current?.candidates.map((candidate) => candidate.filePath) ?? [];
  let assessment: Omit<AudioDecisionAssessment, "problems">;

  if (decision?.humanConfirmed) {
    assessment = { status: decision.status, source: "human", filePath: decision.filePath };
    if (current) {
      const known = new Set(decision.candidateFilePaths);
      const added = currentPaths.filter((path) => !known.has(path) && path !== decision.filePath);
      if (added.length > 0) {
        problems.push({
          code: "selection-new-candidates",
          message: "New candidate audio files were found after the human audio selection; the selection must be confirmed again.",
          filePaths: added,
          conflicts: []
        });
      }
      const selected = current.candidates.find((candidate) => candidate.filePath === decision.filePath);
      const unacknowledged = selected?.conflicts.filter((conflict) => !decision.acknowledgedConflicts.includes(conflict)) ?? [];
      if (selected && unacknowledged.length > 0) {
        problems.push({
          code: "selection-new-conflicts",
          message: "The selected audio file now has conflicting evidence that was not acknowledged; the selection must be confirmed again.",
          filePaths: [selected.filePath],
          conflicts: unacknowledged
        });
      }
      if (decision.filePath && current.rejectedFiles.some((file) => file.filePath === decision.filePath)) {
        problems.push({
          code: "selection-rejected",
          message: "The selected audio file can no longer be read; select a different file or confirm no audio.",
          filePaths: [decision.filePath],
          conflicts: []
        });
      }
    }
  } else if (decision || (current && !recordPath)) {
    const currentStatus = current ? decisionStatus(current.status) : null;
    assessment = {
      status: currentStatus ?? decision?.status ?? null,
      source: "automatic",
      filePath: current ? current.selectedFilePath : decision?.filePath ?? null
    };
    const outdated = decision
      ? current !== null &&
        (decision.status !== currentStatus ||
          (decision.filePath ?? null) !== current.selectedFilePath ||
          !sameMembers(decision.candidateFilePaths, currentPaths))
      : current?.status === "MATCHED";
    if (outdated) {
      problems.push({
        code: "stale-automatic-match",
        message: `The stored automatic audio decision (${decision?.status ?? "not applied"}) no longer matches current evidence (${currentStatus}); apply the current match result before approval.`,
        filePaths: [...new Set([decision?.filePath, current?.selectedFilePath].filter((path): path is string => !!path))],
        conflicts: []
      });
    }
  } else {
    assessment = { status: null, source: recordPath ? "manual-path" : "none", filePath: recordPath };
  }

  if (assessment.status === "AMBIGUOUS" || assessment.status === "NEEDS_REVIEW") {
    problems.unshift({
      code: "unresolved",
      message: "Audio match requires an explicit human selection before approval.",
      filePaths: currentPaths.length > 0 ? currentPaths : decision?.candidateFilePaths ?? [],
      conflicts: current?.candidates.flatMap((candidate) => candidate.conflicts) ?? []
    });
  }
  if (decision && (decision.filePath ?? null) !== recordPath) {
    problems.splice(problems[0]?.code === "unresolved" ? 1 : 0, 0, {
      code: "path-mismatch",
      message: "Audio file path differs from the reviewed audio match.",
      filePaths: [decision.filePath, recordPath].filter((path): path is string => !!path),
      conflicts: []
    });
  }
  return { ...assessment, problems };
}

/**
 * Records an explicit human audio choice. Pass `null` to confirm that no audio
 * file should be attached.
 */
export function confirmAudioSelection(
  record: DemoRecording,
  result: AudioMatchResult,
  filePath: string | null,
  options: AudioSelectionOptions = {}
): DemoRecording {
  if (result.recordingId !== record.recordingId) {
    throw new Error("Audio match result belongs to a different recording.");
  }
  const candidateFilePaths = result.candidates.map((candidate) => candidate.filePath);
  if (filePath === null) {
    return {
      ...record,
      audioFilePath: null,
      audioMatch: {
        status: "NO_AUDIO_CONFIRMED",
        filePath: null,
        basis: null,
        candidateFilePaths,
        humanConfirmed: true,
        acknowledgedConflicts: []
      }
    };
  }

  const candidate = result.candidates.find((entry) => entry.filePath === resolve(filePath));
  if (!candidate) {
    throw new Error("Selected audio file is not one of the evaluated match candidates.");
  }
  if (candidate.conflicts.length > 0 && !options.acknowledgeConflicts) {
    throw new Error("Selected audio file has conflicting evidence that must be explicitly acknowledged.");
  }
  return {
    ...record,
    audioFilePath: candidate.filePath,
    audioMatch: {
      status: "CONFIRMED",
      filePath: candidate.filePath,
      basis: candidate.basis,
      candidateFilePaths,
      humanConfirmed: true,
      acknowledgedConflicts: [...candidate.conflicts]
    }
  };
}
