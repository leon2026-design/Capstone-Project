import { expect, type Page } from "@playwright/test";
import {
  normalizeDeclarationValue,
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DeclarationValue,
  type DemoRecording,
  type PreparationContext
} from "../metadata/recordValidation";

// Record types and validation live in a runtime-neutral module; re-exported for existing callers.
export {
  getArtistAttributionProblem,
  isValidDate,
  normalizeDeclarationValue,
  reviewAndApproveRecord,
  validateRecordForPreparation,
  type DeclarationValue,
  type DemoRecording,
  type IsrcValidation,
  type PreparationContext,
  type RecordReviewOptions
} from "../metadata/recordValidation";

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

export const approveRecordForPreparation = reviewAndApproveRecord;
export const ensureReadyForBrowserPreparation = validateRecordForPreparation;

export async function prepareMediabaseForm(
  page: Page,
  record: DemoRecording,
  context: PreparationContext = {}
) {
  validateRecordForPreparation(record, context);

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
