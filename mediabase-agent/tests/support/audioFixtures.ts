import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FixtureTags = {
  artist?: string;
  title?: string;
  album?: string;
  isrc?: string | string[];
  version?: string;
};

function id3TextFrame(id: string, text: string): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "latin1")]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(body.length, 4);
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

/** Minimal ID3v2.3 tag with Latin-1 text frames. */
export function buildId3Tag(tags: FixtureTags): Buffer {
  const frames: Buffer[] = [];
  if (tags.artist) frames.push(id3TextFrame("TPE1", tags.artist));
  if (tags.title) frames.push(id3TextFrame("TIT2", tags.title));
  if (tags.album) frames.push(id3TextFrame("TALB", tags.album));
  if (tags.version) frames.push(id3TextFrame("TIT3", tags.version));
  for (const isrc of [tags.isrc ?? []].flat()) frames.push(id3TextFrame("TSRC", isrc));
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00", "latin1"), syncSafe(body.length), body]);
}

function riffChunk(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  const padding = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, data, padding]);
}

export type WavFixtureOptions = {
  sampleRate?: number;
  bitDepth?: 16 | 24;
  channels?: number;
  durationSeconds?: number;
  /** Tags written to a RIFF LIST/INFO chunk (artist, title, album only). */
  riffInfo?: Pick<FixtureTags, "artist" | "title" | "album">;
  /** Tags written to an embedded `id3 ` chunk, including ISRC and version. */
  id3?: FixtureTags;
};

export function buildWav(options: WavFixtureOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 8000;
  const bitDepth = options.bitDepth ?? 16;
  const channels = options.channels ?? 1;
  const blockAlign = channels * (bitDepth / 8);
  const frameCount = Math.round(sampleRate * (options.durationSeconds ?? 0.5));

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitDepth, 14);

  const chunks = [riffChunk("fmt ", fmt), riffChunk("data", Buffer.alloc(frameCount * blockAlign))];
  if (options.riffInfo) {
    const infoEntries = (
      [
        ["IART", options.riffInfo.artist],
        ["INAM", options.riffInfo.title],
        ["IPRD", options.riffInfo.album]
      ] as const
    )
      .filter(([, value]) => value)
      .map(([id, value]) => riffChunk(id, Buffer.from(`${value}\0`, "latin1")));
    chunks.push(riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "latin1"), ...infoEntries])));
  }
  if (options.id3) chunks.push(riffChunk("id3 ", buildId3Tag(options.id3)));

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
