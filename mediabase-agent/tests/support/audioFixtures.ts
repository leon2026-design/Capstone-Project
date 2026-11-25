import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FixtureTags = {
  artist?: string;
  albumArtist?: string;
  title?: string;
  album?: string;
  genre?: string;
  year?: string;
  comments?: string;
  isrc?: string | string[];
  version?: string;
};

function id3TextFrame(id: string, text: string, version: 3 | 4): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "latin1")]);
  return buildId3Frame(id, body, version);
}

export function buildId3Frame(id: string, body: Buffer, version: 3 | 4 = 3): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  if (version === 4) syncSafe(body.length).copy(header, 4);
  else header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function syncSafe(size: number): Buffer {
  return Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f
  ]);
}

/** Minimal ID3v2.3/v2.4 tag with Latin-1 text frames. */
export function buildId3Tag(tags: FixtureTags, version: 3 | 4 = 3, additionalFrames: readonly Buffer[] = []): Buffer {
  const frames: Buffer[] = [];
  if (tags.artist) frames.push(id3TextFrame("TPE1", tags.artist, version));
  if (tags.albumArtist) frames.push(id3TextFrame("TPE2", tags.albumArtist, version));
  if (tags.title) frames.push(id3TextFrame("TIT2", tags.title, version));
  if (tags.album) frames.push(id3TextFrame("TALB", tags.album, version));
  if (tags.genre) frames.push(id3TextFrame("TCON", tags.genre, version));
  if (tags.year) frames.push(id3TextFrame(version === 4 ? "TDRC" : "TYER", tags.year, version));
  if (tags.version) frames.push(id3TextFrame("TIT3", tags.version, version));
  for (const isrc of [tags.isrc ?? []].flat()) frames.push(id3TextFrame("TSRC", isrc, version));
  if (tags.comments) {
    const text = Buffer.from(tags.comments, "latin1");
    const body = Buffer.concat([Buffer.from([0x00]), Buffer.from("eng", "latin1"), Buffer.from([0x00]), text]);
    frames.push(buildId3Frame("COMM", body, version));
  }
  const body = Buffer.concat([...frames, ...additionalFrames]);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, version, 0, 0]), syncSafe(body.length), body]);
}

export function buildId3v1Tag(tags: FixtureTags, genreCode = 255): Buffer {
  const tag = Buffer.alloc(128);
  tag.write("TAG", 0, "latin1");
  for (const [value, offset, length] of [
    [tags.title, 3, 30], [tags.artist, 33, 30], [tags.album, 63, 30],
    [tags.year, 93, 4], [tags.comments, 97, 30]
  ] as const) {
    if (value) Buffer.from(value, "latin1").copy(tag, offset, 0, length);
  }
  tag[127] = genreCode;
  return tag;
}

export function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  const padding = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, data, padding]);
}

export type WavFixtureOptions = {
  sampleRate?: number;
  bitDepth?: 16 | 24 | 32 | 64;
  channels?: number;
  durationSeconds?: number;
  codec?: "PCM" | "IEEE_FLOAT";
  /** Tags written to a RIFF LIST/INFO chunk (artist, title, album only). */
  riffInfo?: Pick<FixtureTags, "artist" | "title" | "album" | "genre" | "year" | "comments">;
  /** Tags written to an embedded `id3 ` chunk, including ISRC and version. */
  id3?: FixtureTags;
  id3Bytes?: Buffer;
  ancillaryChunks?: ReadonlyArray<{ id: string; data: Buffer }>;
  extraInfo?: ReadonlyArray<{ id: string; data: Buffer }>;
  extensible?: boolean;
};

export function buildWav(options: WavFixtureOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 8000;
  const bitDepth = options.bitDepth ?? 16;
  const channels = options.channels ?? 1;
  const blockAlign = channels * (bitDepth / 8);
  const frameCount = Math.round(sampleRate * (options.durationSeconds ?? 0.5));

  const fmt = Buffer.alloc(options.extensible ? 40 : 16);
  const codecId = options.codec === "IEEE_FLOAT" ? 3 : 1;
  fmt.writeUInt16LE(options.extensible ? 0xfffe : codecId, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitDepth, 14);
  if (options.extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bitDepth, 18);
    Buffer.from(codecId === 3 ? "0300000000001000800000aa00389b71" : "0100000000001000800000aa00389b71", "hex").copy(fmt, 24);
  }

  const chunks = [
    riffChunk("fmt ", fmt),
    ...(options.ancillaryChunks ?? []).map((chunk) => riffChunk(chunk.id, chunk.data)),
    riffChunk("data", Buffer.alloc(frameCount * blockAlign))
  ];
  if (options.riffInfo || options.extraInfo?.length) {
    const infoEntries = (
      [
        ["IART", options.riffInfo?.artist],
        ["INAM", options.riffInfo?.title],
        ["IPRD", options.riffInfo?.album],
        ["IGNR", options.riffInfo?.genre],
        ["ICRD", options.riffInfo?.year],
        ["ICMT", options.riffInfo?.comments]
      ] as const
    )
      .filter(([, value]) => value)
      .map(([id, value]) => riffChunk(id, Buffer.from(`${value}\0`, "latin1")));
    chunks.push(riffChunk("LIST", Buffer.concat([
      Buffer.from("INFO", "latin1"), ...infoEntries,
      ...(options.extraInfo ?? []).map((entry) => riffChunk(entry.id, entry.data))
    ])));
  }
  if (options.id3Bytes || options.id3) chunks.push(riffChunk("id3 ", options.id3Bytes ?? buildId3Tag(options.id3!)));

  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo frames of silence. */
export function buildMp3(tags?: FixtureTags, frameCount = 40): Buffer {
  const frameLength = Math.floor((144 * 128000) / 44100);
  const frames = Array.from({ length: frameCount }, () => {
    const frame = Buffer.alloc(frameLength);
    frame.set([0xff, 0xfb, 0x90, 0x00], 0);
    return frame;
  });
  return Buffer.concat([tags ? buildId3Tag(tags) : Buffer.alloc(0), ...frames]);
}

export function writeFixture(path: string, contents: Buffer | string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}
