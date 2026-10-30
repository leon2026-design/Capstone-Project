import { expect, test } from "@playwright/test";
import {
  lookupMusicBrainzByIsrc,
  lookupMusicBrainzReleases
} from "../src/research/musicBrainzLookup";

const ISRC = "USAAA2600010";
const USER_AGENT = "mediabase-agent-tests/1.0 (offline mocks)";
const RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "33333333-3333-4333-8333-333333333333";

function recording() {
  return {
    recordingId: "TEST-MB-001",
    isrc: ISRC,
    artist: "Fictional Artist",
    title: "Fictional Song",
    approvalStatus: "DRAFT" as const
  };
}

function candidate(id = RECORDING_ID, title = "Fictional Song") {
  return {
    id,
    title,
    "artist-credit": [
      { name: "Fictional Artist", joinphrase: "" }
    ]
  };
}

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchSource: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });

    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  };

  return { fetchSource, calls };
}

test("returns a candidate and source link without changing the record", async () => {
  const record = Object.freeze(recording());
  const before = JSON.stringify(record);
  const fake = fakeFetch({
    isrc: ISRC,
    recordings: [candidate()]
  });

  const result = await lookupMusicBrainzByIsrc(record, {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("NEEDS_REVIEW");
  expect(result.requiresHumanReview).toBe(true);
  expect(result.candidates).toEqual([{
    musicBrainzId: RECORDING_ID,
    title: "Fictional Song",
    artistCredit: "Fictional Artist",
    sourceUrl: `https://musicbrainz.org/recording/${RECORDING_ID}`,
    releases: [],
    releaseListMayBeIncomplete: true
  }]);

  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].url).toBe(
    `https://musicbrainz.org/ws/2/isrc/${ISRC}?inc=artist-credits+releases&fmt=json`
  );
  expect(new Headers(fake.calls[0].init?.headers).get("User-Agent"))
    .toBe(USER_AGENT);
  expect(JSON.stringify(record)).toBe(before);
});

