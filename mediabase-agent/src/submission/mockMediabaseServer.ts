import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";

/**
 * MB-10 local mock of the Mediabase receiving endpoint. It binds to 127.0.0.1
 * only, serves `fixtures/mock-mediabase.html`, parses real multipart uploads
 * (including the audio bytes), and can simulate success, validation failure,
 * transport failure, a delayed response, and an ambiguous outcome after
 * receipt. Nothing here talks to the real Mediabase.
 */

export type MockScenario =
  | { kind: "success" }
  /** 422: the server refuses the submission and stores nothing. */
  | { kind: "validation-failure" }
  /** 503 with `stored: false, retryable: true`: demonstrably safe to retry. */
  | { kind: "unavailable" }
  /** The connection is lost mid-reply and nothing was stored; the client cannot tell this from a lost confirmation. */
  | { kind: "reset-before-receipt" }
  | { kind: "delayed-success"; delayMs: number }
  /** The submission is stored, then the connection is lost mid-reply, so the confirmation never arrives. */
  | { kind: "ambiguous-after-receipt" };

export type MockReceivedFile = {
  fieldName: string;
  fileName: string;
  contentType: string | null;
  size: number;
  sha256: string;
};

export type MockReceipt = {
  submissionId: string;
  confirmationId: string;
  receivedAt: string;
  fields: Record<string, string>;
  files: MockReceivedFile[];
};

export type MockRequestLogEntry = {
  sequence: number;
  scenario: MockScenario["kind"];
  submissionId: string | null;
  contentType: string;
  multipart: boolean;
  fileCount: number;
  outcome: "STORED" | "DUPLICATE" | "REJECTED" | "UNAVAILABLE" | "DROPPED" | "BAD_REQUEST";
};

export type MockMediabaseServer = {
  readonly baseUrl: string;
  readonly formUrl: string;
  readonly submitUrl: string;
  /** Scenarios consumed one per submission, in order; `success` once the queue is empty. */
  enqueue(...scenarios: MockScenario[]): void;
  receipt(submissionId: string): MockReceipt | null;
  receipts(): MockReceipt[];
  requests(): MockRequestLogEntry[];
  /** Submissions delivered again with an already-stored submission id. */
  duplicateDeliveries(): number;
  close(): Promise<void>;
};

export type MockServerOptions = {
  formHtmlPath?: string;
  /** Text fields the mock requires, like the real form's required inputs. */
  requiredFields?: readonly string[];
  maxBodyBytes?: number;
  /** Fixed clock for deterministic receipts. */
  now?: () => Date;
};

const DEFAULT_REQUIRED = ["submissionId", "submitterName", "email", "artist", "title", "officialReleaseDate"];

type Part = { name: string; fileName: string | null; contentType: string | null; data: Buffer };

/**
 * Starts a reply and cuts the connection part-way through the body. A reset
 * before any reply bytes would not do: browsers transparently resend a POST
 * when a reused keep-alive connection resets before the response starts.
 */
function dropMidResponse(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
  response.write('{"stored":', () => setTimeout(() => request.socket.destroy(), 25));
}

