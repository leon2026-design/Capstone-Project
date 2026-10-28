import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  prepareMediabaseForm,
  reviewAndApproveRecord,
  validateRecordForPreparation
} from "../src/browser/mediabaseForm";
import { importOrchardCsv } from "../src/metadata/orchardImporter";

const headers =
  "TRACK,PRODUCT ARTIST,TRACK ARTIST,ISRC,LABEL IMPRINT,PRODUCT,DISPLAY UPC,VERSION/MIX,PRODUCT TYPE";

test("imports complete metadata and preserves the Mediabase record shape", () => {
  const { records, report } = importOrchardCsv(
    `${headers}\n"Signal, Again","North Star","The Harbor Lights",us-aaa-26-00001,North Star,"Midnight Signals",001234567890,Radio Edit,Album`,
    "fictional-export.csv"
  );

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    artist: "The Harbor Lights",
    title: "Signal, Again",
    featuredArtist: null,
    version: "Radio Edit",
    isrc: "USAAA2600001",
    albumTitle: "Midnight Signals",
    albumUPC: "001234567890",
    approvalStatus: "DRAFT"
  });
  expect(Object.keys(records[0]).sort()).toEqual([
    "albumReleaseDate", "albumTitle", "albumUPC", "approvalStatus", "artist",
    "artistWebsite", "audioFilePath", "canadianContentDeclaration",
    "christmasHanukkahDeclaration", "comments", "company",
    "email", "featuredArtist", "generativeAiAudioDeclaration",
    "hideUntil", "independentLabelDeclaration", "isrc", "isrcValidation", "label",
    "officialReleaseDate", "phone", "recordingId", "rememberInformation",
    "submitterName", "title", "version"
  ].sort());
  expect(report.issues).toEqual([
    expect.objectContaining({ code: "artist-conflict", row: 2 })
  ]);
  expect(report.sourceRows[0]).toEqual({
    row: 2,
    productArtist: "North Star",
    trackArtist: "The Harbor Lights",
    rawIsrc: "us-aaa-26-00001"
  });
});

test("retains missing and invalid ISRC values as report issues", () => {
  const csv = `${headers}\n"Missing","Artist","","","Label","Album","123","",Album\n"Bad","Artist","","not-an-isrc","Label","Album","456","",Album`;
  const result = importOrchardCsv(csv);

  expect(result.records.map((record) => record.isrc)).toEqual([null, null]);
  expect(result.records.map((record) => record.isrcValidation)).toEqual([
    { status: "missing", originalValue: null, reviewed: false },
    { status: "invalid", originalValue: "not-an-isrc", reviewed: false }
  ]);
  expect(result.report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "missing-isrc", rawValue: null, row: 2 }),
      expect.objectContaining({ code: "invalid-isrc", rawValue: "not-an-isrc", row: 3 })
    ])
  );
});

test("keeps required-field gaps, optional-column gaps, and single product interpretation", () => {
  const result = importOrchardCsv(
    "TRACK,PRODUCT,PRODUCT TYPE\n,Single Product,Single\nTitle,,Album"
  );

  expect(result.records).toHaveLength(2);
  expect(result.records[0]).toMatchObject({ artist: "", title: "", albumTitle: null });
  expect(result.records[1]).toMatchObject({ artist: "", title: "Title", albumTitle: null });
  expect(result.report.issues.filter((issue) => issue.code === "missing-required-field")).toHaveLength(4);
});

test("keeps versions and duplicate source rows independent", () => {
  const row = `"Track","Artist","","USAAA2600001","Label","Album","123","Clean","Album"`;
  const result = importOrchardCsv(`${headers}\n${row}\n${row}\n${row.replace("Clean", "Remix")}`);

  expect(result.records).toHaveLength(3);
  expect(result.records.map((record) => record.version)).toEqual(["Clean", "Clean", "Remix"]);
  expect(new Set(result.records.map((record) => record.recordingId)).size).toBe(3);
  expect(result.report.issues.filter((issue) => issue.code === "duplicate-source-row")).toHaveLength(1);
});

