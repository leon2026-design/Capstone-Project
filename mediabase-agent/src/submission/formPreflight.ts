import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { redactResearchText } from "../metadata/metadataResearch";
import { normalizeDeclarationValue, type DemoRecording } from "../metadata/recordValidation";

/**
 * Independent pre-submission verification. After `prepareMediabaseForm` fills
 * the page, this module reads what the DOM actually holds (text values, checked
 * radios, the attached file's name, size, and SHA-256) and compares it with
 * values derived separately from the approved canonical record. It never looks
 * at what was passed to the form-filling function. Any failure blocks submission.
 */

export const FORM_TEXT_FIELDS = [
  "submitterName",
  "company",
  "phone",
  "email",
  "artist",
  "featuredArtist",
  "title",
  "version",
  "isrc",
  "label",
  "officialReleaseDate",
  "albumTitle",
  "albumUPC",
  "albumReleaseDate",
  "artistWebsite",
  "comments",
  "hideUntil"
] as const;

export const FORM_RADIO_FIELDS = [
  "rememberInformation",
  "generativeAiAudioDeclaration",
  "independentLabelDeclaration",
  "christmasHanukkahDeclaration",
  "canadianContentDeclaration"
] as const;

const CONTACT_FIELDS: ReadonlySet<string> = new Set(["submitterName", "company", "phone", "email"]);
const FILE_FIELD = "audioFile";
const SUBMISSION_ID_FIELD = "submissionId";

export type ObservedFile = { name: string; size: number; type: string; sha256: string };

export type ObservedFormState = {
  text: Record<string, string>;
  /** Checked value per radio group, or null when none is checked. */
  radios: Record<string, string | null>;
  fileInputs: Array<{ name: string; multiple: boolean; files: ObservedFile[] }>;
  submitClickCount: string | null;
  formSubmitCount: string | null;
};

export type ExpectedUpload = { fileName: string; size: number; sha256: string };

export type ExpectedFormState = {
  text: Record<string, string>;
  radios: Record<string, string | null>;
  upload: ExpectedUpload | null;
  submissionId: string;
};

export type PreflightFailureCode =
  | "FIELD_MISSING"
  | "FIELD_VALUE_MISMATCH"
  | "RADIO_SELECTION_MISMATCH"
  | "UNEXPECTED_FIELD_VALUE"
  | "FILE_INPUT_MISSING"
  | "FILE_INPUT_MULTIPLE"
  | "FILE_COUNT_MISMATCH"
  | "FILE_NAME_MISMATCH"
  | "FILE_SIZE_MISMATCH"
  | "FILE_DIGEST_MISMATCH"
  | "SUBMISSION_ID_MISMATCH"
  | "ALREADY_SUBMITTED";

export type PreflightFailure = {
  code: PreflightFailureCode;
  field: string;
  /** Redacted: contact values never appear; other values are sanitized and shortened. */
  expected: string | null;
  observed: string | null;
};

export type PreflightResult = {
  ok: boolean;
  failures: PreflightFailure[];
  /** Optional advisory text from a `DiscrepancyExplainer`; never affects `ok`. */
  explanations: string[];
};

/** An optional second reviewer (for example an LLM) that may explain failures but can never pass them. */
export interface DiscrepancyExplainer {
  explain(failures: readonly PreflightFailure[]): Promise<string[]>;
}

/** The form state the approved record requires, derived without reference to the form filler. */
export function expectedFormState(
  record: Readonly<DemoRecording>,
  upload: ExpectedUpload | null,
  submissionId: string
): ExpectedFormState {
  const text: Record<string, string> = {};
  for (const field of FORM_TEXT_FIELDS) {
    const value = record[field];
    text[field] = typeof value === "string" ? value : "";
  }
  const radios: Record<string, string | null> = {
    rememberInformation: String(record.rememberInformation === true)
  };
  for (const field of FORM_RADIO_FIELDS.slice(1)) {
    const value = normalizeDeclarationValue(record[field as keyof DemoRecording] as string | null | undefined);
    radios[field] = value === "unanswered" ? null : value;
  }
  return { text, radios, upload, submissionId };
}

type RawObservedFile = { name: string; size: number; type: string; sha256: string | null; bytesBase64: string | null };
type RawObserved = Omit<ObservedFormState, "fileInputs"> & {
  fileInputs: Array<{ name: string; multiple: boolean; files: RawObservedFile[] }>;
};

// Plain JavaScript evaluated in the page, kept as source so no compile-time transform can inject helpers into it.
const READ_FORM_SOURCE = `async function (selector) {
  var form = document.querySelector(selector);
  if (!(form instanceof HTMLFormElement)) throw new Error("Mediabase form not found.");
  var text = {};
  var radios = {};
  var fileInputs = [];
  var elements = Array.from(form.elements);
  for (var i = 0; i < elements.length; i += 1) {
    var element = elements[i];
    if (element instanceof HTMLInputElement && element.type === "radio") {
      if (!(element.name in radios)) radios[element.name] = null;
      if (element.checked) radios[element.name] = element.value;
    } else if (element instanceof HTMLInputElement && element.type === "file") {
      var files = [];
      var list = Array.from(element.files || []);
      for (var j = 0; j < list.length; j += 1) {
        var file = list[j];
        var buffer = await file.arrayBuffer();
        var subtle = globalThis.crypto && globalThis.crypto.subtle;
        if (subtle) {
          var digest = new Uint8Array(await subtle.digest("SHA-256", buffer));
          var hex = "";
          for (var k = 0; k < digest.length; k += 1) hex += digest[k].toString(16).padStart(2, "0");
          files.push({ name: file.name, size: file.size, type: file.type, sha256: hex, bytesBase64: null });
        } else {
          var bytes = new Uint8Array(buffer);
          var binary = "";
          for (var m = 0; m < bytes.length; m += 1) binary += String.fromCharCode(bytes[m]);
          files.push({ name: file.name, size: file.size, type: file.type, sha256: null, bytesBase64: btoa(binary) });
        }
      }
      fileInputs.push({ name: element.name, multiple: element.multiple, files: files });
    } else if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.name) {
      text[element.name] = element.value;
    }
  }
  var submit = document.querySelector("#submit");
  return {
    text: text,
    radios: radios,
    fileInputs: fileInputs,
    submitClickCount: submit ? submit.getAttribute("data-click-count") : null,
    formSubmitCount: form.getAttribute("data-submit-count")
  };
}`;

