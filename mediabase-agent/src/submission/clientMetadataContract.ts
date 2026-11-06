import type { AudioFormat, AudioMetadata } from "../audio/audioMetadata";
import { normalizeIsrcValue } from "../audio/audioMetadata";
import { getArtistAttributionProblem, isValidDate, type DemoRecording } from "../metadata/recordValidation";
import { redactResearchText } from "../metadata/metadataResearch";
import { reviewedVersionFromTitle } from "../metadata/versionDesignation";
import type { AudioTagField, AudioTagProfile, ExplicitTagValue, ExplicitTagValues } from "./audioTagProfile";
import { canonicalJson, sha256Hex } from "./submissionLedger";

export const CLIENT_METADATA_FIELDS = [
  "title", "artist", "additionalArtists", "albumArtist", "album", "isrc", "year",
  "genre", "publisher", "comments", "contentRating", "version"
] as const;

export type ClientMetadataField = (typeof CLIENT_METADATA_FIELDS)[number];
export type MetadataSource = "REVIEWED_RECORD" | "REVIEWED_DECISION" | "EMBEDDED" | "FILENAME";
export type MetadataRequirement = "REQUIRED" | "WHEN_APPLICABLE" | "OPTIONAL";

export type ClientFieldRule = {
  requirement: MetadataRequirement;
  valueType: "TEXT" | "ISRC" | "YEAR" | "CONTENT_RATING";
  sourcePriority: readonly MetadataSource[];
  automaticRecovery: boolean;
  conflictRequiresReview: boolean;
  /** Confirmed technical mappings only; null means that encoding is unresolved. */
  embeddedMapping: Readonly<Record<AudioFormat, string | null>>;
};

export type PublisherAlias = {
  original: string;
  canonical: string;
  approvedBy: string;
  sourceReference: string;
};

export type ClientMetadataContract = {
  id: string;
  version: string;
  supportedFormats: readonly AudioFormat[];
  fields: Readonly<Record<ClientMetadataField, ClientFieldRule>>;
  namingProfileId: string;
  contentRatingPolicy: {
    labels: readonly ["clean", "explicit"];
    filenameEvidenceOnly: true;
    conflictsRequireAcknowledgement: true;
  };
  publisherAliases: readonly PublisherAlias[];
  unresolvedMappings: readonly string[];
  audit: "PROVENANCE_REQUIRED";
};

const SOURCES: readonly MetadataSource[] = ["REVIEWED_RECORD", "REVIEWED_DECISION", "EMBEDDED", "FILENAME"];

function rule(
  requirement: MetadataRequirement,
  valueType: ClientFieldRule["valueType"],
  mp3: string | null,
  wav: string | null
): ClientFieldRule {
  return {
    requirement, valueType, sourcePriority: SOURCES, automaticRecovery: true,
    conflictRequiresReview: true, embeddedMapping: { MP3: mp3, WAV: wav }
  };
}

/**
 * Sponsor-required values are distinct from destination encoding support.
 * The unresolved mappings are intentionally not invented from sample files.
 */
export const SPONSOR_METADATA_CONTRACT: ClientMetadataContract = {
  id: "sponsor-recording-metadata",
  version: "1",
  supportedFormats: ["MP3", "WAV"],
  fields: {
    title: rule("REQUIRED", "TEXT", "ID3:TIT2", "ID3:TIT2+INFO:INAM"),
    artist: rule("REQUIRED", "TEXT", "ID3:TPE1", "ID3:TPE1+INFO:IART"),
    additionalArtists: rule("WHEN_APPLICABLE", "TEXT", null, null),
    albumArtist: rule("REQUIRED", "TEXT", "ID3:TPE2", "ID3:TPE2"),
    album: rule("REQUIRED", "TEXT", "ID3:TALB", "ID3:TALB+INFO:IPRD"),
    isrc: rule("REQUIRED", "ISRC", "ID3:TSRC", "ID3:TSRC"),
    year: rule("REQUIRED", "YEAR", "ID3:TYER/TDRC", "ID3:TYER/TDRC+INFO:ICRD"),
    genre: rule("REQUIRED", "TEXT", "ID3:TCON", "ID3:TCON+INFO:IGNR"),
    publisher: rule("REQUIRED", "TEXT", null, null),
    comments: rule("REQUIRED", "TEXT", "ID3:COMM", "ID3:COMM+INFO:ICMT"),
    contentRating: rule("REQUIRED", "CONTENT_RATING", null, null),
    version: rule("WHEN_APPLICABLE", "TEXT", "ID3:TIT3", "ID3:TIT3")
  },
  namingProfileId: "sponsor-title",
  contentRatingPolicy: {
    labels: ["clean", "explicit"],
    filenameEvidenceOnly: true,
    conflictsRequireAcknowledgement: true
  },
  publisherAliases: [],
  unresolvedMappings: [
    "Rye Music publisher frame",
    "clean/explicit encoding",
    "additional artist representation",
    "destination tag-reader compatibility"
  ],
  audit: "PROVENANCE_REQUIRED"
};

