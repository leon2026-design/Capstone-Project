import { randomBytes } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join, resolve } from "node:path";

/**
 * MB-08: replaceable storage for review sessions. A backend only stores opaque
 * text documents under safe keys; validation, revisions, and audit integrity
 * live in `reviewSessionStore`. No backend here contacts a network service.
 */
export interface ReviewStorageBackend {
  readonly kind: string;
  /** Returns the stored document, or null if none exists. */
  read(key: string): Promise<string | null>;
  /** Replaces a document atomically: readers see the old or the new content, never a partial write. */
  replace(key: string, content: string): Promise<void>;
  /** Runs `task` while holding an exclusive lock for `key`, across processes where the medium allows. */
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Keys of all stored documents. */
  keys(): Promise<string[]>;
}

export class ReviewStorageLockedError extends Error {
  constructor() {
    super("Another review session is saving this recording; try again.");
    this.name = "ReviewStorageLockedError";
  }
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function assertStorageKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key.");
}

/** In-process backend for tests and short-lived tools. */
export function createInMemoryReviewStorage(): ReviewStorageBackend {
  const documents = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  return {
    kind: "memory",
    async read(key) {
      assertStorageKey(key);
      return documents.get(key) ?? null;
    },
    async replace(key, content) {
      assertStorageKey(key);
      documents.set(key, content);
    },
    async withLock(key, task) {
      assertStorageKey(key);
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((done) => { release = done; });
      const chained = previous.then(() => current);
      locks.set(key, chained);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (locks.get(key) === chained) locks.delete(key);
      }
    },
    async keys() {
      return [...documents.keys()].sort();
    }
  };
}

/** The subset of `fs.promises` the JSON backend uses; injectable to simulate failures. */
export type ReviewFileSystem = Pick<
  typeof nodeFs,
  "mkdir" | "readFile" | "open" | "rename" | "unlink" | "readdir" | "stat"
>;

export type JsonFileReviewStorageOptions = {
  fileSystem?: ReviewFileSystem;
  /** A lock file older than this is treated as abandoned by a crashed process. */
  staleLockMs?: number;
  /** Documents larger than this are refused when read. */
  maxDocumentBytes?: number;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Local JSON files, one per key. Writes go to a temporary file that is flushed
 * and then renamed over the target, so an interrupted save leaves the previous
 * document intact. Files are created owner-only where the OS supports modes.
 */
export function createJsonFileReviewStorage(
  directory: string,
  options: JsonFileReviewStorageOptions = {}
): ReviewStorageBackend {
  const fs = options.fileSystem ?? nodeFs;
  const root = resolve(directory);
  const staleLockMs = options.staleLockMs ?? 30_000;
  const maxBytes = options.maxDocumentBytes ?? 20 * 1024 * 1024;
  const documentPath = (key: string) => join(root, `${key}.json`);
  const lockPath = (key: string) => join(root, `${key}.lock`);
  const ensureRoot = () => fs.mkdir(root, { recursive: true, mode: 0o700 });

  async function removeQuietly(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async function acquire(key: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath(key), "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const age = await fs.stat(lockPath(key)).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (attempt > 0 || age < staleLockMs) throw new ReviewStorageLockedError();
        await removeQuietly(lockPath(key));
      }
    }
    throw new ReviewStorageLockedError();
  }

  return {
    kind: "json-file",
    async read(key) {
      assertStorageKey(key);
      let info;
      try {
        info = await fs.stat(documentPath(key));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      if (info.size > maxBytes) throw new Error("Stored review document exceeds the size limit.");
      return fs.readFile(documentPath(key), "utf8");
    },
    async replace(key, content) {
      assertStorageKey(key);
      await ensureRoot();
      const temporary = join(root, `${key}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, documentPath(key));
      } catch (error) {
        await removeQuietly(temporary).catch(() => undefined);
        throw error;
      }
    },
    async withLock(key, task) {
      assertStorageKey(key);
      await ensureRoot();
      await acquire(key);
      try {
        // Holding the lock means any temporary file for this key was left by an interrupted save.
        for (const name of await fs.readdir(root)) {
          if (name.startsWith(`${key}.`) && name.endsWith(".tmp")) await removeQuietly(join(root, name));
        }
        return await task();
      } finally {
        await removeQuietly(lockPath(key));
      }
    },
    async keys() {
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      return names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((key) => KEY_PATTERN.test(key))
        .sort();
    }
  };
}