test("parses valid quoted content and rejects characters after closing quotes", () => {
  const result = importOrchardCsv(
    `${headers}\n"Title, \"\"Again\"\"\nPart 2","Product Artist","Track Artist","USAAA2600001","Label","Album","0001","",Album`
  );
  expect(result.records[0]).toMatchObject({
    title: 'Title, "Again"\nPart 2',
    artist: "Track Artist"
  });

  expect(importOrchardCsv("").records).toEqual([]);
  expect(importOrchardCsv('TRACK,PRODUCT ARTIST\n"",Artist').records[0]).toMatchObject({
    title: "",
    artist: "Artist"
  });
  expect(importOrchardCsv('"TRACK","Artist\nTitle').report.issues[0]).toMatchObject({
    code: "malformed-csv"
  });
  expect(importOrchardCsv('TRACK,PRODUCT ARTIST\n"Title"unexpected,Artist').report.issues[0]).toMatchObject({
    code: "malformed-csv",
    message: "Unexpected character after a closing quoted CSV field."
  });
});

test("uses recording attributes, not row position, for stable recording IDs", () => {
  const firstRow = `"Track One","Artist","","USAAA2600001","Label","Album","123","",Album`;
  const secondRow = `"Track Two","Artist","","USAAA2600002","Label","Album","123","",Album`;
  const firstImport = importOrchardCsv(`${headers}\n${firstRow}\n${secondRow}`, "export.csv");
  const reorderedImport = importOrchardCsv(`${headers}\n${secondRow}\n${firstRow}`, "export.csv");

  expect(new Map(firstImport.records.map((record) => [record.title, record.recordingId]))).toEqual(
    new Map(reorderedImport.records.map((record) => [record.title, record.recordingId]))
  );
  const csv = `${headers}\n${firstRow}`;
  expect(importOrchardCsv(csv, "other.csv").records[0].recordingId).not.toBe(
    importOrchardCsv(csv, "export.csv").records[0].recordingId
  );
});