export type MetadataEvidence = {
  source: MetadataSource;
  sourceReference: string;
  originalValue: string;
  normalizedValue: string;
  resolutionRule: string;
  confidence: "VERIFIED" | "REVIEWED" | "UNCONFIRMED";
  reviewerId: string | null;
  automaticallyApplied: boolean;
  recordedAt: string;
  acknowledgement?: { note: string; evidenceReferences: string[] };
};

export type ResolvedClientField = {
  status: "VERIFIED" | "RECOVERED" | "MISSING" | "CONFLICT" | "UNSUPPORTED_MAPPING" | "NOT_APPLICABLE";
  value: string | null;
  evidence: MetadataEvidence[];
};

export type ClientMetadataProblem = {
  code: string;
  field: ClientMetadataField;
  message: string;
  evidenceReferences: string[];
  recommendedAction: string;
};

export type ClientMetadataResolution = {
  contractId: string;
  contractVersion: string;
  contractDigest: string;
  metadataDigest: string;
  fields: Record<ClientMetadataField, ResolvedClientField>;
  problems: ClientMetadataProblem[];
  warnings: ClientMetadataProblem[];
};

const TAG_FIELDS: Partial<Record<ClientMetadataField, AudioTagField>> = {
  title: "title", artist: "artist", albumArtist: "albumArtist", album: "album",
  isrc: "isrc", year: "year", genre: "genre", comments: "comments",
  contentRating: "contentRating", version: "version"
};

const WRITABLE: ReadonlySet<AudioTagField> = new Set([
  "title", "artist", "albumArtist", "album", "isrc", "year", "genre", "comments", "version"
]);

function validText(value: string | null | undefined): string | null {
  const text = value?.normalize("NFC").trim() ?? "";
  return text && !/\p{Cc}/u.test(text) ? text : null;
}

function approved(value: ExplicitTagValue | undefined): value is ExplicitTagValue {
  return !!value && !!validText(value.value) && !!validText(value.sourceReference) && !!validText(value.approvedBy);
}

function ratingIndicators(
  value: string | null | undefined,
  source: MetadataSource,
  labels: ClientMetadataContract["contentRatingPolicy"]["labels"]
): Array<"CLEAN" | "EXPLICIT"> {
  const text = (value ?? "").normalize("NFKC").toLowerCase().trim();
  const tokens: readonly string[] = source === "FILENAME"
    ? text.match(/[\p{L}\p{N}]+/gu) ?? []
    : source === "REVIEWED_DECISION"
      ? [text]
      : [...text.matchAll(/(?:\(|\[)\s*(clean|explicit)(?:\s+(?:version|edit|mix))?\s*(?:\)|\])|(?:^|\s+-\s+)(clean|explicit)\s*$/gu)]
        .map((match) => match[1] ?? match[2]);
  const result: Array<"CLEAN" | "EXPLICIT"> = [];
  if (tokens.includes(labels[0])) result.push("CLEAN");
  if (tokens.includes(labels[1])) result.push("EXPLICIT");
  return result;
}

