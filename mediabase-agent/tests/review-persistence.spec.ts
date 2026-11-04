import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryReviewStorage,
  createJsonFileReviewStorage,
  type ReviewFileSystem,
  type ReviewStorageBackend
} from "../src/storage/reviewStorageBackend";
import {
  applyHumanReviewDecision,
  processPendingReviews,
  reviewBasisFor,
  type HumanReviewState
} from "../src/workflow/humanReview";
import {
  applyCombinedReviewDecisionsWithRefusalLog,
  applyReviewDecisionsWithRefusalLog,
  combinedReviewSessionDigest,
  COMBINED_REVIEW_SESSION_SCHEMA_VERSION,
  createReviewSessionStore,
  recordRefusedDecision,
  reviewSessionDigest,
  reviewStorageKey,
  REVIEW_SESSION_FORMAT,
  REVIEW_SESSION_SCHEMA_VERSION,
  verifyHumanGapReviewState,
  type ReviewSessionStore
} from "../src/workflow/reviewSessionStore";
import {
  applyHumanGapDecision,
  applyResearchReviewDecision,
  publicHumanGapAuditTrail,
  startHumanGapReview,
  type HumanGapReviewState
} from "../src/workflow/humanGapReview";
import type { DemoRecording } from "../src/metadata/recordValidation";
import { MB_RELEASE_ID, decide, gapDecide, setup } from "./support/reviewFixture";

const SAVED_AT = new Date("2026-11-04T16:00:00.000Z");

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), "mb08-review-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fileStore(dir: string, fileSystem?: ReviewFileSystem): ReviewSessionStore {
  return createReviewSessionStore(
    createJsonFileReviewStorage(dir, { ...(fileSystem ? { fileSystem } : {}) }),
    { now: () => SAVED_AT }
  );
}

/** An MB-07 session with approved, edited, rejected, and deferred decisions. */
async function reviewed(options: Parameters<typeof setup>[0] = {}) {
  const base = await setup(options);
  const batch = processPendingReviews(base.state, [
    decide(base.state, "label", "APPROVE_SUGGESTED_VALUE", { note: "Matches the label catalog." }),
    decide(base.state, "officialReleaseDate", "EDIT_SUGGESTED_VALUE", {
      editedValue: "11/14/2026", note: "Label confirmed the earlier street date."
    }),
    decide(base.state, "albumUPC", "REJECT_SUGGESTION", { note: "Research UPC not confirmed by distributor." }),
    decide(base.state, "albumReleaseDate", "DEFER_DECISION", { note: "Waiting for the label." })
  ]);
  expect(batch.rejected).toEqual([]);
  return { ...base, reviewed: batch.state };
}

function findingStatuses(state: HumanReviewState): Record<string, string[]> {
  return Object.fromEntries(state.decisions.map((item) => [
    item.decision.field, item.findingReviews.map((finding) => `${finding.source}:${finding.status}`).sort()
  ]));
}

async function storedFile(dir: string, recordingId: string): Promise<string> {
  return join(dir, `${reviewStorageKey(recordingId)}.json`);
}

async function tamper(
  dir: string,
  recordingId: string,
  original: string,
  mutate: (document: any) => void,
  redigest = true
): Promise<void> {
  const document = JSON.parse(original);
  mutate(document);
  if (redigest) document.contentDigest = reviewSessionDigest(document.state, document.refusedDecisions);
  await fs.writeFile(await storedFile(dir, recordingId), JSON.stringify(document));
}

for (const backendKind of ["json-file", "memory"] as const) {
  test(`saves and restores a review session across a restart (${backendKind})`, async () => {
    await withTempDir(async (dir) => {
      const memory = createInMemoryReviewStorage();
      const open = (): ReviewSessionStore => backendKind === "memory"
        ? createReviewSessionStore(memory, { now: () => SAVED_AT })
        : fileStore(dir);
      const { workflow, reviewed: state } = await reviewed();

      const saved = await open().save(state, { expectedRevision: 0, sessionId: "review-desk-1" });
      expect(saved).toMatchObject({ ok: true, unchanged: false });
      if (!saved.ok) throw new Error(saved.message);
      expect(saved.session).toMatchObject({
        recordingId: state.recordingId, revision: 1, savedAt: SAVED_AT.toISOString(), savedBy: "review-desk-1"
      });

      // A fresh store instance stands in for a restarted application.
      const loaded = await open().load(state.recordingId);
      if (!loaded.ok) throw new Error(`${loaded.code}: ${loaded.message}`);
      const restored = loaded.session.state;
      expect(loaded.session.revision).toBe(1);
      expect(restored).toEqual(state);
      expect(Object.isFrozen(restored.recording)).toBe(true);
      expect(Object.isFrozen(restored.auditTrail[0].evidence)).toBe(true);
      expect(restored.originalRecording).toEqual(workflow.recording);
      expect(restored.recording.approvalStatus).toBe("DRAFT");
      expect(restored.recording.label).toBe("Fictional Label");
      expect(restored.recording.officialReleaseDate).toBe("11/14/2026");
      expect(findingStatuses(restored)).toMatchObject({
        label: expect.arrayContaining(["RESEARCH:APPROVED"]),
        officialReleaseDate: expect.arrayContaining(["RESEARCH:EDITED"]),
        albumUPC: expect.arrayContaining(["RESEARCH:REJECTED"]),
        albumReleaseDate: expect.arrayContaining(["RESEARCH:DEFERRED"])
      });
      expect(restored.decisions.map((item) => item.status)).toEqual(state.decisions.map((item) => item.status));
      expect(restored.decisions.map((item) => item.decision)).toEqual(workflow.metadataDecisions);
      expect(restored.gapReport).toEqual(state.gapReport);

      expect(restored.auditTrail).toEqual(state.auditTrail);
      expect(restored.auditTrail.map((entry) => entry.action)).toEqual([
        "APPROVE_SUGGESTED_VALUE", "EDIT_SUGGESTED_VALUE", "REJECT_SUGGESTION", "DEFER_DECISION"
      ]);
      const first = restored.auditTrail[0];
      expect(first.reviewer).toEqual({ reviewerId: "brad", displayName: "Brad (fictional reviewer)" });
      expect(first.reviewedAt).toBe("2026-11-04T15:30:00.000Z");
      expect(first).toMatchObject({ recordingId: state.recordingId, previousValue: null, resultingValue: "Fictional Label" });
      expect(first.proposalId).toBeTruthy();
      expect(first.note).toBe("Matches the label catalog.");
      const urls = new Set(restored.auditTrail.flatMap((entry) => entry.evidence.map((item) => item.url)));
      expect(urls).toContain("https://catalog.example.test/release");
      expect(urls).toContain(`https://musicbrainz.org/release/${MB_RELEASE_ID}`);
    });
  });
}

