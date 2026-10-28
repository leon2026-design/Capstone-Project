import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  prepareMediabaseForm,
  type DemoRecording
} from "../src/browser/mediabaseForm";

const mockForm = readFileSync("fixtures/mock-mediabase.html", "utf8");

function cloneRecord(overrides: Partial<DemoRecording> = {}): DemoRecording {
  const record = JSON.parse(
    readFileSync("fixtures/example-record.json", "utf8")
  ) as DemoRecording;

  return { ...record, ...overrides };
}

test("fills the mock form without submitting", async ({ page }, testInfo) => {
  const record: DemoRecording = cloneRecord();

  await page.setContent(mockForm);
  await prepareMediabaseForm(page, record);

  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(record.submitterName ?? "");
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue(record.company ?? "");
  await expect(page.getByLabel("Phone #", { exact: true })).toHaveValue(record.phone ?? "");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(record.email ?? "");
  await expect(page.locator('input[name="rememberInformation"][value="true"]')).toBeChecked();

  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue(record.artist);
  await expect(page.getByLabel("Featured Artist", { exact: true })).toHaveValue(record.featuredArtist ?? "");
  await expect(page.getByLabel("Exact Title", { exact: true })).toHaveValue(record.title);
  await expect(page.getByLabel("Version/Mix", { exact: true })).toHaveValue(record.version ?? "");
  await expect(page.getByLabel("Track ISRC", { exact: true })).toHaveValue(record.isrc ?? "");

  await expect(page.getByLabel("Label Listing", { exact: true })).toHaveValue(record.label ?? "");
  await expect(page.getByLabel("Official Release Date (mm/dd/yyyy)", { exact: true })).toHaveValue(record.officialReleaseDate ?? "");
  await expect(page.getByLabel("Album Title (if applicable)", { exact: true })).toHaveValue(record.albumTitle ?? "");
  await expect(page.getByLabel("Album UPC", { exact: true })).toHaveValue(record.albumUPC ?? "");
  await expect(page.getByLabel("Album Release Date (mm/dd/yyyy)", { exact: true })).toHaveValue(record.albumReleaseDate ?? "");

  await expect(page.locator('input[name="generativeAiAudioDeclaration"][value="no"]')).toBeChecked();
  await expect(page.locator('input[name="independentLabelDeclaration"][value="yes"]')).toBeChecked();
  await expect(page.locator('input[name="christmasHanukkahDeclaration"]:checked')).toHaveCount(0);
  await expect(page.locator('input[name="canadianContentDeclaration"][value="yes"]')).toBeChecked();

  await expect(page.getByLabel("Artist website URL", { exact: true })).toHaveValue(record.artistWebsite ?? "");
  await expect(page.getByLabel("Additional comments about this song?", { exact: true })).toHaveValue(record.comments ?? "");
  await expect(page.getByLabel("Hide Until", { exact: true })).toHaveValue(record.hideUntil ?? "");

  await expect(page.locator("#submit")).toHaveAttribute("data-click-count", "0");
  await expect(page.locator("#mediabase-form")).toHaveAttribute("data-submit-count", "0");

  await page.screenshot({
    path: testInfo.outputPath("mediabase-prefilled.png"),
    fullPage: true
  });
});

test("leaves optional empty fields empty and rejects missing required info", async ({ page }) => {
  const incomplete: DemoRecording = {
    ...cloneRecord(),
    submitterName: "",
    email: "",
    artist: "",
    title: "",
    featuredArtist: null,
    version: null,
    isrc: null,
    albumUPC: null,
    comments: "",
    generativeAiAudioDeclaration: null,
    independentLabelDeclaration: null,
    christmasHanukkahDeclaration: null,
    canadianContentDeclaration: null,
  };

  await page.setContent(mockForm);

  await expect(async () => prepareMediabaseForm(page, incomplete)).rejects.toThrow(
    "Name and email are required."
  );

  await page.setContent(mockForm);
  await prepareMediabaseForm(page, {
    ...cloneRecord(),
    featuredArtist: null,
    albumTitle: "",
    label: "",
    comments: "",
    hideUntil: null,
    artistWebsite: "",
    generativeAiAudioDeclaration: null,
    independentLabelDeclaration: null,
    christmasHanukkahDeclaration: null,
    canadianContentDeclaration: null,
  });

  await expect(page.getByLabel("Featured Artist", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Album Title (if applicable)", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Artist website URL", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Additional comments about this song?", { exact: true })).toHaveValue("");
  await expect(page.locator('input[name="generativeAiAudioDeclaration"]:checked')).toHaveCount(0);
  await expect(page.locator('input[name="christmasHanukkahDeclaration"]:checked')).toHaveCount(0);
});

test("rejects a missing or incorrectly formatted official release date", async ({ page }) => {
  await page.setContent(mockForm);

  await expect(
    prepareMediabaseForm(page, cloneRecord({ officialReleaseDate: null }))
  ).rejects.toThrow("Official release date is required in mm/dd/yyyy format.");

  await page.setContent(mockForm);
  await expect(
    prepareMediabaseForm(page, cloneRecord({ officialReleaseDate: "2026-11-15" }))
  ).rejects.toThrow("Official release date is required in mm/dd/yyyy format.");
});

test("keeps declarations unanswered when explicitly null and handles multiple versions independently", async ({ page }) => {
  const first = cloneRecord();
  const second = cloneRecord({
    recordingId: "TEST-002",
    artist: "Second Artist",
    featuredArtist: "Cleo Vale",
    title: "Second Title",
    version: "Acoustic Mix",
    isrc: "USAAA2600002",
    generativeAiAudioDeclaration: "yes",
    independentLabelDeclaration: "no",
    christmasHanukkahDeclaration: "yes",
    canadianContentDeclaration: null,
  });

  await page.setContent(mockForm);
  await prepareMediabaseForm(page, first);
  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue(first.artist);
  await expect(page.getByLabel("Version/Mix", { exact: true })).toHaveValue(first.version ?? "");
  await expect(page.locator('input[name="canadianContentDeclaration"][value="yes"]')).toBeChecked();

  await page.setContent(mockForm);
  await prepareMediabaseForm(page, second);
  await expect(page.getByLabel("Exact Artist", { exact: true })).toHaveValue(second.artist);
  await expect(page.getByLabel("Exact Title", { exact: true })).toHaveValue(second.title);
  await expect(page.getByLabel("Version/Mix", { exact: true })).toHaveValue(second.version ?? "");
  await expect(page.getByLabel("Track ISRC", { exact: true })).toHaveValue(second.isrc ?? "");

  await expect(page.locator('input[name="generativeAiAudioDeclaration"][value="yes"]')).toBeChecked();
  await expect(page.locator('input[name="independentLabelDeclaration"][value="no"]')).toBeChecked();
  await expect(page.locator('input[name="christmasHanukkahDeclaration"][value="yes"]')).toBeChecked();
  await expect(page.locator('input[name="canadianContentDeclaration"]:checked')).toHaveCount(0);

  await expect(page.locator("#submit")).toHaveAttribute("data-click-count", "0");
  await expect(page.locator("#mediabase-form")).toHaveAttribute("data-submit-count", "0");
});