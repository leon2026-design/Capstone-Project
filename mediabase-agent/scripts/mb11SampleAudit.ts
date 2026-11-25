import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, parse, resolve } from "node:path";
import { extractAudioMetadata, normalizeIsrcValue, type AudioFormat } from "../src/audio/audioMetadata";
import { reviewedVersionFromTitle } from "../src/metadata/versionDesignation";
import { AudioTagFormatError, readId3Values, readId3v1Values } from "../src/submission/audioId3";
import type { AudioTagField } from "../src/submission/audioTagProfile";
import { inspectWave, waveTagAgrees } from "../src/submission/wavAudio";

type AuditFile = {
  id: string;
  sha256: string;
  format: AudioFormat;
  durationSeconds: number | null;
  missing: string[];
  conflicts: string[];
  isrcHash: string | null;
  titleHash: string | null;
  artistHash: string | null;
  versionHash: string | null;
  versionIndicators: string[];
  filenameCleanIndicator: boolean;
  rightsReviewRequired: boolean;
};

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const identityHash = (value: string | null | undefined) =>
  value?.trim() ? digest(value.normalize("NFKC").trim().toLowerCase()) : null;

async function localFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found.sort();
}

function isAudioCandidate(header: Buffer, path: string): boolean {
  const extension = extname(path).toLowerCase();
  return [".mp3", ".wav", ".wave"].includes(extension) ||
    header.toString("latin1", 0, 3) === "ID3" ||
    ["RIFF", "RF64", "RIFX", "BW64"].includes(header.toString("latin1", 0, 4)) ||
    header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
}

