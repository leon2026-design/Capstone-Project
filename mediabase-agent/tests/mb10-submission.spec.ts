import { expect, test, type Browser, type TestInfo } from "@playwright/test";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { startMockMediabaseServer, type MockMediabaseServer } from "../src/submission/mockMediabaseServer";
import { createTemplateNamingProfile } from "../src/submission/namingProfile";
import { LiveDestinationForbiddenError, assertLocalDestination, installLoopbackNetworkGuard } from "../src/submission/submissionSafety";
import { submissionLedgerKey } from "../src/submission/submissionLedger";
import { humanOnlyGapQueue } from "../src/workflow/humanGapReview";
import {
  createSubmissionCoordinator,
  localMockDestination,
  type SubmissionCoordinator,
  type SubmissionCoordinatorOptions
} from "../src/workflow/submissionCoordinator";
import {
  SUBMITTER,
  confirmArtist,
  fullReview,
  manual,
  orchardCsv,
  research_,
  reviewDesk,
  setField,
  stores,
  workflowOptions,
  writeWav,
  type OrchardRow,
  type Stores
} from "./support/mb10Fixture";

/**
 * MB-10: the offline end-to-end coordinator. Real WAV files, real MB-06/07/09
 * review through the MB-08 store, a real browser filling the mock form, and a
 * real multipart upload to a loopback-only mock endpoint. Never live Mediabase.
 */

const SONG: OrchardRow = { track: "Fictional Song", artist: "Fictional Artist", isrc: "USAAA2600010" };
const SONG_TAGS = { artist: "Fictional Artist", title: "Fictional Song", album: "Fictional Album", isrc: "USAAA2600010" };
const APPROVED_AT = "2026-11-05T10:00:00.000Z";

type Env = {
  dir: string;
  server: MockMediabaseServer;
  stores: Stores;
  sleeps: number[];
  coordinator(extra?: Partial<SubmissionCoordinatorOptions>): SubmissionCoordinator;
  /** Counts page openings so tests can prove the browser was never used. */
  pages: { opened: number; open: () => ReturnType<Browser["newPage"]> };
};

const servers: MockMediabaseServer[] = [];
test.afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function env(testInfo: TestInfo, browser: Browser, kind: "memory" | "json" = "memory"): Promise<Env> {
  const dir = testInfo.outputPath("mb10");
  await fs.mkdir(dir, { recursive: true });
  const server = await startMockMediabaseServer();
  servers.push(server);
  const shared = stores(kind, dir);
  const sleeps: number[] = [];
  const pages = {
    opened: 0,
    open: () => {
      pages.opened += 1;
      return browser.newPage();
    }
  };
  return {
    dir,
    server,
    stores: shared,
    sleeps,
    pages,
    coordinator(extra = {}) {
      const { reviewStore, ledger } = shared.open();
      return createSubmissionCoordinator({
        reviewStore,
        ledger,
        destination: localMockDestination(server.baseUrl),
        workflow: workflowOptions,
        sleep: async (ms) => void sleeps.push(ms),
        ...extra
      });
    }
  };
}

async function importSong(e: Env, c: SubmissionCoordinator, row: OrchardRow = SONG, tags = SONG_TAGS, fileName = "fictional-song.wav") {
  const wav = writeWav(e.dir, fileName, tags);
  const outcomes = await c.importRecordings({ csv: orchardCsv([row]), sourceName: "fictional-orchard.csv", audioPaths: [wav] });
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0];
  if (!outcome.ok) throw new Error(`import failed: ${outcome.code}`);
  return { recordingId: outcome.recordingId, wav, outcome };
}

async function approve(c: SubmissionCoordinator, recordingId: string, approvalId = `approval-${recordingId}`) {
  const basis = await c.approvalBasis(recordingId);
  if (!basis.ok) throw new Error(basis.code);
  return c.approve({ recordingId, approvalId, approvedBy: { reviewerId: "brad", displayName: "Brad (fictional)" }, approvedAt: APPROVED_AT, basis: basis.basis });
}