test("continues reviewing after a restart; replayed decisions stay rejected and history only grows", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: state } = await reviewed();
    const replay = decide(state, "label", "APPROVE_SUGGESTED_VALUE", { reviewId: state.auditTrail[0].reviewId });
    const preparedBeforeRestart = decide(state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
      source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Release sleeve confirms the MusicBrainz date."
    });
    expect((await fileStore(dir).save(state, { expectedRevision: 0 })).ok).toBe(true);

    const loaded = await fileStore(dir).load(state.recordingId);
    if (!loaded.ok) throw new Error(loaded.message);
    const restored = loaded.session.state;

    const duplicate = applyHumanReviewDecision(restored, replay);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.rejection.code).toBe("DUPLICATE_REVIEW");
    const repeatedRejection = applyHumanReviewDecision(restored,
      decide(restored, "albumUPC", "REJECT_SUGGESTION"));
    expect(repeatedRejection.ok).toBe(false);
    if (!repeatedRejection.ok) expect(repeatedRejection.rejection.code).toBe("ALREADY_DECIDED");

    // The MB-07 basis is identical across the restart, so a prepared decision still applies.
    expect(reviewBasisFor(restored, preparedBeforeRestart.decisionId)).toEqual(preparedBeforeRestart.basis);
    const continued = applyHumanReviewDecision(restored, preparedBeforeRestart);
    if (!continued.ok) throw new Error(continued.rejection.message);
    expect(continued.state.recording.albumReleaseDate).toBe("11/15/2026");

    const saved = await fileStore(dir).save(continued.state, { expectedRevision: 1 });
    expect(saved).toMatchObject({ ok: true, session: { revision: 2 } });
    const again = await fileStore(dir).save(continued.state, { expectedRevision: 2 });
    expect(again).toMatchObject({ ok: true, unchanged: true, session: { revision: 2 } });

    const reloaded = await fileStore(dir).load(state.recordingId);
    if (!reloaded.ok) throw new Error(reloaded.message);
    expect(reloaded.session.state.auditTrail).toHaveLength(5);
    expect(reloaded.session.state.auditTrail.slice(0, 4)).toEqual(state.auditTrail);
    expect(reloaded.session.state.recording.approvalStatus).toBe("DRAFT");
  });
});

