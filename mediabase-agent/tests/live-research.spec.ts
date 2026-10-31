import { expect, test } from "@playwright/test";
import { ApiError, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeMetadataGaps } from "../src/metadata/metadataGapAnalyzer";
import {
  buildMetadataResearchTasks,
  researchIdentityFingerprint,
  validateMetadataResearchResponse,
  type MetadataResearchResponse,
  type MetadataResearchTask,
  type ResearchEvidenceClaim,
  type ResearchField
} from "../src/metadata/metadataResearch";
import { MockMetadataResearchProvider } from "../src/metadata/mockResearchProvider";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import {
  buildGeminiResearchPrompt,
  classifyGeminiError,
  DEFAULT_GEMINI_RESEARCH_CONFIG,
  GeminiConfigurationError,
  GeminiMetadataResearchProvider,
  loadGeminiResearchConfig,
  validateGeminiResearchConfig,
  type GeminiClientLike
} from "../src/research/geminiResearchProvider";
import { backoffDelayMs, runMetadataResearch, validateResearchLimits } from "../src/research/researchOrchestrator";
import { ResearchProviderError, type ResearchGrounding } from "../src/research/researchProvider";
import {
  isPublicAddress,
  parseApprovedSources,
  SourceVerifier,
  SourceVerifierConfigurationError,
  type SourceFetch
} from "../src/research/sourceVerifier";

const FAKE_KEY = "fictional-test-gemini-credential-0000";
const LABEL_HOST = "lowtiderecords.example";
const REGISTRY_HOST = "isrc-registry.example";
const LABEL_URL = `https://${LABEL_HOST}/releases/low-tide-atlas`;
const OTHER_LABEL_URL = `https://${LABEL_HOST}/releases/other-album`;
const REGISTRY_URL = `https://${REGISTRY_HOST}/recordings/glass-coast`;
const APPROVED = parseApprovedSources(`${LABEL_HOST}=official-label,*.${REGISTRY_HOST}=identifier-registry`);

function record() {
  return importOrchardCsv(
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,VERSION\n" +
      "Glass Coast,Mara Quill,Tidewater Collective,Low Tide Atlas,Album,Radio Edit\n",
    "fictional-live-research.csv"
  ).records[0];
}

function taskFor(field: ResearchField, source = record()): MetadataResearchTask {
  const task = buildMetadataResearchTasks(source, analyzeMetadataGaps(source)).find((item) => item.field === field);
  if (!task) throw new Error(`Missing fictional ${field} task.`);
  return task;
}

function labelClaim(overrides: Partial<ResearchEvidenceClaim> = {}): ResearchEvidenceClaim {
  return {
    sourceId: "Low Tide Records release page",
    url: LABEL_URL,
    category: "official-label",
    quote: "Label: Low Tide Records",
    supportedValue: "Low Tide Records",
    ...overrides
  };
}

function labelResponse(task: MetadataResearchTask, overrides: Partial<MetadataResearchResponse> = {}): MetadataResearchResponse {
  return {
    recordingId: task.recordingId,
    gapId: task.gapId,
    field: task.field,
    suggestedValue: "Low Tide Records",
    evidence: [labelClaim()],
    explanation: "The official label release page for Low Tide Atlas lists the label.",
    confidence: "HIGH",
    conflictingEvidence: [],
    outcome: "PROPOSED",
    ...overrides
  };
}

const LABEL_PAGE = `<!doctype html><html><head><title>Low Tide Atlas</title>
<script>document.write("Label: Fabricated Records")</script><style>.x{}</style></head>
<body><h1>Low Tide Atlas</h1><p>by Tidewater Collective</p><p>Featuring Mara Quill &amp; friends.</p>
<p>Label: Low Tide Records</p><p>Catalog LTR-001</p></body></html>`;
const OTHER_PAGE = `<html><body><h1>Harbor Songs</h1><p>by Someone Else</p><p>Label: Low Tide Records</p></body></html>`;
const CONFLICT_PAGE = `<html><body><h1>Low Tide Atlas</h1><p>Tidewater Collective</p><p>Distributed under Saltwater Sound</p></body></html>`;

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

type FetchLog = string[];

function fakeFetch(pages: Record<string, () => Response>, log: FetchLog = []): SourceFetch {
  return async (url, init) => {
    log.push(url);
    expect(init.redirect).toBe("manual");
    const page = pages[url];
    if (!page) throw new TypeError("fictional network failure");
    return page();
  };
}

const publicResolver = async (): Promise<readonly string[]> => ["93.184.216.34"];

function verifier(pages: Record<string, () => Response>, log: FetchLog = [], extra: Partial<ConstructorParameters<typeof SourceVerifier>[0]> = {}) {
  return new SourceVerifier(
    { approvedSources: APPROVED, ...extra },
    { fetch: fakeFetch(pages, log), resolveHost: publicResolver }
  );
}