/** Import, review every gap through MB-07/MB-09, and record the explicit final approval. */
async function readySong(e: Env, c: SubmissionCoordinator, row: OrchardRow = SONG, tags = SONG_TAGS, fileName?: string) {
  const imported = await importSong(e, c, row, tags, fileName);
  const { reviewStore } = e.stores.open();
  const desk = await reviewDesk(reviewStore, imported.recordingId, fullReview(row.artist));
  expect(desk.rejected).toEqual([]);
  const approval = await approve(c, imported.recordingId);
  expect(approval.ok, JSON.stringify(approval)).toBe(true);
  return imported;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test.describe("MB-10 end-to-end submission", () => {
  test("batch imports do not auto-assign one matching audio file to multiple recordings", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const wav = writeWav(e.dir, "fictional-song.wav", { artist: "Fictional Artist", title: "Fictional Song", album: "Fictional Album" });
    const outcomes = await c.importRecordings({
      csv: orchardCsv([
        { track: "Fictional Song", artist: "Fictional Artist", product: "Fictional Album A" },
        { track: "Fictional Song", artist: "Fictional Artist", product: "Fictional Album B" }
      ]),
      sourceName: "fictional-orchard.csv",
      audioPaths: [wav]
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((item) => item.ok && item.corrections.length === 0)).toBe(true);
    const { reviewStore } = e.stores.open();
    for (const item of outcomes) {
      if (!item.ok) continue;
      const loaded = await reviewStore.loadCombined(item.recordingId);
      expect(loaded.ok && loaded.session.state.research.audioMatch.status).toBe("AMBIGUOUS");
      expect(loaded.ok && loaded.session.state.research.recording.audioMatch?.status).toBe("AMBIGUOUS");
    }
  });

  test("the Mediabase coordinator rejects a policy that disables audio uploads", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    expect(() => e.coordinator({ policy: { requireAudio: false } })).toThrow("requires audio uploads");
  });

  for (const kind of ["memory", "json"] as const) {
    test(`a valid recording is imported, reviewed, approved, filled, verified, uploaded, and confirmed (${kind})`, async ({ browser }, testInfo) => {
      const e = await env(testInfo, browser, kind);
      const c = e.coordinator();
      const { recordingId, wav, outcome } = await readySong(e, c);
      expect(outcome.corrections.map((item) => item.code)).toEqual(["AUDIO_AUTO_MATCH_APPLIED"]);

      const result = await c.submit(recordingId, { openPage: e.pages.open });
      expect(result.ok && result.status).toBe("SUBMITTED");
      if (!result.ok) return;
      expect(result.attempts).toBe(1);
      expect(result.confirmation?.confirmationId).toMatch(/^MOCK-CONF-[0-9A-F]{12}$/);

      // Exactly one multipart request carrying exactly one file whose bytes match the source.
      const requests = e.server.requests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ multipart: true, fileCount: 1, outcome: "STORED" });
      const receipt = e.server.receipt(result.submissionId!);
      const bytes = await fs.readFile(wav);
      expect(receipt?.files).toEqual([{ fieldName: "audioFile", fileName: "fictional-song.wav", contentType: "audio/wav", size: bytes.length, sha256: sha256(bytes) }]);
      expect(receipt?.fields).toMatchObject({
        submissionId: result.submissionId, artist: "Fictional Artist", title: "Fictional Song", isrc: "USAAA2600010",
        label: "Fictional Label", officialReleaseDate: "11/15/2026", email: SUBMITTER.email,
        generativeAiAudioDeclaration: "no", canadianContentDeclaration: "no"
      });

      // The confirmation persists across a restart, with an append-only history.
      const restarted = e.coordinator();
      const status = await restarted.status(recordingId);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.entry.status).toBe("SUBMITTED");
      expect(status.entry.confirmation).toEqual(result.confirmation);
      expect(status.entry.statusHistory.map((item) => item.status)).toEqual(
        ["IMPORTED", "READY", "VALIDATING", "READY", "FILLING_FORM", "SUBMITTING", "SUBMITTED"]);
      const attempt = status.entry.attempts.at(-1)!;
      expect(attempt).toMatchObject({ status: "SUBMITTED", networkRequestSent: true, audioSha256: sha256(bytes), recordingId, destinationId: "local-mock-mediabase" });
      expect(attempt.receipt).toMatchObject({ verified: true, fileCount: 1, fileSize: bytes.length, fileSha256: sha256(bytes), mismatches: [] });
      expect(status.entry.approvals).toHaveLength(1);

      // The verified review session is untouched: the coordinator never marks the review APPROVED.
      const review = await e.stores.open().reviewStore.loadCombined(recordingId);
      expect(review.ok && review.session.state.research.recording.approvalStatus).toBe("DRAFT");
      expect(review.ok && review.session.revision).toBe(2);
    });
  }

  test("missing metadata stops before any browser interaction", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c);

    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("NEEDS_ATTENTION");
    expect(e.pages.opened).toBe(0);
    expect(e.server.requests()).toEqual([]);
    const codes = result.ok ? result.exceptions.map((item) => `${item.code}:${item.field}`) : [];
    expect(codes).toEqual(expect.arrayContaining([
      "HUMAN_GAP_UNRESOLVED:artist-unconfirmed",
      "MISSING_REQUIRED_FIELD:email",
      "MISSING_REQUIRED_FIELD:officialReleaseDate",
      "ARTIST_ATTRIBUTION_UNCONFIRMED:artist",
      "DECLARATION_UNANSWERED:canadianContentDeclaration",
      "APPROVAL_REQUIRED:approvalStatus"
    ]));
    // Nothing is invented: the declarations stay unanswered and approval is refused.
    const refused = await approve(c, recordingId);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe("APPROVAL_REFUSED");
  });

  test("invalid metadata is refused by MB-09 and never reaches the form", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c);
    const { reviewStore } = e.stores.open();
    const desk = await reviewDesk(reviewStore, recordingId, [setField("email", "not-an-email"), setField("canadianContentDeclaration", "maybe")]);
    expect(desk.rejected).toHaveLength(2);
    expect(desk.session.refusedDecisions).toHaveLength(2);
    const evaluation = await c.evaluate(recordingId);
    expect(evaluation.ok && evaluation.exceptions.map((item) => item.code)).toEqual(expect.arrayContaining(["MISSING_REQUIRED_FIELD", "DECLARATION_UNANSWERED"]));
    expect(e.pages.opened).toBe(0);
  });

  test("an unresolved (deferred) human-only gap blocks approval and preparation", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c);
    const { reviewStore } = e.stores.open();
    const steps = fullReview("Fictional Artist").filter((_, index, all) => index !== all.length - 1);
    await reviewDesk(reviewStore, recordingId, [...steps, manual("declaration-unanswered", { action: "DEFER" }, { field: "canadianContentDeclaration" })]);

    const refused = await approve(c, recordingId);
    expect(!refused.ok && refused.code).toBe("APPROVAL_REFUSED");
    expect(!refused.ok && refused.exceptions?.map((item) => `${item.code}:${item.field}`)).toEqual(
      expect.arrayContaining(["HUMAN_GAP_UNRESOLVED:declaration-unanswered", "DECLARATION_UNANSWERED:canadianContentDeclaration"]));
    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("NEEDS_ATTENTION");
    expect(e.pages.opened).toBe(0);
  });

  test("conflicting audio cannot be silently approved and needs an acknowledged human selection", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c, SONG, { ...SONG_TAGS, artist: "Someone Else Entirely" });
    const { reviewStore } = e.stores.open();
    const desk = await reviewDesk(reviewStore, recordingId, fullReview("Fictional Artist"));
    expect(desk.session.state.research.recording.audioFilePath ?? null).toBeNull();

    const refused = await approve(c, recordingId);
    expect(!refused.ok && refused.exceptions?.map((item) => item.code)).toEqual(expect.arrayContaining(["HUMAN_GAP_UNRESOLVED", "AUDIO_NOT_SELECTED"]));

    const gap = humanOnlyGapQueue(desk.session.state).find((item) => item.allowedActions.includes("CONFIRM_AUDIO"))!;
    const audioFileId = gap.audioCandidates[0].audioFileId;
    const unacknowledged = await reviewDesk(reviewStore, recordingId, [manual(gap.gap.code, { action: "CONFIRM_AUDIO", audioFileId })]);
    expect(unacknowledged.rejected).toEqual(["ACKNOWLEDGEMENT_REQUIRED"]);
    await reviewDesk(reviewStore, recordingId, [manual(gap.gap.code, { action: "CONFIRM_AUDIO", audioFileId, acknowledgeConflicts: true },
      { note: "Label confirmed the embedded artist tag is wrong." })]);

    const evaluation = await c.evaluate(recordingId);
    expect(evaluation.ok && evaluation.exceptions.map((item) => item.code)).toEqual(["APPROVAL_REQUIRED"]);
    expect(evaluation.ok && evaluation.warnings.map((item) => `${item.code}:${item.field}`)).toContain("AUDIO_TAG_CONFLICT_ACKNOWLEDGED:artist");
    expect((await approve(c, recordingId)).ok).toBe(true);
    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("SUBMITTED");
  });

  test("a conflicting Orchard artist cannot be confirmed without a note", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c, { ...SONG, artist: "Fictional Artist" });
    const { reviewStore } = e.stores.open();
    const loaded = await reviewStore.loadCombined(recordingId);
    expect(loaded.ok).toBe(true);
    // Confirming an Exact Artist that differs from every Orchard value is refused without a note.
    const desk = await reviewDesk(reviewStore, recordingId, [
      manual("artist-unconfirmed", { action: "CONFIRM_ARTIST", exactArtist: "Different Artist" }, { note: undefined as unknown as string })
    ]);
    expect(desk.rejected.length).toBe(1);
    const evaluation = await c.evaluate(recordingId);
    expect(evaluation.ok && evaluation.exceptions.map((item) => item.code)).toContain("ARTIST_ATTRIBUTION_UNCONFIRMED");
  });

  test("approval is bound to content: later review changes or audio edits make it stale", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId, wav } = await importSong(e, c);
    const { reviewStore } = e.stores.open();
    await reviewDesk(reviewStore, recordingId, fullReview("Fictional Artist"));
    const basis = await c.approvalBasis(recordingId);
    if (!basis.ok) throw new Error(basis.code);

    // A later review decision changes the revision: the captured basis is stale.
    await reviewDesk(reviewStore, recordingId, [research_("albumUPC", "REJECT_SUGGESTION")]);
    const stale = await c.approve({ recordingId, approvalId: "approval-stale", approvedBy: { reviewerId: "brad", displayName: null }, approvedAt: APPROVED_AT, basis: basis.basis });
    expect(!stale.ok && stale.code).toBe("APPROVAL_STALE");

    expect((await approve(c, recordingId, "approval-fresh")).ok).toBe(true);
    const replayed = await approve(c, recordingId, "approval-fresh");
    expect(!replayed.ok && replayed.code).toBe("DUPLICATE_APPROVAL");

    // Changing the audio bytes after approval invalidates it before any browser opens.
    await fs.appendFile(wav, Buffer.from([0]));
    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("NEEDS_ATTENTION");
    expect(result.ok && result.exceptions.map((item) => item.code)).toContain("APPROVAL_STALE");
    expect(e.pages.opened).toBe(0);
  });

  test("the independent preflight catches an altered form value; an explainer cannot override it", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const explained: string[] = [];
    const c = e.coordinator({
      afterFormFilled: async (page) => {
        await page.locator('input[name="title"]').fill("Fictional Song (Tampered)");
      },
      explainer: {
        async explain(failures) {
          explained.push(...failures.map((item) => item.code));
          return ["Advisory: the difference looks harmless."];
        }
      }
    });
    const { recordingId } = await readySong(e, c);
    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("PREFLIGHT_FAILED");
    expect(result.ok && result.preflightFailures.map((item) => `${item.code}:${item.field}`)).toEqual(["FIELD_VALUE_MISMATCH:title"]);
    expect(result.ok && result.explanations).toEqual(["Advisory: the difference looks harmless."]);
    expect(explained).toEqual(["FIELD_VALUE_MISMATCH"]);
    expect(e.server.requests()).toEqual([]);
    const status = await c.status(recordingId);
    expect(status.ok && status.entry.attempts.at(-1)).toMatchObject({ status: "PREFLIGHT_FAILED", networkRequestSent: false, errorCode: "PREFLIGHT_MISMATCH" });
  });

  test("the preflight catches a swapped audio file and an altered declaration", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator({
      afterFormFilled: async (page) => {
        await page.locator("#audio-file").setInputFiles({ name: "fictional-song.wav", mimeType: "audio/wav", buffer: Buffer.from("not the approved audio") });
        await page.locator('input[name="canadianContentDeclaration"][value="yes"]').check();
      }
    });
    const { recordingId } = await readySong(e, c);
    const result = await c.submit(recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("PREFLIGHT_FAILED");
    expect(result.ok && result.preflightFailures.map((item) => item.code)).toEqual(
      expect.arrayContaining(["FILE_SIZE_MISMATCH", "FILE_DIGEST_MISMATCH", "RADIO_SELECTION_MISMATCH"]));
    expect(e.server.requests()).toEqual([]);
  });

  test("a destination validation failure is logged and does not stop the next queued job", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const first = await readySong(e, c);
    const second = await readySong(e, c, { track: "Second Fictional Song", artist: "Fictional Artist", isrc: "USAAA2600011" },
      { ...SONG_TAGS, title: "Second Fictional Song", isrc: "USAAA2600011" }, "second-fictional-song.wav");
    e.server.enqueue({ kind: "validation-failure" });

    const results = await c.processQueue([first.recordingId, "ORCHARD-NOT-IMPORTED", second.recordingId], { openPage: e.pages.open });
    expect(results.map((item) => (item.ok ? item.status : item.code))).toEqual(["FAILED", "NOT_IMPORTED", "SUBMITTED"]);
    const failed = await c.status(first.recordingId);
    expect(failed.ok && failed.entry.exceptions).toEqual([expect.objectContaining({ code: "DESTINATION_REJECTED", kind: "SPONSOR_DECISION" })]);
    expect(failed.ok && failed.entry.attempts.at(-1)).toMatchObject({ status: "REJECTED", errorCode: "MOCK_VALIDATION_REJECTED" });
  });

  test("retryable transport failures follow bounded retry rules", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const recovered = await readySong(e, c);
    e.server.enqueue({ kind: "unavailable" }, { kind: "unavailable" });
    const ok = await c.submit(recovered.recordingId, { openPage: e.pages.open });
    expect(ok.ok && [ok.status, ok.attempts]).toEqual(["SUBMITTED", 3]);
    expect(e.sleeps).toEqual([250, 1000]);
    const history = await c.status(recovered.recordingId);
    expect(history.ok && history.entry.attempts.map((item) => item.status)).toEqual(
      ["STARTED", "RETRYABLE_FAILURE", "STARTED", "RETRYABLE_FAILURE", "STARTED", "SUBMITTED"]);

    const exhausted = await readySong(e, c, { track: "Second Fictional Song", artist: "Fictional Artist", isrc: "USAAA2600011" },
      { ...SONG_TAGS, title: "Second Fictional Song", isrc: "USAAA2600011" }, "second-fictional-song.wav");
    e.server.enqueue({ kind: "unavailable" }, { kind: "unavailable" }, { kind: "unavailable" }, { kind: "unavailable" });
    const failed = await c.submit(exhausted.recordingId, { openPage: e.pages.open });
    expect(failed.ok && [failed.status, failed.attempts]).toEqual(["FAILED", 3]);
    expect(failed.ok && failed.exceptions.map((item) => `${item.code}:${item.kind}`)).toEqual(["TRANSPORT_RETRY_EXHAUSTED:RECOVERABLE"]);
    expect(e.server.receipts().map((item) => item.submissionId)).toEqual([ok.ok ? ok.submissionId : ""]);
  });

  test("an ambiguous outcome after receipt never triggers a blind duplicate and is reconciled", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    e.server.enqueue({ kind: "ambiguous-after-receipt" });

    const first = await c.submit(recordingId, { openPage: e.pages.open });
    expect(first.ok && first.status).toBe("OUTCOME_UNKNOWN");
    expect(first.ok && first.attempts).toBe(1);
    expect(e.server.receipts()).toHaveLength(1);

    // Submitting again does not resend: reconciliation is required.
    const again = await c.submit(recordingId, { openPage: e.pages.open });
    expect(again.ok && again.status).toBe("OUTCOME_UNKNOWN");
    expect(again.ok && again.exceptions.map((item) => item.code)).toEqual(["RECONCILIATION_REQUIRED"]);
    expect(e.server.requests()).toHaveLength(1);
    expect(e.pages.opened).toBe(1);

    const reconciled = await c.reconcile(recordingId);
    expect(reconciled.ok && [reconciled.result, reconciled.status]).toEqual(["FOUND", "SUBMITTED"]);
    expect(reconciled.ok && reconciled.confirmation?.confirmationId).toBe(e.server.receipts()[0].confirmationId);
    expect(e.server.duplicateDeliveries()).toBe(0);
    const after = await c.submit(recordingId, { openPage: e.pages.open });
    expect(after.ok && after.alreadySubmitted).toBe(true);
    expect(e.server.requests()).toHaveLength(1);
  });

  test("a dropped connection before receipt reconciles to not-received and can be resubmitted explicitly", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    e.server.enqueue({ kind: "reset-before-receipt" });
    const first = await c.submit(recordingId, { openPage: e.pages.open });
    expect(first.ok && first.status).toBe("OUTCOME_UNKNOWN");
    const reconciled = await c.reconcile(recordingId);
    expect(reconciled.ok && [reconciled.result, reconciled.status]).toEqual(["NOT_FOUND", "FAILED"]);
    const second = await c.submit(recordingId, { openPage: e.pages.open });
    expect(second.ok && second.status).toBe("SUBMITTED");
    expect(e.server.receipts()).toHaveLength(1);
  });

  test("a delayed response beyond the timeout becomes an unknown outcome; within the timeout it succeeds", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator({ policy: { responseTimeoutMs: 400 } });
    const slow = await readySong(e, c);
    e.server.enqueue({ kind: "delayed-success", delayMs: 1500 });
    const timedOut = await c.submit(slow.recordingId, { openPage: e.pages.open });
    expect(timedOut.ok && timedOut.status).toBe("OUTCOME_UNKNOWN");
    const status = await c.status(slow.recordingId);
    expect(status.ok && status.entry.attempts.at(-1)?.errorCode).toBe("RESPONSE_TIMEOUT");
    const reconciled = await c.reconcile(slow.recordingId);
    expect(reconciled.ok && reconciled.status).toBe("SUBMITTED");

    const prompt = await readySong(e, c, { track: "Second Fictional Song", artist: "Fictional Artist", isrc: "USAAA2600011" },
      { ...SONG_TAGS, title: "Second Fictional Song", isrc: "USAAA2600011" }, "second-fictional-song.wav");
    e.server.enqueue({ kind: "delayed-success", delayMs: 100 });
    const ok = await c.submit(prompt.recordingId, { openPage: e.pages.open });
    expect(ok.ok && ok.status).toBe("SUBMITTED");
  });

  test("duplicate and concurrent submit requests send exactly one upload", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    const [a, b] = await Promise.all([
      c.submit(recordingId, { openPage: e.pages.open }),
      c.submit(recordingId, { openPage: e.pages.open })
    ]);
    const outcomes = [a, b].map((item) => (item.ok ? item.status : item.code)).sort();
    expect(outcomes).toEqual(["SUBMISSION_IN_PROGRESS", "SUBMITTED"]);

    // A second process sharing the same storage waits for the lock, then sees SUBMITTED.
    const other = e.coordinator();
    const late = await other.submit(recordingId, { openPage: e.pages.open });
    expect(late.ok && late.alreadySubmitted).toBe(true);
    expect(e.server.requests()).toHaveLength(1);
    expect(e.pages.opened).toBe(1);
  });

  test("restart and resume keep the saved review, never re-run research, and never resubmit", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser, "json");
    const c = e.coordinator();
    const { recordingId, wav } = await importSong(e, c);
    const { reviewStore } = e.stores.open();
    await reviewDesk(reviewStore, recordingId, fullReview("Fictional Artist"));

    // Restart: importing the same Orchard file resumes; the review revision is unchanged.
    const restarted = e.coordinator();
    const again = await restarted.importRecordings({ csv: orchardCsv([SONG]), sourceName: "fictional-orchard.csv", audioPaths: [wav] });
    expect(again).toEqual([expect.objectContaining({ ok: true, recordingId, resumed: true, reviewRevision: 2 })]);
    expect(restarted.metrics().counters.importsResumed).toBe(1);
    expect(restarted.metrics().counters.imports).toBeUndefined();

    // A saved review without a ledger entry (crash between the two saves) is resumed, not overwritten.
    await fs.rm(join(e.dir, "submissions"), { recursive: true, force: true });
    const recovered = await e.coordinator().importRecordings({ csv: orchardCsv([SONG]), sourceName: "fictional-orchard.csv", audioPaths: [wav] });
    expect(recovered).toEqual([expect.objectContaining({ ok: true, resumed: true, reviewRevision: 2 })]);

    const final = e.coordinator();
    expect((await approve(final, recordingId)).ok).toBe(true);
    expect((await final.submit(recordingId, { openPage: e.pages.open })).ok).toBe(true);
    const afterRestart = e.coordinator();
    const repeat = await afterRestart.submit(recordingId, { openPage: e.pages.open });
    expect(repeat.ok && repeat.alreadySubmitted).toBe(true);
    expect(e.server.requests()).toHaveLength(1);
  });

  test("a process interrupted mid-submission resumes as an unknown outcome, not a resend", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser, "json");
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    // Simulate a crash right after SUBMITTING and a STARTED attempt were persisted, before any reply was recorded.
    const crashing = e.coordinator();
    const ledger = e.stores.open().ledger;
    await ledger.transact(recordingId, "local-mock-mediabase", async (tx) => {
      if (!tx.loaded.ok) throw new Error(tx.loaded.code);
      const { revision: _r, updatedAt: _u, ...entry } = structuredClone(tx.loaded.entry);
      const at = "2026-11-05T11:00:00.000Z";
      entry.status = "SUBMITTING";
      entry.statusHistory.push({ sequence: entry.statusHistory.length + 1, status: "SUBMITTING", at, reason: null, exceptionCodes: [] });
      entry.attempts.push({
        sequence: 1, attemptId: "SUB-CRASH:1", submissionId: "SUB-CRASH", recordingId, destinationId: "local-mock-mediabase",
        audioSha256: null, status: "STARTED", startedAt: at, finishedAt: null, networkRequestSent: true,
        validationSummary: { exceptions: 0, warnings: 0, preflightFailures: [] }, errorCode: null, expected: null, receipt: null
      });
      return tx.write(entry);
    });

    const evaluation = await crashing.evaluate(recordingId);
    expect(evaluation.ok && evaluation.status).toBe("OUTCOME_UNKNOWN");
    const blocked = await crashing.submit(recordingId, { openPage: e.pages.open });
    expect(blocked.ok && blocked.status).toBe("OUTCOME_UNKNOWN");
    expect(e.pages.opened).toBe(0);
    const reconciled = await crashing.reconcile(recordingId);
    expect(reconciled.ok && reconciled.result).toBe("NOT_FOUND");
    const resubmitted = await crashing.submit(recordingId, { openPage: e.pages.open });
    expect(resubmitted.ok && resubmitted.status).toBe("SUBMITTED");
    const status = await crashing.status(recordingId);
    expect(status.ok && status.entry.attempts.map((item) => `${item.status}:${item.errorCode}`)).toEqual([
      "STARTED:null", "OUTCOME_UNKNOWN:INTERRUPTED", "RECONCILED_NOT_FOUND:null", "STARTED:null", "SUBMITTED:null"
    ]);
  });

  test("corrupted, tampered, or rewritten storage is refused before the browser opens", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser, "json");
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    const ledgerFile = join(e.dir, "submissions", `${submissionLedgerKey(recordingId, "local-mock-mediabase")}.json`);
    const original = await fs.readFile(ledgerFile, "utf8");

    // Signed content edited (still valid JSON): integrity failure.
    await fs.writeFile(ledgerFile, original.replace('"status": "READY"', '"status": "SUBMITTED"').replace('"status":"READY"', '"status":"SUBMITTED"'));
    const tampered = await c.submit(recordingId, { openPage: e.pages.open });
    expect(!tampered.ok && tampered.code).toMatch(/^LEDGER_(INTEGRITY_CHECK_FAILED|CORRUPTED_DATA)$/);

    await fs.writeFile(ledgerFile, "{ not json");
    const corrupted = await c.submit(recordingId, { openPage: e.pages.open });
    expect(!corrupted.ok && corrupted.code).toBe("LEDGER_CORRUPTED_DATA");

    // Removing a recorded approval is a history rewrite, even through the ledger API.
    await fs.writeFile(ledgerFile, original);
    const history = await e.stores.open().ledger.transact(recordingId, "local-mock-mediabase", async (tx) => {
      if (!tx.loaded.ok) throw new Error(tx.loaded.code);
      const { revision: _r, updatedAt: _u, ...entry } = structuredClone(tx.loaded.entry);
      entry.approvals = [];
      return tx.write(entry);
    });
    expect(!history.ok && history.code).toBe("HISTORY_REWRITE");

    // A tampered review session is reported as an integrity exception, never submitted.
    const reviewFile = (await fs.readdir(join(e.dir, "reviews"))).find((name) => name.endsWith(".json"))!;
    const reviewPath = join(e.dir, "reviews", reviewFile);
    const reviewText = await fs.readFile(reviewPath, "utf8");
    await fs.writeFile(reviewPath, reviewText.replace("Fictional Label", "Forged Label"));
    const forged = await c.submit(recordingId, { openPage: e.pages.open });
    expect(forged.ok && forged.status).toBe("NEEDS_ATTENTION");
    expect(forged.ok && forged.exceptions.map((item) => `${item.code}:${item.kind}`)).toEqual(
      [expect.stringMatching(/^REVIEW_(INTEGRITY_CHECK_FAILED|CORRUPTED_DATA):INTEGRITY$/)]);
    expect(e.pages.opened).toBe(0);
    expect(e.server.requests()).toEqual([]);
  });

  test("the ledger keeps contact details and local paths out of stored history", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser, "json");
    const c = e.coordinator();
    const { recordingId } = await readySong(e, c);
    await c.submit(recordingId, { openPage: e.pages.open });
    const text = await fs.readFile(join(e.dir, "submissions", `${submissionLedgerKey(recordingId, "local-mock-mediabase")}.json`), "utf8");
    expect(text).not.toContain(SUBMITTER.email);
    expect(text).not.toContain(SUBMITTER.name);
    expect(text).not.toContain(e.dir);
    expect(text).not.toContain(e.dir.replace(/\\/g, "\\\\"));
  });

  test("a naming profile is enforced; a permitted deterministic rename uploads under the new name only", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser);
    const profile = createTemplateNamingProfile("fictional-isrc-names", "{isrc}{ext}");
    const strict = e.coordinator({ namingProfile: profile });
    const imported = await importSong(e, strict, SONG, SONG_TAGS, "rename-me.wav");
    await reviewDesk(e.stores.open().reviewStore, imported.recordingId, fullReview("Fictional Artist"));
    const refused = await approve(strict, imported.recordingId);
    expect(!refused.ok && refused.exceptions?.map((item) => item.code)).toContain("FILENAME_POLICY_VIOLATION");

    const permitted = e.coordinator({ namingProfile: profile, policy: { allowUploadRename: true } });
    expect((await approve(permitted, imported.recordingId)).ok).toBe(true);
    const result = await permitted.submit(imported.recordingId, { openPage: e.pages.open });
    expect(result.ok && result.status).toBe("SUBMITTED");
    expect(e.server.receipts()[0].files.map((item) => item.fileName)).toEqual(["USAAA2600010.wav"]);
    await expect(fs.stat(imported.wav)).resolves.toBeTruthy();
    const status = await permitted.status(imported.recordingId);
    expect(status.ok && status.entry.corrections.map((item) => `${item.code}:${item.resulting}`)).toContain("UPLOAD_FILENAME_APPLIED:USAAA2600010.wav");
  });
});