test("imports Orchard CSV rows into draft recordings and prepares an approved form", async ({ page }) => {
  const csv = readFileSync("fixtures/orchard-multiple-versions.csv", "utf8");
  const { records, report } = importOrchardCsv(csv, "fictional-export.csv");

  expect(records).toHaveLength(2);
  expect(records.every((record) => record.approvalStatus === "DRAFT")).toBeTruthy();
  expect(records.map((record) => record.version)).toEqual(["Radio Edit", "Remix"]);
  expect(new Set(records.map((record) => record.recordingId)).size).toBe(2);
  expect(report.issues.some((issue) => issue.code === "missing-isrc")).toBeTruthy();
  expect(report.issues.filter((issue) => issue.code === "artist-conflict")).toHaveLength(2);
  expect(report.sourceRows[0]).toMatchObject({
    productArtist: "North Star Music",
    trackArtist: "The Harbor Lights"
  });
  const remix = records.find((record) => record.version === "Remix");
  expect(remix).toMatchObject({
    artist: "The Harbor Lights",
    featuredArtist: null,
    title: "Signal, Again",
    version: "Remix",
    isrc: null,
    isrcValidation: { status: "missing", originalValue: null, reviewed: false }
  });
  if (!remix) {
    throw new Error("Expected the fictional Orchard fixture to contain a Remix row.");
  }

  expect(() => reviewAndApproveRecord(remix, {
    submitterName: "Casey Morgan",
    email: "casey@example.test",
    officialReleaseDate: "11/15/2026"
  })).toThrow("Missing Orchard ISRC must be explicitly reviewed before approval.");

  const approved = reviewAndApproveRecord(remix, {
    submitterName: "Casey Morgan",
    email: "casey@example.test",
    company: "Fictional Music Group",
    phone: "555-010-2929",
    rememberInformation: true,
    officialReleaseDate: "11/15/2026",
    generativeAiAudioDeclaration: "no",
    independentLabelDeclaration: "yes",
    christmasHanukkahDeclaration: null,
    canadianContentDeclaration: "yes"
  }, {
    confirmMissingIsrc: true
  });

  expect(approved.approvalStatus).toBe("APPROVED");
  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await prepareMediabaseForm(page, approved);

  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Casey Morgan");
  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue("The Harbor Lights");
  await expect(page.getByLabel("Exact Title", { exact: true })).toHaveValue("Signal, Again");
  await expect(page.getByLabel("Version/Mix", { exact: true })).toHaveValue("Remix");
  await expect(page.getByLabel("Track ISRC", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Label Listing", { exact: true })).toHaveValue("North Star Music Group");
  await expect(page.getByLabel("Album Title (if applicable)", { exact: true })).toHaveValue("Midnight Signals");
  await expect(page.getByLabel("Album UPC", { exact: true })).toHaveValue("001234567890");
  await expect(page.locator('input[name="generativeAiAudioDeclaration"][value="no"]')).toBeChecked();
  await expect(page.locator('#submit')).toHaveAttribute('data-click-count', '0');
  await expect(page.locator('#mediabase-form')).toHaveAttribute('data-submit-count', '0');
});

test("rejects an invalid imported ISRC until it is corrected and revalidated", async ({ page }) => {
  const csv = `${headers}\n"Broken Signal","Product Artist","Track Artist","bad-isrc","Label","Album","000123456789","Clean","Album"`;
  const { records, report } = importOrchardCsv(csv, "invalid-isrc.csv");
  const imported = records[0];
  const reviewData = {
    submitterName: "Casey Morgan",
    email: "casey@example.test",
    officialReleaseDate: "11/15/2026"
  };

  expect(imported).toMatchObject({
    isrc: null,
    approvalStatus: "DRAFT",
    isrcValidation: {
      status: "invalid",
      originalValue: "bad-isrc",
      reviewed: false
    }
  });
  expect(report.issues).toContainEqual(
    expect.objectContaining({ code: "invalid-isrc", rawValue: "bad-isrc" })
  );
  expect(() => reviewAndApproveRecord(imported, reviewData)).toThrow(
    "Invalid Orchard ISRC must be corrected before approval."
  );

  const approved = reviewAndApproveRecord(imported, {
    ...reviewData,
    isrc: "USAAA2600003"
  });
  expect(approved).toMatchObject({
    isrc: "USAAA2600003",
    approvalStatus: "APPROVED",
    isrcValidation: {
      status: "valid",
      originalValue: "bad-isrc",
      reviewed: true
    }
  });

  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await prepareMediabaseForm(page, approved);
  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue("Track Artist");
  await expect(page.getByLabel("Exact Title", { exact: true })).toHaveValue("Broken Signal");
  await expect(page.getByLabel("Track ISRC", { exact: true })).toHaveValue("USAAA2600003");
  await expect(page.getByLabel("Album UPC", { exact: true })).toHaveValue("000123456789");
  await expect(page.locator("#submit")).toHaveAttribute("data-click-count", "0");
  await expect(page.locator("#mediabase-form")).toHaveAttribute("data-submit-count", "0");
});

test("rejects unapproved drafts and missing required fields before browser preparation", async ({ page }) => {
  const draft = importOrchardCsv(readFileSync("fixtures/orchard-multiple-versions.csv", "utf8"), "fictional-export.csv").records[0];
  const requiredReviewData = {
    submitterName: "Casey Morgan",
    email: "casey@example.test",
    officialReleaseDate: "11/15/2026"
  };

  expect(() => validateRecordForPreparation(draft)).toThrow("Recording must be approved before form preparation.");
  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await expect(prepareMediabaseForm(page, draft)).rejects.toThrow(
    "Recording must be approved before form preparation."
  );
  expect(() =>
    reviewAndApproveRecord(draft, {
      submitterName: "",
      email: "",
      officialReleaseDate: null
    })
  ).toThrow("Name and email are required.");
  expect(() =>
    reviewAndApproveRecord(draft, {
      ...requiredReviewData,
      artist: ""
    })
  ).toThrow("Artist and title are required.");
  expect(() =>
    reviewAndApproveRecord(draft, {
      ...requiredReviewData,
      title: ""
    })
  ).toThrow("Artist and title are required.");
  expect(() =>
    reviewAndApproveRecord(draft, {
      ...requiredReviewData,
      officialReleaseDate: null
    })
  ).toThrow("Official release date is required in mm/dd/yyyy format.");
});