/** Reads the rendered form from the DOM. The file digest is computed from the File the page will send. */
export async function readRenderedForm(page: Page, formSelector = "#mediabase-form"): Promise<ObservedFormState> {
  const raw = (await page.evaluate(`(${READ_FORM_SOURCE})(${JSON.stringify(formSelector)})`)) as RawObserved;
  return {
    ...raw,
    fileInputs: raw.fileInputs.map((input) => ({
      ...input,
      files: input.files.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        sha256: file.sha256 ?? createHash("sha256").update(Buffer.from(file.bytesBase64 ?? "", "base64")).digest("hex")
      }))
    }))
  };
}

function shown(field: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (CONTACT_FIELDS.has(field)) return value === "" ? "" : "[redacted]";
  const clean = redactResearchText(value);
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

/** Deterministic comparison; every difference is a typed failure. */
export function compareFormState(expected: ExpectedFormState, observed: ObservedFormState): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  const add = (code: PreflightFailureCode, field: string, want: string | null, saw: string | null) =>
    failures.push({ code, field, expected: shown(field, want), observed: shown(field, saw) });

  for (const [field, value] of Object.entries(expected.text)) {
    if (!(field in observed.text)) add("FIELD_MISSING", field, value, null);
    else if (observed.text[field] !== value) add("FIELD_VALUE_MISMATCH", field, value, observed.text[field]);
  }
  for (const [field, value] of Object.entries(expected.radios)) {
    if (!(field in observed.radios)) add("FIELD_MISSING", field, value, null);
    else if (observed.radios[field] !== value) add("RADIO_SELECTION_MISMATCH", field, value, observed.radios[field]);
  }

  if (!(SUBMISSION_ID_FIELD in observed.text)) add("FIELD_MISSING", SUBMISSION_ID_FIELD, expected.submissionId, null);
  else if (observed.text[SUBMISSION_ID_FIELD] !== expected.submissionId) {
    add("SUBMISSION_ID_MISMATCH", SUBMISSION_ID_FIELD, expected.submissionId, observed.text[SUBMISSION_ID_FIELD]);
  }
  const known = new Set<string>([...Object.keys(expected.text), SUBMISSION_ID_FIELD]);
  for (const [field, value] of Object.entries(observed.text)) {
    if (!known.has(field) && value !== "") add("UNEXPECTED_FIELD_VALUE", field, "", value);
  }
  for (const field of Object.keys(observed.radios)) {
    if (!(field in expected.radios) && observed.radios[field] !== null) {
      add("UNEXPECTED_FIELD_VALUE", field, null, observed.radios[field]);
    }
  }

  const audioInput = observed.fileInputs.find((input) => input.name === FILE_FIELD);
  const otherFiles = observed.fileInputs.filter((input) => input.name !== FILE_FIELD).flatMap((input) => input.files);
  if (!audioInput) {
    add("FILE_INPUT_MISSING", FILE_FIELD, expected.upload ? "1" : "0", null);
  } else {
    if (audioInput.multiple) add("FILE_INPUT_MULTIPLE", FILE_FIELD, "single", "multiple");
    const wantCount = expected.upload ? 1 : 0;
    const totalCount = audioInput.files.length + otherFiles.length;
    if (totalCount !== wantCount) add("FILE_COUNT_MISMATCH", FILE_FIELD, String(wantCount), String(totalCount));
    const file = audioInput.files[0];
    if (expected.upload && file) {
      if (file.name !== expected.upload.fileName) add("FILE_NAME_MISMATCH", FILE_FIELD, expected.upload.fileName, file.name);
      if (file.size !== expected.upload.size) add("FILE_SIZE_MISMATCH", FILE_FIELD, String(expected.upload.size), String(file.size));
      if (file.sha256 !== expected.upload.sha256) add("FILE_DIGEST_MISMATCH", FILE_FIELD, expected.upload.sha256, file.sha256);
    }
  }

  if (observed.submitClickCount !== "0" || observed.formSubmitCount !== "0") {
    add("ALREADY_SUBMITTED", "form", "0", `${observed.submitClickCount ?? "?"}/${observed.formSubmitCount ?? "?"}`);
  }
  return failures;
}

export async function runFormPreflight(
  page: Page,
  expected: ExpectedFormState,
  options: { explainer?: DiscrepancyExplainer } = {}
): Promise<PreflightResult> {
  const failures = compareFormState(expected, await readRenderedForm(page));
  let explanations: string[] = [];
  if (failures.length > 0 && options.explainer) {
    try {
      explanations = (await options.explainer.explain(failures)).map((item) => redactResearchText(String(item)));
    } catch {
      explanations = ["The optional discrepancy explainer failed; deterministic failures stand."];
    }
  }
  // Deterministic failures decide the outcome; explanations are advisory only.
  return { ok: failures.length === 0, failures, explanations };
}
