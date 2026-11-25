import NodeID3 = require("node-id3");
import type { AudioTagField, AudioTagValues } from "./audioTagProfile";

export class AudioTagFormatError extends Error {
  constructor(readonly code: string, readonly field: AudioTagField | null, message: string) {
    super(message);
  }
}

type Frame = { id: string; bytes: Buffer; body: Buffer; flags: number };
type ParsedTag = { version: 3 | 4; end: number; frames: Frame[]; padding: Buffer };

const FIELD_FRAMES: Partial<Record<AudioTagField, readonly string[]>> = {
  title: ["TIT2"], artist: ["TPE1"], album: ["TALB"], isrc: ["TSRC"],
  version: ["TIT3"], genre: ["TCON"], year: ["TYER", "TDRC"],
  albumArtist: ["TPE2"], comments: ["COMM"]
};

function syncSafeNumber(bytes: Buffer): number {
  if (bytes.length !== 4 || [...bytes].some((byte) => (byte & 0x80) !== 0)) {
    throw new AudioTagFormatError("MALFORMED_ID3", null, "Invalid ID3 sync-safe size.");
  }
  return (bytes[0] * 0x200000) + (bytes[1] * 0x4000) + (bytes[2] * 0x80) + bytes[3];
}

function syncSafeBytes(size: number): Buffer {
  if (!Number.isInteger(size) || size < 0 || size > 0x0fffffff) {
    throw new AudioTagFormatError("ID3_SIZE_UNSUPPORTED", null, "ID3 tag or frame exceeds the supported size.");
  }
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
}

function parseId3(bytes: Buffer): ParsedTag {
  if (bytes.length < 3 || bytes.toString("latin1", 0, 3) !== "ID3") {
    return { version: 3, end: 0, frames: [], padding: Buffer.alloc(0) };
  }
  if (bytes.length < 10 || (bytes[3] !== 3 && bytes[3] !== 4) || bytes[4] !== 0 || bytes[5] !== 0) {
    throw new AudioTagFormatError("UNSUPPORTED_ID3_VARIANT", null, "ID3 version, header flags, or revision is unsupported.");
  }
  const version = bytes[3] as 3 | 4;
  const end = 10 + syncSafeNumber(bytes.subarray(6, 10));
  if (end > bytes.length) throw new AudioTagFormatError("MALFORMED_ID3", null, "ID3 tag is truncated.");
  const frames: Frame[] = [];
  let offset = 10;
  while (offset < end && bytes[offset] !== 0) {
    if (offset + 10 > end) throw new AudioTagFormatError("MALFORMED_ID3", null, "ID3 frame header is truncated.");
    const id = bytes.toString("latin1", offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) throw new AudioTagFormatError("MALFORMED_ID3", null, "ID3 frame identifier is invalid.");
    const size = version === 4 ? syncSafeNumber(bytes.subarray(offset + 4, offset + 8)) : bytes.readUInt32BE(offset + 4);
    const frameEnd = offset + 10 + size;
    if (frameEnd > end) throw new AudioTagFormatError("MALFORMED_ID3", null, "ID3 frame exceeds its tag.");
    frames.push({
      id, bytes: bytes.subarray(offset, frameEnd), body: bytes.subarray(offset + 10, frameEnd),
      flags: bytes.readUInt16BE(offset + 8)
    });
    offset = frameEnd;
  }
  const padding = bytes.subarray(offset, end);
  if (padding.some((byte) => byte !== 0)) throw new AudioTagFormatError("MALFORMED_ID3", null, "Invalid ID3 padding.");

  for (const [field, ids] of Object.entries(FIELD_FRAMES) as Array<[AudioTagField, readonly string[]]>) {
    if (field === "comments") continue;
    const matching = frames.filter((frame) => ids.includes(frame.id));
    if (matching.length > 1) {
      throw new AudioTagFormatError("DUPLICATE_ID3_FRAME", field, "A mapped ID3 field has multiple frames.");
    }
    if (matching.some((frame) => frame.flags !== 0)) {
      throw new AudioTagFormatError("UNSUPPORTED_ID3_FRAME", field, "A mapped ID3 frame uses unsupported flags.");
    }
  }
  return { version, end, frames, padding };
}

function isDefaultComment(frame: Frame): boolean {
  if (frame.id !== "COMM") return false;
  if (frame.flags !== 0 || frame.body.length < 5) {
    throw new AudioTagFormatError("UNSUPPORTED_ID3_FRAME", "comments", "An ID3 comment frame is malformed or has unsupported flags.");
  }
  const encoding = frame.body[0];
  if (encoding === 0 || encoding === 3) return frame.body[4] === 0;
  if (encoding === 1 || encoding === 2) {
    const start = frame.body[4] === 0xff && frame.body[5] === 0xfe ||
      frame.body[4] === 0xfe && frame.body[5] === 0xff ? 6 : 4;
    return frame.body.length >= start + 2 && frame.body[start] === 0 && frame.body[start + 1] === 0;
  }
  throw new AudioTagFormatError("UNSUPPORTED_ID3_FRAME", "comments", "ID3 comment encoding is unsupported.");
}

function makeFrame(id: string, body: Buffer, version: 3 | 4): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  if (version === 4) syncSafeBytes(body.length).copy(header, 4);
  else header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function textBytes(value: string, version: 3 | 4): Buffer {
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new AudioTagFormatError("UNSUPPORTED_TAG_VALUE", null, "A tag value contains invalid Unicode.");
  }
  return version === 4
    ? Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")])
    : Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, "utf16le")]);
}