export function clientContractDigest(contract: ClientMetadataContract): string {
  return sha256Hex(canonicalJson(contract));
}

function validateContract(contract: ClientMetadataContract): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(contract.id) || !/^[1-9]\d*(?:\.\d+){0,2}$/.test(contract.version)) {
    throw new Error("Client metadata contract needs a safe ID and explicit numeric version.");
  }
  if (!contract.supportedFormats.length || contract.supportedFormats.some((format) => format !== "MP3" && format !== "WAV")) {
    throw new Error("Client metadata contract must name supported audio formats.");
  }
  if (contract.contentRatingPolicy?.labels.join(",") !== "clean,explicit" ||
    !contract.contentRatingPolicy.filenameEvidenceOnly || !contract.contentRatingPolicy.conflictsRequireAcknowledgement) {
    throw new Error("Client content-rating policy must keep explicit labels and human conflict review.");
  }
  for (const field of CLIENT_METADATA_FIELDS) {
    const item = contract.fields[field];
    const expectedType = field === "isrc" ? "ISRC" : field === "year" ? "YEAR" :
      field === "contentRating" ? "CONTENT_RATING" : "TEXT";
    if (!item || !["REQUIRED", "WHEN_APPLICABLE", "OPTIONAL"].includes(item.requirement) ||
      item.valueType !== expectedType || !item.sourcePriority.length || !item.conflictRequiresReview ||
      item.sourcePriority.some((source) => !SOURCES.includes(source))) {
      throw new Error(`Invalid or unsafe client metadata rule for ${field}.`);
    }
  }
  const aliases = new Set<string>();
  for (const alias of contract.publisherAliases) {
    if (![alias.original, alias.canonical, alias.approvedBy, alias.sourceReference].every((item) => validText(item))) {
      throw new Error("Publisher aliases require an original, canonical value, reviewer, and source reference.");
    }
    const key = alias.original.normalize("NFC").trim().toLowerCase();
    if (aliases.has(key)) throw new Error("Publisher aliases must not map the same original value more than once.");
    aliases.add(key);
  }
}

