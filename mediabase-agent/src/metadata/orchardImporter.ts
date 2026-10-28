import { createHash } from "node:crypto";
import type { DemoRecording } from "../browser/mediabaseForm";

export type OrchardIssueSeverity = "warning" | "error";

export type OrchardImportIssue = {
  row: number;
  code:
    | "duplicate-source-row"
    | "invalid-isrc"
    | "missing-isrc"
    | "missing-required-field"
    | "malformed-csv";
  field?: string;
  message: string;
  rawValue?: string | null;
  severity: OrchardIssueSeverity;
};

export type OrchardImportReport = {
  sourceName: string;
  rowCount: number;
  importedCount: number;
  issues: OrchardImportIssue[];
  sourceRows: Array<{
    row: number;
    trackArtist: string | null;
    rawIsrc: string | null;
  }>;
};

export type OrchardImportResult = {
  records: DemoRecording[];
  report: OrchardImportReport;
};

type CsvRow = Record<string, string>;

const REQUIRED_HEADERS = ["TRACK", "PRODUCT ARTIST"];

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function clean(value: string | undefined): string | null {
  const result = value?.trim() ?? "";
  return result ? result : null;
}

function parseCsv(input: string): { headers: string[]; rows: string[][]; error?: string } {
  if (!input.trim()) {
    return { headers: [], rows: [] };
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field.length !== 0) {
        return { headers: [], rows: [], error: "Unexpected quote in an unquoted CSV field." };
      }
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    return { headers: [], rows: [], error: "Unclosed quoted CSV field." };
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = (rows.shift() ?? []).map(normalizeHeader);
  if (headers.length === 0 || headers.every((header) => !header)) {
    return { headers: [], rows: [], error: "CSV does not contain a header row." };
  }
  return { headers, rows };
}

function isSingleProduct(productType: string | null): boolean {
  return productType !== null && /^(DIGITAL )?SINGLE$|^TRACK$/.test(productType.toUpperCase());
}

