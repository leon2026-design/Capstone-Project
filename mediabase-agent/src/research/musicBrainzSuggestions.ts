import {
  researchIdentityFingerprint,
  validateMetadataResearchResponse,
  type MetadataResearchResponse,
  type MetadataResearchTask,
  type ResearchValidationResult
} from "../metadata/metadataResearch";
import { isValidDate } from "../metadata/recordValidation";
import type {
  MusicBrainzLookupResult,
  MusicBrainzReleaseLookupResult
} from "./musicBrainzLookup";

export type MusicBrainzSelection = {
  musicBrainzRecordingId: string;
  musicBrainzReleaseId: string;
};

/**
 * Converts an explicitly selected MusicBrainz release into the existing
 * proposal format. Catalog evidence is not independent verification.
 * This function never changes records or approves metadata.
 */
export function buildMusicBrainzProposal(
  task: Readonly<MetadataResearchTask>,
  lookup: Readonly<MusicBrainzLookupResult>,
  releaseLookup: Readonly<MusicBrainzReleaseLookupResult>,
  selection: Readonly<MusicBrainzSelection>
): ResearchValidationResult {
  const reject = (message: string): ResearchValidationResult => ({
    ok: false,
    errors: [message]
  });

  if (
    task.identityFingerprint !==
    researchIdentityFingerprint(task.recordingId, task.existingMetadata)
  ) {
    return reject("The research task identity snapshot is inconsistent.");
  }

  if (
    lookup.recordingId !== task.recordingId ||
    !task.existingMetadata.isrc ||
    lookup.queriedIsrc !== task.existingMetadata.isrc
  ) {
    return reject("The MusicBrainz lookup does not match this task and ISRC.");
  }

  if (
    lookup.status !== "NEEDS_REVIEW" ||
    lookup.error !== null ||
    releaseLookup.status !== "NEEDS_REVIEW" ||
    releaseLookup.error !== null
  ) {
    return reject("Successful recording and release lookups are required.");
  }

  const candidate = lookup.candidates.find(
    (item) =>
      item.musicBrainzId === selection.musicBrainzRecordingId
  );

  if (
    !candidate ||
    releaseLookup.musicBrainzId !== candidate.musicBrainzId
  ) {
    return reject("The selected recording is not linked to these results.");
  }

  const release = releaseLookup.releases.find(
    (item) =>
      item.musicBrainzId === selection.musicBrainzReleaseId
  );

  if (!release) {
    return reject("The selected release is not among the retrieved releases.");
  }

  if (
    task.field !== "albumTitle" &&
    task.field !== "albumUPC" &&
    task.field !== "albumReleaseDate"
  ) {
    return reject("This adapter supports album title, UPC, and release date only.");
  }

  if (task.existingMetadata[task.field]?.trim()) {
    return reject("Existing metadata must not be replaced by this adapter.");
  }

  if (!task.allowedSourceCategories.includes("published-catalog")) {
    return reject("This task does not allow published catalog sources.");
  }

  const expectedSourceUrl =
    `https://musicbrainz.org/release/${release.musicBrainzId}`;

  if (release.sourceUrl !== expectedSourceUrl) {
    return reject("The release source link is inconsistent.");
  }

  let rawValue: string | null;
  let candidateValue: string | null;

  if (task.field === "albumTitle") {
    rawValue = release.title;
    candidateValue = release.title.trim() || null;
  } else if (task.field === "albumUPC") {
    rawValue = release.barcode;
    candidateValue = release.barcode;
  } else {
    rawValue = release.date;
    candidateValue = null;

    // Only full dates can become candidates. Partial dates stay evidence.
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(release.date ?? "");

    if (match) {
      const formatted = `${match[2]}/${match[3]}/${match[1]}`;
      if (isValidDate(formatted)) candidateValue = formatted;
    }
  }

  const response: MetadataResearchResponse = {
    recordingId: task.recordingId,
    gapId: task.gapId,
    field: task.field,
    suggestedValue: candidateValue,
    evidence: rawValue?.trim()
      ? [{
          sourceId: "MusicBrainz",
          url: expectedSourceUrl,
          category: "published-catalog",
          // Exact returned field text, not an invented sentence or page quote.
          quote: rawValue,
          supportedValue: candidateValue ?? rawValue
        }]
      : [],
    explanation:
      "The explicitly selected MusicBrainz release supplies catalog data. " +
      (
        candidateValue === null
          ? `No usable complete value was proposed. Raw catalog value: ${rawValue ?? "(missing)"}. `
          : ""
      ) +
      "Recording identity, version, and release suitability still require review. " +
      "No independent verification or metadata approval is claimed.",
    confidence: "UNKNOWN",
    conflictingEvidence: [],
    outcome: candidateValue === null
      ? "INSUFFICIENT_EVIDENCE"
      : "PROPOSED"
  };

  // No verification attestations are manufactured here.
  // Validator retains the evidence but withholds suggestedValue
  // until independently verified support is supplied.
  return validateMetadataResearchResponse(task, response);
}