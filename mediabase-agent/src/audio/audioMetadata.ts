import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

export type AudioFormat = "WAV" | "MP3";

export type AudioMetadata = {
  filePath: string;
  fileName: string;
  /** Format detected from file content, not from the extension. */
  format: AudioFormat;
  extensionMatchesFormat: boolean;
  durationSeconds: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  /** Normalized embedded ISRC when every embedded value agrees on one valid ISRC. */
  isrc: string | null;
  /** Every embedded ISRC value exactly as stored in the file. */
  rawIsrcs: string[];
  /** Explicit version/mix tag (ID3 TIT3 subtitle); never inferred from the title. */
  version: string | null;
};

export type AudioExtractionErrorCode = "MISSING_FILE" | "UNSUPPORTED_FORMAT" | "INVALID_AUDIO";

export type AudioExtractionResult =
  | { status: "OK"; filePath: string; fileName: string; metadata: AudioMetadata }
  | {
      status: "ERROR";
      filePath: string;
      fileName: string;
      error: AudioExtractionErrorCode;
      message: string;
    };

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const EXTENSIONS: Record<AudioFormat, string[]> = {
  WAV: [".wav", ".wave"],
  MP3: [".mp3"]
};
const MIME_TYPES: Record<AudioFormat, string> = {
  WAV: "audio/wav",
  MP3: "audio/mpeg"
};

export function normalizeIsrcValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  return ISRC_PATTERN.test(normalized) ? normalized : null;
}

function isMpegLayer3FrameHeader(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const versionBits = (bytes[1] >> 3) & 0x03;
  const layerBits = (bytes[1] >> 1) & 0x03;
  const bitrateIndex = bytes[2] >> 4;
  const sampleRateIndex = (bytes[2] >> 2) & 0x03;
  return (
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    versionBits !== 0x01 &&
    layerBits === 0x01 &&
    bitrateIndex !== 0x00 &&
    bitrateIndex !== 0x0f &&
    sampleRateIndex !== 0x03
  );
}

function detectFormat(header: Buffer): AudioFormat | null {
  if (
    header.length >= 12 &&
    header.toString("latin1", 0, 4) === "RIFF" &&
    header.toString("latin1", 8, 12) === "WAVE"
  ) {
    return "WAV";
  }
  if (header.length >= 10 && header.toString("latin1", 0, 3) === "ID3") return "MP3";
  return isMpegLayer3FrameHeader(header) ? "MP3" : null;
}

function firstText(values: Array<string | null | undefined> | undefined): string | null {
  for (const value of values ?? []) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function positiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reads metadata from a local WAV or MP3 file. Files are only opened for
 * reading; tags are never written back.
 */
export async function extractAudioMetadata(filePath: string): Promise<AudioExtractionResult> {
  const absolutePath = resolve(filePath);
  const fileName = basename(absolutePath);
  const failure = (error: AudioExtractionErrorCode, message: string): AudioExtractionResult => ({
    status: "ERROR",
    filePath: absolutePath,
    fileName,
    error,
    message
  });

  let fileSize: number;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return failure("MISSING_FILE", "Audio path is not a regular file.");
    }
    fileSize = info.size;
  } catch {
    return failure("MISSING_FILE", "Audio file does not exist or cannot be read.");
  }

  const header = Buffer.alloc(16);
  let bytesRead: number;
  try {
    const handle = await open(absolutePath, "r");
    try {
      ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }
  } catch {
    return failure("MISSING_FILE", "Audio file does not exist or cannot be read.");
  }
  const format = detectFormat(header.subarray(0, bytesRead));
  if (format === null) {
    return failure("UNSUPPORTED_FORMAT", "File content is not a supported WAV or MP3 audio file.");
  }

  const { parseStream } = await import("music-metadata");
  let parsed: Awaited<ReturnType<typeof parseStream>>;
  const stream = createReadStream(absolutePath, { flags: "r" });
  try {
    parsed = await parseStream(
      stream,
      { mimeType: MIME_TYPES[format], size: fileSize },
      { duration: true, skipCovers: true }
    );
  } catch (error) {
    return failure("INVALID_AUDIO", `Audio could not be parsed: ${(error as Error).message}`);
  } finally {
    stream.destroy();
  }

  const container = parsed.format.container?.toUpperCase() ?? "";
  const formatConfirmed =
    format === "WAV"
      ? container === "WAVE"
      : container.startsWith("MPEG") && /LAYER 3/i.test(parsed.format.codec ?? "");
  if (!formatConfirmed) {
    return failure(
      "INVALID_AUDIO",
      `Parsed container ${parsed.format.container ?? "unknown"} does not match detected ${format} content.`
    );
  }
  const durationSeconds = positiveNumber(parsed.format.duration);
  if (durationSeconds === null) {
    return failure("INVALID_AUDIO", "File does not contain decodable audio.");
  }

  const rawIsrcs = (parsed.common.isrc ?? []).map((value) => value.trim()).filter(Boolean);
  const normalizedIsrcs = rawIsrcs.map(normalizeIsrcValue);
  const distinctIsrcs = new Set(normalizedIsrcs);
  const isrc =
    distinctIsrcs.size === 1 && normalizedIsrcs[0] !== null ? normalizedIsrcs[0] : null;

  return {
    status: "OK",
    filePath: absolutePath,
    fileName,
    metadata: {
      filePath: absolutePath,
      fileName,
      format,
      extensionMatchesFormat: EXTENSIONS[format].includes(extname(fileName).toLowerCase()),
      durationSeconds,
      sampleRate: positiveNumber(parsed.format.sampleRate),
      bitDepth: positiveNumber(parsed.format.bitsPerSample),
      channels: positiveNumber(parsed.format.numberOfChannels),
      artist: firstText([parsed.common.artist, ...(parsed.common.artists ?? [])]),
      title: firstText([parsed.common.title]),
      album: firstText([parsed.common.album]),
      isrc,
      rawIsrcs,
      version: firstText(parsed.common.subtitle)
    }
  };
}

export async function extractAudioMetadataBatch(
  filePaths: string[]
): Promise<AudioExtractionResult[]> {
  const results: AudioExtractionResult[] = [];
  for (const filePath of [...filePaths].map((path) => resolve(path)).sort()) {
    results.push(await extractAudioMetadata(filePath));
  }
  return results;
}
