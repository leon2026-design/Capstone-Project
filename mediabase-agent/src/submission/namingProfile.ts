import { extname } from "node:path";
import type { AudioFormat } from "../audio/audioMetadata";
import type { DemoRecording } from "../metadata/recordValidation";

export type NamingProblemCode =
  | "UNSAFE_CHARACTERS"
  | "EXTENSION_MISMATCH"
  | "NAME_TOO_LONG"
  | "EMPTY_NAME"
  | "CONVENTION_MISMATCH"
  | "NAME_COLLISION";

export type NamingProblem = { code: NamingProblemCode; message: string };
export type NamingCheck = {
  ok: boolean;
  problems: NamingProblem[];
  suggestedName: string | null;
};
export type NamingInput = {
  fileName: string;
  format: AudioFormat;
  record: Readonly<DemoRecording>;
};

/** Versioned destination-specific upload naming policy. It never renames a recording or prepared artifact. */
export interface UploadNamingProfile {
  readonly id: string;
  readonly version?: string;
  readonly description: string;
  check(input: NamingInput): NamingCheck;
}

export type ConfigurableNamingProfileOptions = {
  id: string;
  version: string;
  /**
   * Tokens in braces; optional segments use square brackets, e.g.
   * `{artist} - {title}[ ({version})]{ext}`. Optional segments disappear
   * completely when one of their values is absent.
   */
  template: string;
  maxLength?: number;
  unicodeNormalization?: "NFC" | "NFKC";
  invalidCharacterReplacement?: string;
  /** Test characters; global/sticky regex flags are ignored. */
  allowedCharacters?: RegExp;
};

const EXTENSIONS: Record<AudioFormat, string[]> = { WAV: [".wav", ".wave"], MP3: [".mp3"] };
const SAFE_CHARACTERS = /[\p{L}\p{N} ._()&'+,-]/u;
const DEFAULT_MAX_NAME_LENGTH = 180;
const NAMING_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKENS = new Set(["artist", "title", "version", "mix", "contentRating", "isrc", "recordingId", "ext"]);

function normalizeFilename(value: string, normalization: "NFC" | "NFKC", replacement: string): string {
  const invalid = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
  return value
    .normalize(normalization)
    .replace(invalid, replacement)
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/ +([.)])/g, "$1")
    .replace(/\( +/g, "(")
    .trim()
    .replace(/[. ]+$/g, "");
}

function hasUnsafeCharacters(fileName: string, allowed: RegExp): boolean {
  const flags = allowed.flags.replace(/[gy]/g, "");
  const characterPattern = new RegExp(`^(?:${allowed.source})$`, flags);
  return !/^[\p{L}\p{N}]/u.test(fileName) ||
    [...fileName].some((character) => !characterPattern.test(character)) ||
    fileName.includes("..");
}

export function basicFileNameProblems(fileName: string, format: AudioFormat): NamingProblem[] {
  const problems: NamingProblem[] = [];
  if (!fileName.trim()) {
    problems.push({ code: "EMPTY_NAME", message: "Upload filename is empty." });
    return problems;
  }
  if (hasUnsafeCharacters(fileName, SAFE_CHARACTERS)) {
    problems.push({ code: "UNSAFE_CHARACTERS", message: "Upload filename contains characters outside the safe set." });
  }
  if (fileName.length > DEFAULT_MAX_NAME_LENGTH) {
    problems.push({ code: "NAME_TOO_LONG", message: `Upload filename exceeds ${DEFAULT_MAX_NAME_LENGTH} characters.` });
  }
  if (!EXTENSIONS[format].includes(extname(fileName).toLowerCase())) {
    problems.push({ code: "EXTENSION_MISMATCH", message: `Upload filename extension does not match the detected ${format} format.` });
  }
  return problems;
}

/** No destination convention is assumed; the current artifact name is checked only for safety. */
export const SAFE_FILENAME_PROFILE: UploadNamingProfile = {
  id: "safe-filename",
  version: "1",
  description: "Safe Unicode characters and a matching audio extension; no destination naming convention.",
  check({ fileName, format }) {
    const problems = basicFileNameProblems(fileName, format);
    return { ok: problems.length === 0, problems, suggestedName: null };
  }
};

export const BASIC_FILENAME_PROFILE: UploadNamingProfile = {
  id: "basic-filename",
  version: "1",
  description: "Recording ID and the detected extension; no sponsor-specific convention.",
  check({ fileName, format, record }) {
    const expected = `${record.recordingId.replace(/[^A-Za-z0-9-]/g, "-")}${EXTENSIONS[format][0]}`;
    const problems = basicFileNameProblems(fileName, format);
    if (fileName !== expected) {
      problems.push({ code: "CONVENTION_MISMATCH", message: "Upload filename does not follow the basic profile." });
    }
    return { ok: problems.length === 0, problems, suggestedName: expected };
  }
};