function grounding(...hosts: string[]): ResearchGrounding {
  return {
    searchEnabled: true,
    sources: hosts.map((host, index) => ({
      uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/fictional-${index}`,
      title: host,
      domain: null
    })),
    searchQueryCount: hosts.length ? 1 : 0
  };
}

function geminiResponse(body: unknown, hosts: string[] = [LABEL_HOST]): GenerateContentResponse {
  return {
    candidates: [{
      content: { role: "model", parts: [{ text: "internal reasoning", thought: true }, { text: typeof body === "string" ? body : JSON.stringify(body) }] },
      groundingMetadata: {
        groundingChunks: [
          ...grounding(...hosts).sources.map((source) => ({ web: { uri: source.uri, title: source.title ?? undefined } })),
          { web: { uri: "http://insecure.example/ignored", title: "insecure.example" } }
        ],
        webSearchQueries: hosts.length ? ["Low Tide Atlas Tidewater Collective label", " "] : []
      }
    }],
    usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 150, thoughtsTokenCount: 40, toolUsePromptTokenCount: 300, totalTokenCount: 1090 }
  } as unknown as GenerateContentResponse;
}

type ClientStep = GenerateContentResponse | Error;

function fakeClient(steps: ClientStep[] | ((params: GenerateContentParameters) => ClientStep)) {
  const calls: GenerateContentParameters[] = [];
  const client: GeminiClientLike = {
    models: {
      async generateContent(params) {
        calls.push(params);
        const step = typeof steps === "function" ? steps(params) : steps.shift();
        if (!step) throw new Error("No fake Gemini response left.");
        if (step instanceof Error) throw step;
        return step;
      }
    }
  };
  return { client, calls };
}

function gemini(client: GeminiClientLike): GeminiMetadataResearchProvider {
  return new GeminiMetadataResearchProvider(DEFAULT_GEMINI_RESEARCH_CONFIG, client);
}

function rateLimit(delaySeconds?: number): ApiError {
  return new ApiError({
    status: 429,
    message: JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: `Too many requests for key ${FAKE_KEY}`,
        details: delaySeconds ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${delaySeconds}s` }] : []
      }
    })
  });
}

function quotaError(details: unknown[], status = 429): ApiError {
  return new ApiError({
    status,
    message: JSON.stringify({
      error: {
        code: status,
        status: "RESOURCE_EXHAUSTED",
        message: `Private prompt and credential ${FAKE_KEY}`,
        details
      }
    })
  });
}

