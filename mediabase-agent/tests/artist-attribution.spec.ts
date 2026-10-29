import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DemoRecording
} from "../src/browser/mediabaseForm";
import { importOrchardCsv, isOrchardRecordingId } from "../src/metadata/orchardImporter";
import { isLegacyManualRecord } from "../src/metadata/recordValidation";

const headers = "TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,VERSION/MIX";
const reviewData = {
  submitterName: "Casey Morgan",
  email: "casey@example.test",
  officialReleaseDate: "11/15/2026"
};
const missingAttributionMessage =
  "Recording has no artist attribution decision and is not marked as a legacy manual record; the Mediabase Exact Artist must be explicitly confirmed before approval.";

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
    featuredArtistSource: "VYDIA",
    confirmedSource: null
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
  expect(fixture.recordSource).toBe("MANUAL");
  expect(isLegacyManualRecord(fixture)).toBe(true);
  expect(() => validateRecordForPreparation(fixture)).not.toThrow();
  expect(reviewAndApproveRecord(fixture).artist).toBe("Example Artist");

  // The exception is explicit: dropping the marker fails closed.
  const { recordSource, ...unmarked } = fixture;
  void recordSource;
  expect(isLegacyManualRecord(unmarked)).toBe(false);
  expect(() => validateRecordForPreparation(unmarked)).toThrow(missingAttributionMessage);
});

test("cannot bypass Orchard artist confirmation by omitting the attribution decision", () => {
  const draft = importOne(`"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit`);
  expect(draft.recordSource).toBe("ORCHARD");
  expect(isOrchardRecordingId(draft.recordingId)).toBe(true);
  const { artistAttribution, ...withoutAttribution } = draft;
  void artistAttribution;
  const missingMessage = missingAttributionMessage;

  expect(() => reviewAndApproveRecord(withoutAttribution, { ...reviewData, artist: "Mara Quill" })).toThrow(missingMessage);
  expect(() =>
    validateRecordForPreparation({ ...withoutAttribution, ...reviewData, artist: "Mara Quill", approvalStatus: "APPROVED" })
  ).toThrow(missingMessage);
  expect(() =>
    validateRecordForPreparation({
      ...draft,
      ...reviewData,
      artist: "Mara Quill",
      artistAttribution: undefined,
      approvalStatus: "APPROVED"
    })
  ).toThrow(missingMessage);
  // Provenance does not depend on the mutable recording ID.
  const renamed = { ...withoutAttribution, ...reviewData, recordingId: "TEST-001", artist: "Mara Quill", approvalStatus: "APPROVED" as const };
  expect(() => validateRecordForPreparation(renamed)).toThrow(missingMessage);
  expect(() => validateRecordForPreparation({ ...renamed, recordSource: undefined })).toThrow(missingMessage);
  // A legacy marker cannot be combined with an importer-format ID or set through review data.
  expect(() =>
    validateRecordForPreparation({ ...withoutAttribution, ...reviewData, recordSource: "MANUAL", artist: "Mara Quill", approvalStatus: "APPROVED" })
  ).toThrow(missingMessage);
  expect(() =>
    reviewAndApproveRecord({ ...withoutAttribution, recordingId: "TEST-001" }, { ...reviewData, artist: "Mara Quill", recordSource: "MANUAL" })
  ).toThrow(missingMessage);
  // An explicit human confirmation is still accepted.
  expect(
    reviewAndApproveRecord(withoutAttribution, reviewData, { confirmArtistAttribution: { exactArtist: "Mara Quill" } })
  ).toMatchObject({ artist: "Mara Quill", artistAttribution: { confirmed: true } });
});

test("rejects forged or inconsistent attribution decisions", () => {
  const draft = importOne(`"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit`);
  const approved = reviewAndApproveRecord(draft, reviewData, { confirmArtistAttribution: { exactArtist: "Mara Quill" } });
  const inconsistent =
    "Artist attribution data is inconsistent with the Orchard artist values; the Exact Artist must be confirmed again.";

  // Hand-set `confirmed` without going through confirmArtistAttribution.
  expect(() =>
    validateRecordForPreparation({
      ...approved,
      artistAttribution: { ...draft.artistAttribution!, confirmed: true, confirmedExactArtist: "Mara Quill" }
    })
  ).toThrow(inconsistent);
  // A conflict relabelled as agreement.
  expect(() =>
    validateRecordForPreparation({ ...approved, artistAttribution: { ...approved.artistAttribution!, status: "AGREES" } })
  ).toThrow(inconsistent);
  expect(() =>
    validateRecordForPreparation({ ...approved, artistAttribution: { ...approved.artistAttribution!, confirmedExactArtist: " " } })
  ).toThrow(inconsistent);
});

test("invalidates a confirmation when the Orchard artist values change", () => {
  const draft = importOne(`"Glass Coast","Northbound Collective","Mara Quill",USAAA2600010,Radio Edit`);
  const approved = reviewAndApproveRecord(draft, reviewData, { confirmArtistAttribution: { exactArtist: "Mara Quill" } });
  expect(approved.artistAttribution?.confirmedSource).toEqual({
    trackArtist: "Mara Quill",
    productArtist: "Northbound Collective"
  });
  expect(() => validateRecordForPreparation(approved)).not.toThrow();
  // Unrelated edits keep the confirmation valid.
  expect(() => validateRecordForPreparation({ ...approved, comments: "Updated note." })).not.toThrow();

  const changed: DemoRecording = {
    ...approved,
    artistAttribution: { ...approved.artistAttribution!, productArtist: "Harbor Collective" }
  };
  expect(() => validateRecordForPreparation(changed)).toThrow(
    "Orchard artist values changed after the Exact Artist was confirmed; a new explicit confirmation is required."
  );
  expect(
    reviewAndApproveRecord(changed, {}, { confirmArtistAttribution: { exactArtist: "Mara Quill" } }).artistAttribution
  ).toMatchObject({
    status: "CONFLICT",
    confirmedSource: { trackArtist: "Mara Quill", productArtist: "Harbor Collective" }
  });
});
