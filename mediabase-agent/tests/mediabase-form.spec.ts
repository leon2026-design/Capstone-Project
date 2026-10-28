import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  prepareMediabaseForm,
  type DemoRecording
} from "../src/browser/mediabaseForm";

test("fills the mock form without submitting", async ({ page }, testInfo) => {
  const record: DemoRecording = JSON.parse(
    readFileSync("fixtures/example-record.json", "utf8")
  );

  const mockForm = readFileSync(
    "fixtures/mock-mediabase.html",
    "utf8"
  );

  await page.setContent(mockForm);
  await prepareMediabaseForm(page, record);

  await expect(
    page.getByLabel("Exact Artist", { exact: true })
  ).toHaveValue(record.artist);

  await expect(
    page.getByLabel("Exact Title", { exact: true })
  ).toHaveValue(record.title);

  await expect(
    page.getByLabel("Version/Mix", { exact: true })
  ).toHaveValue(record.version);

  await expect(
    page.getByLabel("Track ISRC", { exact: true })
  ).toHaveValue(record.isrc ?? "");

  await expect(page.locator("#submit")).toHaveAttribute(
    "data-click-count",
    "0"
  );

  await expect(page.locator("#mediabase-form")).toHaveAttribute(
    "data-submit-count",
    "0"
  );

  await page.screenshot({
    path: testInfo.outputPath("mediabase-prefilled.png"),
    fullPage: true
  });
});