import { join } from "node:path";
import { createInMemoryReviewStorage, createJsonFileReviewStorage, type ReviewStorageBackend } from "../../src/storage/reviewStorageBackend";
import { createSubmissionLedger, type SubmissionLedger } from "../../src/submission/submissionLedger";
import type { ResearchField } from "../../src/metadata/metadataResearch";
import { DECLARATION_FIELDS, humanOnlyGapQueue, type HumanGapAction, type HumanGapReviewState } from "../../src/workflow/humanGapReview";
import {
  applyCombinedReviewDecisionsWithRefusalLog,
  createReviewSessionStore,
  type ReviewSessionStore,
  type StoredCombinedReviewSession
} from "../../src/workflow/reviewSessionStore";
import type { RecordingWorkflowOptions } from "../../src/workflow/recordingWorkflow";
import { buildWav, writeFixture, type FixtureTags } from "./audioFixtures";
import { MB_RECORDING_ID, MB_RELEASE_ID, decide, gapDecide, musicBrainz, research, verifier } from "./reviewFixture";

/** Fictional MB-10 inputs: Orchard rows, real WAV files on disk, and offline stores. Nothing here is real data. */

export const MB10_KEY = "fictional-mb10-offline-key-not-a-secret";
export const SUBMITTER = { name: "Dana Fictional", email: "dana@example.test" };

export type OrchardRow = { track: string; artist: string; product?: string; isrc?: string };

export function orchardCsv(rows: readonly OrchardRow[]): string {
  const header = "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,ISRC";
  return [header, ...rows.map((row) => [row.track, row.artist, row.artist, row.product ?? "Fictional Album", "Album", row.isrc ?? ""].join(","))].join("\n");
}

export function writeWav(directory: string, fileName: string, tags: FixtureTags): string {
  return writeFixture(join(directory, fileName), buildWav({
    riffInfo: { artist: tags.artist, title: tags.title, album: tags.album },
    id3: tags
  }));
}

export const workflowOptions: RecordingWorkflowOptions = {
  research: { mode: "mock", provider: research, verifier },
  musicBrainz: { provider: musicBrainz, selection: { musicBrainzRecordingId: MB_RECORDING_ID, musicBrainzReleaseId: MB_RELEASE_ID } }
};

export type Stores = {
  reviewBackend: ReviewStorageBackend;
  ledgerBackend: ReviewStorageBackend;
  open(): { reviewStore: ReviewSessionStore; ledger: SubmissionLedger };
};

/** Review sessions and the submission ledger live in separate backends (or folders). */
export function stores(kind: "memory" | "json", directory: string): Stores {
  const reviewBackend = kind === "memory" ? createInMemoryReviewStorage() : createJsonFileReviewStorage(join(directory, "reviews"));
  const ledgerBackend = kind === "memory" ? createInMemoryReviewStorage() : createJsonFileReviewStorage(join(directory, "submissions"));
  return {
    reviewBackend,
    ledgerBackend,
    // Each call is a fresh "process" over the same storage.
    open: () => ({
      reviewStore: createReviewSessionStore(reviewBackend, { integrityKey: MB10_KEY }),
      ledger: createSubmissionLedger(ledgerBackend, { integrityKey: MB10_KEY })
    })
  };
}

type CombinedReviewItem = Parameters<typeof applyCombinedReviewDecisionsWithRefusalLog>[1][number];

export type DeskStep = (state: HumanGapReviewState) => CombinedReviewItem;

/**
 * A reviewer's desk: loads the saved session, applies each decision against the
 * current state (so every basis is fresh), and saves through MB-08.
 */
export async function reviewDesk(store: ReviewSessionStore, recordingId: string, steps: readonly DeskStep[]) {
  const loaded = await store.loadCombined(recordingId);
  if (!loaded.ok) throw new Error(`load failed: ${loaded.code} ${loaded.message}`);
  let progress = { state: loaded.session.state, refusedDecisions: loaded.session.refusedDecisions };
  const rejected: string[] = [];
  for (const step of steps) {
    const batch = applyCombinedReviewDecisionsWithRefusalLog(progress, [step(progress.state)]);
    rejected.push(...batch.rejected.map((item) => item.rejection.code));
    progress = { state: batch.state, refusedDecisions: batch.refusedDecisions };
  }
  const saved = await store.saveCombined(progress.state, {
    expectedRevision: loaded.session.revision, sessionId: "mb10-review-desk", refusedDecisions: progress.refusedDecisions
  });
  if (!saved.ok) throw new Error(`save failed: ${saved.code} ${saved.message}`);
  return { session: saved.session as StoredCombinedReviewSession, rejected };
}

let deskCounter = 0;
const id = (prefix: string) => `${prefix}-${++deskCounter}`;

export const research_ = (field: ResearchField, action: "APPROVE_SUGGESTED_VALUE" | "REJECT_SUGGESTION" = "APPROVE_SUGGESTED_VALUE"): DeskStep =>
  (state) => ({ kind: "RESEARCH", decision: decide(state.research, field, action, { note: "Checked against the catalog.", reviewId: id("mb10-research") }) });

export const manual = (code: string, action: HumanGapAction, extra: { field?: string; note?: string } = {}): DeskStep =>
  (state) => ({ kind: "MANUAL", decision: gapDecide(state, code, action, { note: "Confirmed with the label.", ...extra, reviewId: id("mb10-manual") }) });

export const confirmArtist = (artist: string): DeskStep =>
  manual("artist-unconfirmed", { action: "CONFIRM_ARTIST", exactArtist: artist, primaryArtist: artist });

export const setField = (field: string, value: string): DeskStep => {
  const code = (DECLARATION_FIELDS as readonly string[]).includes(field) ? "declaration-unanswered" : "missing-required-field";
  return manual(code, { action: "SET_FIELD", field, value } as HumanGapAction, { field });
};

/** Decisions a reviewer makes for a clean recording; declarations default to "no". */
export function fullReview(artist: string, declarations: Partial<Record<(typeof DECLARATION_FIELDS)[number], string>> = {}): DeskStep[] {
  return [
    research_("officialReleaseDate"),
    research_("label"),
    confirmArtist(artist),
    setField("submitterName", SUBMITTER.name),
    setField("email", SUBMITTER.email),
    ...DECLARATION_FIELDS.map((field) => setField(field, declarations[field] ?? "no"))
  ];
}

export function openGapCodes(state: HumanGapReviewState): string[] {
  return humanOnlyGapQueue(state).filter((item) => item.status !== "ACKNOWLEDGED").map((item) => item.gap.code);
}
