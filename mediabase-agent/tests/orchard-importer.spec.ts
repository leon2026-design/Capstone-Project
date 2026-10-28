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
    artist: "North Star",
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
    "hideUntil", "independentLabelDeclaration", "isrc", "label",
    "officialReleaseDate", "phone", "recordingId", "rememberInformation",
    "submitterName", "title", "version"
  ].sort());
  expect(report.issues).toEqual([]);
  expect(report.sourceRows[0]).toEqual({
    row: 2,
    trackArtist: "The Harbor Lights",
    rawIsrc: "us-aaa-26-00001"
  });
});

test("retains missing and invalid ISRC values as report issues", () => {
  const csv = `${headers}\n"Missing","Artist","","","Label","Album","123","",Album\n"Bad","Artist","","not-an-isrc","Label","Album","456","",Album`;
  const result = importOrchardCsv(csv);

  expect(result.records.map((record) => record.isrc)).toEqual([null, null]);
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

test("parses quoted commas, line breaks, and malformed or empty input", () => {
  const result = importOrchardCsv(
    `${headers}\n"Title\nPart 2","Artist, Inc.","Track Artist","USAAA2600001","Label","Album","0001","",Album`
  );
  expect(result.records[0]).toMatchObject({ title: "Title\nPart 2", artist: "Artist, Inc." });

  expect(importOrchardCsv("").records).toEqual([]);
  expect(importOrchardCsv('"TRACK","Artist\nTitle').report.issues[0].code).toBe("malformed-csv");
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
  const remix = records.find((record) => record.version === "Remix");
  expect(remix).toMatchObject({
    artist: "North Star Music",
    title: "Signal, Again",
    version: "Remix",
    isrc: null
  });
  if (!remix) {
    throw new Error("Expected the fictional Orchard fixture to contain a Remix row.");
  }

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
  });

  expect(approved.approvalStatus).toBe("APPROVED");
  await page.setContent(readFileSync("fixtures/mock-mediabase.html", "utf8"));
  await prepareMediabaseForm(page, approved);

  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Casey Morgan");
  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue("North Star Music");
  await expect(page.getByLabel("Exact Title", { exact: true })).toHaveValue("Signal, Again");
  await expect(page.getByLabel("Version/Mix", { exact: true })).toHaveValue("Remix");
  await expect(page.getByLabel("Track ISRC", { exact: true })).toHaveValue("");
  await expect(page.locator('input[name="generativeAiAudioDeclaration"][value="no"]')).toBeChecked();
  await expect(page.locator('#submit')).toHaveAttribute('data-click-count', '0');
  await expect(page.locator('#mediabase-form')).toHaveAttribute('data-submit-count', '0');
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
