import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  RESEARCH_SOURCE_CATEGORIES,
  redactResearchText,
  researchIdentityFingerprint,
  type MetadataResearchTask,
  type ResearchEvidenceClaim,
  type ResearchField,
  type ResearchSourceCategory,
  type VerifiedResearchEvidence
} from "../metadata/metadataResearch";
import type { ResearchGrounding } from "./researchProvider";

/** A host the verifier may retrieve. Configured by the operator, never by the model. */
export type ApprovedSource = {
  host: string;
  includeSubdomains: boolean;
  category: ResearchSourceCategory;
};

export type SourceVerifierConfig = {
  approvedSources: readonly ApprovedSource[];
  /** When true, a cited URL must belong to a host that search grounding actually returned. */
  requireGrounding: boolean;
  /** Budget for one retrieval, including redirects and body download. */
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxSourcesPerTask: number;
  /** Identity anchors (title/artist/version) must appear within this many characters of the quote. */
  identityWindowChars: number;
};

export const DEFAULT_SOURCE_VERIFIER_CONFIG: SourceVerifierConfig = {
  approvedSources: [],
  requireGrounding: true,
  timeoutMs: 10_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  maxSourcesPerTask: 6,
  identityWindowChars: 2_000
};

export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export type SourceVerificationStatus =
  | "VERIFIED"
  | "NO_URL"
  | "UNSAFE_URL"
  | "SOURCE_NOT_APPROVED"
  | "CATEGORY_MISMATCH"
  | "NOT_GROUNDED"
  | "REDIRECT_BLOCKED"
  | "PRIVATE_ADDRESS"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "UNSUPPORTED_CONTENT"
  | "QUOTE_NOT_FOUND"
  | "VALUE_NOT_IN_QUOTE"
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_SNAPSHOT_MISMATCH"
  | "NOT_CHECKED_LIMIT";

export const SOURCE_VERIFICATION_DESCRIPTIONS: Record<SourceVerificationStatus, string> = {
  VERIFIED: "Retrieved source contains the quote, the value, and this recording's identity.",
  NO_URL: "No source URL was provided, so the claim cannot be retrieved.",
  UNSAFE_URL: "The URL is not a plain public https URL (scheme, credentials, port, IP, or local host).",
  SOURCE_NOT_APPROVED: "The host is not on the approved source list.",
  CATEGORY_MISMATCH: "The claimed source category does not match the approved category for this host.",
  NOT_GROUNDED: "The cited host was not among the sources returned by search grounding.",
  REDIRECT_BLOCKED: "The source redirected to an unapproved or unsafe location, or redirected too many times.",
  PRIVATE_ADDRESS: "The host resolved to a private, loopback, or otherwise non-public address.",
  FETCH_FAILED: "The source could not be retrieved.",
  HTTP_ERROR: "The source returned an unsuccessful HTTP status.",
  TIMEOUT: "Retrieving the source timed out.",
  TOO_LARGE: "The source exceeded the response size limit.",
  UNSUPPORTED_CONTENT: "The source content type is not text or HTML.",
  QUOTE_NOT_FOUND: "The quoted text does not appear in the retrieved source.",
  VALUE_NOT_IN_QUOTE: "The quoted text does not contain the claimed value.",
  IDENTITY_NOT_FOUND: "The source near the quote does not identify this recording, release, and version.",
  IDENTITY_SNAPSHOT_MISMATCH: "The task's identity snapshot does not match its metadata; nothing was verified.",
  NOT_CHECKED_LIMIT: "Not retrieved: the per-task source retrieval limit was reached."
};

export type SourceVerificationReport = {
  role: "SUPPORTING" | "CONFLICTING";
  sourceId: string;
  url: string | null;
  finalUrl: string | null;
  host: string | null;
  approvedCategory: ResearchSourceCategory | null;
  claimedValue: string;
  contradictsSuggestion: boolean;
  status: SourceVerificationStatus;
  description: string;
  verificationId: string | null;
};

export type EvidenceVerificationResult = {
  /** Only created from retrieved content; bound to the task's identity snapshot. */
  attestations: VerifiedResearchEvidence[];
  reports: SourceVerificationReport[];
};

export type ClaimsToVerify = {
  suggestedValue: string | null;
  evidence: readonly ResearchEvidenceClaim[];
  conflictingEvidence: readonly ResearchEvidenceClaim[];
};

export interface EvidenceVerifier {
  verify(task: MetadataResearchTask, claims: ClaimsToVerify, grounding: ResearchGrounding): Promise<EvidenceVerificationResult>;
}

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];
const TEXT_CONTENT = /^(?:text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/ld\+json)\b/i;

