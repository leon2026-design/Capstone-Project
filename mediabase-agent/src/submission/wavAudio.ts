import { normalizeIsrcValue } from "../audio/audioMetadata";
import { AudioTagFormatError, readId3Values, updateId3Values } from "./audioId3";
import type { AudioTagField, AudioTagValues } from "./audioTagProfile";

type Chunk = { id: string; data: Buffer; raw: Buffer };
type InfoEntry = Chunk & { field: AudioTagField | null };

export type WaveInspection = {
  chunks: Chunk[];
  info: InfoEntry[] | null;
  infoEncoding: "latin1" | "windows-1252" | "utf8";
  id3: AudioTagValues;
  infoValues: Partial<Record<AudioTagField, string[]>>;
  pcm: Buffer;
  format: {
    codec: "PCM" | "IEEE_FLOAT";
    channels: number;
    sampleRate: number;
    bitDepth: number;
    validBits: number;
    blockAlign: number;
    sampleFrames: number;
    durationSeconds: number;
  };
};

const INFO_FIELDS: Readonly<Record<string, AudioTagField>> = {
  INAM: "title", TITL: "title", IART: "artist", IPRD: "album", IRPD: "album",
  ICRD: "year", YEAR: "year", IGNR: "genre", GNRE: "genre", ICMT: "comments", COMM: "comments"
};
const DEFAULT_INFO_IDS: Partial<Record<AudioTagField, string>> = {
  title: "INAM", artist: "IART", album: "IPRD", year: "ICRD", genre: "IGNR", comments: "ICMT"
};
const PCM_GUID = Buffer.from("0100000000001000800000aa00389b71", "hex");
const FLOAT_GUID = Buffer.from("0300000000001000800000aa00389b71", "hex");

function chunksFrom(bytes: Buffer, start: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new AudioTagFormatError("MALFORMED_WAV", null, "RIFF chunk header is truncated.");
    const size = bytes.readUInt32LE(offset + 4);
    const payloadEnd = offset + 8 + size;
    const paddedEnd = payloadEnd + (size & 1);
    if (paddedEnd > end) throw new AudioTagFormatError("MALFORMED_WAV", null, "RIFF chunk exceeds its container.");
    chunks.push({
      id: bytes.toString("latin1", offset, offset + 4),
      data: bytes.subarray(offset + 8, payloadEnd),
      raw: bytes.subarray(offset, paddedEnd)
    });
    offset = paddedEnd;
  }
  return chunks;
}

function makeChunk(id: string, data: Buffer): Buffer {
  if (data.length > 0xffffffff) throw new AudioTagFormatError("UNSUPPORTED_WAV_VARIANT", null, "RIFF chunk is too large.");
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function decodeInfo(data: Buffer, encoding: WaveInspection["infoEncoding"]): string {
  const zero = data.indexOf(0);
  if (zero >= 0 && data.subarray(zero).some((byte) => byte !== 0)) {
    throw new AudioTagFormatError("MALFORMED_WAV_INFO", null, "RIFF INFO field contains multiple values.");
  }
  const text = zero < 0 ? data : data.subarray(0, zero);
  try {
    return encoding === "latin1" ? text.toString("latin1") : new TextDecoder(encoding, { fatal: true }).decode(text);
  } catch {
    throw new AudioTagFormatError("MALFORMED_WAV_INFO", null, "RIFF INFO field has invalid text encoding.");
  }
}

function encodeInfo(value: string, encoding: WaveInspection["infoEncoding"], field: AudioTagField): Buffer {
  if (Buffer.from(value, "utf8").toString("utf8") !== value || /\p{Cc}/u.test(value)) {
    throw new AudioTagFormatError("UNSUPPORTED_TAG_VALUE", field, "RIFF INFO value contains invalid text.");
  }
  if (encoding !== "utf8" && [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code > 0xff || code >= 0x80 && code <= 0x9f;
  })) {
    throw new AudioTagFormatError("UNSUPPORTED_TAG_MAPPING", field, "The existing RIFF INFO encoding cannot represent this value safely.");
  }
  return Buffer.concat([Buffer.from(value, encoding === "utf8" ? "utf8" : "latin1"), Buffer.from([0])]);
}