/** Minimal RFC 7578 multipart/form-data parser that keeps file parts as raw bytes. */
export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let position = body.indexOf(delimiter);
  if (position < 0) throw new Error("Multipart boundary not found.");
  while (true) {
    position += delimiter.length;
    if (body.subarray(position, position + 2).toString("latin1") === "--") break;
    if (body.subarray(position, position + 2).toString("latin1") !== "\r\n") throw new Error("Malformed multipart delimiter.");
    position += 2;
    const headerEnd = body.indexOf("\r\n\r\n", position, "latin1");
    if (headerEnd < 0) throw new Error("Malformed multipart headers.");
    const headers = body.subarray(position, headerEnd).toString("utf8").split("\r\n");
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headerEnd + 4);
    if (next < 0) throw new Error("Unterminated multipart part.");
    const data = body.subarray(headerEnd + 4, next);
    let name: string | null = null;
    let fileName: string | null = null;
    let contentType: string | null = null;
    for (const header of headers) {
      const [key, ...rest] = header.split(":");
      const value = rest.join(":").trim();
      if (key.trim().toLowerCase() === "content-disposition") {
        name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1] ?? null;
        const file = /(?:^|;)\s*filename="([^"]*)"/i.exec(value);
        fileName = file ? file[1] : null;
      } else if (key.trim().toLowerCase() === "content-type") {
        contentType = value;
      }
    }
    if (name === null) throw new Error("Multipart part without a name.");
    parts.push({ name, fileName, contentType, data: Buffer.from(data) });
    position = next + 2;
  }
  return parts;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", fail);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function startMockMediabaseServer(options: MockServerOptions = {}): Promise<MockMediabaseServer> {
  const formHtml = readFileSync(options.formHtmlPath ?? resolve(__dirname, "../../fixtures/mock-mediabase.html"), "utf8");
  const required = options.requiredFields ?? DEFAULT_REQUIRED;
  const limit = options.maxBodyBytes ?? 50 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const queue: MockScenario[] = [];
  const stored = new Map<string, MockReceipt>();
  const log: MockRequestLogEntry[] = [];
  const sockets = new Set<Socket>();
  let duplicates = 0;

  const store = (fields: Record<string, string>, files: MockReceivedFile[]): MockReceipt => {
    const submissionId = fields.submissionId;
    const receipt: MockReceipt = {
      submissionId,
      confirmationId: `MOCK-CONF-${createHash("sha256").update(submissionId).digest("hex").slice(0, 12).toUpperCase()}`,
      receivedAt: now().toISOString(),
      fields,
      files
    };
    stored.set(submissionId, receipt);
    return receipt;
  };

  async function handleSubmit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const scenario = queue.shift() ?? { kind: "success" as const };
    const contentType = request.headers["content-type"] ?? "";
    const entry: MockRequestLogEntry = {
      sequence: log.length + 1,
      scenario: scenario.kind,
      submissionId: null,
      contentType: contentType.split(";")[0],
      multipart: contentType.startsWith("multipart/form-data"),
      fileCount: 0,
      outcome: "BAD_REQUEST"
    };
    log.push(entry);
    const body = await readBody(request, limit);
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!entry.multipart || !boundary) {
      json(response, 400, { stored: false, retryable: false, code: "NOT_MULTIPART" });
      return;
    }
    let parts: Part[];
    try {
      parts = parseMultipart(body, boundary[1] ?? boundary[2]);
    } catch {
      json(response, 400, { stored: false, retryable: false, code: "MALFORMED_MULTIPART" });
      return;
    }
    const fields: Record<string, string> = {};
    const files: MockReceivedFile[] = [];
    for (const part of parts) {
      if (part.fileName !== null) {
        // Browsers send an empty file part for an empty file input; it is not an upload.
        if (part.fileName === "" && part.data.length === 0) continue;
        files.push({
          fieldName: part.name,
          fileName: part.fileName,
          contentType: part.contentType,
          size: part.data.length,
          sha256: createHash("sha256").update(part.data).digest("hex")
        });
      } else {
        fields[part.name] = part.data.toString("utf8");
      }
    }
    entry.submissionId = fields.submissionId || null;
    entry.fileCount = files.length;

    if (scenario.kind === "unavailable") {
      entry.outcome = "UNAVAILABLE";
      json(response, 503, { stored: false, retryable: true, code: "MOCK_TEMPORARILY_UNAVAILABLE" });
      return;
    }
    if (scenario.kind === "reset-before-receipt") {
      entry.outcome = "DROPPED";
      dropMidResponse(request, response);
      return;
    }
    const problems = required.filter((field) => !fields[field]?.trim());
    if (files.length !== 1 || files[0].fieldName !== "audioFile" || files[0].size === 0) problems.push("audioFile");
    if (scenario.kind === "validation-failure" || problems.length > 0) {
      entry.outcome = "REJECTED";
      json(response, 422, {
        stored: false,
        retryable: false,
        code: scenario.kind === "validation-failure" ? "MOCK_VALIDATION_REJECTED" : "MOCK_REQUIRED_FIELDS",
        fields: problems
      });
      return;
    }
    const existing = stored.get(fields.submissionId);
    if (existing) {
      duplicates += 1;
      entry.outcome = "DUPLICATE";
      json(response, 200, { stored: true, duplicate: true, submissionId: existing.submissionId, confirmationId: existing.confirmationId });
      return;
    }
    const receipt = store(fields, files);
    entry.outcome = "STORED";
    if (scenario.kind === "ambiguous-after-receipt") {
      dropMidResponse(request, response);
      return;
    }
    if (scenario.kind === "delayed-success") await sleep(scenario.delayMs);
    if (response.destroyed || request.socket.destroyed) return;
    json(response, 200, { stored: true, duplicate: false, submissionId: receipt.submissionId, confirmationId: receipt.confirmationId });
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const handle = async () => {
      if (request.method === "GET" && url.pathname === "/mock-mediabase/form") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(formHtml);
        return;
      }
      if (request.method === "POST" && url.pathname === "/mock-mediabase/submit") {
        await handleSubmit(request, response);
        return;
      }
      const receiptPath = /^\/mock-mediabase\/receipts\/([A-Za-z0-9-]{1,128})$/.exec(url.pathname);
      if (request.method === "GET" && receiptPath) {
        const receipt = stored.get(receiptPath[1]);
        if (receipt) json(response, 200, { found: true, receipt });
        else json(response, 404, { found: false });
        return;
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 404, { code: "NOT_FOUND" });
    };
    handle().catch(() => {
      if (!response.headersSent) json(response, 500, { stored: false, retryable: false, code: "MOCK_SERVER_ERROR" });
      else response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    formUrl: `${baseUrl}/mock-mediabase/form`,
    submitUrl: `${baseUrl}/mock-mediabase/submit`,
    enqueue: (...scenarios) => void queue.push(...scenarios),
    receipt: (submissionId) => structuredClone(stored.get(submissionId) ?? null),
    receipts: () => structuredClone([...stored.values()]),
    requests: () => structuredClone(log),
    duplicateDeliveries: () => duplicates,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      })
  };
}