function exhaustedQuota(): ApiError {
  return quotaError([{
    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
    violations: [{
      quotaMetric: "generativelanguage.googleapis.com/generate_content_requests",
      quotaId: "GenerateRequestsPerDayPerProjectPerModel",
      quotaValue: "100",
      description: `Private details ${FAKE_KEY}`
    }]
  }]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const noSleep = async (): Promise<void> => undefined;

// Any accidental real network access fails the test instead of reaching the internet.
let realFetch: typeof globalThis.fetch;
test.beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Network access is forbidden in tests.");
  }) as typeof globalThis.fetch;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test.describe("Gemini provider", () => {
  test("sends a grounded, schema-constrained request and returns untrusted JSON with grounding and usage", async () => {
    const task = taskFor("label");
    const { client, calls } = fakeClient([geminiResponse(labelResponse(task))]);
    const result = await gemini(client).researchWithGrounding(task);

    expect(result.response).toEqual(labelResponse(task));
    expect(result.grounding).toEqual({ searchEnabled: true, sources: grounding(LABEL_HOST).sources, searchQueryCount: 1 });
    expect(result.usage).toEqual({
      providerCalls: 1, promptTokens: 600, candidatesTokens: 150, thoughtsTokens: 40,
      toolUsePromptTokens: 300, totalTokens: 1090, searchQueries: 1
    });
    const [params] = calls;
    expect(params.model).toBe(DEFAULT_GEMINI_RESEARCH_CONFIG.model);
    expect(params.config?.tools).toEqual([{ googleSearch: {} }]);
    expect(params.config?.responseMimeType).toBe("application/json");
    expect(params.config?.automaticContinuation).toBe(false);
    expect(params.config?.httpOptions?.retryOptions).toBeUndefined();
    const schema = params.config?.responseJsonSchema as { properties: Record<string, { enum?: string[] }>; additionalProperties: boolean };
    expect(schema.properties.recordingId.enum).toEqual([task.recordingId]);
    expect(schema.properties.field.enum).toEqual(["label"]);
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(params)).not.toContain(FAKE_KEY);
  });

  test("flattens multi-line explanations but leaves values and quotes untouched", async () => {
    const task = taskFor("label");
    const body = labelResponse(task, { explanation: "Line one.\nLine two.\tTabbed." });
    const { client } = fakeClient([geminiResponse(body)]);
    const result = await gemini(client).researchWithGrounding(task);
    expect((result.response as MetadataResearchResponse).explanation).toBe("Line one. Line two. Tabbed.");
    expect((result.response as MetadataResearchResponse).evidence).toEqual(body.evidence);
  });

  test("rejects malformed JSON, empty output, and blocked prompts as INVALID_RESPONSE", async () => {
    const task = taskFor("label");
    for (const response of [
      geminiResponse("{not json"),
      { candidates: [{ content: { parts: [{ text: "only thoughts", thought: true }] } }] } as unknown as GenerateContentResponse,
      { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } as unknown as GenerateContentResponse
    ]) {
      const { client } = fakeClient([response]);
      await expect(gemini(client).researchWithGrounding(task)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  test("missing API key and invalid configuration fail before any request without echoing secrets", () => {
    expect(() => loadGeminiResearchConfig({})).toThrow(GeminiConfigurationError);
    expect(() => loadGeminiResearchConfig({ GEMINI_API_KEY: "   " })).toThrow(/GEMINI_API_KEY/);
    expect(loadGeminiResearchConfig({ GEMINI_API_KEY: FAKE_KEY }).model).toBe(DEFAULT_GEMINI_RESEARCH_CONFIG.model);
    expect(loadGeminiResearchConfig({ GOOGLE_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_MODEL: "models/gemini-2.5-flash" }).model)
      .toBe("gemini-2.5-flash");
    const invalid: NodeJS.ProcessEnv[] = [
      { GEMINI_API_KEY: FAKE_KEY, GOOGLE_GENAI_USE_VERTEXAI: "true" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_MODEL: "gemini-3-flash-preview" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_MODEL: "gemini-flash-latest" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_MODEL: "gpt-4" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_TIMEOUT_MS: "5" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_MAX_OUTPUT_TOKENS: "lots" },
      { GEMINI_API_KEY: FAKE_KEY, MEDIABASE_GEMINI_GOOGLE_SEARCH: "maybe" }
    ];
    for (const env of invalid) {
      let message = "";
      try {
        loadGeminiResearchConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(GeminiConfigurationError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(FAKE_KEY);
    }
    expect(() => validateGeminiResearchConfig({ ...DEFAULT_GEMINI_RESEARCH_CONFIG, model: "gemini-2.5-flash-image" }))
      .toThrow(GeminiConfigurationError);
    expect(() => new SourceVerifier({ timeoutMs: 1 })).toThrow(SourceVerifierConfigurationError);
    expect(() => parseApprovedSources("localhost=official-label")).toThrow(SourceVerifierConfigurationError);
    expect(() => parseApprovedSources(`${LABEL_HOST}=random-blog`)).toThrow(SourceVerifierConfigurationError);
    expect(() => validateResearchLimits({ maxRetries: 50 })).toThrow(/maxRetries/);
  });

  test("classifies SDK failures into safe codes without retaining the original message", () => {
    const quota = classifyGeminiError(new ApiError({ status: 429, message: `You exceeded your current quota ${FAKE_KEY}` }));
    expect(quota).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429, retryable: true, retryAfterMs: null });
    expect(classifyGeminiError(rateLimit(12))).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 12_000 });
    expect(classifyGeminiError(new ApiError({ status: 503, message: "overloaded" }))).toMatchObject({ code: "TRANSIENT", retryable: true });
    expect(classifyGeminiError(new ApiError({ status: 403, message: "denied" }))).toMatchObject({ code: "AUTHENTICATION_ERROR", retryable: false });
    expect(classifyGeminiError(new ApiError({ status: 400, message: "API key not valid" }))).toMatchObject({ code: "AUTHENTICATION_ERROR" });
    expect(classifyGeminiError(new ApiError({ status: 400, message: "tool not supported" }))).toMatchObject({ code: "CONFIGURATION_ERROR" });
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    expect(classifyGeminiError(timeout)).toMatchObject({ code: "TIMEOUT", retryable: true });
    for (const error of [quota, classifyGeminiError(new Error(`boom ${FAKE_KEY}`))]) {
      expect(error.message).not.toContain(FAKE_KEY);
      expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
    }
  });

  test("distinguishes confirmed exhausted quota from temporary or ambiguous 429 details", () => {
    const type = (name: string) => `type.googleapis.com/google.rpc.${name}`;
    const cases: { error: ApiError; code: string; delay?: number | null }[] = [
      { error: exhaustedQuota(), code: "QUOTA_EXHAUSTED" },
      {
        error: quotaError([{ "@type": type("QuotaFailure"), violations: [{ quotaValue: "0" }] },
          { "@type": type("RetryInfo"), retryDelay: "2s" }]),
        code: "QUOTA_EXHAUSTED"
      },
      {
        error: quotaError([{ "@type": type("ErrorInfo"), domain: "googleapis.com", reason: "DAILY_LIMIT_EXCEEDED" }]),
        code: "QUOTA_EXHAUSTED"
      },
      {
        error: quotaError([{ "@type": type("ErrorInfo"), domain: "googleapis.com", reason: "QUOTA_EXHAUSTED" }]),
        code: "QUOTA_EXHAUSTED"
      },
      {
        error: quotaError([{ "@type": type("QuotaFailure"), violations: [{ quotaId: "RequestsPerMinute", quotaValue: "30" }] },
          { "@type": type("RetryInfo"), retryDelay: "1.25s" }]),
        code: "RATE_LIMITED", delay: 1250
      },
      { error: quotaError([{ "@type": type("QuotaFailure"), violations: [{ description: "daily quota exceeded" }] }]), code: "RATE_LIMITED" },
      { error: quotaError([{ "@type": type("ErrorInfo"), domain: "googleapis.com", reason: "QUOTA_EXCEEDED" }]), code: "RATE_LIMITED" },
      { error: quotaError([{ "@type": type("ErrorInfo"), domain: FAKE_KEY, reason: "QUOTA_EXHAUSTED" }]), code: "RATE_LIMITED" },
      { error: quotaError([{ "@type": "unknown", quotaValue: 0, retryDelay: "5s" }]), code: "RATE_LIMITED" },
      { error: quotaError([{ "@type": type("RetryInfo"), retryDelay: `5s ${FAKE_KEY}` }]), code: "RATE_LIMITED" },
      { error: quotaError([{ "@type": type("RetryInfo"), retryDelay: "999999999999999999999s" }]), code: "RATE_LIMITED" },
      { error: quotaError([]), code: "RATE_LIMITED" },
      { error: new ApiError({ status: 429, message: `RESOURCE_EXHAUSTED ${FAKE_KEY}` }), code: "RATE_LIMITED" },
      { error: new ApiError({ status: 429, message: '{"error":{"code":429,"details":' }), code: "RATE_LIMITED" },
      { error: new ApiError({ status: 429, message: '{"error":{"code":403,"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaValue":0}]}]}}' }), code: "RATE_LIMITED" }
    ];
    for (const { error, code, delay } of cases) {
      const classified = classifyGeminiError(error);
      expect(classified).toMatchObject({
        code, httpStatus: 429, retryable: code !== "QUOTA_EXHAUSTED", retryAfterMs: delay ?? null
      });
      expect(JSON.stringify(classified)).not.toContain(FAKE_KEY);
      expect(classified.message).not.toContain("Private");
      expect(classified).not.toHaveProperty("cause");
    }
    expect(new ResearchProviderError("QUOTA_EXHAUSTED", { retryable: true }).retryable).toBe(false);
  });

  test("keeps timeout diagnostics separate from HTTP rate-limit diagnostics", () => {
    for (const status of [408, 504]) {
      expect(classifyGeminiError(new ApiError({ status, message: FAKE_KEY }))).toMatchObject({
        code: "TIMEOUT", httpStatus: status, retryable: true
      });
    }
    for (const name of ["AbortError", "TimeoutError"]) {
      expect(classifyGeminiError(Object.assign(new Error(FAKE_KEY), { name }))).toMatchObject({
        code: "TIMEOUT", httpStatus: null, retryable: true
      });
    }
  });

  test("prompts contain only redacted, allowlisted task data", () => {
    const task = taskFor("label");
    const tainted: MetadataResearchTask = {
      ...task,
      originalEvidence: [...task.originalEvidence, { source: "record", field: "label", value: "brad@example.test C:\\Users\\Brad\\audio.wav" }]
    };
    const prompt = buildGeminiResearchPrompt(tainted);
    expect(prompt).toContain("Low Tide Atlas");
    expect(prompt).not.toContain("brad@example.test");
    expect(prompt).not.toContain("C:\\Users");
    expect(prompt).not.toContain("approvalStatus");
    expect(prompt).not.toContain("submitter");
  });
});

test.describe("Source verifier", () => {
  test("verifies a grounded, approved source only after retrieving content that matches value and identity", async () => {
    const task = taskFor("label");
    const log: FetchLog = [];
    const result = await verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }, log)
      .verify(task, { suggestedValue: "Low Tide Records", evidence: [labelClaim()], conflictingEvidence: [] }, grounding(LABEL_HOST));

    expect(log).toEqual([LABEL_URL]);
    expect(result.reports).toMatchObject([{ status: "VERIFIED", role: "SUPPORTING", host: LABEL_HOST, approvedCategory: "official-label" }]);
    expect(result.attestations).toHaveLength(1);
    expect(result.attestations[0]).toMatchObject({
      ...labelClaim(), recordingId: task.recordingId, field: "label", identityFingerprint: task.identityFingerprint
    });
    expect(result.attestations[0].verificationId).toMatch(/^VERIFY-[0-9A-F]{16}$/);
    expect(result.reports[0].verificationId).toBe(result.attestations[0].verificationId);
  });

  test("keeps unverified, fabricated, and misleading citations as provider claims", async () => {
    const task = taskFor("label");
    const pages = { [LABEL_URL]: () => html(LABEL_PAGE), [OTHER_LABEL_URL]: () => html(OTHER_PAGE) };
    const claims = [
      labelClaim({ sourceId: "fabricated quote", quote: "Label: Low Tide Records International" }),
      labelClaim({ sourceId: "quote without value", quote: "Catalog LTR-001" }),
      labelClaim({ sourceId: "script-only text", quote: "Label: Fabricated Records", supportedValue: "Fabricated Records" }),
      labelClaim({ sourceId: "different release", url: OTHER_LABEL_URL }),
      labelClaim({ sourceId: "wrong category", category: "distributor" }),
      labelClaim({ sourceId: "unapproved host", url: "https://random-blog.example/post" }),
      labelClaim({ sourceId: "no url", url: null })
    ];
    const result = await verifier(pages).verify(
      task, { suggestedValue: "Low Tide Records", evidence: claims, conflictingEvidence: [] }, grounding(LABEL_HOST)
    );
    expect(result.reports.map((report) => [report.sourceId, report.status])).toEqual([
      ["fabricated quote", "QUOTE_NOT_FOUND"],
      ["quote without value", "VALUE_NOT_IN_QUOTE"],
      ["script-only text", "QUOTE_NOT_FOUND"],
      ["different release", "IDENTITY_NOT_FOUND"],
      ["wrong category", "CATEGORY_MISMATCH"],
      ["unapproved host", "SOURCE_NOT_APPROVED"],
      ["no url", "NO_URL"]
    ]);
    expect(result.attestations).toEqual([]);
  });

  test("requires the cited host to come from search grounding, never from the model alone", async () => {
    const task = taskFor("label");
    const log: FetchLog = [];
    const result = await verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }, log)
      .verify(task, { suggestedValue: "Low Tide Records", evidence: [labelClaim()], conflictingEvidence: [] }, grounding());
    expect(result.reports[0].status).toBe("NOT_GROUNDED");
    expect(result.attestations).toEqual([]);
    expect(log).toEqual([]);

    const limited = await verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }, log, { maxSourcesPerTask: 1 }).verify(task, {
      suggestedValue: "Low Tide Records",
      evidence: [labelClaim(), labelClaim({ sourceId: "same page" }), labelClaim({ sourceId: "second page", url: OTHER_LABEL_URL })],
      conflictingEvidence: []
    }, grounding(LABEL_HOST));
    expect(limited.reports.map((report) => report.status)).toEqual(["VERIFIED", "VERIFIED", "NOT_CHECKED_LIMIT"]);
    expect(log).toEqual([LABEL_URL]);
  });

  test("blocks unsafe URLs, private addresses, and redirects to unapproved or unsafe hosts", async () => {
    const task = taskFor("label");
    const log: FetchLog = [];
    const hop = (n: number) => `https://${LABEL_HOST}/hop-${n}`;
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    const pages: Record<string, () => Response> = {
      [hop(1)]: redirect("https://evil.example/steal"),
      [hop(2)]: redirect("http://127.0.0.1/admin"),
      [hop(3)]: redirect(hop(4)),
      [hop(4)]: redirect(hop(5)),
      [hop(5)]: redirect(hop(6)),
      [hop(6)]: redirect(hop(7)),
      [hop(8)]: redirect("/releases/low-tide-atlas"),
      [LABEL_URL]: () => html(LABEL_PAGE)
    };
    const unsafe = [
      "http://lowtiderecords.example/releases/low-tide-atlas",
      "https://user:pass@lowtiderecords.example/x",
      "https://lowtiderecords.example:8443/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://printer.local/x",
      "file:///etc/passwd"
    ];
    const claims = [
      ...unsafe.map((url) => labelClaim({ sourceId: url, url })),
      ...[1, 2, 3, 8].map((n) => labelClaim({ sourceId: `hop-${n}`, url: hop(n) }))
    ];
    const result = await verifier(pages, log, { maxSourcesPerTask: 20 })
      .verify(task, { suggestedValue: "Low Tide Records", evidence: claims, conflictingEvidence: [] }, grounding(LABEL_HOST));
    expect(result.reports.map((report) => report.status)).toEqual([
      ...unsafe.map(() => "UNSAFE_URL"),
      "REDIRECT_BLOCKED", "REDIRECT_BLOCKED", "REDIRECT_BLOCKED", "VERIFIED"
    ]);
    expect(log.some((url) => !url.startsWith(`https://${LABEL_HOST}/`))).toBe(false);

    const rebinding = new SourceVerifier(
      { approvedSources: APPROVED },
      { fetch: fakeFetch(pages, log), resolveHost: async () => ["93.184.216.34", "10.0.0.7"] }
    );
    const privateResult = await rebinding
      .verify(task, { suggestedValue: "Low Tide Records", evidence: [labelClaim()], conflictingEvidence: [] }, grounding(LABEL_HOST));
    expect(privateResult.reports[0].status).toBe("PRIVATE_ADDRESS");

    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });

  test("enforces timeouts, size limits, content types, and HTTP failures", async () => {
    const task = taskFor("label");
    const url = (name: string) => `https://${LABEL_HOST}/${name}`;
    const big = "x".repeat(5_000);
    const pages: Record<string, () => Response> = {
      [url("declared-large")]: () => html("small", { headers: { "content-type": "text/html", "content-length": "999999999" } }),
      [url("streamed-large")]: () => html(big),
      [url("binary")]: () => new Response("PDF", { headers: { "content-type": "application/pdf" } }),
      [url("missing")]: () => html("gone", { status: 404 })
    };
    const slowFetch: SourceFetch = (target, init) => {
      if (target !== url("slow")) return fakeFetch(pages)(target, init);
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    };
    const result = await new SourceVerifier(
      { approvedSources: APPROVED, timeoutMs: 100, maxBytes: 1_024 },
      { fetch: slowFetch, resolveHost: publicResolver }
    ).verify(task, {
      suggestedValue: "Low Tide Records",
      evidence: ["slow", "declared-large", "streamed-large", "binary", "missing", "unreachable"]
        .map((name) => labelClaim({ sourceId: name, url: url(name) })),
      conflictingEvidence: []
    }, grounding(LABEL_HOST));
    expect(result.reports.map((report) => report.status)).toEqual([
      "TIMEOUT", "TOO_LARGE", "TOO_LARGE", "UNSUPPORTED_CONTENT", "HTTP_ERROR", "FETCH_FAILED"
    ]);
    expect(result.attestations).toEqual([]);
  });

  test("verifies field formats such as ISRCs and dates and checks the recording version", async () => {
    const isrcTask = taskFor("isrc");
    const page = `<html><body><h2>Glass Coast (Radio Edit)</h2><p>Mara Quill</p><p>ISRC: QZ-FIC-26-00001</p></body></html>`;
    const unversioned = `<html><body><h2>Glass Coast</h2><p>Mara Quill</p><p>ISRC: QZFIC2600001</p></body></html>`;
    const claim = (url: string, quote: string): ResearchEvidenceClaim => ({
      sourceId: url, url, category: "identifier-registry", quote, supportedValue: "QZFIC2600001"
    });
    const result = await new SourceVerifier({ approvedSources: APPROVED }, {
      fetch: fakeFetch({ [REGISTRY_URL]: () => html(page), [`${REGISTRY_URL}-plain`]: () => html(unversioned) }),
      resolveHost: publicResolver
    }).verify(isrcTask, {
      suggestedValue: "QZFIC2600001",
      evidence: [claim(REGISTRY_URL, "ISRC: QZ-FIC-26-00001"), claim(`${REGISTRY_URL}-plain`, "ISRC: QZFIC2600001")],
      conflictingEvidence: []
    }, grounding(`api.${REGISTRY_HOST}`, REGISTRY_HOST));
    expect(result.reports.map((report) => report.status)).toEqual(["VERIFIED", "IDENTITY_NOT_FOUND"]);
  });
});

