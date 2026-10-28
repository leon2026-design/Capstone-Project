import type { Page } from "@playwright/test";

export type DemoRecording = {
  recordingId: string;
  artist: string;
  title: string;
  version: string;
  isrc: string | null;
  approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED";
};

export async function prepareMediabaseForm(
  page: Page,
  record: DemoRecording
) {
  if (record.approvalStatus !== "APPROVED") {
    throw new Error("Recording must be approved before form preparation.");
  }

  if (!record.artist.trim() || !record.title.trim()) {
    throw new Error("Artist and title are required.");
  }

  if (record.isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(record.isrc)) {
    throw new Error("ISRC must have a valid normalized 12-character format.");
  }

  await page.getByLabel("Exact Artist", { exact: true }).fill(record.artist);
  await page.getByLabel("Exact Title", { exact: true }).fill(record.title);
  await page.getByLabel("Version/Mix", { exact: true }).fill(record.version);
  await page.getByLabel("Track ISRC", { exact: true }).fill(record.isrc ?? "");
}