test("keeps multiple recordings independent", async () => {
  await withTempDir(async (dir) => {
    const one = (await reviewed()).reviewed;
    const twoBase = await setup({ sourceName: "second-fictional-review.csv" });
    expect(twoBase.state.recordingId).not.toBe(one.recordingId);
    const two = applyHumanReviewDecision(twoBase.state, decide(twoBase.state, "label", "REJECT_SUGGESTION"));
    if (!two.ok) throw new Error(two.rejection.message);

    const store = fileStore(dir);
    expect((await store.save(one, { expectedRevision: 0 })).ok).toBe(true);
    expect((await store.save(two.state, { expectedRevision: 0 })).ok).toBe(true);
    const twoMore = applyHumanReviewDecision(two.state, decide(two.state, "albumUPC", "DEFER_DECISION"));
    if (!twoMore.ok) throw new Error(twoMore.rejection.message);
    expect(await store.save(twoMore.state, { expectedRevision: 1 })).toMatchObject({ ok: true, session: { revision: 2 } });

    const loadedOne = await store.load(one.recordingId);
    const loadedTwo = await store.load(two.state.recordingId);
    if (!loadedOne.ok || !loadedTwo.ok) throw new Error("Expected both sessions to load.");
    expect(loadedOne.session.revision).toBe(1);
    expect(loadedOne.session.state).toEqual(one);
    expect(loadedTwo.session.state).toEqual(twoMore.state);

    const files = (await fs.readdir(dir)).sort();
    expect(files).toEqual([`${reviewStorageKey(one.recordingId)}.json`, `${reviewStorageKey(two.state.recordingId)}.json`].sort());
    expect(files.join(" ")).not.toContain(one.recordingId);

    const listing = await store.list();
    expect(listing.map((item) => item.ok && [item.recordingId, item.revision, item.auditEntries]).sort()).toEqual([
      [one.recordingId, 1, 4], [two.state.recordingId, 2, 2]
    ].sort());
    expect(await store.load("unknown-recording")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

test("detects conflicting revisions and never lets an older session overwrite newer decisions", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: state } = await reviewed();
    expect((await fileStore(dir).save(state, { expectedRevision: 0 })).ok).toBe(true);
    expect(await fileStore(dir).save(state, { expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT", currentRevision: 1 });

    const sessionA = await fileStore(dir).load(state.recordingId);
    const sessionB = await fileStore(dir).load(state.recordingId);
    if (!sessionA.ok || !sessionB.ok) throw new Error("Expected both sessions to load.");

    const a = applyHumanReviewDecision(sessionA.session.state, decide(sessionA.session.state, "albumReleaseDate",
      "EDIT_SUGGESTED_VALUE", { source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Sleeve confirms date." }));
    if (!a.ok) throw new Error(a.rejection.message);
    expect(await fileStore(dir).save(a.state, { expectedRevision: 1, sessionId: "session-a" }))
      .toMatchObject({ ok: true, session: { revision: 2, savedBy: "session-a" } });

    const b = applyHumanReviewDecision(sessionB.session.state, decide(sessionB.session.state, "albumUPC",
      "EDIT_SUGGESTED_VALUE", { source: "MUSICBRAINZ", editedValue: "0012345678905", note: "Distributor confirmed." }));
    if (!b.ok) throw new Error(b.rejection.message);
    expect(await fileStore(dir).save(b.state, { expectedRevision: 1, sessionId: "session-b" }))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT", currentRevision: 2 });
    // Claiming the latest revision does not help: B's history lacks A's entry.
    expect(await fileStore(dir).save(b.state, { expectedRevision: 2 }))
      .toMatchObject({ ok: false, code: "HISTORY_REWRITE", currentRevision: 2 });
    // Saving an older state (fewer entries) is also refused.
    expect(await fileStore(dir).save(state, { expectedRevision: 2 }))
      .toMatchObject({ ok: false, code: "HISTORY_REWRITE" });

    const latest = await fileStore(dir).load(state.recordingId);
    if (!latest.ok) throw new Error(latest.message);
    expect(latest.session.revision).toBe(2);
    expect(latest.session.state).toEqual(a.state);

    // B rebases: reload, re-prepare against the latest state, and save.
    const rebased = applyHumanReviewDecision(latest.session.state, decide(latest.session.state, "albumUPC",
      "EDIT_SUGGESTED_VALUE", { source: "MUSICBRAINZ", editedValue: "0012345678905", note: "Distributor confirmed." }));
    if (!rebased.ok) throw new Error(rebased.rejection.message);
    const merged = await fileStore(dir).save(rebased.state, { expectedRevision: 2, sessionId: "session-b" });
    if (!merged.ok) throw new Error(merged.message);
    expect(merged.session.revision).toBe(3);
    expect(merged.session.state.auditTrail.map((entry) => entry.field)).toEqual([
      "label", "officialReleaseDate", "albumUPC", "albumReleaseDate", "albumReleaseDate", "albumUPC"
    ]);
  });
});

test("concurrent saves from separate stores never both succeed", async () => {
  await withTempDir(async (dir) => {
    const { state, reviewed: next } = await reviewed();
    expect((await fileStore(dir).save(state, { expectedRevision: 0 })).ok).toBe(true);
    const results = await Promise.all([
      fileStore(dir).save(next, { expectedRevision: 1 }),
      fileStore(dir).save(next, { expectedRevision: 1 })
    ]);
    const succeeded = results.filter((result) => result.ok && !result.unchanged);
    expect(succeeded).toHaveLength(1);
    const other = results.find((result) => result !== succeeded[0]);
    expect(other).toMatchObject({ ok: false });
    if (other && !other.ok) expect(["REVISION_CONFLICT", "LOCKED"]).toContain(other.code);
  });
});

test("rejects corrupted or incompatible saved data and never overwrites it", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: state } = await reviewed();
    expect((await fileStore(dir).save(state, { expectedRevision: 0 })).ok).toBe(true);
    const file = await storedFile(dir, state.recordingId);
    const original = await fs.readFile(file, "utf8");
    const load = () => fileStore(dir).load(state.recordingId);

    await fs.writeFile(file, original.slice(0, Math.floor(original.length / 2)));
    expect(await load()).toMatchObject({ ok: false, code: "CORRUPTED_DATA" });
    expect(await fileStore(dir).save(state, { expectedRevision: 1 })).toMatchObject({ ok: false, code: "CORRUPTED_DATA" });
    expect(await fs.readFile(file, "utf8")).toBe(original.slice(0, Math.floor(original.length / 2)));

    const cases: Array<[string, (document: any) => void, string, boolean?]> = [
      ["schema version", (doc) => { doc.schemaVersion = 2; }, "INCOMPATIBLE_VERSION"],
      ["format", (doc) => { doc.format = "something-else"; }, "INCOMPATIBLE_VERSION"],
      ["revision", (doc) => { doc.revision = 0; }, "CORRUPTED_DATA"],
      ["checksum", (doc) => { doc.state.recording.label = "Silently Changed"; }, "CORRUPTED_DATA", false],
      ["recording identifier", (doc) => { doc.recordingId = "another-recording"; }, "INTEGRITY_CHECK_FAILED"],
      ["unreviewed value", (doc) => { doc.state.recording.label = "Unreviewed Label"; }, "INTEGRITY_CHECK_FAILED"],
      ["unrelated field", (doc) => { doc.state.recording.title = "Other Song"; }, "INTEGRITY_CHECK_FAILED"],
      ["automatic approval", (doc) => {
        doc.state.recording.approvalStatus = "APPROVED";
        doc.state.recordingApprovalRequired = false;
      }, "INTEGRITY_CHECK_FAILED"],
      ["original snapshot", (doc) => { doc.state.originalRecording.label = "Rewritten"; }, "INTEGRITY_CHECK_FAILED"],
      ["deleted audit entry", (doc) => {
        doc.state.auditTrail.pop();
        doc.auditEntries -= 1;
      }, "INTEGRITY_CHECK_FAILED"],
      ["rewritten resulting value", (doc) => { doc.state.auditTrail[0].resultingValue = "Other Label"; }, "INTEGRITY_CHECK_FAILED"],
      ["evidence URL", (doc) => {
        doc.state.auditTrail[0].evidence[0].url = "https://elsewhere.example.test/";
      }, "INTEGRITY_CHECK_FAILED"],
      ["forged approval of conflicting evidence", (doc) => {
        const entry = doc.state.auditTrail[3];
        entry.action = "APPROVE_SUGGESTED_VALUE";
        entry.outcome = "VALUE_APPLIED";
        entry.valueOrigin = "SUGGESTED_VALUE";
        entry.resultingValue = "11/16/2026";
        doc.state.recording.albumReleaseDate = "11/16/2026";
      }, "INTEGRITY_CHECK_FAILED"],
      ["missing sections", (doc) => { delete doc.state.decisions; }, "INTEGRITY_CHECK_FAILED"]
    ];
    for (const [name, mutate, code, redigest] of cases) {
      await tamper(dir, state.recordingId, original, mutate, redigest ?? true);
      const result = await load();
      expect(result, name).toMatchObject({ ok: false, code });
    }

    await fs.writeFile(file, original);
    expect((await load()).ok).toBe(true);
  });
});

test("refuses to save states MB-07 did not produce, and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: state } = await reviewed();
    const forged = (mutate: (draft: any) => void) => {
      const draft = structuredClone(state) as any;
      mutate(draft);
      return draft as HumanReviewState;
    };
    const store = fileStore(dir);
    for (const candidate of [
      forged((draft) => { draft.recording.albumUPC = "0012345678905"; }),
      forged((draft) => { draft.recording.approvalStatus = "APPROVED"; }),
      forged((draft) => { draft.auditTrail.shift(); }),
      forged((draft) => { draft.decisions[0].findingReviews[0].status = "APPROVED"; }),
      forged((draft) => { draft.audioExtractions = "nope"; }),
      null as unknown as HumanReviewState
    ]) {
      expect(await store.save(candidate, { expectedRevision: 0 })).toMatchObject({ ok: false, code: "INVALID_STATE" });
    }
    expect(await store.save(state, { expectedRevision: -1 })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await store.save(state, { expectedRevision: 0, sessionId: "me@example.test" }))
      .toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

test("an interrupted save leaves the previously saved revision intact", async () => {
  await withTempDir(async (dir) => {
    const { state, reviewed: next } = await reviewed();
    expect((await fileStore(dir).save(state, { expectedRevision: 0 })).ok).toBe(true);
    const file = await storedFile(dir, state.recordingId);
    const before = await fs.readFile(file, "utf8");
    const real: ReviewFileSystem = {
      mkdir: fs.mkdir, readFile: fs.readFile, open: fs.open, rename: fs.rename,
      unlink: fs.unlink, readdir: fs.readdir, stat: fs.stat
    };
    const ioError = (code: string) => Object.assign(new Error(`${code}: failed at ${dir}`), { code });

    // Fails while the temporary file is half written.
    const partialWrite: ReviewFileSystem = {
      ...real,
      open: (async (path: string, flags?: string, mode?: number) => {
        const handle = await fs.open(path, flags, mode);
        if (!String(path).endsWith(".tmp")) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "writeFile") {
              return async (content: string) => {
                await target.writeFile(content.slice(0, 64));
                throw ioError("ENOSPC");
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }) as typeof fs.open
    };
    // Fails at the final commit (rename).
    const failedCommit: ReviewFileSystem = { ...real, rename: async () => { throw ioError("EIO"); } };

    for (const fileSystem of [partialWrite, failedCommit]) {
      const result = await fileStore(dir, fileSystem).save(next, { expectedRevision: 1 });
      expect(result).toMatchObject({ ok: false, code: "STORAGE_ERROR" });
      if (!result.ok) expect(result.message).not.toContain(dir);
      expect(await fs.readFile(file, "utf8")).toBe(before);
      expect((await fs.readdir(dir)).filter((name) => !name.endsWith(".json"))).toEqual([]);
      const loaded = await fileStore(dir).load(state.recordingId);
      expect(loaded).toMatchObject({ ok: true, session: { revision: 1 } });
    }

    // A crash can leave a truncated temporary file; it is ignored and cleaned up by the next save.
    const leftover = join(dir, `${reviewStorageKey(state.recordingId)}.999.deadbeef.tmp`);
    await fs.writeFile(leftover, before.slice(0, 40));
    expect((await fileStore(dir).load(state.recordingId)).ok).toBe(true);
    expect((await fileStore(dir).list()).every((entry) => entry.ok)).toBe(true);
    expect(await fileStore(dir).save(next, { expectedRevision: 1 })).toMatchObject({ ok: true, session: { revision: 2 } });
    expect(await fs.readdir(dir)).toEqual([`${reviewStorageKey(state.recordingId)}.json`]);
  });
});

test("a signed store detects rewritten audit notes, reviewers, and timestamps", async () => {
  await withTempDir(async (dir) => {
    const key = "fictional-local-review-key-0001";
    const signed = () => createReviewSessionStore(createJsonFileReviewStorage(dir), { integrityKey: key });
    expect(() => createReviewSessionStore(createInMemoryReviewStorage(), { integrityKey: "short" })).toThrow();
    const { reviewed: state } = await reviewed();
    expect((await signed().save(state, { expectedRevision: 0 })).ok).toBe(true);
    const original = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    expect(JSON.parse(original).signature).toMatch(/^HMAC-SHA256-[0-9a-f]{64}$/);
    expect((await signed().load(state.recordingId)).ok).toBe(true);

    const rewrites: Array<[string, (document: any) => void]> = [
      ["note", (doc) => { doc.state.auditTrail[0].note = "Different note."; }],
      ["reviewer", (doc) => { doc.state.auditTrail[1].reviewer.reviewerId = "someone-else"; }],
      ["timestamp", (doc) => { doc.state.auditTrail[2].reviewedAt = "2020-01-01T00:00:00.000Z"; }],
      ["revision", (doc) => { doc.revision = 7; }],
      ["signature removed", (doc) => { doc.signature = null; }]
    ];
    for (const [name, mutate] of rewrites) {
      await tamper(dir, state.recordingId, original, mutate);
      expect(await signed().load(state.recordingId), name).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
    }
    // The wrong key is also refused.
    await fs.writeFile(await storedFile(dir, state.recordingId), original);
    const wrongKey = createReviewSessionStore(createJsonFileReviewStorage(dir), { integrityKey: "another-fictional-key-0002" });
    expect(await wrongKey.load(state.recordingId)).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
  });
});

test("an existing lock blocks saving until it is safely removed", async () => {
  await withTempDir(async (dir) => {
    const { state } = await reviewed();
    const lock = join(dir, `${reviewStorageKey(state.recordingId)}.lock`);
    await fs.writeFile(lock, "{}");
    expect(await fileStore(dir).save(state, { expectedRevision: 0 })).toMatchObject({ ok: false, code: "LOCKED" });
    expect(await fs.readFile(lock, "utf8")).toBe("{}");
    await fs.unlink(lock);
    expect(await fileStore(dir).save(state, { expectedRevision: 0 })).toMatchObject({
      ok: true, session: { revision: 1 }
    });
    expect((await fs.readdir(dir)).some((name) => name.endsWith(".lock"))).toBe(false);
  });
});

test("limits exposure of contact information and local paths", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: state } = await reviewed({
      current: (record) => {
        record.submitterName = "Fictional Submitter";
        record.email = "submitter@example.test";
        record.phone = "555-0100";
      }
    });
    const withNote = applyHumanReviewDecision(state, decide(state, "albumReleaseDate", "DEFER_DECISION", {
      note: "Ask submitter@example.test about C:\\Users\\someone\\master.wav"
    }));
    if (!withNote.ok) throw new Error(withNote.rejection.message);
    expect((await fileStore(dir).save(withNote.state, { expectedRevision: 0 })).ok).toBe(true);

    const raw = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    expect(raw).not.toContain("C:\\\\Users\\\\someone");
    expect(withNote.auditEntry.note).toBe("Ask [redacted email] about [redacted local path]");
    if (process.platform !== "win32") {
      expect((await fs.stat(await storedFile(dir, state.recordingId))).mode & 0o077).toBe(0);
    }

    const listing = JSON.stringify(await fileStore(dir).list());
    for (const secret of ["submitter@example.test", "555-0100", "Fictional Submitter", "fictional-song.wav", "fictional-audio"]) {
      expect(listing).not.toContain(secret);
    }

    const restored = await fileStore(dir).load(state.recordingId);
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.session.state.recording.email).toBe("submitter@example.test");
  });
});

