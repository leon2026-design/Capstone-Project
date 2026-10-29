import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DemoRecording
} from "../src/browser/mediabaseForm";
import { importOrchardCsv } from "../src/metadata/orchardImporter";

const headers = "TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,VERSION/MIX";
const reviewData = {
  submitterName: "Casey Morgan",
  email: "casey@example.test",
  officialReleaseDate: "11/15/2026"
};

function importOne(row: string): DemoRecording {
  return importOrchardCsv(`${headers}\n${row}`, "attribution.csv").records[0];
}

test("keeps TRACK ARTIST and PRODUCT ARTIST as distinct source concepts", () => {
  const { records, report } = importOrchardCsv(
    `${headers}\n"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit\n` +
      `"Tidewater","Mara Quill","mara  quill",USAAA2600011,\n` +
      `"Lantern","","Mara Quill",USAAA2600012,\n` +
      `"Beacon","Northbound Collective","",USAAA2600013,`,
    "attribution.csv"
  );

  expect(records.map((record) => [record.artist, record.artistAttribution?.status])).toEqual([
    ["", "CONFLICT"],
    ["", "AGREES"],
    ["", "TRACK_ARTIST_ONLY"],
    ["", "PRODUCT_ARTIST_ONLY"]
  ]);
  expect(records.map((record) => record.artistAttribution?.candidateExactArtists)).toEqual([
    ["Mara Quill", "Northbound Collective"],
    ["mara  quill"],
    ["Mara Quill"],
    ["Northbound Collective"]
  ]);
  expect(records.every((record) => record.artistAttribution?.requiresConfirmation === true)).toBeTruthy();
  expect(records.every((record) => record.artistAttribution?.confirmed === false)).toBeTruthy();
  expect(records[0].artistAttribution).toEqual({
    trackArtist: "Mara Quill",
    productArtist: "Northbound Collective",
    status: "CONFLICT",
    candidateExactArtists: ["Mara Quill", "Northbound Collective"],
    requiresConfirmation: true,
    confirmed: false,
    confirmedExactArtist: null,
    primaryArtist: null,
    secondaryArtist: null,
    tertiaryArtist: null,
    featuredArtistSource: "VYDIA"
  });
  expect(records.every((record) => record.featuredArtist === null)).toBeTruthy();
  expect(records.every((record) => record.artistAttribution?.primaryArtist === null)).toBeTruthy();
  expect(report.issues.filter((issue) => issue.code === "artist-conflict")).toEqual([
    expect.objectContaining({ row: 2, field: "TRACK ARTIST/PRODUCT ARTIST" })
  ]);
  expect(report.issues.filter((issue) => issue.code === "missing-required-field")).toEqual([]);
});

test("requires explicit confirmation even when Orchard artist columns agree or only one is present", () => {
  const unconfirmedMessage =
    "Mediabase Exact Artist must be explicitly confirmed from the Orchard artist attribution before approval.";
  const drafts = [
    importOne(`"Tidewater","Mara Quill","mara  quill",USAAA2600011,`),
    importOne(`"Lantern","","Mara Quill",USAAA2600012,`),
    importOne(`"Beacon","Northbound Collective","",USAAA2600013,`)
  ];

  for (const draft of drafts) {
    expect(draft.artist).toBe("");
    expect(() => reviewAndApproveRecord(draft, reviewData)).toThrow(unconfirmedMessage);
    expect(() => reviewAndApproveRecord(draft, { ...reviewData, artist: "Mara Quill" })).toThrow(unconfirmedMessage);
    expect(() =>
      reviewAndApproveRecord(draft, {
        ...reviewData,
        artist: "Mara Quill",
        artistAttribution: { ...draft.artistAttribution!, confirmed: true, confirmedExactArtist: "Mara Quill" }
      })
    ).toThrow(unconfirmedMessage);
    expect(() =>
      validateRecordForPreparation({
        ...draft,
        ...reviewData,
        artist: "Mara Quill",
        approvalStatus: "APPROVED",
        artistAttribution: { ...draft.artistAttribution!, requiresConfirmation: false as unknown as true }
      })
    ).toThrow(unconfirmedMessage);
  }

  const [agrees, trackOnly, productOnly] = drafts;
  expect(
    reviewAndApproveRecord(agrees, reviewData, { confirmArtistAttribution: { exactArtist: "Mara Quill" } })
  ).toMatchObject({
    artist: "Mara Quill",
    approvalStatus: "APPROVED",
    artistAttribution: { status: "AGREES", confirmed: true, confirmedExactArtist: "Mara Quill", primaryArtist: null }
  });
  // The reviewer may choose an Exact Artist that is not the track performer.
  expect(
    reviewAndApproveRecord(trackOnly, reviewData, {
      confirmArtistAttribution: { exactArtist: "Mara Quill & Northbound Collective", primaryArtist: "Mara Quill" }
    })
  ).toMatchObject({
    artist: "Mara Quill & Northbound Collective",
    featuredArtist: null,
    artistAttribution: { status: "TRACK_ARTIST_ONLY", trackArtist: "Mara Quill", primaryArtist: "Mara Quill" }
  });
  expect(
    reviewAndApproveRecord(productOnly, reviewData, { confirmArtistAttribution: { exactArtist: "Northbound Collective" } })
      .artistAttribution
  ).toMatchObject({ status: "PRODUCT_ARTIST_ONLY", productArtist: "Northbound Collective", confirmed: true });
});