test.describe("Research orchestration", () => {
  test("live run produces a pending-review proposal backed by independently verified evidence", async () => {
    const task = taskFor("label");
    const { client } = fakeClient([geminiResponse(labelResponse(task))]);
    const result = await runMetadataResearch([task], {
      mode: "live",
      provider: gemini(client),
      verifier: verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }),
      sleep: noSleep
    });
    const [taskResult] = result.results;
    expect(result.model).toBe(DEFAULT_GEMINI_RESEARCH_CONFIG.model);
    expect(taskResult).toMatchObject({
      status: "PROPOSAL_PENDING_REVIEW",
      attempts: 1,
      grounding: { status: "GROUNDED", sourceCount: 1, searchQueryCount: 1 },
      verification: { status: "VERIFIED", verifiedSupportingCount: 1, verifiedOfficialSource: true }
    });
    expect(taskResult.proposal).toMatchObject({
      suggestedValue: "Low Tide Records",
      outcome: "PROPOSED",
      reviewStatus: "PENDING_REVIEW",
      requiresHumanReview: true,
      agentMayResolve: false
    });
    expect(taskResult.proposal?.evidence[0]).toMatchObject({ verification: "INDEPENDENTLY_VERIFIED", url: LABEL_URL });
    expect(result.usage).toMatchObject({ providerCalls: 1, totalTokens: 1090, searchQueries: 1 });
    expect(result.failures).toEqual([]);
  });

  test("ungrounded or unverifiable citations leave the proposal unresolved with no suggested value", async () => {
    const task = taskFor("label");
    const { client } = fakeClient([geminiResponse(labelResponse(task), [])]);
    const result = await runMetadataResearch([task], {
      mode: "live",
      provider: gemini(client),
      verifier: verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }),
      sleep: noSleep
    });
    const [taskResult] = result.results;
    expect(taskResult.grounding.status).toBe("NO_GROUNDING");
    expect(taskResult.verification).toMatchObject({ status: "UNVERIFIED", reports: [{ status: "NOT_GROUNDED" }] });
    expect(taskResult.proposal).toMatchObject({
      outcome: "INSUFFICIENT_EVIDENCE",
      suggestedValue: null,
      reviewStatus: "PENDING_REVIEW",
      evidence: [{ verification: "PROVIDER_CLAIM", supportedValue: "Low Tide Records" }]
    });
  });

  test("conflicting verified sources are surfaced and never resolved by the agent", async () => {
    const task = taskFor("label");
    const conflict = labelClaim({
      sourceId: "Low Tide Records distribution note",
      url: `https://${LABEL_HOST}/releases/low-tide-atlas/distribution`,
      quote: "Distributed under Saltwater Sound",
      supportedValue: "Saltwater Sound"
    });
    const { client } = fakeClient([geminiResponse(labelResponse(task, { conflictingEvidence: [conflict], outcome: "CONFLICTING_EVIDENCE" }))]);
    const result = await runMetadataResearch([task], {
      mode: "live",
      provider: gemini(client),
      verifier: verifier({ [LABEL_URL]: () => html(LABEL_PAGE), [conflict.url as string]: () => html(CONFLICT_PAGE) }),
      sleep: noSleep
    });
    const [taskResult] = result.results;
    expect(taskResult.verification).toMatchObject({ verifiedSupportingCount: 1, verifiedConflictingCount: 1 });
    expect(taskResult.verification.reports.find((report) => report.role === "CONFLICTING"))
      .toMatchObject({ status: "VERIFIED", contradictsSuggestion: true });
    expect(taskResult.proposal).toMatchObject({
      outcome: "CONFLICTING_EVIDENCE",
      conflictRequiresHumanResolution: true,
      agentMayResolve: false,
      reviewStatus: "PENDING_REVIEW"
    });
  });

  test("ISRC conflicts may be researched but the agent can never resolve them", async () => {
    const source = record();
    source.isrc = "QZFIC2600001";
    source.isrcValidation = { status: "valid", originalValue: source.isrc, reviewed: true };
    source.audioFilePath = resolve("C:\\fictional\\glass.wav");
    const report = analyzeMetadataGaps(source, {
      audioExtractions: [{
        status: "OK", filePath: source.audioFilePath, fileName: "glass.wav",
        metadata: {
          filePath: source.audioFilePath, fileName: "glass.wav", format: "WAV",
          extensionMatchesFormat: true, durationSeconds: 1, sampleRate: 44100, channels: 2, bitDepth: 16,
          artist: "Mara Quill", title: "Glass Coast", album: "Low Tide Atlas",
          version: "Radio Edit", isrc: "QZFIC2600002", rawIsrcs: ["QZFIC2600002"]
        }
      }]
    });
    const task = buildMetadataResearchTasks(source, report).find((item) => item.gapCode === "audio-isrc-conflict");
    if (!task) throw new Error("Expected an ISRC conflict task.");
    expect(buildGeminiResearchPrompt(task)).not.toContain("C:\\fictional");
    const claim: ResearchEvidenceClaim = {
      sourceId: "registry", url: REGISTRY_URL, category: "identifier-registry",
      quote: "ISRC: QZFIC2600001", supportedValue: "QZFIC2600001"
    };
    const page = `<html><body><h2>Glass Coast (Radio Edit)</h2><p>Mara Quill</p><p>ISRC: QZFIC2600001</p></body></html>`;
    const response: MetadataResearchResponse = {
      recordingId: task.recordingId, gapId: task.gapId, field: "isrc", suggestedValue: "QZFIC2600001",
      evidence: [claim], explanation: "The registry lists the Orchard ISRC.", confidence: "HIGH",
      conflictingEvidence: [], outcome: "PROPOSED"
    };
    const { client } = fakeClient([geminiResponse(response, [REGISTRY_HOST])]);
    const result = await runMetadataResearch([task], {
      mode: "live",
      provider: gemini(client),
      verifier: new SourceVerifier({ approvedSources: APPROVED }, { fetch: fakeFetch({ [REGISTRY_URL]: () => html(page) }), resolveHost: publicResolver }),
      sleep: noSleep
    });
    expect(result.results[0].verification.status).toBe("VERIFIED");
    expect(result.proposals[0]).toMatchObject({
      outcome: "CONFLICTING_EVIDENCE", agentMayResolve: false, conflictRequiresHumanResolution: true, reviewStatus: "PENDING_REVIEW"
    });
    expect(source.isrc).toBe("QZFIC2600001");
  });

  test("unrelated fields, unrequested recordings, and approval or hierarchy patches are rejected", async () => {
    const task = taskFor("label");
    const attempts: unknown[] = [
      { ...labelResponse(task), field: "isrc" },
      { ...labelResponse(task), recordingId: "ORCHARD-SOMEONE-ELSE" },
      { ...labelResponse(task), approvalStatus: "APPROVED" },
      { ...labelResponse(task), artistAttribution: { primaryArtist: "Mara Quill" } },
      { ...labelResponse(task), evidence: [labelClaim({ category: "random-blog" as never })] }
    ];
    for (const body of attempts) {
      const { client } = fakeClient([geminiResponse(body)]);
      const result = await runMetadataResearch([task], { mode: "live", provider: gemini(client), sleep: noSleep });
      expect(result.failures).toMatchObject([{ errorCode: "INVALID_RESPONSE", status: "UNRESOLVED", retryEligible: true }]);
      expect(result.proposals).toEqual([]);
    }
  });

  test("identity changes invalidate earlier verification results", async () => {
    const task = taskFor("label");
    const verification = await verifier({ [LABEL_URL]: () => html(LABEL_PAGE) })
      .verify(task, { suggestedValue: "Low Tide Records", evidence: [labelClaim()], conflictingEvidence: [] }, grounding(LABEL_HOST));
    expect(verification.attestations).toHaveLength(1);
    const accepted = validateMetadataResearchResponse(task, labelResponse(task), verification.attestations);
    expect(accepted.ok && accepted.proposal.evidence[0].verification).toBe("INDEPENDENTLY_VERIFIED");

    const changedRecord = { ...record(), version: "Extended Mix" };
    const changedTask = taskFor("label", changedRecord);
    expect(changedTask.recordingId).toBe(task.recordingId);
    expect(changedTask.identityFingerprint).not.toBe(task.identityFingerprint);
    const stale = validateMetadataResearchResponse(changedTask, labelResponse(changedTask), verification.attestations);
    expect(stale.ok && stale.proposal).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", evidence: [{ verification: "PROVIDER_CLAIM" }] });

    const tampered: MetadataResearchTask = { ...task, existingMetadata: { ...task.existingMetadata, title: "Different Song" } };
    expect(researchIdentityFingerprint(tampered.recordingId, tampered.existingMetadata)).not.toBe(tampered.identityFingerprint);
    const tamperedResult = await verifier({ [LABEL_URL]: () => html(LABEL_PAGE) })
      .verify(tampered, { suggestedValue: "Low Tide Records", evidence: [labelClaim()], conflictingEvidence: [] }, grounding(LABEL_HOST));
    expect(tamperedResult).toMatchObject({ attestations: [], reports: [{ status: "IDENTITY_SNAPSHOT_MISMATCH" }] });
  });

  test("retries rate limits with provider delays and backoff, then succeeds", async () => {
    const task = taskFor("label");
    const sleeps: number[] = [];
    const { client, calls } = fakeClient([rateLimit(7), rateLimit(), geminiResponse(labelResponse(task))]);
    const result = await runMetadataResearch([task], {
      mode: "live", provider: gemini(client), limits: { maxRetries: 2, initialBackoffMs: 1_000, maxBackoffMs: 30_000 },
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([7_000, 2_000]);
    expect(result.results[0]).toMatchObject({ status: "PROPOSAL_PENDING_REVIEW", attempts: 3 });
    expect(result.usage.providerCalls).toBe(3);
    expect(backoffDelayMs(validateResearchLimits({ initialBackoffMs: 1_000, maxBackoffMs: 5_000 }), 4, null)).toBe(5_000);
  });

  test("timeouts and rate limits stop after the retry limit; quota errors and invalid output are not retried", async () => {
    const task = taskFor("label");
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const cases: [ClientStep[], string, number][] = [
      [[rateLimit(1), rateLimit(1), rateLimit(1), rateLimit(1)], "RATE_LIMITED", 3],
      [[timeout, timeout, timeout, timeout], "TIMEOUT", 3],
      [[new ApiError({ status: 503, message: "overloaded" }), new ApiError({ status: 503, message: "overloaded" }), new ApiError({ status: 503, message: "overloaded" })], "PROVIDER_ERROR", 3],
      [[exhaustedQuota()], "QUOTA_EXHAUSTED", 1],
      [[geminiResponse("{broken"), geminiResponse(labelResponse(task))], "INVALID_RESPONSE", 1],
      [[geminiResponse({ nonsense: true }), geminiResponse(labelResponse(task))], "INVALID_RESPONSE", 1]
    ];
    for (const [steps, errorCode, attempts] of cases) {
      const { client, calls } = fakeClient([...steps]);
      const result = await runMetadataResearch([task], { mode: "live", provider: gemini(client), limits: { maxRetries: 2 }, sleep: noSleep });
      expect(result.results[0], errorCode).toMatchObject({ status: "FAILED", attempts, failure: { errorCode, status: "UNRESOLVED", retryEligible: true } });
      expect(calls).toHaveLength(attempts);
    }
  });

  test("exports only safe quota diagnostics, never retries exhaustion, and continues other tasks", async () => {
    const tasks = [taskFor("label"), taskFor("isrc")].sort((a, b) => a.taskId.localeCompare(b.taskId));
    const [failed, successful] = tasks;
    const validResponse: MetadataResearchResponse = {
      ...labelResponse(successful), suggestedValue: null, evidence: [], outcome: "INSUFFICIENT_EVIDENCE"
    };
    const { client, calls } = fakeClient([exhaustedQuota(), geminiResponse(validResponse, [])]);
    const sleeps: number[] = [];
    const result = await runMetadataResearch(tasks, {
      mode: "live", provider: gemini(client), limits: { maxRetries: 5 },
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(result.failures).toEqual([{
      taskId: failed.taskId, recordingId: failed.recordingId, gapId: failed.gapId,
      errorCode: "QUOTA_EXHAUSTED",
      description: expect.any(String),
      status: "UNRESOLVED", retryEligible: true,
      diagnostics: { httpStatus: 429, category: "QUOTA_EXHAUSTED", retryable: false }
    }]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].taskId).toBe(successful.taskId);
    const exported = JSON.stringify(result);
    for (const secret of [FAKE_KEY, "Private prompt", "quotaMetric", "quotaId", "quotaValue"]) {
      expect(exported).not.toContain(secret);
    }
  });

  test("retains safe final-attempt diagnostics for temporary rate limits and timeouts", async () => {
    const task = taskFor("label");
    for (const [error, diagnostics] of [
      [rateLimit(1), { httpStatus: 429, category: "RATE_LIMITED", retryable: true }],
      [Object.assign(new Error(FAKE_KEY), { name: "TimeoutError" }), { httpStatus: null, category: "TIMEOUT", retryable: true }]
    ] as const) {
      const { client } = fakeClient([error]);
      const result = await runMetadataResearch([task], {
        mode: "live", provider: gemini(client), limits: { maxRetries: 0 }, sleep: noSleep
      });
      expect(result.failures[0].diagnostics).toEqual(diagnostics);
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    }
  });

  test("isolates per-task failures, enforces budgets, and aborts the batch on credential errors", async () => {
    const source = record();
    const tasks = buildMetadataResearchTasks(source, analyzeMetadataGaps(source));
    const byField = Object.fromEntries(tasks.map((task) => [task.field, task]));
    const label = byField.label;
    const { client } = fakeClient((params) => {
      const text = JSON.stringify(params.contents);
      if (text.includes(":label")) return geminiResponse(labelResponse(label));
      if (text.includes(":albumUPC")) return new Error(`exploded with ${FAKE_KEY}`);
      return geminiResponse("{broken");
    });
    const result = await runMetadataResearch([...tasks].reverse(), { mode: "live", provider: gemini(client), sleep: noSleep });
    expect(result.results.map((item) => item.taskId)).toEqual([...tasks].map((task) => task.taskId).sort());
    expect(result.proposals.map((proposal) => proposal.field)).toEqual(["label"]);
    const fieldOf = (taskId: string) => tasks.find((task) => task.taskId === taskId)?.field;
    expect(Object.fromEntries(result.failures.map((failure) => [fieldOf(failure.taskId), failure.errorCode]))).toEqual(
      Object.fromEntries(tasks.filter((task) => task.field !== "label")
        .map((task) => [task.field, task.field === "albumUPC" ? "PROVIDER_ERROR" : "INVALID_RESPONSE"]))
    );
    expect(result.failures.length + result.proposals.length).toBe(tasks.length);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);

    const budget = await runMetadataResearch(tasks, {
      mode: "live", provider: gemini(fakeClient(() => geminiResponse("{broken")).client),
      limits: { maxTasks: 2, maxProviderCalls: 1 }, sleep: noSleep
    });
    expect(budget.results.map((item) => item.failure?.errorCode)).toEqual(
      ["INVALID_RESPONSE", "BUDGET_EXHAUSTED", ...tasks.slice(2).map(() => "BUDGET_EXHAUSTED")]
    );
    expect(budget.usage.providerCalls).toBe(1);

    const auth = fakeClient([new ApiError({ status: 401, message: `bad key ${FAKE_KEY}` })]);
    const aborted = await runMetadataResearch(tasks, { mode: "live", provider: gemini(auth.client), sleep: noSleep });
    expect(auth.calls).toHaveLength(1);
    expect(aborted.failures.map((failure) => failure.errorCode)).toEqual(
      ["AUTHENTICATION_ERROR", ...tasks.slice(1).map(() => "BATCH_ABORTED")]
    );
    expect(JSON.stringify(aborted)).not.toContain(FAKE_KEY);
  });

  test("dry-run makes no provider calls and mock mode works offline without grounding", async () => {
    const task = taskFor("label");
    const { client, calls } = fakeClient([]);
    const dry = await runMetadataResearch([task], { mode: "dry-run", provider: gemini(client) });
    expect(calls).toEqual([]);
    expect(dry.results[0]).toMatchObject({ status: "PLANNED_DRY_RUN", attempts: 0, proposal: null, failure: null });

    const mock = await runMetadataResearch([task], {
      mode: "mock",
      provider: new MockMetadataResearchProvider({ [task.taskId]: labelResponse(task) }),
      sleep: noSleep
    });
    expect(mock.model).toBeNull();
    expect(mock.results[0]).toMatchObject({
      status: "PROPOSAL_PENDING_REVIEW",
      grounding: { status: "NOT_APPLICABLE" },
      proposal: { outcome: "INSUFFICIENT_EVIDENCE", reviewStatus: "PENDING_REVIEW" }
    });
    await expect(runMetadataResearch([task], { mode: "live", provider: new MockMetadataResearchProvider() }))
      .rejects.toThrow(/grounded provider/);
  });

  test("verification reports redact private data echoed in citations", async () => {
    const task = taskFor("label");
    const result = await verifier({}).verify(task, {
      suggestedValue: "Low Tide Records",
      evidence: [labelClaim({ sourceId: "brad@example.test", url: "https://random.example/?who=brad@example.test" })],
      conflictingEvidence: []
    }, grounding(LABEL_HOST));
    expect(JSON.stringify(result.reports)).not.toContain("brad@example.test");
  });

  test("never mutates records or tasks and never touches approval, audio, or Mediabase", async () => {
    const source = deepFreeze(record());
    const before = JSON.stringify(source);
    const task = deepFreeze(taskFor("label", source));
    const { client } = fakeClient([geminiResponse(labelResponse(task))]);
    const result = await runMetadataResearch(deepFreeze([task]), {
      mode: "live",
      provider: gemini(client),
      verifier: verifier({ [LABEL_URL]: () => html(LABEL_PAGE) }),
      sleep: noSleep
    });
    expect(result.proposals).toHaveLength(1);
    expect(JSON.stringify(source)).toBe(before);
    expect(source.approvalStatus).toBe("DRAFT");
    const serialized = JSON.stringify(result);
    for (const forbidden of ["approvalStatus", "APPROVED", "audioMatch", "declarations", "artistAttribution"]) {
      expect(serialized).not.toContain(forbidden);
    }

    for (const file of ["researchOrchestrator.ts", "geminiResearchProvider.ts", "sourceVerifier.ts", "researchProvider.ts"]) {
      const code = readFileSync(join(__dirname, "..", "src", "research", file), "utf8");
      expect(code, file).not.toMatch(/playwright|mediabaseForm|prepareMediabaseForm|\.submit\(|page\.goto/i);
    }
    const demo = readFileSync(join(__dirname, "..", "scripts", "liveResearchDemo.ts"), "utf8");
    expect(demo).not.toMatch(/playwright|mediabaseForm|prepareMediabaseForm/i);
  });
});
