import { expect, type Page } from "@playwright/test";

export type DeclarationValue = "yes" | "no" | "unanswered" | null;

export type DemoRecording = {
  recordingId: string;
  submitterName?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  rememberInformation?: boolean;
  artist: string;
  featuredArtist?: string | null;
  title: string;
  version?: string | null;
  isrc?: string | null;
  label?: string | null;
  officialReleaseDate?: string | null;
  albumTitle?: string | null;
  albumUPC?: string | null;
  albumReleaseDate?: string | null;
  generativeAiAudioDeclaration?: DeclarationValue;
  independentLabelDeclaration?: DeclarationValue;
  christmasHanukkahDeclaration?: DeclarationValue;
  canadianContentDeclaration?: DeclarationValue;
  artistWebsite?: string | null;
  comments?: string | null;
  hideUntil?: string | null;
  audioFilePath?: string | null;
  approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED";
};

function normalizeDeclarationValue(
  value: DeclarationValue | string | undefined | null
): DeclarationValue {
  if (value === undefined || value === null || value === "") {
    return "unanswered";
  }

  const normalized = String(value).trim().toLowerCase();

  if (normalized === "yes" || normalized === "true") {
    return "yes";
  }

  if (normalized === "no" || normalized === "false") {
    return "no";
  }

  if (normalized === "unanswered") {
    return "unanswered";
  }

  throw new Error(`Unsupported declaration value: ${value}`);
}

function isValidDate(value: string): boolean {
  const match = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(\d{4})$/.exec(
    value
  );
  if (!match) {
    return false;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (year === 0) {
    return false;
  }

  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];

  return day <= daysInMonth[month - 1];
}

async function fillTextIfPresent(
  page: Page,
  label: string,
  value: string | null | undefined
) {
  const locator = page.getByLabel(label, { exact: true });

  if (value === null || value === undefined) {
    await locator.fill("");
    await expect(locator).toHaveValue("");
    return;
  }

  await locator.fill(value);
  await expect(locator).toHaveValue(value);
}

async function fillDeclaration(
  page: Page,
  name: string,
  value: DeclarationValue | string | undefined | null
) {
  const normalized = normalizeDeclarationValue(value);
  const options = page.locator(`input[name="${name}"]`);

  if (normalized === "unanswered") {
    await options.evaluateAll((inputs) =>
      inputs.forEach((input) => {
        (input as HTMLInputElement).checked = false;
      })
    );
    await expect
      .poll(() =>
        options.evaluateAll((inputs) =>
          inputs.some((input) => (input as HTMLInputElement).checked)
        )
      )
      .toBe(false);
    return;
  }

  const option = page.locator(`input[name="${name}"][value="${normalized}"]`);
  await option.check();
  await expect(option).toBeChecked();
}

export function validateRecordForPreparation(record: DemoRecording): void {
  if (record.approvalStatus !== "APPROVED") {
    throw new Error("Recording must be approved before form preparation.");
  }

  if (!record.submitterName?.trim() || !record.email?.trim()) {
    throw new Error("Name and email are required.");
  }

  if (!record.artist.trim() || !record.title.trim()) {
    throw new Error("Artist and title are required.");
  }

  if (!record.officialReleaseDate || !isValidDate(record.officialReleaseDate)) {
    throw new Error("Official release date is required in mm/dd/yyyy format.");
  }

  if (
    record.albumReleaseDate !== null &&
    record.albumReleaseDate !== undefined &&
    record.albumReleaseDate !== "" &&
    !isValidDate(record.albumReleaseDate)
  ) {
    throw new Error("Album release date must be a valid mm/dd/yyyy date.");
  }

  if (record.isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(record.isrc)) {
    throw new Error("ISRC must have a valid normalized 12-character format.");
  }
}

export function reviewAndApproveRecord(
  record: DemoRecording,
  reviewData: Partial<DemoRecording> = {}
): DemoRecording {
  const approved: DemoRecording = {
    ...record,
    ...reviewData,
    approvalStatus: "APPROVED"
  };

  validateRecordForPreparation(approved);
  return approved;
}

export const approveRecordForPreparation = reviewAndApproveRecord;
export const ensureReadyForBrowserPreparation = validateRecordForPreparation;

export async function prepareMediabaseForm(
  page: Page,
  record: DemoRecording
) {
  validateRecordForPreparation(record);

  await fillTextIfPresent(page, "Name", record.submitterName ?? null);
  await fillTextIfPresent(page, "Company", record.company ?? null);
  await fillTextIfPresent(page, "Phone #", record.phone ?? null);
  await fillTextIfPresent(page, "Email", record.email ?? null);

  const rememberInformation = page.locator(
    `input[name="rememberInformation"][value="${record.rememberInformation === true}"]`
  );
  await rememberInformation.check();
  await expect(rememberInformation).toBeChecked();

  await fillTextIfPresent(page, "Exact Artist", record.artist);
  await fillTextIfPresent(page, "Featured Artist", record.featuredArtist ?? null);
  await fillTextIfPresent(page, "Exact Title", record.title);
  await fillTextIfPresent(page, "Version/Mix", record.version ?? null);
  await fillTextIfPresent(page, "Track ISRC", record.isrc ?? null);

  await fillTextIfPresent(page, "Label Listing", record.label ?? null);
  await fillTextIfPresent(
    page,
    "Official Release Date (mm/dd/yyyy)",
    record.officialReleaseDate ?? null
  );
  await fillTextIfPresent(page, "Album Title (if applicable)", record.albumTitle ?? null);
  await fillTextIfPresent(page, "Album UPC", record.albumUPC ?? null);
  await fillTextIfPresent(
    page,
    "Album Release Date (mm/dd/yyyy)",
    record.albumReleaseDate ?? null
  );

  await fillDeclaration(page, "generativeAiAudioDeclaration", record.generativeAiAudioDeclaration);
  await fillDeclaration(
    page,
    "independentLabelDeclaration",
    record.independentLabelDeclaration
  );
  await fillDeclaration(
    page,
    "christmasHanukkahDeclaration",
    record.christmasHanukkahDeclaration
  );
  await fillDeclaration(
    page,
    "canadianContentDeclaration",
    record.canadianContentDeclaration
  );

  await fillTextIfPresent(page, "Artist website URL", record.artistWebsite ?? null);
  await fillTextIfPresent(page, "Additional comments about this song?", record.comments ?? null);
  await fillTextIfPresent(page, "Hide Until", record.hideUntil ?? null);

  const audioFileInput = page.locator('#audio-file');
  expect(
    await audioFileInput.evaluate(
      (input: HTMLInputElement) => input.multiple
    )
  ).toBe(false);
  if (record.audioFilePath) {
    await audioFileInput.setInputFiles(record.audioFilePath);
  }
  const expectedAudioFileCount = record.audioFilePath ? 1 : 0;
  await expect
    .poll(() =>
      audioFileInput.evaluate(
        (input: HTMLInputElement) => input.files?.length ?? 0
      )
    )
    .toBe(expectedAudioFileCount);

  await expect(page.locator('#submit')).toHaveAttribute('data-click-count', '0');
  await expect(page.locator('#mediabase-form')).toHaveAttribute('data-submit-count', '0');
}