export function resolveClientMetadata(
  recording: Readonly<DemoRecording>,
  format: AudioFormat,
  tagProfile: AudioTagProfile,
  options: {
    contract?: ClientMetadataContract;
    explicitValues?: ExplicitTagValues;
    sourceMetadata?: AudioMetadata;
    recordedAt?: string;
  } = {}
): ClientMetadataResolution {
  const contract = options.contract ?? SPONSOR_METADATA_CONTRACT;
  validateContract(contract);
  if (!contract.supportedFormats.includes(format)) throw new Error(`Client contract does not support ${format}.`);
  const at = options.recordedAt ?? new Date().toISOString();
  const evidence = (
    source: MetadataSource, reference: string, original: string, normalized: string,
    resolutionRule: string, reviewerId: string | null = null, automatic = false
  ): MetadataEvidence => ({
    source, sourceReference: reference, originalValue: original, normalizedValue: normalized,
    resolutionRule, confidence: source === "FILENAME" ? "UNCONFIRMED" : reviewerId ? "REVIEWED" : "VERIFIED",
    reviewerId, automaticallyApplied: automatic, recordedAt: at
  });
  const results = {} as Record<ClientMetadataField, ResolvedClientField>;
  const problems: ClientMetadataProblem[] = [];
  const warnings: ClientMetadataProblem[] = [];
  const addProblem = (
    field: ClientMetadataField, code: string, message: string, items: MetadataEvidence[], action: string,
    blocking = true
  ) => {
    const list = blocking ? problems : warnings;
    list.push({
      code, field, message,
      evidenceReferences: [...new Set(items.map((item) => redactResearchText(item.sourceReference)))],
      recommendedAction: action
    });
  };
  const explicit = options.explicitValues ?? {};
  const additional = [
    recording.artistAttribution?.secondaryArtist,
    recording.artistAttribution?.tertiaryArtist,
    recording.featuredArtist
  ].map(validText).filter((value): value is string => value !== null);
  const exactArtist = getArtistAttributionProblem(recording as DemoRecording)
    ? null
    : recording.artistAttribution?.confirmedExactArtist ?? (recording.recordSource === "MANUAL" ? recording.artist : null);
  const titleVersion = reviewedVersionFromTitle(recording.title);
  const values: Record<ClientMetadataField, string | null> = {
    title: validText(recording.title),
    artist: validText(exactArtist),
    additionalArtists: additional.length ? additional.join("; ") : null,
    albumArtist: validText(recording.artistAttribution?.productArtist),
    album: validText(recording.albumTitle),
    isrc: recording.isrcValidation?.status === "invalid" || recording.isrcValidation?.status === "missing"
      ? null : normalizeIsrcValue(recording.isrc),
    year: recording.officialReleaseDate && isValidDate(recording.officialReleaseDate)
      ? recording.officialReleaseDate.slice(-4) : null,
    genre: approved(explicit.genre) ? validText(explicit.genre.value) : null,
    publisher: approved(explicit.publisher) ? validText(explicit.publisher.value) : null,
    comments: validText(recording.comments),
    contentRating: null,
    version: validText(recording.version ?? titleVersion)
  };

  for (const field of CLIENT_METADATA_FIELDS) {
    const fieldRule = contract.fields[field];
    let value = values[field];
    let items: MetadataEvidence[] = [];
    if (field === "version" && recording.version && titleVersion &&
      recording.version.normalize("NFKC").trim().toLowerCase() !== titleVersion.normalize("NFKC").trim().toLowerCase()) {
      items = [
        evidence("REVIEWED_RECORD", "reviewed-record.title", recording.title, titleVersion, "title-version"),
        evidence("REVIEWED_RECORD", "reviewed-record.version", recording.version, recording.version.trim(), "reviewed-version")
      ];
      results[field] = { status: "CONFLICT", value: null, evidence: items };
      addProblem(field, "VERSION_CONFLICT", "The reviewed title and version disagree.", items,
        "Review the title and version together before preparation.");
      continue;
    }
    if (field === "contentRating") {
      const candidates: MetadataEvidence[] = [];
      const appendRatings = (text: string | null | undefined, source: MetadataSource, ref: string, reviewer?: string) => {
        for (const rating of ratingIndicators(text, source, contract.contentRatingPolicy.labels)) {
          candidates.push(evidence(source, ref, text!, rating, "explicit-clean-or-explicit-token", reviewer ?? null, source === "EMBEDDED"));
        }
      };
      appendRatings(recording.title, "REVIEWED_RECORD", "reviewed-record.title");
      if (approved(explicit.contentRating)) {
        appendRatings(explicit.contentRating.value, "REVIEWED_DECISION", explicit.contentRating.sourceReference, explicit.contentRating.approvedBy);
      }
      appendRatings(options.sourceMetadata?.title, "EMBEDDED", "selected-audio.embedded-title");
      appendRatings(options.sourceMetadata?.fileName, "FILENAME", "selected-audio.filename");
      items = candidates;
      const distinct = new Set(candidates.map((item) => item.normalizedValue));
      if (distinct.size > 1) {
        const decision = explicit.contentRating;
        const selected = approved(decision) && fieldRule.sourcePriority.includes("REVIEWED_DECISION")
          ? candidates.find((item) => item.source === "REVIEWED_DECISION" && item.reviewerId === decision.approvedBy)
          : undefined;
        const conflictingReferences = selected
          ? candidates.filter((item) => item.normalizedValue !== selected.normalizedValue).map((item) => item.sourceReference)
          : [];
        const acknowledged = selected && !!validText(decision?.note) &&
          conflictingReferences.every((ref) => decision?.acknowledgedEvidence?.includes(ref));
        if (!acknowledged) {
          results[field] = { status: "CONFLICT", value: null, evidence: items };
          addProblem(field, "CONTENT_RATING_CONFLICT", "Clean/explicit evidence conflicts.", items,
            "Review the conflicting title, tag, and filename evidence.");
          continue;
        }
        selected.resolutionRule = "human-acknowledged-conflicting-rating-evidence";
        selected.acknowledgement = { note: decision!.note!.trim(), evidenceReferences: [...conflictingReferences] };
        value = selected.normalizedValue;
      }
      if (!value) {
        const selected = candidates
          .filter((item) => item.source !== "FILENAME" && fieldRule.sourcePriority.includes(item.source) &&
            (item.source !== "EMBEDDED" || fieldRule.automaticRecovery))
          .sort((left, right) => fieldRule.sourcePriority.indexOf(left.source) - fieldRule.sourcePriority.indexOf(right.source))[0];
        value = selected?.normalizedValue ?? null;
      }
    } else if (value) {
      const override = field === "genre" ? explicit.genre : field === "publisher" ? explicit.publisher : undefined;
      const source = override ? "REVIEWED_DECISION" : "REVIEWED_RECORD";
      if (!fieldRule.sourcePriority.includes(source)) value = null;
      if (!value) {
        results[field] = { status: fieldRule.requirement === "REQUIRED" ? "MISSING" : "NOT_APPLICABLE", value: null, evidence: [] };
        if (fieldRule.requirement === "REQUIRED") {
          addProblem(field, "REQUIRED_TAG_VALUE_MISSING", `No approved source is enabled for ${field}.`, [],
            `Review the contract's source policy for ${field}.`);
        }
        continue;
      }
      const original = field === "year" ? recording.officialReleaseDate! :
        field === "version" && !recording.version ? recording.title : value;
      items.push(evidence(
        override ? "REVIEWED_DECISION" : "REVIEWED_RECORD",
        override?.sourceReference ?? (field === "version" && !recording.version ? "reviewed-record.title" : `reviewed-record.${field}`),
        override?.value ?? original, value, field === "year" ? "validated-release-year" :
          field === "version" && !recording.version ? "explicit-reviewed-title-version" : "reviewed-value",
        override?.approvedBy ?? null, field === "version" && !recording.version
      ));
      if (field === "publisher") {
        const alias = contract.publisherAliases.find((item) => item.original.normalize("NFC").trim().toLowerCase() === value!.toLowerCase());
        if (alias) {
          value = alias.canonical.normalize("NFC").trim();
          items.push(evidence("REVIEWED_DECISION", alias.sourceReference, alias.original, value, "approved-publisher-alias", alias.approvedBy));
        }
      }
    }

    if (!value) {
      const applicable = fieldRule.requirement === "REQUIRED";
      results[field] = { status: applicable ? "MISSING" : "NOT_APPLICABLE", value: null, evidence: items };
      if (applicable) {
        addProblem(field, field === "contentRating" ? "CLEAN_EXPLICIT_UNKNOWN" : "REQUIRED_TAG_VALUE_MISSING",
          `Required ${field} is not established by approved evidence.`, items,
          `Provide or review evidence for ${field}; do not invent a value.`);
      }
      continue;
    }
    const mappedField = TAG_FIELDS[field];
    const unsupported = !fieldRule.embeddedMapping[format] || !mappedField ||
      !WRITABLE.has(mappedField) || !tagProfile.mappings.includes(mappedField);
    if (unsupported) {
      results[field] = { status: "UNSUPPORTED_MAPPING", value, evidence: items };
      addProblem(field, "UNSUPPORTED_TAG_MAPPING", `No approved writable ${format} mapping is configured for ${field}.`, items,
        `Confirm and implement the ${field} encoding before preparation.`, fieldRule.requirement !== "OPTIONAL");
    } else {
      results[field] = {
        status: items.some((item) => item.automaticallyApplied) ? "RECOVERED" : "VERIFIED",
        value, evidence: items
      };
    }
  }

  const semanticFields = CLIENT_METADATA_FIELDS.map((field) => ({
    field, status: results[field].status, value: results[field].value,
    evidence: results[field].evidence.map(({ recordedAt: _recordedAt, ...item }) => item)
  }));
  return {
    contractId: contract.id,
    contractVersion: contract.version,
    contractDigest: clientContractDigest(contract),
    metadataDigest: sha256Hex(canonicalJson(semanticFields)),
    fields: results,
    problems,
    warnings
  };
}
