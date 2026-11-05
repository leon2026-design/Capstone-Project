import type { Page } from "@playwright/test";

/**
 * MB-10 safety guards. Every MB-10 browser session and HTTP request is limited
 * to loopback hosts. There is no live-Mediabase code path: a destination whose
 * host is not a loopback literal is refused before anything is opened.
 */

export class LiveDestinationForbiddenError extends Error {
  readonly code = "LIVE_DESTINATION_FORBIDDEN";
  constructor(message: string) {
    super(message);
    this.name = "LiveDestinationForbiddenError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Hosts that must never be contacted, even if a loopback alias were misconfigured to point at them. */
const FORBIDDEN_HOST_PATTERN = /(^|\.)mediabase\.com$/i;

export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
    url.username === "" && url.password === "";
}

/** Throws unless `value` is an http(s) URL on a loopback host. Real Mediabase domains are always refused. */
export function assertLocalDestination(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LiveDestinationForbiddenError("Submission destination is not a valid URL.");
  }
  if (FORBIDDEN_HOST_PATTERN.test(url.hostname)) {
    throw new LiveDestinationForbiddenError("Real Mediabase destinations are forbidden in MB-10; only the local mock may be used.");
  }
  if (!isLoopbackUrl(value)) {
    throw new LiveDestinationForbiddenError("Submission destinations must be loopback (127.0.0.1, localhost, or ::1).");
  }
  return url;
}

/**
 * Aborts every request the page makes to a non-loopback host, including
 * redirects and subresources, and records which hosts were blocked.
 */
export async function installLoopbackNetworkGuard(page: Page): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank" || isLoopbackUrl(url)) {
      await route.continue();
      return;
    }
    let host = "unparseable";
    try {
      host = new URL(url).hostname;
    } catch {
      // Keep the placeholder.
    }
    blocked.push(host);
    await route.abort("blockedbyclient");
  });
  return { blocked };
}