function valueFor(row: CsvRow, ...names: string[]): string | null {
  for (const name of names) {
    const value = clean(row[name]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeIsrc(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(normalized)
    ? normalized
    : null;
}

function recordingIdentity(row: CsvRow): string[] {
  const rawIsrc = valueFor(row, "ISRC");
  return [
    valueFor(row, "TRACK"),
    valueFor(row, "PRODUCT ARTIST"),
    valueFor(row, "TRACK ARTIST"),
    normalizeIsrc(rawIsrc) ?? rawIsrc,
    valueFor(row, "VERSION", "VERSION/MIX", "MIX", "TRACK VERSION", "RECORDING VERSION"),
    valueFor(row, "LABEL IMPRINT"),
    valueFor(row, "PRODUCT"),
    valueFor(row, "DISPLAY UPC"),
    valueFor(row, "PRODUCT TYPE", "PRODUCT_TYPE", "RELEASE TYPE")
  ].map((value) => (value ?? "").trim().toUpperCase());
}

function stableId(
  sourceName: string,
  row: CsvRow,
  duplicateOccurrence: number
): string {
  const identity = [
    sourceName.trim(),
    ...recordingIdentity(row),
    duplicateOccurrence
  ].join("\u001F");
  return `ORCHARD-${createHash("sha256").update(identity).digest("hex").slice(0, 16).toUpperCase()}`;
}

function duplicateKey(row: CsvRow): string {
  return recordingIdentity(row).join("\u001F");
}

export function importOrchardCsv(
  csv: string,
  sourceName = "orchard.csv"
): OrchardImportResult {
  const parsed = parseCsv(csv);
  const issues: OrchardImportIssue[] = [];
  if (parsed.error) {
    issues.push({
      row: 1,
      code: "malformed-csv",
      message: parsed.error,
      severity: "error"
    });
    return {
      records: [],
      report: { sourceName, rowCount: 0, importedCount: 0, issues, sourceRows: [] }
    };
  }
  if (parsed.headers.length === 0) {
    return {
      records: [],
      report: { sourceName, rowCount: 0, importedCount: 0, issues, sourceRows: [] }
    };
  }

  const headerSet = new Set(parsed.headers);
  for (const header of REQUIRED_HEADERS) {
    if (!headerSet.has(header)) {
      issues.push({
        row: 1,
        code: "missing-required-field",
        field: header,
        message: `Required Orchard column ${header} is missing.`,
        severity: "error"
      });
    }
  }

  const records: DemoRecording[] = [];
  const sourceRows: OrchardImportReport["sourceRows"] = [];
  const seenRows = new Map<string, number>();
  for (const [index, values] of parsed.rows.entries()) {
    if (values.every((value) => value.trim() === "")) continue;
    const rowNumber = index + 2;
    const row: CsvRow = {};
    parsed.headers.forEach((header, column) => {
      row[header] = values[column] ?? "";
    });

    const key = duplicateKey(row);
    const duplicateOccurrence = (seenRows.get(key) ?? 0) + 1;
    if (duplicateOccurrence > 1) {
      issues.push({
        row: rowNumber,
        code: "duplicate-source-row",
        message: "This row duplicates an earlier Orchard source row; it was retained separately.",
        severity: "warning"
      });
    }
    seenRows.set(key, duplicateOccurrence);

    const rawIsrc = valueFor(row, "ISRC");
    sourceRows.push({
      row: rowNumber,
      trackArtist: valueFor(row, "TRACK ARTIST"),
      rawIsrc
    });
    const isrc = normalizeIsrc(rawIsrc);
    if (rawIsrc === null) {
      issues.push({
        row: rowNumber,
        code: "missing-isrc",
        field: "ISRC",
        message: "ISRC is missing; the recording was retained without a validated ISRC.",
        rawValue: rawIsrc,
        severity: "warning"
      });
    } else if (isrc === null) {
      issues.push({
        row: rowNumber,
        code: "invalid-isrc",
        field: "ISRC",
        message: "ISRC is invalid; the original value was retained in the import report.",
        rawValue: rawIsrc,
        severity: "warning"
      });
    }

    const artist = valueFor(row, "PRODUCT ARTIST") ?? "";
    const title = valueFor(row, "TRACK") ?? "";
    for (const [field, value] of [["PRODUCT ARTIST", artist], ["TRACK", title]] as const) {
      if (!value) {
        issues.push({
          row: rowNumber,
          code: "missing-required-field",
          field,
          message: `${field} is missing; the record was retained with an empty form value.`,
          severity: "warning"
        });
      }
    }

    const product = valueFor(row, "PRODUCT");
    const productType = valueFor(row, "PRODUCT TYPE", "PRODUCT_TYPE", "RELEASE TYPE");
    const record: DemoRecording = {
      recordingId: stableId(sourceName, row, duplicateOccurrence),
      submitterName: null,
      company: null,
      phone: null,
      email: null,
      rememberInformation: false,
      artist,
      featuredArtist: null,
      title,
      version: valueFor(row, "VERSION", "VERSION/MIX", "MIX", "TRACK VERSION", "RECORDING VERSION"),
      isrc,
      label: valueFor(row, "LABEL IMPRINT"),
      officialReleaseDate: null,
      albumTitle: isSingleProduct(productType) ? null : product,
      albumUPC: valueFor(row, "DISPLAY UPC"),
      albumReleaseDate: null,
      generativeAiAudioDeclaration: null,
      independentLabelDeclaration: null,
      christmasHanukkahDeclaration: null,
      canadianContentDeclaration: null,
      artistWebsite: null,
      comments: null,
      hideUntil: null,
      audioFilePath: null,
      approvalStatus: "DRAFT"
    };
    records.push(record);
  }

  return {
    records,
    report: {
      sourceName,
      rowCount: parsed.rows.filter((row) => row.some((value) => value.trim() !== "")).length,
      importedCount: records.length,
      issues,
      sourceRows
    }
  };
}
