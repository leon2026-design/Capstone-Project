import { expect, type Page } from "@playwright/test";
import type { AudioMatchDecision } from "../audio/audioMatcher";
import {
  confirmArtistAttribution,
  createArtistAttributionDecision,
  type ArtistAttributionDecision,
  type ArtistAttributionSelection
} from "../metadata/artistAttribution";

export type DeclarationValue = "yes" | "no" | "unanswered" | null;

export type IsrcValidation = {
  status: "valid" | "missing" | "invalid";
  originalValue: string | null;
  reviewed: boolean;
};

export type DemoRecording = {
  recordingId: string;
  submitterName?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  rememberInformation?: boolean;
  /** Mediabase Exact Artist. */
  artist: string;
  artistAttribution?: ArtistAttributionDecision;
  featuredArtist?: string | null;
  title: string;
  version?: string | null;
  isrc?: string | null;
  isrcValidation?: IsrcValidation;
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
  /** Local audio path only; it is never uploaded automatically. */
  audioFilePath?: string | null;
  audioMatch?: AudioMatchDecision;
  approvalStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED";
};

export function normalizeDeclarationValue(
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

export function isValidDate(value: string): boolean {
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

const NORMALIZED_ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

export type RecordReviewOptions = {
  confirmMissingIsrc?: boolean;
  /** Explicit human artist selection; required for every Orchard artist-attribution decision. */
  confirmArtistAttribution?: ArtistAttributionSelection;
};

const UNRESOLVED_AUDIO_STATUSES = new Set(["NEEDS_REVIEW", "AMBIGUOUS"]);

export function validateRecordForPreparation(record: DemoRecording): void {
  if (record.approvalStatus !== "APPROVED") {
    throw new Error("Recording must be approved before form preparation.");
  }

  if (!record.submitterName?.trim() || !record.email?.trim()) {
    throw new Error("Name and email are required.");
  }

  const attribution = record.artistAttribution;
  // Gate on `confirmed`, not the stored `requiresConfirmation` flag, so an
  // edited decision object cannot bypass the human selection.
  if (attribution && !attribution.confirmed) {
    throw new Error(
      attribution.status === "CONFLICT"
        ? "Conflicting Orchard artist attribution must be explicitly confirmed before approval."
        : "Mediabase Exact Artist must be explicitly confirmed from the Orchard artist attribution before approval."
    );
  }
  if (attribution?.confirmed && record.artist !== attribution.confirmedExactArtist) {
    throw new Error("Exact Artist differs from the confirmed artist attribution.");
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

  if (record.isrcValidation?.status === "invalid") {
    throw new Error("Invalid Orchard ISRC must be corrected before approval.");
  }

  if (
    record.isrcValidation?.status === "missing" &&
    !record.isrcValidation.reviewed
  ) {
    throw new Error("Missing Orchard ISRC must be explicitly reviewed before approval.");
  }

  if (record.isrc && !NORMALIZED_ISRC_PATTERN.test(record.isrc)) {
    throw new Error("ISRC must have a valid normalized 12-character format.");
  }

  if (record.isrcValidation?.status === "valid" && !record.isrc) {
    throw new Error("Validated ISRC metadata is inconsistent with the recording.");
  }

  if (record.audioMatch) {
    if (UNRESOLVED_AUDIO_STATUSES.has(record.audioMatch.status)) {
      throw new Error("Audio match requires an explicit human selection before approval.");
    }
    if ((record.audioMatch.filePath ?? null) !== (record.audioFilePath ?? null)) {
      throw new Error("Audio file path differs from the reviewed audio match.");
    }
  }
}

export function reviewAndApproveRecord(
  record: DemoRecording,
  reviewData: Partial<DemoRecording> = {},
  options: RecordReviewOptions = {}
): DemoRecording {
  const {
    isrcValidation: ignoredValidation,
    artistAttribution: ignoredAttribution,
    audioMatch: ignoredAudioMatch,
    ...reviewedFields
  } = reviewData;
  void ignoredValidation;
  void ignoredAttribution;
  void ignoredAudioMatch;

  let artistAttribution = record.artistAttribution;
  const selection = options.confirmArtistAttribution;
  if (selection) {
    artistAttribution = confirmArtistAttribution(
      artistAttribution ?? createArtistAttributionDecision(null, null),
      selection
    );
    if (
      reviewedFields.artist !== undefined &&
      reviewedFields.artist.trim() !== artistAttribution.confirmedExactArtist
    ) {
      throw new Error("Reviewed artist must match the confirmed artist attribution.");
    }
    reviewedFields.artist = artistAttribution.confirmedExactArtist ?? "";
  } else if (
    artistAttribution?.confirmed &&
    reviewedFields.artist !== undefined &&
    reviewedFields.artist !== artistAttribution.confirmedExactArtist
  ) {
    throw new Error("Confirmed artist attribution cannot change without a new explicit confirmation.");
  }
  const candidateIsrc = reviewedFields.isrc !== undefined
    ? reviewedFields.isrc?.trim() || null
    : record.isrc?.trim() || null;
  let isrcValidation = record.isrcValidation;

  if (candidateIsrc !== null) {
    if (!NORMALIZED_ISRC_PATTERN.test(candidateIsrc)) {
      throw new Error("ISRC must have a valid normalized 12-character format.");
    }
    isrcValidation = {
      status: "valid",
      originalValue: record.isrcValidation?.originalValue ?? record.isrc ?? candidateIsrc,
      reviewed: true
    };
  } else if (record.isrcValidation?.status === "invalid") {
    throw new Error("Invalid Orchard ISRC must be corrected before approval.");
  } else if (record.isrcValidation) {
    if (!options.confirmMissingIsrc) {
      throw new Error("Missing Orchard ISRC must be explicitly reviewed before approval.");
    }
    isrcValidation = {
      status: "missing",
      originalValue: record.isrcValidation.originalValue,
      reviewed: true
    };
  }

  const approved: DemoRecording = {
    ...record,
    ...reviewedFields,
    isrc: candidateIsrc,
    isrcValidation,
    ...(artistAttribution ? { artistAttribution } : {}),
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
