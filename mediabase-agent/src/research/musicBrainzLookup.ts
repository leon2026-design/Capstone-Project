import type { DemoRecording } from "../metadata/recordValidation";

export type MusicBrainzReleaseCandidate = {
  musicBrainzId: string;
  title: string;
  date: string | null;
  country: string | null;
  barcode: string | null;
  sourceUrl: string;
};

export type MusicBrainzCandidate = {
  musicBrainzId: string;
  title: string;
  artistCredit: string;
  sourceUrl: string;
  releases: MusicBrainzReleaseCandidate[];
  releaseListMayBeIncomplete: true;
};

export type MusicBrainzLookupResult = {
  recordingId: string;
  queriedIsrc: string | null;
  status: "NEEDS_REVIEW" | "NO_MATCH" | "INVALID_ISRC" | "FAILED";
  candidates: MusicBrainzCandidate[];
  requiresHumanReview: true;
  error: "HTTP_ERROR" | "REQUEST_FAILED" | "INVALID_RESPONSE" | null;
};

type LookupRecording = Readonly<
  Pick<DemoRecording, "recordingId" | "isrc">
>;

type LookupOptions = {
  userAgent: string;
  /** Injectable so tests do not contact MusicBrainz. */
  fetch?: typeof globalThis.fetch;
};

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const MBID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Spaces requests from this module in this Node process.
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestStarted = 0;

function schedule<T>(operation: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - lastRequestStarted));

    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    lastRequestStarted = Date.now();
    return operation();
  });

  requestQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseRelease(value: unknown): MusicBrainzReleaseCandidate {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !MBID_PATTERN.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim()
  ) {
    throw new Error("Invalid MusicBrainz release.");
  }

  return {
    musicBrainzId: value.id,
    title: value.title,
    // Preserve partial dates without inventing a month or day.
    date: optionalText(value.date),
    country: optionalText(value.country),
    // Keep barcodes as strings to preserve leading zeros.
    barcode: optionalText(value.barcode),
    sourceUrl: `https://musicbrainz.org/release/${value.id}`
  };
}

function parseCandidate(value: unknown): MusicBrainzCandidate {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !MBID_PATTERN.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    !Array.isArray(value["artist-credit"])
  ) {
    throw new Error("Invalid MusicBrainz recording.");
  }

  const artistCredit = value["artist-credit"].map((credit: unknown) => {
    if (!isObject(credit) || typeof credit.name !== "string") {
      throw new Error("Invalid MusicBrainz artist credit.");
    }

    return credit.name +
      (typeof credit.joinphrase === "string" ? credit.joinphrase : "");
  }).join("");

  const releases = value.releases;

  if (releases !== undefined && !Array.isArray(releases)) {
    throw new Error("Invalid MusicBrainz release list.");
  }

  return {
    musicBrainzId: value.id,
    title: value.title,
    artistCredit,
    sourceUrl: `https://musicbrainz.org/recording/${value.id}`,
    releases: Array.isArray(releases) ? releases.map(parseRelease) : [],
    releaseListMayBeIncomplete: true
  };
}

/**
 * Read-only ISRC lookup.
 * Results are catalog candidates requiring human review.
 * It never changes recording fields or approval decisions.
 */
export async function lookupMusicBrainzByIsrc(
  record: LookupRecording,
  options: LookupOptions
): Promise<MusicBrainzLookupResult> {
  const recordingId = record.recordingId;
  const isrc = record.isrc ?? null;

  const base = {
    recordingId,
    queriedIsrc: isrc,
    candidates: [] as MusicBrainzCandidate[],
    requiresHumanReview: true as const,
    error: null
  };

  if (!isrc || !ISRC_PATTERN.test(isrc)) {
    return { ...base, status: "INVALID_ISRC" };
  }

  if (!options.userAgent.trim()) {
    throw new Error("A MusicBrainz application User-Agent is required.");
  }

  const fetchSource = options.fetch ?? globalThis.fetch;
  const userAgent = options.userAgent;

  return schedule(async () => {
    try {
      const response = await fetchSource(
        `https://musicbrainz.org/ws/2/isrc/${isrc}?inc=artist-credits+releases&fmt=json`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": userAgent
          },
          signal: AbortSignal.timeout(10_000),
          redirect: "error"
        }
      );

      if (response.status === 404) {
        return { ...base, status: "NO_MATCH" };
      }

      if (!response.ok) {
        return { ...base, status: "FAILED", error: "HTTP_ERROR" };
      }

      try {
        const data: unknown = await response.json();

        if (
          !isObject(data) ||
          data.isrc !== isrc ||
          !Array.isArray(data.recordings)
        ) {
          throw new Error("Invalid MusicBrainz response.");
        }

        const candidates = data.recordings.map(parseCandidate);

        return {
          ...base,
          status: candidates.length > 0 ? "NEEDS_REVIEW" : "NO_MATCH",
          candidates
        };
      } catch {
        return { ...base, status: "FAILED", error: "INVALID_RESPONSE" };
      }
    } catch {
      return { ...base, status: "FAILED", error: "REQUEST_FAILED" };
    }
  });
}
export type MusicBrainzReleaseLookupResult = {
  musicBrainzId: string;
  status: "NEEDS_REVIEW" | "NO_MATCH" | "INVALID_RECORDING_ID" | "FAILED";
  releases: MusicBrainzReleaseCandidate[];
  releaseListMayBeIncomplete: true;
  requiresHumanReview: true;
  error: "HTTP_ERROR" | "REQUEST_FAILED" | "INVALID_RESPONSE" | null;
};

/**
 * Retrieves linked releases for one selected MusicBrainz recording.
 * Uses the same request queue as the ISRC lookup.
 * Does not select a release or apply metadata to a recording.
 */
export async function lookupMusicBrainzReleases(
  musicBrainzId: string,
  options: LookupOptions
): Promise<MusicBrainzReleaseLookupResult> {
  const base = {
    musicBrainzId,
    releases: [] as MusicBrainzReleaseCandidate[],
    releaseListMayBeIncomplete: true as const,
    requiresHumanReview: true as const,
    error: null
  };

  if (!MBID_PATTERN.test(musicBrainzId)) {
    return { ...base, status: "INVALID_RECORDING_ID" };
  }

  if (!options.userAgent.trim()) {
    throw new Error("A MusicBrainz application User-Agent is required.");
  }

  const fetchSource = options.fetch ?? globalThis.fetch;
  const userAgent = options.userAgent;

  return schedule(async () => {
    try {
      const response = await fetchSource(
        `https://musicbrainz.org/ws/2/recording/${musicBrainzId}?inc=artist-credits%2Breleases&fmt=json`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": userAgent
          },
          signal: AbortSignal.timeout(10_000),
          redirect: "error"
        }
      );

      if (response.status === 404) {
        return { ...base, status: "NO_MATCH" };
      }

      if (!response.ok) {
        return { ...base, status: "FAILED", error: "HTTP_ERROR" };
      }

      try {
        const data: unknown = await response.json();

        if (
          !isObject(data) ||
          data.id !== musicBrainzId ||
          !Array.isArray(data.releases)
        ) {
          throw new Error("Invalid MusicBrainz release response.");
        }

        const releases = data.releases.map(parseRelease);

        return {
          ...base,
          status: releases.length > 0 ? "NEEDS_REVIEW" : "NO_MATCH",
          releases
        };
      } catch {
        return { ...base, status: "FAILED", error: "INVALID_RESPONSE" };
      }
    } catch {
      return { ...base, status: "FAILED", error: "REQUEST_FAILED" };
    }
  });
}