test("requires a typed confirmation when both Orchard artist columns are missing", () => {
  const draft = importOrchardCsv(`${headers}\n"Untitled Demo","","",USAAA2600014,`, "missing.csv").records[0];
  expect(draft.artistAttribution).toMatchObject({ status: "MISSING", candidateExactArtists: [], confirmed: false });
  expect(() => reviewAndApproveRecord(draft, { ...reviewData, artist: "Mara Quill" })).toThrow(
    "Mediabase Exact Artist must be explicitly confirmed from the Orchard artist attribution before approval."
  );
  expect(
    reviewAndApproveRecord(draft, reviewData, { confirmArtistAttribution: { exactArtist: "Mara Quill" } }).artist
  ).toBe("Mara Quill");
});

test("requires explicit human confirmation for conflicting artist attribution", () => {
  const draft = importOne(`"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit`);

  expect(() => reviewAndApproveRecord(draft, reviewData)).toThrow(
    "Conflicting Orchard artist attribution must be explicitly confirmed before approval."
  );
  expect(() => reviewAndApproveRecord(draft, { ...reviewData, artist: "Mara Quill" })).toThrow(
    "Conflicting Orchard artist attribution must be explicitly confirmed before approval."
  );
  expect(() =>
    reviewAndApproveRecord(draft, {
      ...reviewData,
      artistAttribution: { ...draft.artistAttribution!, confirmed: true, confirmedExactArtist: "Mara Quill" }
    })
  ).toThrow("Conflicting Orchard artist attribution must be explicitly confirmed before approval.");
  expect(() =>
    reviewAndApproveRecord(
      draft,
      { ...reviewData, artist: "Northbound Collective" },
      { confirmArtistAttribution: { exactArtist: "Mara Quill" } }
    )
  ).toThrow("Reviewed artist must match the confirmed artist attribution.");

  const approved = reviewAndApproveRecord(draft, reviewData, {
    confirmArtistAttribution: {
      exactArtist: "Northbound Collective",
      primaryArtist: "Northbound Collective",
      secondaryArtist: "Mara Quill",
      tertiaryArtist: ""
    }
  });
  expect(approved).toMatchObject({
    artist: "Northbound Collective",
    featuredArtist: null,
    approvalStatus: "APPROVED",
    artistAttribution: {
      trackArtist: "Mara Quill",
      productArtist: "Northbound Collective",
      status: "CONFLICT",
      confirmed: true,
      confirmedExactArtist: "Northbound Collective",
      primaryArtist: "Northbound Collective",
      secondaryArtist: "Mara Quill",
      tertiaryArtist: null
    }
  });
});

test("preserves an explicitly confirmed artist selection", () => {
  const draft = importOne(`"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit`);
  const approved = reviewAndApproveRecord(draft, reviewData, {
    confirmArtistAttribution: { exactArtist: "Mara Quill" }
  });

  const reapproved = reviewAndApproveRecord(approved, { comments: "Updated note." });
  expect(reapproved).toMatchObject({ artist: "Mara Quill", comments: "Updated note." });
  expect(reapproved.artistAttribution?.confirmedExactArtist).toBe("Mara Quill");

  expect(() => reviewAndApproveRecord(approved, { artist: "Northbound Collective" })).toThrow(
    "Confirmed artist attribution cannot change without a new explicit confirmation."
  );
  expect(() => validateRecordForPreparation({ ...approved, artist: "Northbound Collective" })).toThrow(
    "Exact Artist differs from the confirmed artist attribution."
  );
  expect(
    reviewAndApproveRecord(approved, {}, { confirmArtistAttribution: { exactArtist: "Northbound Collective" } })
      .artist
  ).toBe("Northbound Collective");
});

test("keeps previously approved fixtures without attribution decisions valid", () => {
  const fixture = JSON.parse(readFileSync("fixtures/example-record.json", "utf8")) as DemoRecording;
  expect(fixture.artistAttribution).toBeUndefined();
  expect(() => validateRecordForPreparation(fixture)).not.toThrow();
  expect(reviewAndApproveRecord(fixture).artist).toBe("Example Artist");
});