function tokenValues(record: Readonly<DemoRecording>, format: AudioFormat): Record<string, string | null> {
  const explicitArtist = record.artistAttribution?.confirmedExactArtist;
  return {
    artist: explicitArtist ?? (record.recordSource === "MANUAL" ? record.artist : null),
    title: record.title || null,
    version: record.version?.trim() || null,
    mix: record.version?.trim() || null,
    contentRating: null,
    isrc: record.isrc?.trim() || null,
    recordingId: record.recordingId,
    ext: EXTENSIONS[format][0]
  };
}

function renderTemplate(template: string, values: Record<string, string | null>): { text: string | null; missing: string[] } {
  const missing = new Set<string>();
  const expandedOptional = template.replace(/\[([^\[\]]*)\]/g, (_group, contents: string) => {
    const tokens = [...contents.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    return tokens.some((token) => !values[token]) ? "" : contents;
  });
  const text = expandedOptional.replace(/\{([^{}]+)\}/g, (_token, name: string) => {
    if (!TOKENS.has(name)) throw new Error(`Unsupported naming placeholder: {${name}}`);
    const value = values[name];
    if (!value) {
      missing.add(name);
      return "";
    }
    return value;
  });
  return { text: missing.size > 0 ? null : text, missing: [...missing] };
}

export function createConfigurableNamingProfile(options: ConfigurableNamingProfileOptions): UploadNamingProfile {
  if (!NAMING_ID.test(options.id) || !/^[1-9]\d*(?:\.\d+){0,2}$/.test(options.version)) {
    throw new Error("Naming profile requires a safe id and an explicit numeric version.");
  }
  for (const match of options.template.matchAll(/\{([^{}]+)\}/g)) {
    if (!TOKENS.has(match[1])) throw new Error(`Unsupported naming placeholder: {${match[1]}}`);
  }
  const maxLength = options.maxLength ?? DEFAULT_MAX_NAME_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength < 16 || maxLength > 240) {
    throw new Error("Naming profile maxLength must be from 16 to 240.");
  }
  const normalization = options.unicodeNormalization ?? "NFC";
  const replacement = options.invalidCharacterReplacement ?? "-";
  if (replacement.length > 1 || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(replacement)) {
    throw new Error("Filename replacement must be one safe character.");
  }
  const allowed = options.allowedCharacters ?? SAFE_CHARACTERS;
  const description = `v${options.version} template ${options.template}`;
  return {
    id: options.id,
    version: options.version,
    description,
    check({ fileName, format, record }) {
      const rendered = renderTemplate(options.template, tokenValues(record, format));
      const expected = rendered.text === null
        ? null
        : normalizeFilename(rendered.text, normalization, replacement);
      const candidate = normalizeFilename(fileName, normalization, replacement);
      const problems = basicFileNameProblems(candidate, format)
        .filter((problem) => problem.code !== "NAME_TOO_LONG" && problem.code !== "UNSAFE_CHARACTERS");
      if (candidate.length > maxLength) {
        problems.push({ code: "NAME_TOO_LONG", message: `Upload filename exceeds ${maxLength} characters.` });
      }
      if (hasUnsafeCharacters(candidate, allowed)) {
        problems.push({ code: "UNSAFE_CHARACTERS", message: "Upload filename contains characters outside this profile's allowed set." });
      }
      if (expected === null) {
        problems.push({ code: "CONVENTION_MISMATCH", message: `Required naming values are missing: ${rendered.missing.join(", ")}.` });
      } else if (candidate !== expected) {
        problems.push({ code: "CONVENTION_MISMATCH", message: "Upload filename does not follow the active versioned naming profile." });
      }
      const suggestion = expected !== null && expected.length <= maxLength &&
        !hasUnsafeCharacters(expected, allowed) &&
        EXTENSIONS[format].includes(extname(expected).toLowerCase())
        ? expected
        : null;
      return { ok: problems.length === 0, problems, suggestedName: suggestion };
    }
  };
}

/** Backward-compatible wrapper for MB-10's simple {isrc}, {recordingId}, {ext} templates. */
export function createTemplateNamingProfile(id: string, template: string): UploadNamingProfile {
  return createConfigurableNamingProfile({ id, version: "1", template });
}

export type NamingCollision = { normalizedName: string; recordingIds: string[] };

/** Finds collisions using case-folded Unicode normalization as on common Windows filesystems. */
export function findNamingCollisions(
  items: readonly NamingInput[],
  profile: UploadNamingProfile
): NamingCollision[] {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const checked = profile.check(item);
    const name = checked.suggestedName ?? item.fileName;
    const key = name.normalize("NFKC").toUpperCase();
    const recordings = groups.get(key) ?? new Set<string>();
    recordings.add(item.record.recordingId);
    groups.set(key, recordings);
  }
  return [...groups]
    .filter(([, recordingIds]) => recordingIds.size > 1)
    .map(([normalizedName, recordingIds]) => ({ normalizedName, recordingIds: [...recordingIds].sort() }));
}