test("notes whose redaction leaves edge whitespace survive the replay check", async () => {
  const { reviewed: state } = await reviewed();
  const odd = applyHumanReviewDecision(state, decide(state, "albumReleaseDate", "DEFER_DECISION", {
    note: "\u0001Checked with the label\u0002"
  }));
  if (!odd.ok) throw new Error(odd.rejection.message);
  expect(odd.auditEntry.note).toBe(" Checked with the label ");
  const store = createReviewSessionStore(createInMemoryReviewStorage());
  expect((await store.save(odd.state, { expectedRevision: 0 })).ok).toBe(true);
  const loaded = await store.load(state.recordingId);
  expect(loaded.ok && loaded.session.state).toEqual(odd.state);
});

test("a custom backend only needs the storage interface", async () => {
  const documents = new Map<string, string>();
  const calls: string[] = [];
  const backend: ReviewStorageBackend = {
    kind: "custom",
    async read(key) { calls.push("read"); return documents.get(key) ?? null; },
    async replace(key, content) { calls.push("replace"); documents.set(key, content); },
    async withLock(_key, task) { calls.push("lock"); return task(); },
    async keys() { return [...documents.keys()]; }
  };
  const { reviewed: state } = await reviewed();
  const store = createReviewSessionStore(backend);
  expect((await store.save(state, { expectedRevision: 0 })).ok).toBe(true);
  expect(calls).toEqual(["lock", "read", "replace"]);
  const document = JSON.parse([...documents.values()][0]);
  expect(document).toMatchObject({
    format: REVIEW_SESSION_FORMAT, schemaVersion: 1, revision: 1, auditEntries: 4, refusedDecisionCount: 0, refusedDecisions: []
  });
  expect((await store.load(state.recordingId)).ok).toBe(true);
});