test("preserves multiple candidates for human review", async () => {
  const fake = fakeFetch({
    isrc: ISRC,
    recordings: [
      candidate(),
      candidate(
        "22222222-2222-4222-8222-222222222222",
        "Fictional Song (Remix)"
      )
    ]
  });

  const result = await lookupMusicBrainzByIsrc(recording(), {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("NEEDS_REVIEW");
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[1].title).toBe("Fictional Song (Remix)");
  expect(result.requiresHumanReview).toBe(true);
});

test("rejects missing or invalid ISRCs without making requests", async () => {
  const fake = fakeFetch({});

  for (const isrc of [null, "", "INVALID", "US-AAA-26-00010"]) {
    const result = await lookupMusicBrainzByIsrc(
      { recordingId: "TEST-INVALID", isrc },
      { userAgent: USER_AGENT, fetch: fake.fetchSource }
    );

    expect(result.status).toBe("INVALID_ISRC");
    expect(result.candidates).toEqual([]);
  }

  expect(fake.calls).toHaveLength(0);
});

test("reports no match for an empty result or HTTP 404", async () => {
  for (const status of [200, 404]) {
    const fake = fakeFetch({ isrc: ISRC, recordings: [] }, status);

    const result = await lookupMusicBrainzByIsrc(recording(), {
      userAgent: USER_AGENT,
      fetch: fake.fetchSource
    });

    expect(result.status).toBe("NO_MATCH");
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeNull();
  }
});

test("reports HTTP failures without retrying automatically", async () => {
  const fake = fakeFetch({}, 503);

  const result = await lookupMusicBrainzByIsrc(recording(), {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("FAILED");
  expect(result.error).toBe("HTTP_ERROR");
  expect(fake.calls).toHaveLength(1);
});

test("handles network failures without exposing raw errors", async () => {
  const fetchSource: typeof globalThis.fetch = async () => {
    throw new Error("Private diagnostic information");
  };

  const result = await lookupMusicBrainzByIsrc(recording(), {
    userAgent: USER_AGENT,
    fetch: fetchSource
  });

  expect(result.status).toBe("FAILED");
  expect(result.error).toBe("REQUEST_FAILED");
  expect(JSON.stringify(result)).not.toContain("Private diagnostic");
});

test("rejects malformed responses and mismatched ISRCs", async () => {
  const bodies = [
    null,
    { isrc: "USBBB2600020", recordings: [candidate()] },
    { isrc: ISRC, recordings: "invalid" },
    { isrc: ISRC, recordings: [{ id: "invalid-id", title: "Song" }] }
  ];

  for (const body of bodies) {
    const fake = fakeFetch(body);

    const result = await lookupMusicBrainzByIsrc(recording(), {
      userAgent: USER_AGENT,
      fetch: fake.fetchSource
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("INVALID_RESPONSE");
    expect(result.candidates).toEqual([]);
  }
});

test("requires an application User-Agent before making a request", async () => {
  const fake = fakeFetch({});

  await expect(lookupMusicBrainzByIsrc(recording(), {
    userAgent: " ",
    fetch: fake.fetchSource
  })).rejects.toThrow("User-Agent");

  expect(fake.calls).toHaveLength(0);
});

test("returns release details and preserves barcode leading zeros", async () => {
  const record = Object.freeze(recording());
  const before = JSON.stringify(record);
  const fake = fakeFetch({
    isrc: ISRC,
    recordings: [{
      ...candidate(),
      releases: [{
        id: RELEASE_ID,
        title: "Fictional Album",
        date: "2026-11-15",
        country: "US",
        barcode: "0012345678905"
      }]
    }]
  });

  const result = await lookupMusicBrainzByIsrc(record, {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("NEEDS_REVIEW");
  expect(result.candidates[0].releases).toEqual([{
    musicBrainzId: RELEASE_ID,
    title: "Fictional Album",
    date: "2026-11-15",
    country: "US",
    barcode: "0012345678905",
    sourceUrl: `https://musicbrainz.org/release/${RELEASE_ID}`
  }]);
  expect(result.candidates[0].releaseListMayBeIncomplete).toBe(true);
  expect(JSON.stringify(record)).toBe(before);
});

test("keeps releases separate and preserves partial dates and missing values", async () => {
  const fake = fakeFetch({
    isrc: ISRC,
    recordings: [{
      ...candidate(),
      releases: [
        {
          id: RELEASE_ID,
          title: "Fictional Original Release",
          date: "2026"
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          title: "Fictional Reissue",
          date: "2027-03",
          country: "",
          barcode: ""
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          title: "Fictional Undated Release"
        }
      ]
    }]
  });

  const result = await lookupMusicBrainzByIsrc(recording(), {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("NEEDS_REVIEW");
  const releases = result.candidates[0].releases;

  expect(releases).toHaveLength(3);
  expect(releases.map((release) => release.date))
    .toEqual(["2026", "2027-03", null]);
  expect(releases.map((release) => release.country))
    .toEqual([null, null, null]);
  expect(releases.map((release) => release.barcode))
    .toEqual([null, null, null]);
  expect(result.requiresHumanReview).toBe(true);
});

test("rejects malformed release lists and release identifiers", async () => {
  for (const releases of [
    "invalid",
    [{ id: "invalid-id", title: "Fictional Album" }]
  ]) {
    const fake = fakeFetch({
      isrc: ISRC,
      recordings: [{ ...candidate(), releases }]
    });

    const result = await lookupMusicBrainzByIsrc(recording(), {
      userAgent: USER_AGENT,
      fetch: fake.fetchSource
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("INVALID_RESPONSE");
    expect(result.candidates).toEqual([]);
  }
});
test("retrieves releases through the recording endpoint", async () => {
  const fake = fakeFetch({
    id: RECORDING_ID,
    releases: [{
      id: RELEASE_ID,
      title: "Fictional Album",
      date: "2026-11",
      country: "US",
      barcode: "0012345678905"
    }]
  });

  const result = await lookupMusicBrainzReleases(RECORDING_ID, {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("NEEDS_REVIEW");
  expect(result.requiresHumanReview).toBe(true);
  expect(result.releaseListMayBeIncomplete).toBe(true);
  expect(result.releases).toEqual([{
    musicBrainzId: RELEASE_ID,
    title: "Fictional Album",
    date: "2026-11",
    country: "US",
    barcode: "0012345678905",
    sourceUrl: `https://musicbrainz.org/release/${RELEASE_ID}`
  }]);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].url).toBe(
    `https://musicbrainz.org/ws/2/recording/${RECORDING_ID}?inc=artist-credits%2Breleases&fmt=json`
  );
});

test("rejects invalid recording IDs before making requests", async () => {
  const fake = fakeFetch({});

  const result = await lookupMusicBrainzReleases("invalid-id", {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("INVALID_RECORDING_ID");
  expect(result.releases).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

test("rejects releases returned for a different recording", async () => {
  const fake = fakeFetch({
    id: "22222222-2222-4222-8222-222222222222",
    releases: []
  });

  const result = await lookupMusicBrainzReleases(RECORDING_ID, {
    userAgent: USER_AGENT,
    fetch: fake.fetchSource
  });

  expect(result.status).toBe("FAILED");
  expect(result.error).toBe("INVALID_RESPONSE");
  expect(result.releases).toEqual([]);
});

test("handles empty releases and recording lookup HTTP failures", async () => {
  for (const status of [200, 404, 503]) {
    const fake = fakeFetch({
      id: RECORDING_ID,
      releases: []
    }, status);

    const result = await lookupMusicBrainzReleases(RECORDING_ID, {
      userAgent: USER_AGENT,
      fetch: fake.fetchSource
    });

    expect(result.status).toBe(status === 503 ? "FAILED" : "NO_MATCH");
    expect(result.error).toBe(status === 503 ? "HTTP_ERROR" : null);
    expect(result.releases).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  }
});