function waveFormat(fmt: Buffer, data: Buffer): WaveInspection["format"] {
  if (fmt.length < 16) throw new AudioTagFormatError("MALFORMED_WAV", null, "WAV format chunk is truncated.");
  const tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const byteRate = fmt.readUInt32LE(8);
  const blockAlign = fmt.readUInt16LE(12);
  const bitDepth = fmt.readUInt16LE(14);
  let validBits = bitDepth;
  let codec: "PCM" | "IEEE_FLOAT";
  if (tag === 1) codec = "PCM";
  else if (tag === 3) codec = "IEEE_FLOAT";
  else if (tag === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22 || 18 + fmt.readUInt16LE(16) > fmt.length) {
      throw new AudioTagFormatError("MALFORMED_WAV", null, "Extensible WAV format is truncated.");
    }
    validBits = fmt.readUInt16LE(18);
    const guid = fmt.subarray(24, 40);
    if (guid.equals(PCM_GUID)) codec = "PCM";
    else if (guid.equals(FLOAT_GUID)) codec = "IEEE_FLOAT";
    else throw new AudioTagFormatError("UNSUPPORTED_WAV_VARIANT", null, "WAV extensible subformat is not PCM or IEEE float.");
  } else {
    throw new AudioTagFormatError("UNSUPPORTED_WAV_VARIANT", null, "Compressed WAV formats are not supported.");
  }
  if (!channels || !sampleRate || !bitDepth || bitDepth % 8 !== 0 || !validBits || validBits > bitDepth ||
    blockAlign !== channels * bitDepth / 8 || byteRate !== sampleRate * blockAlign ||
    !data.length || data.length % blockAlign !== 0 ||
    codec === "IEEE_FLOAT" && bitDepth !== 32 && bitDepth !== 64) {
    throw new AudioTagFormatError("MALFORMED_WAV", null, "WAV format and PCM data are inconsistent.");
  }
  const sampleFrames = data.length / blockAlign;
  return { codec, channels, sampleRate, bitDepth, validBits, blockAlign, sampleFrames, durationSeconds: sampleFrames / sampleRate };
}

export function inspectWave(bytes: Buffer): WaveInspection {
  const magic = bytes.toString("latin1", 0, 4);
  if (magic === "RF64" || magic === "RIFX" || magic === "BW64") {
    throw new AudioTagFormatError("UNSUPPORTED_WAV_VARIANT", null, "RF64, BW64, and big-endian WAV are not supported.");
  }
  if (bytes.length < 12 || magic !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new AudioTagFormatError("MALFORMED_WAV", null, "RIFF/WAVE header or container size is invalid.");
  }
  const chunks = chunksFrom(bytes, 12, bytes.length);
  const formats = chunks.filter((item) => item.id === "fmt ");
  const data = chunks.filter((item) => item.id === "data");
  const id3Chunks = chunks.filter((item) => item.id === "id3 " || item.id === "ID3 ");
  const lists = chunks.filter((item) => item.id === "LIST" && item.data.toString("latin1", 0, 4) === "INFO");
  const csets = chunks.filter((item) => item.id === "CSET");
  if (formats.length !== 1 || data.length !== 1 || id3Chunks.length > 1 || lists.length > 1 || csets.length > 1 ||
    chunks.indexOf(formats[0]) > chunks.indexOf(data[0])) {
    throw new AudioTagFormatError("AMBIGUOUS_WAV_CHUNKS", null, "WAV contains missing, duplicate, or ambiguously ordered chunks.");
  }
  if (chunks.some((item) => item.id === "LIST" && item.data.length < 4)) {
    throw new AudioTagFormatError("MALFORMED_WAV", null, "WAV LIST chunk lacks its type.");
  }
  let infoEncoding: WaveInspection["infoEncoding"] = "latin1";
  if (csets.length) {
    if (csets[0].data.length < 8) throw new AudioTagFormatError("MALFORMED_WAV", null, "RIFF CSET chunk is truncated.");
    const codePage = csets[0].data.readUInt16LE(0);
    if (codePage === 1252) infoEncoding = "windows-1252";
    else if (codePage === 65001) infoEncoding = "utf8";
    else if (codePage !== 0 && codePage !== 28591) {
      throw new AudioTagFormatError("UNSUPPORTED_TAG_MAPPING", null, "RIFF INFO code page is unsupported.");
    }
  }
  const info: InfoEntry[] | null = lists.length
    ? chunksFrom(lists[0].data, 4, lists[0].data.length).map((chunk) => ({ ...chunk, field: INFO_FIELDS[chunk.id] ?? null }))
    : null;
  const infoValues: WaveInspection["infoValues"] = {};
  for (const entry of info ?? []) {
    if (!entry.field) continue;
    const text = decodeInfo(entry.data, infoEncoding).trim();
    if (text) (infoValues[entry.field] ??= []).push(text);
  }
  return {
    chunks, info, infoEncoding, infoValues,
    id3: id3Chunks.length ? readId3Values(id3Chunks[0].data, true) : {},
    pcm: data[0].data,
    format: waveFormat(formats[0].data, data[0].data)
  };
}