function commentBytes(value: string, version: 3 | 4): Buffer {
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new AudioTagFormatError("UNSUPPORTED_TAG_VALUE", "comments", "A comment contains invalid Unicode.");
  }
  if (version === 4) return Buffer.concat([Buffer.from([3]), Buffer.from("eng\0", "latin1"), Buffer.from(value, "utf8")]);
  return Buffer.concat([
    Buffer.from([1]), Buffer.from("eng", "latin1"), Buffer.from([0xff, 0xfe, 0, 0, 0xff, 0xfe]),
    Buffer.from(value, "utf16le")
  ]);
}

/** Reads the tag with node-id3, independently of the narrow frame-preserving writer. */
export function readId3Values(bytes: Buffer, requireTagOnly = false): AudioTagValues {
  const parsed = parseId3(bytes);
  if (requireTagOnly && parsed.end !== bytes.length) {
    throw new AudioTagFormatError("MALFORMED_ID3", null, "Embedded ID3 chunk contains trailing bytes.");
  }
  if (!parsed.end) return {};
  const tags = NodeID3.read(bytes.subarray(0, parsed.end));
  const values: AudioTagValues = {
    title: tags.title, artist: tags.artist, album: tags.album, isrc: tags.ISRC,
    version: tags.subtitle, genre: tags.genre, year: tags.recordingTime ?? tags.year,
    albumArtist: tags.performerInfo, comments: tags.comment?.text
  };
  for (const [field, value] of Object.entries(values) as Array<[AudioTagField, string | undefined]>) {
    if (value?.includes("\0")) {
      throw new AudioTagFormatError("MULTIPLE_ID3_VALUES", field, "A mapped ID3 frame contains multiple values.");
    }
  }
  return values;
}

/** ID3v1 is preserved, not rewritten; conflicting legacy values must block. */
export async function readId3v1Values(bytes: Buffer): Promise<AudioTagValues> {
  if (bytes.length < 128 || bytes.toString("latin1", bytes.length - 128, bytes.length - 125) !== "TAG") return {};
  const tag = bytes.subarray(bytes.length - 128);
  const text = (start: number, end: number) => tag.subarray(start, end).toString("latin1").replace(/\0.*$/u, "").trim() || undefined;
  const commentEnd = tag[125] === 0 && tag[126] !== 0 ? 125 : 127;
  let genre: string | undefined;
  if (tag[127] !== 255) {
    const { parseBuffer } = await import("music-metadata");
    const parsed = await parseBuffer(bytes, { mimeType: "audio/mpeg", size: bytes.length }, { skipCovers: true });
    const entry = parsed.native.ID3v1?.find((item) => item.id === "genre");
    if (typeof entry?.value !== "string" || !entry.value.trim()) {
      throw new AudioTagFormatError("UNSUPPORTED_TAG_MAPPING", "genre", "The preserved ID3v1 genre cannot be interpreted safely.");
    }
    genre = entry.value;
  }
  return {
    title: text(3, 33), artist: text(33, 63), album: text(63, 93),
    year: text(93, 97), comments: text(97, commentEnd), genre
  };
}

function equalTag(field: AudioTagField, left: string, right: string): boolean {
  if (field === "year") return left.slice(0, 4) === right;
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  return normalize(left) === normalize(right);
}

/** Replaces only requested frames, preserving every unrelated frame byte-for-byte. */
export function updateId3Values(bytes: Buffer, values: AudioTagValues, requireTagOnly = false): Buffer {
  const parsed = parseId3(bytes);
  if (requireTagOnly && parsed.end !== bytes.length) {
    throw new AudioTagFormatError("MALFORMED_ID3", null, "Embedded ID3 chunk contains trailing bytes.");
  }
  const existing = readId3Values(bytes, requireTagOnly);
  const replacements = new Map<string, Buffer>();
  const removed = new Set<string>();
  for (const [field, value] of Object.entries(values) as Array<[AudioTagField, string | undefined]>) {
    const ids = FIELD_FRAMES[field];
    if (!value || !ids || (existing[field] && equalTag(field, existing[field]!, value))) continue;
    const id = field === "year" ? (parsed.version === 4 ? "TDRC" : "TYER") : ids[0];
    const body = field === "comments" ? commentBytes(value, parsed.version) : textBytes(value, parsed.version);
    replacements.set(id, makeFrame(id, body, parsed.version));
    ids.forEach((item) => removed.add(item));
  }
  const defaultComments = parsed.frames.filter(isDefaultComment);
  if (defaultComments.length > 1) {
    throw new AudioTagFormatError("DUPLICATE_ID3_FRAME", "comments", "Multiple default ID3 comments are ambiguous.");
  }
  const kept = parsed.frames.filter((frame) =>
    frame.id === "COMM" ? !(removed.has("COMM") && isDefaultComment(frame)) : !removed.has(frame.id));
  const newFrames = [...replacements.values()];
  const body = Buffer.concat([...newFrames, ...kept.map((frame) => frame.bytes), parsed.padding]);
  const header = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, parsed.version, 0, 0]), syncSafeBytes(body.length)]);
  return Buffer.concat([header, body, bytes.subarray(parsed.end)]);
}
