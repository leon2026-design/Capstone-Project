import { extname } from "node:path";
import type { AudioFormat } from "../audio/audioMetadata";
import type { DemoRecording } from "../metadata/recordValidation";

/**
 * Destination-specific upload filename policy. MB-10 does not know the
 * sponsor's naming convention, so it is injected. A profile may propose a
 * deterministic name; the coordinator uses it for the uploaded file only when
 * the submission policy permits upload renames. The local file and the
 * recording are never changed.
 */
export type NamingProblemCode =
  | "UNSAFE_CHARACTERS"
  | "EXTENSION_MISMATCH"
  | "NAME_TOO_LONG"
  | "EMPTY_NAME"
  | "CONVENTION_MISMATCH";

export type NamingProblem = { code: NamingProblemCode; message: string };

export type NamingCheck = {
  ok: boolean;
  problems: NamingProblem[];
  /** A deterministic compliant name, if the profile can derive one from approved metadata alone. */
  suggestedName: string | null;
};

export type NamingInput = {
  fileName: string;
  format: AudioFormat;
  record: Readonly<DemoRecording>;
};

export interface UploadNamingProfile {
  readonly id: string;
  readonly description: string;
  check(input: NamingInput): NamingCheck;
}

const EXTENSIONS: Record<AudioFormat, string[]> = { WAV: [".wav", ".wave"], MP3: [".mp3"] };
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()&'+,-]*$/;
const MAX_NAME_LENGTH = 180;

/** Problems every profile shares: a safe, non-empty base name whose extension matches the detected format. */
export function basicFileNameProblems(fileName: string, format: AudioFormat): NamingProblem[] {
  const problems: NamingProblem[] = [];
  if (!fileName.trim()) {
    problems.push({ code: "EMPTY_NAME", message: "Upload filename is empty." });
    return problems;
  }
  if (!SAFE_NAME.test(fileName) || fileName.includes("..")) {
    problems.push({ code: "UNSAFE_CHARACTERS", message: "Upload filename contains characters outside the safe set." });
  }
  if (fileName.length > MAX_NAME_LENGTH) {
    problems.push({ code: "NAME_TOO_LONG", message: `Upload filename exceeds ${MAX_NAME_LENGTH} characters.` });
  }
  if (!EXTENSIONS[format].includes(extname(fileName).toLowerCase())) {
    problems.push({ code: "EXTENSION_MISMATCH", message: `Upload filename extension does not match the detected ${format} format.` });
  }
  return problems;
}

/** Default profile: no naming convention beyond safety and format checks; never proposes a rename. */
export const SAFE_FILENAME_PROFILE: UploadNamingProfile = {
  id: "safe-filename",
  description: "Safe characters and an extension matching the detected audio format; no destination convention.",
  check({ fileName, format }) {
    const problems = basicFileNameProblems(fileName, format);
    return { ok: problems.length === 0, problems, suggestedName: null };
  }
};

/**
 * Builds a profile from an explicit, deterministic template such as
 * `{isrc}{ext}`. Placeholders: {isrc}, {recordingId}, {ext}. A suggestion is
 * offered only when every placeholder has a value. Intended for configured
 * destinations and tests; it is not a guess at any sponsor's convention.
 */
export function createTemplateNamingProfile(id: string, template: string): UploadNamingProfile {
  const allowed = new Set(["isrc", "recordingId", "ext"]);
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    if (!allowed.has(match[1])) throw new Error(`Unsupported naming placeholder: {${match[1]}}`);
  }
  return {
    id,
    description: `Template ${template}`,
    check({ fileName, format, record }) {
      const values: Record<string, string | null> = {
        isrc: record.isrc ?? null,
        recordingId: record.recordingId.replace(/[^A-Za-z0-9-]/g, "-"),
        ext: EXTENSIONS[format][0]
      };
      const missing = [...template.matchAll(/\{([^}]*)\}/g)].some((match) => !values[match[1]]);
      const expected = missing ? null : template.replace(/\{([^}]*)\}/g, (_, key: string) => values[key] ?? "");
      const problems = basicFileNameProblems(fileName, format);
      if (expected === null) {
        problems.push({ code: "CONVENTION_MISMATCH", message: "Approved metadata lacks a value the naming template needs." });
      } else if (fileName !== expected) {
        problems.push({ code: "CONVENTION_MISMATCH", message: "Upload filename does not follow the destination naming template." });
      }
      const suggestion = expected !== null && basicFileNameProblems(expected, format).length === 0 ? expected : null;
      return { ok: problems.length === 0, problems, suggestedName: suggestion };
    }
  };
}