export function waveTagAgrees(field: AudioTagField, actual: string, expected: string): boolean {
  if (field === "isrc") return normalizeIsrcValue(actual) !== null && normalizeIsrcValue(actual) === normalizeIsrcValue(expected);
  if (field === "year") return actual.slice(0, 4) === expected;
  return actual.normalize("NFKC").trim().toLowerCase() === expected.normalize("NFKC").trim().toLowerCase();
}

/** Rewrites only supported ID3/INFO fields; other RIFF chunks and INFO entries are copied verbatim. */
export function updateWaveTags(source: Buffer, values: AudioTagValues): Buffer {
  const inspected = inspectWave(source);
  const originalId3 = inspected.chunks.find((item) => item.id === "id3 " || item.id === "ID3 ");
  const id3 = updateId3Values(originalId3?.data ?? Buffer.alloc(0), values, true);
  const updatedInfo: Buffer | null = inspected.info === null ? null : (() => {
    const seen = new Set<AudioTagField>();
    const entries = inspected.info!.map((entry) => {
      if (!entry.field) return entry.raw;
      const expected = values[entry.field];
      if (!expected) return entry.raw;
      seen.add(entry.field);
      const actual = decodeInfo(entry.data, inspected.infoEncoding);
      return waveTagAgrees(entry.field, actual, expected)
        ? entry.raw
        : makeChunk(entry.id, encodeInfo(expected, inspected.infoEncoding, entry.field));
    });
    for (const [field, id] of Object.entries(DEFAULT_INFO_IDS) as Array<[AudioTagField, string]>) {
      const value = values[field];
      if (value && !seen.has(field)) entries.push(makeChunk(id, encodeInfo(value, inspected.infoEncoding, field)));
    }
    return Buffer.concat([Buffer.from("INFO", "latin1"), ...entries]);
  })();
  const output: Buffer[] = [];
  for (const chunk of inspected.chunks) {
    if (chunk === originalId3) output.push(makeChunk(chunk.id, id3));
    else if (updatedInfo && chunk.id === "LIST" && chunk.data.toString("latin1", 0, 4) === "INFO") {
      output.push(makeChunk("LIST", updatedInfo));
    } else output.push(chunk.raw);
  }
  if (!originalId3) output.push(makeChunk("id3 ", id3));
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...output]);
  if (body.length > 0xffffffff) throw new AudioTagFormatError("UNSUPPORTED_WAV_VARIANT", null, "Prepared WAV exceeds RIFF limits.");
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function waveAudioUnchanged(source: Buffer, prepared: Buffer): boolean {
  const original = inspectWave(source);
  const result = inspectWave(prepared);
  if (!original.pcm.equals(result.pcm) || JSON.stringify(original.format) !== JSON.stringify(result.format)) return false;
  const unchanged = (wave: WaveInspection) => wave.chunks.filter((chunk) =>
    chunk.id !== "id3 " && chunk.id !== "ID3 " &&
    !(chunk.id === "LIST" && chunk.data.toString("latin1", 0, 4) === "INFO"));
  const left = unchanged(original);
  const right = unchanged(result);
  if (left.length !== right.length || left.some((chunk, index) => !chunk.raw.equals(right[index].raw))) return false;
  const unknownInfo = (wave: WaveInspection) => (wave.info ?? []).filter((entry) => entry.field === null);
  const leftInfo = unknownInfo(original);
  const rightInfo = unknownInfo(result);
  return leftInfo.length === rightInfo.length && leftInfo.every((entry, index) => entry.raw.equals(rightInfo[index].raw));
}

/** Verifies both representations with music-metadata and node-id3, independent of the writer. */
export async function verifyWaveTags(bytes: Buffer, values: AudioTagValues): Promise<boolean> {
  const wave = inspectWave(bytes);
  const { parseBuffer } = await import("music-metadata");
  const independentlyParsed = await parseBuffer(bytes, { mimeType: "audio/wav", size: bytes.length }, { duration: true, skipCovers: true });
  const nativeInfo = independentlyParsed.native.exif ?? [];
  for (const [field, expected] of Object.entries(values) as Array<[AudioTagField, string | undefined]>) {
    if (!expected) continue;
    const id3 = wave.id3[field];
    if (!id3 || !waveTagAgrees(field, id3, expected)) return false;
    if (wave.info && DEFAULT_INFO_IDS[field]) {
      const ids = Object.entries(INFO_FIELDS).filter(([, mapped]) => mapped === field).map(([id]) => id);
      const readBack = nativeInfo.filter((item) => ids.includes(item.id)).map((item) => item.value);
      if (!readBack.length || readBack.some((value) => typeof value !== "string" || !waveTagAgrees(field, value, expected))) return false;
    }
  }
  return true;
}