export class SourceVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceVerifierConfigurationError";
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function validHostName(host: string): boolean {
  return HOST_PATTERN.test(host) && isIP(host) === 0 &&
    host !== "localhost" && !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Parses "host=category" entries, comma-separated. A leading "*." includes subdomains. */
export function parseApprovedSources(spec: string | undefined): ApprovedSource[] {
  if (!spec?.trim()) return [];
  return spec.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [rawHost, rawCategory, extra] = entry.split("=");
    const includeSubdomains = rawHost?.trim().startsWith("*.") ?? false;
    const host = normalizeHost((rawHost ?? "").replace(/^\s*\*\./, ""));
    const category = rawCategory?.trim();
    if (extra !== undefined || !validHostName(host)) {
      throw new SourceVerifierConfigurationError(`Invalid approved source host in entry "${redactResearchText(entry)}".`);
    }
    if (!RESEARCH_SOURCE_CATEGORIES.some((item) => item === category)) {
      throw new SourceVerifierConfigurationError(
        `Approved source "${host}" needs a category: ${RESEARCH_SOURCE_CATEGORIES.join(", ")}.`
      );
    }
    return { host, includeSubdomains, category: category as ResearchSourceCategory };
  });
}

function ipv4Public(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  if ([a, b, c].some((part) => part === undefined || Number.isNaN(part))) return false;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Rejects loopback, private, link-local, CGNAT, documentation, multicast, and mapped private addresses. */
export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(value);
  if (family === 4) return ipv4Public(value);
  if (family !== 6) return false;
  if (value === "::" || value === "::1") return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return ipv4Public(mapped[1]);
  if (/^::ffff:/.test(value)) return false;
  const first = parseInt(value.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (value.startsWith("2001:db8:") || value.startsWith("2001:0db8:")) return false;
  return true;
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

type UrlAssessment =
  | { ok: true; url: URL; source: ApprovedSource }
  | { ok: false; status: "UNSAFE_URL" | "SOURCE_NOT_APPROVED" };

function assessUrl(raw: string, approved: readonly ApprovedSource[]): UrlAssessment {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: "UNSAFE_URL" };
  }
  const host = normalizeHost(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || !validHostName(host)) {
    return { ok: false, status: "UNSAFE_URL" };
  }
  const source = approved.find((entry) =>
    host === entry.host || (entry.includeSubdomains && host.endsWith(`.${entry.host}`)));
  return source ? { ok: true, url, source } : { ok: false, status: "SOURCE_NOT_APPROVED" };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "-", mdash: "-" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** Visible text plus JSON-LD structured data; scripts, styles, and markup are removed. */
export function extractPageText(body: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return body;
  const jsonLd = [...body.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((match) => match[1]);
  const visible = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities([visible, ...jsonLd].join(" "));
}

/** Case-, accent-form-, and punctuation-insensitive phrase form, padded with spaces. */
export function normalizePhrase(value: string): string {
  const words = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words ? ` ${words} ` : " ";
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

function ordinal(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}

function dateVariants(value: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return [];
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return [];
  const dayNumber = Number(day);
  const days = [String(dayNumber), day, ordinal(dayNumber)];
  const months = [monthName, monthName.slice(0, 3)];
  const variants = [`${year} ${month} ${day}`];
  for (const name of months) {
    for (const d of days) variants.push(`${name} ${d} ${year}`, `${d} ${name} ${year}`);
  }
  return variants.map((variant) => ` ${variant} `);
}

/** Field-aware check that `value` is literally stated in an already phrase-normalized text. */
export function valueAppears(field: ResearchField, value: string, phrase: string): boolean {
  if (!value.trim()) return false;
  if (field === "isrc") {
    return phrase.replace(/ /g, "").includes(value.replace(/[^a-z0-9]/gi, "").toLowerCase());
  }
  if (field === "albumUPC") {
    const digits = value.replace(/\D/g, "");
    const accepted = new Set([digits, digits.length === 12 ? `0${digits}` : digits, digits.replace(/^0(?=\d{12}$)/, "")]);
    return (phrase.match(/\d+(?: \d+)*/g) ?? []).some((run) => accepted.has(run.replace(/ /g, "")));
  }
  if (field === "officialReleaseDate" || field === "albumReleaseDate") {
    return dateVariants(value).some((variant) => phrase.includes(variant));
  }
  const target = normalizePhrase(value);
  return target.trim().length > 0 && phrase.includes(target);
}

function identityAnchors(task: MetadataResearchTask): { required: string[]; anyArtist: string[] } | null {
  const meta = task.existingMetadata;
  const artists = [meta.artist, meta.trackArtist, meta.productArtist]
    .filter((value): value is string => Boolean(value?.trim()));
  const releaseLevel = task.field === "label" || task.field === "albumUPC" || task.field === "albumReleaseDate";
  const subject = releaseLevel ? meta.albumTitle?.trim() || meta.title?.trim() : meta.title?.trim();
  if (!subject || artists.length === 0) return null;
  const required = [subject];
  if (!releaseLevel && meta.version?.trim()) required.push(meta.version.trim());
  return { required, anyArtist: artists };
}

function identityNearQuote(task: MetadataResearchTask, phrase: string, quoteIndex: number, quoteLength: number, window: number): boolean {
  const anchors = identityAnchors(task);
  if (!anchors) return false;
  const nearby = phrase.slice(Math.max(0, quoteIndex - window), quoteIndex + quoteLength + window);
  const contains = (value: string): boolean => {
    const target = normalizePhrase(value);
    return target.trim().length > 0 && ` ${nearby} `.includes(target);
  };
  return anchors.required.every(contains) && anchors.anyArtist.some(contains);
}

function groundedHosts(grounding: ResearchGrounding): Set<string> {
  const hosts = new Set<string>();
  for (const source of grounding.sources) {
    for (const candidate of [source.domain, source.title]) {
      const host = candidate ? normalizeHost(candidate.replace(/^www\./i, "")) : "";
      if (validHostName(host)) hosts.add(host);
    }
    try {
      const host = normalizeHost(new URL(source.uri).hostname).replace(/^www\./, "");
      // Gemini API grounding URIs are Google redirect links; their host is not the source.
      if (validHostName(host) && !host.endsWith("google.com")) hosts.add(host);
    } catch {
      // Unparseable grounding URIs simply contribute no host.
    }
  }
  return hosts;
}

function isGrounded(host: string, hosts: Set<string>): boolean {
  const bare = host.replace(/^www\./, "");
  for (const grounded of hosts) {
    if (bare === grounded || bare.endsWith(`.${grounded}`)) return true;
  }
  return false;
}

type Retrieved =
  | { ok: true; finalUrl: string; phrase: string; contentHash: string }
  | { ok: false; status: SourceVerificationStatus };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Independently retrieves cited sources and checks them against the claim and the
 * recording identity snapshot. Gemini's descriptions and quotations are never trusted;
 * anything that cannot be established stays a provider claim for human review.
 */
export class SourceVerifier implements EvidenceVerifier {
  private readonly config: SourceVerifierConfig;
  private readonly fetchSource: SourceFetch;
  private readonly resolveHost: HostResolver;

  constructor(
    config: Partial<SourceVerifierConfig> = {},
    dependencies: { fetch?: SourceFetch; resolveHost?: HostResolver } = {}
  ) {
    const merged = { ...DEFAULT_SOURCE_VERIFIER_CONFIG, ...config };
    const bounded = (value: number, min: number, max: number, name: string): void => {
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new SourceVerifierConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
      }
    };
    bounded(merged.timeoutMs, 100, 60_000, "Verifier timeout (ms)");
    bounded(merged.maxBytes, 1_024, 5_000_000, "Verifier max bytes");
    bounded(merged.maxRedirects, 0, 5, "Verifier max redirects");
    bounded(merged.maxSourcesPerTask, 1, 20, "Verifier max sources per task");
    bounded(merged.identityWindowChars, 100, 20_000, "Verifier identity window");
    for (const source of merged.approvedSources) {
      if (!validHostName(normalizeHost(source.host)) ||
        !RESEARCH_SOURCE_CATEGORIES.some((category) => category === source.category)) {
        throw new SourceVerifierConfigurationError("Approved sources need a public host name and a known category.");
      }
    }
    this.config = {
      ...merged,
      approvedSources: merged.approvedSources.map((source) => ({ ...source, host: normalizeHost(source.host) }))
    };
    this.fetchSource = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.resolveHost = dependencies.resolveHost ?? defaultResolveHost;
  }

  async verify(task: MetadataResearchTask, claims: ClaimsToVerify, grounding: ResearchGrounding): Promise<EvidenceVerificationResult> {
    const snapshotValid = task.identityFingerprint === researchIdentityFingerprint(task.recordingId, task.existingMetadata);
    const hosts = groundedHosts(grounding);
    const cache = new Map<string, Promise<Retrieved>>();
    const attestations: VerifiedResearchEvidence[] = [];
    const reports: SourceVerificationReport[] = [];
    const entries = [
      ...claims.evidence.map((claim) => ({ claim, role: "SUPPORTING" as const })),
      ...claims.conflictingEvidence.map((claim) => ({ claim, role: "CONFLICTING" as const }))
    ];
    for (const { claim, role } of entries) {
      const report = (status: SourceVerificationStatus, extra: Partial<SourceVerificationReport> = {}): void => {
        reports.push({
          role,
          sourceId: redactResearchText(claim.sourceId).slice(0, 200),
          url: claim.url ? redactResearchText(claim.url).slice(0, 2_000) : null,
          finalUrl: null,
          host: null,
          approvedCategory: null,
          claimedValue: redactResearchText(claim.supportedValue).slice(0, 500),
          contradictsSuggestion: role === "CONFLICTING" || claim.supportedValue !== claims.suggestedValue,
          status,
          description: SOURCE_VERIFICATION_DESCRIPTIONS[status],
          verificationId: null,
          ...extra
        });
      };
      if (!snapshotValid) { report("IDENTITY_SNAPSHOT_MISMATCH"); continue; }
      if (!claim.url) { report("NO_URL"); continue; }
      const assessment = assessUrl(claim.url, this.config.approvedSources);
      if (!assessment.ok) { report(assessment.status); continue; }
      const host = normalizeHost(assessment.url.hostname);
      const located = { host, approvedCategory: assessment.source.category };
      if (assessment.source.category !== claim.category) { report("CATEGORY_MISMATCH", located); continue; }
      if (this.config.requireGrounding && !isGrounded(host, hosts)) { report("NOT_GROUNDED", located); continue; }
      const key = assessment.url.toString();
      if (!cache.has(key)) {
        if (cache.size >= this.config.maxSourcesPerTask) { report("NOT_CHECKED_LIMIT", located); continue; }
        cache.set(key, this.retrieve(key));
      }
      const retrieved = await (cache.get(key) as Promise<Retrieved>);
      if (!retrieved.ok) { report(retrieved.status, located); continue; }
      const fetched = { ...located, finalUrl: redactResearchText(retrieved.finalUrl).slice(0, 2_000) };
      const quote = normalizePhrase(claim.quote);
      const quoteIndex = quote.trim().length >= 8 ? retrieved.phrase.indexOf(quote) : -1;
      if (quoteIndex < 0) { report("QUOTE_NOT_FOUND", fetched); continue; }
      if (!valueAppears(task.field, claim.supportedValue, quote)) { report("VALUE_NOT_IN_QUOTE", fetched); continue; }
      if (!identityNearQuote(task, retrieved.phrase, quoteIndex, quote.length, this.config.identityWindowChars)) {
        report("IDENTITY_NOT_FOUND", fetched);
        continue;
      }
      const verificationId = `VERIFY-${sha256(JSON.stringify([
        task.identityFingerprint, task.field, claim.sourceId, claim.url, claim.quote,
        claim.supportedValue, retrieved.finalUrl, retrieved.contentHash
      ])).slice(0, 16).toUpperCase()}`;
      attestations.push({
        sourceId: claim.sourceId,
        url: claim.url,
        category: claim.category,
        quote: claim.quote,
        supportedValue: claim.supportedValue,
        recordingId: task.recordingId,
        field: task.field,
        identityFingerprint: task.identityFingerprint,
        verificationId
      });
      report("VERIFIED", { ...fetched, verificationId });
    }
    return { attestations, reports };
  }

  private async retrieve(initialUrl: string): Promise<Retrieved> {
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    let current = initialUrl;
    try {
      for (let hop = 0; hop <= this.config.maxRedirects; hop++) {
        const assessment = assessUrl(current, this.config.approvedSources);
        if (!assessment.ok) return { ok: false, status: hop === 0 ? assessment.status : "REDIRECT_BLOCKED" };
        const addresses = await this.resolveHost(normalizeHost(assessment.url.hostname));
        if (addresses.length === 0 || !addresses.every(isPublicAddress)) return { ok: false, status: "PRIVATE_ADDRESS" };
        const response = await this.fetchSource(current, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8",
            "user-agent": "mediabase-agent-evidence-verifier/1.0 (capstone prototype; read-only)"
          }
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) return { ok: false, status: "HTTP_ERROR" };
          current = new URL(location, current).toString();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: "HTTP_ERROR" };
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!TEXT_CONTENT.test(contentType)) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: "UNSUPPORTED_CONTENT" };
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > this.config.maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: "TOO_LARGE" };
        }
        const body = await this.readLimited(response);
        if (body === null) return { ok: false, status: "TOO_LARGE" };
        return {
          ok: true,
          finalUrl: current,
          phrase: normalizePhrase(extractPageText(body, contentType)),
          contentHash: sha256(body)
        };
      }
      return { ok: false, status: "REDIRECT_BLOCKED" };
    } catch {
      return { ok: false, status: signal.aborted ? "TIMEOUT" : "FETCH_FAILED" };
    }
  }

  private async readLimited(response: Response): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.config.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }
}