export async function auditSampleDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new Error("An explicit absolute local directory is required.");
  const root = resolve(directory);
  if (root === parse(root).root) throw new Error("A filesystem root cannot be audited.");
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The audit path must be a regular directory.");
  const files: AuditFile[] = [];
  const errors: Array<{ id: string; code: string }> = [];
  let nextId = 0;
  for (const path of await localFiles(root)) {
    const id = `FILE-${String(++nextId).padStart(4, "0")}`;
    let bytes: Buffer;
    try {
      const handle = await fs.open(path, "r");
      const header = Buffer.alloc(16);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(header, 0, header.length, 0));
      } finally {
        await handle.close();
      }
      if (!isAudioCandidate(header.subarray(0, bytesRead), path)) continue;
      bytes = await fs.readFile(path);
    } catch {
      errors.push({ id, code: "FILE_UNREADABLE" });
      continue;
    }
    const extraction = await extractAudioMetadata(path);
    if (extraction.status !== "OK") {
      errors.push({ id, code: extraction.error });
      continue;
    }
    const metadata = extraction.metadata;
    const conflicts: string[] = [];
    if (!metadata.extensionMatchesFormat) conflicts.push("EXTENSION_MISMATCH");
    const normalizedIsrcs = metadata.rawIsrcs.map(normalizeIsrcValue);
    if (normalizedIsrcs.some((value) => value === null)) conflicts.push("INVALID_ISRC");
    if (new Set(normalizedIsrcs.filter(Boolean)).size > 1) conflicts.push("CONFLICTING_ISRC");
    if (normalizeIsrcValue(metadata.album)) conflicts.push("SUSPICIOUS_ALBUM_VALUE");
    try {
      if (metadata.format === "WAV") {
        const wave = inspectWave(bytes);
        for (const [field, values] of Object.entries(wave.infoValues) as Array<[AudioTagField, string[]]>) {
          const entries = [wave.id3[field], ...values].filter((value): value is string => !!value);
          if (entries.some((value) => !waveTagAgrees(field, value, entries[0]))) conflicts.push(`ID3_INFO_CONFLICT:${field}`);
        }
      } else {
        const id3 = readId3Values(bytes);
        const legacy = await readId3v1Values(bytes);
        for (const [field, value] of Object.entries(legacy) as Array<[AudioTagField, string | undefined]>) {
          if (value && id3[field] && !waveTagAgrees(field, value, id3[field]!)) conflicts.push(`ID3_VERSION_CONFLICT:${field}`);
        }
      }
    } catch (failure) {
      conflicts.push(failure instanceof AudioTagFormatError ? failure.code : "TAG_INSPECTION_FAILED");
    }
    const version = metadata.version ?? reviewedVersionFromTitle(metadata.title ?? "") ??
      reviewedVersionFromTitle(basename(path, extname(path)));
    const versionIndicators = version
      ? ["RADIO", "EXTENDED", "REMIX", "RERUB", "DJ", "INSTRUMENTAL", "LIVE"]
        .filter((label) => new RegExp(`\\b${label}\\b`, "iu").test(version))
      : [];
    files.push({
      id,
      sha256: digest(bytes),
      format: metadata.format,
      durationSeconds: metadata.durationSeconds,
      missing: [
        !metadata.title && "title", !metadata.artist && "artist", !metadata.album && "album",
        !metadata.isrc && "isrc", !metadata.year && "year", !metadata.genre && "genre",
        !metadata.comments && "comments"
      ].filter((field): field is string => !!field),
      conflicts,
      isrcHash: identityHash(metadata.isrc),
      titleHash: identityHash(metadata.title),
      artistHash: identityHash(metadata.artist),
      versionHash: identityHash(version),
      versionIndicators,
      filenameCleanIndicator: /(?:^|[^\p{L}\p{N}])clean(?:$|[^\p{L}\p{N}])/iu.test(basename(path)),
      rightsReviewRequired: /\b(?:white[\s-]*label|bootleg)\b/iu.test(
        [basename(path), metadata.title, metadata.album].filter(Boolean).join(" ")
      )
    });
  }

  const groups = (key: (file: AuditFile) => string | null) => {
    const byKey = new Map<string, AuditFile[]>();
    for (const file of files) {
      const value = key(file);
      if (!value) continue;
      const group = byKey.get(value) ?? [];
      group.push(file);
      byKey.set(value, group);
    }
    return [...byKey.entries()].filter(([, group]) => group.length > 1);
  };
  const exactDuplicates = groups((file) => file.sha256).map(([sha, group]) => ({ sha256: sha, fileIds: group.map((file) => file.id) }));
  const isrcPairings = groups((file) => file.isrcHash).map(([, group], index) => ({
    groupId: `ISRC-GROUP-${index + 1}`,
    fileIds: group.map((file) => file.id),
    formats: [...new Set(group.map((file) => file.format))],
    differentVersions: new Set(group.map((file) => file.versionHash).filter(Boolean)).size > 1,
    conflictingDurations: group.some((a) => group.some((b) =>
      a.durationSeconds !== null && b.durationSeconds !== null && Math.abs(a.durationSeconds - b.durationSeconds) > 2)),
    conflictingIdentity: new Set(group.map((file) => `${file.titleHash}:${file.artistHash}`)).size > 1
  }));
  const titlePairings = groups((file) =>
    file.titleHash && file.artistHash ? `${file.titleHash}:${file.artistHash}` : null)
    .map(([, group]) => ({ fileIds: group.map((file) => file.id), formats: [...new Set(group.map((file) => file.format))] }));
  return {
    mode: "LOCAL_READ_ONLY_AUDIO_AUDIT",
    directory: "[redacted]",
    counts: { audioFiles: files.length, errors: errors.length },
    files: files.map(({ isrcHash: _isrc, titleHash: _title, artistHash: _artist, versionHash: _version, ...item }) => item),
    exactDuplicates, isrcPairings, titlePairings, errors,
    unsupportedOrUnconfirmed: ["publisher mapping", "clean/explicit encoding", "rights and eligibility"],
    uploaded: false
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    console.error("Usage: npm run mb11:audit -- <absolute-local-reference-directory>");
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await auditSampleDirectory(process.argv[2]), null, 2));
  } catch {
    console.error("Audit input must be an accessible, explicit local directory; no files were uploaded.");
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