test("persists refused decisions across a restart as an append-only, redacted log", async () => {
  await withTempDir(async (dir) => {
    const key = "fictional-local-review-key-0003";
    const open = () => createReviewSessionStore(createJsonFileReviewStorage(dir), { now: () => SAVED_AT, integrityKey: key });
    const recordedAt = new Date("2026-11-04T15:45:00.000Z");
    const { reviewed: state } = await reviewed();

    // Human REJECT_SUGGESTION decisions are audit entries; refused attempts go to the refusal log.
    const first = applyReviewDecisionsWithRefusalLog({ state, refusedDecisions: [] }, [
      decide(state, "label", "APPROVE_SUGGESTED_VALUE", { reviewId: state.auditTrail[0].reviewId }),
      decide(state, "albumReleaseDate", "APPROVE_SUGGESTED_VALUE", { note: "Looks right." }),
      decide(state, "albumUPC", "EDIT_SUGGESTED_VALUE", {
        source: "MUSICBRAINZ", editedValue: "12345", note: "Typed from C:\\Users\\someone\\sleeve.txt, ask a@example.test"
      })
    ], { now: () => recordedAt });
    expect(first.applied).toEqual([]);
    expect(first.state).toBe(state);
    expect(first.rejected.map((item) => item.code)).toEqual([
      "DUPLICATE_REVIEW", "CONFLICT_REQUIRES_EXPLICIT_RESOLUTION", "INVALID_VALUE"
    ]);
    expect(Object.isFrozen(first.refusedDecisions)).toBe(true);

    const saved = await open().save(first.state, { expectedRevision: 0, refusedDecisions: first.refusedDecisions });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.session.refusedDecisions).toEqual(first.refusedDecisions);
    const raw = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    expect(raw).not.toContain("a@example.test");
    expect(raw).not.toContain("sleeve.txt");

    // Restart: the refusals, the human rejection, and the audit trail all survive.
    const loaded = await open().load(state.recordingId);
    if (!loaded.ok) throw new Error(`${loaded.code}: ${loaded.message}`);
    expect(loaded.session.state).toEqual(state);
    expect(loaded.session.state.auditTrail.find((entry) => entry.action === "REJECT_SUGGESTION"))
      .toMatchObject({ field: "albumUPC", outcome: "SUGGESTION_REJECTED", note: "Research UPC not confirmed by distributor." });
    expect(findingStatuses(loaded.session.state).albumUPC).toContain("RESEARCH:REJECTED");
    const refused = loaded.session.refusedDecisions;
    expect(refused).toEqual(first.refusedDecisions);
    expect(refused.map((item) => [item.sequence, item.code, item.field, item.action])).toEqual([
      [1, "DUPLICATE_REVIEW", "label", "APPROVE_SUGGESTED_VALUE"],
      [2, "CONFLICT_REQUIRES_EXPLICIT_RESOLUTION", "albumReleaseDate", "APPROVE_SUGGESTED_VALUE"],
      [3, "INVALID_VALUE", "albumUPC", "EDIT_SUGGESTED_VALUE"]
    ]);
    expect(refused[0]).toMatchObject({
      reviewId: state.auditTrail[0].reviewId,
      recordedAt: recordedAt.toISOString(),
      reviewedAt: "2026-11-04T15:30:00.000Z",
      reviewer: { reviewerId: "brad", displayName: "Brad (fictional reviewer)" },
      source: "RESEARCH"
    });
    expect(refused[1].note).toBe("Looks right.");
    expect(refused[2]).toMatchObject({
      source: "MUSICBRAINZ",
      submittedValue: "12345",
      note: "Typed from [redacted local path]"
    });
    expect(refused.every((item) => item.decisionId && item.proposalId && item.message.length > 0)).toBe(true);
    expect((await open().list())[0]).toMatchObject({ ok: true, auditEntries: 4, refusedDecisions: 3 });

    // Continue after the restart: a new refusal and an accepted edit are appended to their own logs.
    const restored = loaded.session;
    const second = applyReviewDecisionsWithRefusalLog(restored, [
      decide(restored.state, "albumUPC", "REJECT_SUGGESTION"),
      decide(restored.state, "albumReleaseDate", "EDIT_SUGGESTED_VALUE", {
        source: "MUSICBRAINZ", editedValue: "11/15/2026", note: "Sleeve confirms date."
      })
    ], { now: () => recordedAt });
    expect(second.rejected.map((item) => item.code)).toEqual(["ALREADY_DECIDED"]);
    expect(second.applied).toHaveLength(1);
    const resaved = await open().save(second.state, {
      expectedRevision: restored.revision, refusedDecisions: second.refusedDecisions
    });
    expect(resaved).toMatchObject({ ok: true, session: { revision: 2 } });

    // A refusal-only change is still a new revision; omitting the log keeps it.
    const onlyRefusal = recordRefusedDecision(second.refusedDecisions,
      { reviewId: "bad", reviewer: "not-an-object" }, { reviewId: "bad", code: "INVALID_DECISION", message: "Malformed." },
      recordedAt);
    expect(onlyRefusal[4]).toMatchObject({ sequence: 5, reviewer: null, decisionId: null, action: null, code: "INVALID_DECISION" });
    expect(await open().save(second.state, { expectedRevision: 2, refusedDecisions: onlyRefusal }))
      .toMatchObject({ ok: true, unchanged: false, session: { revision: 3 } });
    expect(await open().save(second.state, { expectedRevision: 3 })).toMatchObject({ ok: true, unchanged: true });

    // The refusal log is append-only and validated like the audit trail.
    expect(await open().save(second.state, { expectedRevision: 3, refusedDecisions: onlyRefusal.slice(0, 4) }))
      .toMatchObject({ ok: false, code: "HISTORY_REWRITE", currentRevision: 3 });
    const rewritten = onlyRefusal.map((item, index) => index === 0 ? { ...item, code: "STALE_DECISION" as const } : item);
    expect(await open().save(second.state, { expectedRevision: 3, refusedDecisions: rewritten }))
      .toMatchObject({ ok: false, code: "HISTORY_REWRITE" });
    for (const malformed of [
      [{ ...onlyRefusal[0], sequence: 2 }],
      [{ ...onlyRefusal[0], note: "mail me@example.test" }],
      [{ ...onlyRefusal[0], code: "MADE_UP" }],
      [{ ...onlyRefusal[0], extra: true }],
      "nope"
    ]) {
      expect(await open().save(second.state, { expectedRevision: 3, refusedDecisions: malformed as never }))
        .toMatchObject({ ok: false, code: "INVALID_STATE" });
    }

    // Tampering with the stored refusals is detected on load.
    const original = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    const unsigned = () => createReviewSessionStore(createJsonFileReviewStorage(dir));
    const cases: Array<[string, (document: any) => void, string, boolean?, ReviewSessionStore?]> = [
      ["checksum", (doc) => { doc.refusedDecisions[0].code = "STALE_DECISION"; }, "CORRUPTED_DATA", false],
      ["deleted refusal", (doc) => { doc.refusedDecisions.pop(); }, "INTEGRITY_CHECK_FAILED"],
      ["malformed refusal", (doc) => { doc.refusedDecisions[1].sequence = 9; }, "INTEGRITY_CHECK_FAILED"],
      ["missing log", (doc) => { delete doc.refusedDecisions; }, "CORRUPTED_DATA", false],
      ["signed note", (doc) => { doc.refusedDecisions[1].note = "Different."; }, "INTEGRITY_CHECK_FAILED"]
    ];
    for (const [name, mutate, code, redigest] of cases) {
      await tamper(dir, state.recordingId, original, mutate, redigest ?? true);
      expect(await open().load(state.recordingId), name).toMatchObject({ ok: false, code });
    }
    // Without a key a consistent, re-checksummed edit of free text is not detectable (documented).
    await tamper(dir, state.recordingId, original, (doc) => { doc.refusedDecisions[1].note = "Different."; });
    expect((await unsigned().load(state.recordingId)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MB-09: combined MB-07 + MB-09 sessions (schema version 2)
// ---------------------------------------------------------------------------

/** Orchard artist already on the record, so confirming it keeps the research identity unchanged. */
const attributed = { prepare: (record: DemoRecording) => { record.artist = "Fictional Artist"; } };

function ok<R extends { ok: boolean }>(result: R): Extract<R, { ok: true }> {
  if (!result.ok) {
    const failure = result as { code?: string; message?: string; rejection?: { message: string } };
    throw new Error(`${failure.code ?? ""} ${failure.message ?? failure.rejection?.message ?? ""}`);
  }
  return result as Extract<R, { ok: true }>;
}

/** MB-07 accepts the label, MB-09 confirms the artist, MB-07 rejects the UPC, MB-09 answers a declaration. */
async function combined(options: Parameters<typeof setup>[0] = attributed) {
  const base = await setup(options);
  let state: HumanGapReviewState = startHumanGapReview(base.state);
  state = ok(applyResearchReviewDecision(state, decide(state.research, "label", "APPROVE_SUGGESTED_VALUE",
    { note: "Matches the label catalog." }))).state;
  state = ok(applyHumanGapDecision(state, gapDecide(state, "artist-unconfirmed",
    { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist", primaryArtist: "Fictional Artist" }))).state;
  state = ok(applyResearchReviewDecision(state, decide(state.research, "albumUPC", "REJECT_SUGGESTION",
    { note: "Research UPC not confirmed by distributor." }))).state;
  state = ok(applyHumanGapDecision(state, gapDecide(state, "declaration-unanswered",
    { action: "SET_FIELD", field: "canadianContentDeclaration", value: "yes" },
    { field: "canadianContentDeclaration", note: "Confirmed with the label." }))).state;
  return { ...base, combined: state };
}

async function tamperV2(
  dir: string,
  recordingId: string,
  original: string,
  mutate: (document: any) => void,
  redigest = true
): Promise<void> {
  const document = JSON.parse(original);
  mutate(document);
  if (redigest) document.contentDigest = combinedReviewSessionDigest(document.state, document.refusedDecisions);
  await fs.writeFile(await storedFile(dir, recordingId), JSON.stringify(document));
}

for (const backendKind of ["json-file", "memory"] as const) {
  test(`MB-09: a combined research and manual review survives save, restart, and reload (${backendKind})`, async () => {
    await withTempDir(async (dir) => {
      const memory = createInMemoryReviewStorage();
      const open = (): ReviewSessionStore => backendKind === "memory"
        ? createReviewSessionStore(memory, { now: () => SAVED_AT })
        : fileStore(dir);
      const { workflow, combined: state } = await combined();
      expect(state.reviewEvents.map((event) => event.kind)).toEqual(["RESEARCH", "MANUAL", "RESEARCH", "MANUAL"]);

      const saved = await open().saveCombined(state, { expectedRevision: 0, sessionId: "review-desk-9" });
      expect(saved).toMatchObject({
        ok: true, unchanged: false,
        session: { schemaVersion: COMBINED_REVIEW_SESSION_SCHEMA_VERSION, revision: 1, savedBy: "review-desk-9", upgradedFrom: null }
      });

      // Restart: a fresh store instance reloads and verifies the full combined history.
      const loaded = ok(await open().loadCombined(state.recordingId));
      const restored = loaded.session.state;
      expect(restored).toEqual(state);
      expect(Object.isFrozen(restored.manualAuditTrail[0])).toBe(true);
      expect(restored.research.originalRecording).toEqual(workflow.recording);
      expect(restored.research.recording).toMatchObject({
        artist: "Fictional Artist", label: "Fictional Label", canadianContentDeclaration: "yes", approvalStatus: "DRAFT"
      });
      expect(restored.research.recording.artistAttribution?.confirmed).toBe(true);
      expect(restored.reviewEvents).toEqual(state.reviewEvents);
      expect(restored.manualAuditTrail.map((entry) => entry.eventSequence)).toEqual([2, 4]);
      expect(restored.research.auditTrail.find((entry) => entry.action === "REJECT_SUGGESTION"))
        .toMatchObject({ field: "albumUPC" });
      expect(await open().load(state.recordingId)).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERSION" });
      expect(await open().list()).toEqual([expect.objectContaining({
        ok: true, schemaVersion: 2, revision: 1, auditEntries: 2, manualAuditEntries: 2, approvalStatus: "DRAFT"
      })]);

      // Continue after the restart; the history only grows.
      const next = ok(applyHumanGapDecision(restored, gapDecide(restored, "missing-required-field",
        { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email" }))).state;
      expect(await open().saveCombined(next, { expectedRevision: 1 })).toMatchObject({ ok: true, session: { revision: 2 } });
      expect(await open().saveCombined(next, { expectedRevision: 2 })).toMatchObject({ ok: true, unchanged: true });
      const reloaded = ok(await open().loadCombined(state.recordingId));
      expect(reloaded.session.state).toEqual(next);
      expect(JSON.stringify(publicHumanGapAuditTrail(reloaded.session.state))).not.toContain("submitter@example.test");
    });
  });
}

test("MB-09: replaying the combined history reproduces the exact state", async () => {
  const { combined: state } = await combined();
  const replayed = verifyHumanGapReviewState(JSON.parse(JSON.stringify(state)));
  if (!replayed.ok) throw new Error(replayed.message);
  expect(replayed.value).toEqual(state);
  expect(JSON.stringify(replayed.value)).toBe(JSON.stringify(state));
});

test("MB-09: altered, forged, reordered, or deleted manual history fails verification", async () => {
  await withTempDir(async (dir) => {
    const { combined: state } = await combined();
    expect((await fileStore(dir).saveCombined(state, { expectedRevision: 0 })).ok).toBe(true);
    const original = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    const swap = (list: any[], a: number, b: number) => { [list[a], list[b]] = [list[b], list[a]]; };

    const cases: Array<[string, (document: any) => void]> = [
      ["unreviewed metadata change", (doc) => { doc.state.research.recording.christmasHanukkahDeclaration = "no"; }],
      ["unauthorized approval", (doc) => { doc.state.research.recording.approvalStatus = "APPROVED"; }],
      ["altered manual value", (doc) => { doc.state.manualAuditTrail[1].replay.value = "no"; }],
      ["altered recording to match a forged value", (doc) => {
        doc.state.manualAuditTrail[1].replay.value = "no";
        doc.state.research.recording.canadianContentDeclaration = "no";
      }],
      ["altered artist roles", (doc) => { doc.state.manualAuditTrail[0].replay.secondaryArtist = "Forged Guest"; }],
      ["deleted manual entry", (doc) => {
        doc.state.manualAuditTrail.pop();
        doc.state.reviewEvents.pop();
        doc.manualAuditEntries -= 1;
        doc.reviewEvents -= 1;
      }],
      ["deleted event only", (doc) => { doc.state.reviewEvents.pop(); doc.reviewEvents -= 1; }],
      ["reordered events", (doc) => {
        swap(doc.state.reviewEvents, 0, 1);
        doc.state.reviewEvents.forEach((event: any, index: number) => { event.sequence = index + 1; });
      }],
      ["reordered events without renumbering the audit trail", (doc) => {
        swap(doc.state.reviewEvents, 1, 2);
        doc.state.reviewEvents.forEach((event: any, index: number) => { event.sequence = index + 1; });
      }],
      ["duplicate review id", (doc) => {
        const reused = doc.state.research.auditTrail[0].reviewId;
        doc.state.manualAuditTrail[1].reviewId = reused;
        doc.state.reviewEvents[3].reviewId = reused;
      }],
      ["forged manual confirmation", (doc) => {
        const forged = JSON.parse(JSON.stringify(doc.state.manualAuditTrail[1]));
        Object.assign(forged, { sequence: 3, eventSequence: 5, reviewId: "forged-1" });
        doc.state.manualAuditTrail.push(forged);
        doc.state.reviewEvents.push({ sequence: 5, kind: "MANUAL", reviewId: "forged-1", auditSequence: 3 });
        doc.manualAuditEntries += 1;
        doc.reviewEvents += 1;
      }],
      ["stale basis", (doc) => { doc.state.manualAuditTrail[1].gapDigest = "GAP-000000000000000000000000"; }],
      ["modified evidence", (doc) => {
        doc.state.manualAuditTrail[0].evidence.push({ source: "record", field: "artist", value: "Forged" });
      }],
      ["modified research evidence", (doc) => {
        doc.state.research.auditTrail[0].evidence[0].url = "https://elsewhere.example.test/";
      }],
      ["unknown event kind", (doc) => { doc.state.reviewEvents[1].kind = "AUTOMATIC"; }]
    ];
    for (const [name, mutate] of cases) {
      await tamperV2(dir, state.recordingId, original, mutate);
      expect(await fileStore(dir).loadCombined(state.recordingId), name)
        .toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
    }
    await tamperV2(dir, state.recordingId, original, (doc) => { doc.state.manualAuditTrail[0].note = "x"; }, false);
    expect(await fileStore(dir).loadCombined(state.recordingId)).toMatchObject({ ok: false, code: "CORRUPTED_DATA" });

    // A tampered in-memory state is refused before anything is written.
    await fs.writeFile(await storedFile(dir, state.recordingId), original);
    const forged = JSON.parse(JSON.stringify(state));
    forged.research.recording.generativeAiAudioDeclaration = "no";
    expect(await fileStore(dir).saveCombined(forged, { expectedRevision: 1 })).toMatchObject({ ok: false, code: "INVALID_STATE" });
    expect(await fs.readFile(await storedFile(dir, state.recordingId), "utf8")).toBe(original);
  });
});

test("MB-09: version-1 sessions stay readable and are upgraded only explicitly", async () => {
  await withTempDir(async (dir) => {
    const { reviewed: v1State } = await reviewed(attributed);
    const refused = recordRefusedDecision([], { reviewId: "bad" }, { reviewId: "bad", code: "INVALID_DECISION", message: "Malformed." },
      SAVED_AT);
    expect((await fileStore(dir).save(v1State, { expectedRevision: 0, refusedDecisions: refused })).ok).toBe(true);
    const v1Text = await fs.readFile(await storedFile(dir, v1State.recordingId), "utf8");
    expect(JSON.parse(v1Text).schemaVersion).toBe(REVIEW_SESSION_SCHEMA_VERSION);

    // MB-08 reads are unchanged; combined access requires an explicit upgrade.
    expect((await fileStore(dir).load(v1State.recordingId)).ok).toBe(true);
    expect(await fileStore(dir).loadCombined(v1State.recordingId)).toMatchObject({ ok: false, code: "UPGRADE_REQUIRED" });
    expect(await fileStore(dir).saveCombined(startHumanGapReview(v1State), { expectedRevision: 1 }))
      .toMatchObject({ ok: false, code: "UPGRADE_REQUIRED", currentRevision: 1 });
    expect(await fileStore(dir).upgrade(v1State.recordingId, { expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(await fileStore(dir).upgrade(v1State.recordingId, { expectedRevision: 2 }))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT", currentRevision: 1 });
    expect(await fileStore(dir).upgrade("no-such-recording", { expectedRevision: 1 }))
      .toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await fs.readFile(await storedFile(dir, v1State.recordingId), "utf8")).toBe(v1Text);

    const upgraded = ok(await fileStore(dir).upgrade(v1State.recordingId, { expectedRevision: 1, sessionId: "upgrade-desk" }));
    expect(upgraded).toMatchObject({ unchanged: false, session: { schemaVersion: 2, revision: 2, savedBy: "upgrade-desk" } });
    expect(upgraded.session.upgradedFrom).toEqual({
      schemaVersion: 1, revision: 1, contentDigest: reviewSessionDigest(v1State, refused)
    });
    // Nothing was reinterpreted: the MB-07 state, history, and refusals are carried over verbatim.
    expect(upgraded.session.state.research).toEqual(v1State);
    expect(upgraded.session.refusedDecisions).toEqual(refused);
    expect(upgraded.session.state.manualAuditTrail).toEqual([]);
    expect(upgraded.session.state.reviewEvents.map((event) => [event.kind, event.reviewId]))
      .toEqual(v1State.auditTrail.map((entry) => ["RESEARCH", entry.reviewId]));

    // The upgraded document is version 2: MB-08 v1 writes may not overwrite it.
    const v2Text = await fs.readFile(await storedFile(dir, v1State.recordingId), "utf8");
    expect(await fileStore(dir).load(v1State.recordingId)).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERSION" });
    expect(await fileStore(dir).save(v1State, { expectedRevision: 2 })).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERSION" });
    expect(await fs.readFile(await storedFile(dir, v1State.recordingId), "utf8")).toBe(v2Text);
    expect(await fileStore(dir).upgrade(v1State.recordingId, { expectedRevision: 2 })).toMatchObject({ ok: true, unchanged: true });

    // MB-09 continues on the upgraded session; provenance is carried forward.
    const loaded = ok(await fileStore(dir).loadCombined(v1State.recordingId));
    const next = ok(applyHumanGapDecision(loaded.session.state, gapDecide(loaded.session.state, "artist-unconfirmed",
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist" }))).state;
    const resaved = ok(await fileStore(dir).saveCombined(next, { expectedRevision: 2 }));
    expect(resaved.session).toMatchObject({ revision: 3, upgradedFrom: upgraded.session.upgradedFrom });
    expect(ok(await fileStore(dir).loadCombined(v1State.recordingId)).session.state).toEqual(next);

    // Upgrade provenance and schema numbers are validated too.
    const current = await fs.readFile(await storedFile(dir, v1State.recordingId), "utf8");
    await tamperV2(dir, v1State.recordingId, current, (doc) => { doc.upgradedFrom.revision = 9; });
    expect(await fileStore(dir).loadCombined(v1State.recordingId)).toMatchObject({ ok: false, code: "CORRUPTED_DATA" });
    await tamperV2(dir, v1State.recordingId, current, (doc) => { doc.schemaVersion = 3; });
    expect(await fileStore(dir).loadCombined(v1State.recordingId)).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERSION" });
    expect(await fileStore(dir).load(v1State.recordingId)).toMatchObject({ ok: false, code: "INCOMPATIBLE_VERSION" });
  });
});

test("MB-09: an unmodified version-1 document from MB-08 upgrades in a memory store too", async () => {
  const memory = createInMemoryReviewStorage();
  const store = createReviewSessionStore(memory, { now: () => SAVED_AT });
  const { reviewed: v1State } = await reviewed();
  expect((await store.save(v1State, { expectedRevision: 0 })).ok).toBe(true);
  const upgraded = ok(await store.upgrade(v1State.recordingId, { expectedRevision: 1 }));
  expect(upgraded.session.state.research).toEqual(v1State);
  expect((await store.list())[0]).toMatchObject({ ok: true, schemaVersion: 2, manualAuditEntries: 0, auditEntries: 4 });
});

test("MB-09: concurrent combined sessions produce revision conflicts, not silent overwrites", async () => {
  await withTempDir(async (dir) => {
    const { combined: state } = await combined();
    expect((await fileStore(dir).saveCombined(state, { expectedRevision: 0 })).ok).toBe(true);
    const deskA = ok(await fileStore(dir).loadCombined(state.recordingId)).session;
    const deskB = ok(await fileStore(dir).loadCombined(state.recordingId)).session;

    const a = ok(applyHumanGapDecision(deskA.state, gapDecide(deskA.state, "missing-required-field",
      { action: "SET_FIELD", field: "submitterName", value: "Fictional Submitter" }, { field: "submitterName" }))).state;
    const b = ok(applyHumanGapDecision(deskB.state, gapDecide(deskB.state, "declaration-unanswered",
      { action: "SET_FIELD", field: "independentLabelDeclaration", value: "no" }, { field: "independentLabelDeclaration" }))).state;
    expect(await fileStore(dir).saveCombined(a, { expectedRevision: deskA.revision })).toMatchObject({ ok: true, session: { revision: 2 } });
    expect(await fileStore(dir).saveCombined(b, { expectedRevision: deskB.revision }))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT", currentRevision: 2 });
    // Even with the right revision, desk B's diverged history is not an append to desk A's.
    expect(await fileStore(dir).saveCombined(b, { expectedRevision: 2 })).toMatchObject({ ok: false, code: "HISTORY_REWRITE" });
    // An older state cannot drop newer decisions.
    expect(await fileStore(dir).saveCombined(state, { expectedRevision: 2 })).toMatchObject({ ok: false, code: "HISTORY_REWRITE" });
    expect(ok(await fileStore(dir).loadCombined(state.recordingId)).session.state).toEqual(a);

    // Racing saves from separate stores never both succeed.
    const latest = ok(await fileStore(dir).loadCombined(state.recordingId)).session;
    const c = ok(applyHumanGapDecision(latest.state, gapDecide(latest.state, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email" }))).state;
    const results = await Promise.all([
      fileStore(dir).saveCombined(c, { expectedRevision: 2 }),
      fileStore(dir).saveCombined(c, { expectedRevision: 2 })
    ]);
    expect(results.filter((result) => result.ok && !result.unchanged)).toHaveLength(1);
    const other = results.find((result) => !result.ok || result.unchanged);
    if (other && !other.ok) expect(["REVISION_CONFLICT", "LOCKED"]).toContain(other.code);
  });
});

test("MB-09: a signed store detects rewritten manual history and headers", async () => {
  await withTempDir(async (dir) => {
    const key = "fictional-local-review-key-0009";
    const signed = () => createReviewSessionStore(createJsonFileReviewStorage(dir), { integrityKey: key });
    const { combined: state } = await combined();
    expect((await signed().saveCombined(state, { expectedRevision: 0 })).ok).toBe(true);
    const original = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    expect(JSON.parse(original).signature).toMatch(/^HMAC-SHA256-[0-9a-f]{64}$/);
    expect((await signed().loadCombined(state.recordingId)).ok).toBe(true);

    const rewrites: Array<[string, (document: any) => void]> = [
      ["manual note", (doc) => { doc.state.manualAuditTrail[1].note = "Different note."; }],
      ["manual timestamp", (doc) => { doc.state.manualAuditTrail[0].reviewedAt = "2020-01-01T00:00:00.000Z"; }],
      ["manual reviewer name", (doc) => { doc.state.manualAuditTrail[0].reviewer.displayName = "Someone"; }],
      ["manual reviewer id", (doc) => { doc.state.manualAuditTrail[0].reviewer.reviewerId = "someone-else"; }],
      ["fully renumbered reorder of independent decisions", (doc) => {
        [doc.state.reviewEvents[1], doc.state.reviewEvents[2]] = [doc.state.reviewEvents[2], doc.state.reviewEvents[1]];
        doc.state.reviewEvents.forEach((event: any, index: number) => { event.sequence = index + 1; });
        doc.state.manualAuditTrail[0].eventSequence = 3;
      }],
      ["header count", (doc) => { doc.manualAuditEntries = 2; doc.revision = 4; }],
      ["upgrade provenance", (doc) => { doc.upgradedFrom = null; doc.savedBy = "someone"; }],
      ["signature removed", (doc) => { doc.signature = null; }]
    ];
    for (const [name, mutate] of rewrites) {
      await tamperV2(dir, state.recordingId, original, mutate);
      expect(await signed().loadCombined(state.recordingId), name).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
    }
    await fs.writeFile(await storedFile(dir, state.recordingId), original);
    const wrongKey = createReviewSessionStore(createJsonFileReviewStorage(dir), { integrityKey: "another-fictional-key-0010" });
    expect(await wrongKey.loadCombined(state.recordingId)).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
    // Without a key a consistent, re-checksummed edit of a free-text note, or a fully renumbered reorder of
    // independent decisions, is not detectable (documented); a signing key covers both.
    await tamperV2(dir, state.recordingId, original, (doc) => { doc.state.manualAuditTrail[1].note = "Different note."; });
    expect((await fileStore(dir).loadCombined(state.recordingId)).ok).toBe(true);
  });
});

test("MB-09: refused manual and research decisions persist as one append-only, redacted log", async () => {
  await withTempDir(async (dir) => {
    const key = "fictional-local-review-key-0011";
    const recordedAt = new Date("2026-11-04T15:45:00.000Z");
    const open = () => createReviewSessionStore(createJsonFileReviewStorage(dir), { now: () => SAVED_AT, integrityKey: key });
    const { combined: state } = await combined();

    const batch = applyCombinedReviewDecisionsWithRefusalLog({ state, refusedDecisions: [] }, [
      { kind: "MANUAL", decision: gapDecide(state, "missing-required-field",
        { action: "SET_FIELD", field: "email", value: "not an email a@example.test" },
        { field: "email", note: "From C:\\Users\\someone\\contacts.txt" }) },
      { kind: "RESEARCH", decision: decide(state.research, "label", "APPROVE_SUGGESTED_VALUE",
        { reviewId: state.research.auditTrail[0].reviewId }) },
      { kind: "MANUAL", decision: gapDecide(state, "declaration-unanswered",
        { action: "ACKNOWLEDGE" }, { field: "independentLabelDeclaration" }) },
      { kind: "MANUAL", decision: gapDecide(state, "missing-required-field",
        { action: "SET_FIELD", field: "submitterName", value: "Fictional Submitter" }, { field: "submitterName" }) }
    ], { now: () => recordedAt });
    expect(batch.rejected.map((item) => `${item.kind}:${item.rejection.code}`))
      .toEqual(["MANUAL:INVALID_VALUE", "RESEARCH:DUPLICATE_REVIEW", "MANUAL:NOTE_REQUIRED"]);
    expect(batch.applied).toHaveLength(1);
    expect(batch.state.research.recording.email).toBe(state.research.recording.email);

    const saved = ok(await open().saveCombined(batch.state, { expectedRevision: 0, refusedDecisions: batch.refusedDecisions }));
    expect(saved.session.refusedDecisions).toHaveLength(3);
    const raw = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    expect(raw).not.toContain("a@example.test");
    expect(raw).not.toContain("contacts.txt");

    const loaded = ok(await open().loadCombined(state.recordingId)).session;
    expect(loaded.refusedDecisions).toEqual(batch.refusedDecisions);
    expect(loaded.refusedDecisions[0]).toMatchObject({
      kind: "MANUAL", sequence: 1, field: "email", action: "SET_FIELD", code: "INVALID_VALUE",
      reviewer: { reviewerId: "dana" }, note: "From [redacted local path]", recordedAt: recordedAt.toISOString()
    });
    expect(loaded.refusedDecisions[1]).toMatchObject({ sequence: 2, code: "DUPLICATE_REVIEW", field: "label" });
    expect(loaded.refusedDecisions[1]).not.toHaveProperty("kind");
    expect(loaded.state).toEqual(batch.state);

    // Append-only and validated like the audit trail.
    expect(await open().saveCombined(batch.state, { expectedRevision: 1, refusedDecisions: batch.refusedDecisions.slice(0, 2) }))
      .toMatchObject({ ok: false, code: "HISTORY_REWRITE" });
    expect(await open().saveCombined(batch.state, {
      expectedRevision: 1, refusedDecisions: [{ ...batch.refusedDecisions[0], note: "mail me@example.test" }] as never
    })).toMatchObject({ ok: false, code: "INVALID_STATE" });
    const original = await fs.readFile(await storedFile(dir, state.recordingId), "utf8");
    await tamperV2(dir, state.recordingId, original, (doc) => { doc.refusedDecisions[0].code = "MADE_UP"; });
    expect(await open().loadCombined(state.recordingId)).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
    await tamperV2(dir, state.recordingId, original, (doc) => { doc.refusedDecisions.pop(); doc.refusedDecisionCount -= 1; });
    expect(await open().loadCombined(state.recordingId)).toMatchObject({ ok: false, code: "INTEGRITY_CHECK_FAILED" });
  });
});

test("MB-09: approval stays a separate explicit operation across persistence", async () => {
  await withTempDir(async (dir) => {
    const { combined: state } = await combined();
    expect(state.research.recording.approvalStatus).toBe("DRAFT");
    expect(state.research.recordingApprovalRequired).toBe(true);
    expect(state.research.gapReport.gaps.some((gap) => gap.code === "approval-pending")).toBe(true);
    ok(await fileStore(dir).saveCombined(state, { expectedRevision: 0 }));
    const restored = ok(await fileStore(dir).loadCombined(state.recordingId)).session.state;
    expect(restored.research.recording.approvalStatus).toBe("DRAFT");
    expect(restored.manualAuditTrail.every((entry) => entry.resultingApprovalStatus === "DRAFT")).toBe(true);

    // A previously approved recording changed by review is saved as needing review again, never re-approved.
    const { combined: approved } = await combined({
      ...attributed, current: (record) => { record.approvalStatus = "APPROVED"; }
    });
    expect(approved.research.recording.approvalStatus).toBe("NEEDS_REVIEW");
    expect(approved.manualAuditTrail.every((entry) => entry.resultingApprovalStatus === "NEEDS_REVIEW")).toBe(true);
    const memory = createReviewSessionStore(createInMemoryReviewStorage(), { now: () => SAVED_AT });
    ok(await memory.saveCombined(approved, { expectedRevision: 0 }));
    expect(ok(await memory.loadCombined(approved.recordingId)).session.state.research.recording.approvalStatus)
      .toBe("NEEDS_REVIEW");
  });
});