test.describe("MB-10 live-destination guards", () => {
  test("real Mediabase and non-loopback destinations are refused", async () => {
    for (const url of ["https://www.mediabase.com/submit", "https://mediabase.com", "http://example.test/form", "http://10.0.0.5/form", "file:///C:/form.html"]) {
      expect(() => assertLocalDestination(url)).toThrow(LiveDestinationForbiddenError);
      expect(() => localMockDestination(url)).toThrow(LiveDestinationForbiddenError);
    }
    expect(assertLocalDestination("http://127.0.0.1:4000/x").hostname).toBe("127.0.0.1");
    expect(assertLocalDestination("http://localhost:4000/x").hostname).toBe("localhost");
    const live = { id: "live", formUrl: "https://www.mediabase.com/form", lookupReceipt: async () => ({ status: "UNAVAILABLE" as const }) };
    const memory = stores("memory", "unused");
    expect(() => createSubmissionCoordinator({ ...memory.open(), destination: live, workflow: workflowOptions })).toThrow(LiveDestinationForbiddenError);
  });

  test("the page network guard blocks any non-loopback request", async ({ page }) => {
    const server = await startMockMediabaseServer();
    servers.push(server);
    const guard = await installLoopbackNetworkGuard(page);
    await page.goto(server.formUrl);
    const outcome = await page.evaluate(async () => {
      try {
        await fetch("https://www.mediabase.com/submit", { method: "POST", body: "x" });
        return "sent";
      } catch {
        return "blocked";
      }
    });
    expect(outcome).toBe("blocked");
    expect(guard.blocked.some((url) => url.includes("mediabase.com"))).toBe(true);
  });

  test("the mock form sends at most once over loopback and ignores a repeated submit", async ({ page }) => {
    const server = await startMockMediabaseServer();
    servers.push(server);
    await page.goto(server.formUrl);
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("#mediabase-form")!;
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await expect(page.locator("#submission-result")).toHaveAttribute("data-status", /responded|repeat-ignored/);
    await expect.poll(() => server.requests().length).toBe(1);
    // Required fields were empty: the mock refused it and stored nothing.
    expect(server.requests()[0].outcome).toBe("REJECTED");
    expect(server.receipts()).toEqual([]);
  });
});

test.describe("MB-10 mock endpoint", () => {
  test("receipt lookup reports unknown submissions as not found", async () => {
    const server = await startMockMediabaseServer();
    servers.push(server);
    const destination = localMockDestination(server.baseUrl);
    await expect(destination.lookupReceipt("SUB-UNKNOWN")).resolves.toEqual({ status: "NOT_FOUND" });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(destination.lookupReceipt("SUB-UNKNOWN")).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  test("non-multipart and multi-file requests are refused", async () => {
    const server = await startMockMediabaseServer();
    servers.push(server);
    const json = await fetch(server.submitUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
    const form = new FormData();
    for (const [key, value] of Object.entries({ submissionId: "SUB-X", submitterName: "Dana", email: "d@example.test", artist: "A", title: "T", officialReleaseDate: "11/15/2026" })) form.set(key, value);
    form.append("audioFile", new Blob([Buffer.from("one")]), "one.wav");
    form.append("audioFile", new Blob([Buffer.from("two")]), "two.wav");
    const two = await fetch(server.submitUrl, { method: "POST", body: form });
    expect(two.status).toBe(422);
    expect(await two.json()).toMatchObject({ stored: false, fields: ["audioFile"] });
    expect(server.receipts()).toEqual([]);
  });

  test("an artist confirmation and research decisions remain in the verified review history", async ({ browser }, testInfo) => {
    const e = await env(testInfo, browser, "json");
    const c = e.coordinator();
    const { recordingId } = await importSong(e, c);
    const { reviewStore } = e.stores.open();
    await reviewDesk(reviewStore, recordingId, [research_("label"), confirmArtist("Fictional Artist")]);
    await c.evaluate(recordingId);
    const reloaded = await e.stores.open().reviewStore.loadCombined(recordingId);
    expect(reloaded.ok && reloaded.session.state.reviewEvents.map((item) => item.kind)).toEqual(["RESEARCH", "MANUAL"]);
  });
});
