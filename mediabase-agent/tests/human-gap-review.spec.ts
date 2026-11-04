import { expect, test } from "@playwright/test";
import { createArtistAttributionDecision } from "../src/metadata/artistAttribution";
import type { DemoRecording } from "../src/metadata/recordValidation";
import { applyHumanReviewDecision } from "../src/workflow/humanReview";
import {
  applyCombinedReviewDecisions,
  applyHumanGapDecision,
  applyResearchReviewDecision,
  humanGapBasisFor,
  humanGapReviewSummary,
  humanOnlyGapQueue,
  isHumanOnlyGap,
  publicHumanGapAuditTrail,
  startHumanGapReview,
  validateHumanGapValue,
  type HumanGapDecision,
  type HumanGapReviewState
} from "../src/workflow/humanGapReview";
import { conflictingAudio, decide, gapDecide, REVIEWED_AT, setup } from "./support/reviewFixture";

/** The default MB-06 -> MB-07 fixture wrapped for MB-09. */
async function gapState(options: Parameters<typeof setup>[0] = {}) {
  const base = await setup(options);
  return { ...base, gap: startHumanGapReview(base.state) };
}

/** A recording whose Orchard artist is already filled in but not yet confirmed. */
const attributed = { prepare: (record: DemoRecording) => { record.artist = "Fictional Artist"; } };

/** Two clean candidates plus one with a conflicting embedded artist; no file selected yet. */
const ambiguousAudio = {
  extraAudio: [conflictingAudio("fictional-song-copy.wav", "Fictional Artist"), conflictingAudio()],
  prepare: (record: DemoRecording) => { delete record.audioFilePath; }
};

function accepted(result: ReturnType<typeof applyHumanGapDecision>): HumanGapReviewState {
  if (!result.ok) throw new Error(`${result.rejection.code}: ${result.rejection.message}`);
  return result.state;
}

function rejectionCode(result: ReturnType<typeof applyHumanGapDecision>): string | null {
  return result.ok ? null : result.rejection.code;
}

function artistGap(state: HumanGapReviewState) {
  const item = humanOnlyGapQueue(state).find((entry) => entry.allowedActions.includes("CONFIRM_ARTIST"));
  if (!item) throw new Error("No artist gap.");
  return item;
}

function audioGap(state: HumanGapReviewState) {
  const item = humanOnlyGapQueue(state).find((entry) => entry.gap.area === "audio");
  if (!item) throw new Error("No audio gap.");
  return item;
}

function decisionFor(
  state: HumanGapReviewState,
  gapId: string,
  action: HumanGapDecision["action"],
  extra: { note?: string; reviewId?: string } = {}
): HumanGapDecision {
  return {
    reviewId: extra.reviewId ?? `manual-${gapId.length}-${Math.random().toString(36).slice(2, 10)}`,
    recordingId: state.recordingId,
    gapId,
    action,
    reviewer: { reviewerId: "dana", displayName: "Dana (fictional reviewer)" },
    reviewedAt: REVIEWED_AT,
    basis: humanGapBasisFor(state, gapId),
    ...(extra.note !== undefined ? { note: extra.note } : {})
  };
}

test.describe("MB-09 human-only gap isolation", () => {
  test("queues only human-only metadata gaps, never research-eligible gaps or the approval gate", async () => {
    const { gap } = await gapState();
    const report = gap.research.gapReport.gaps;
    const queue = humanOnlyGapQueue(gap);

    expect(queue.length).toBeGreaterThan(0);
    for (const item of queue) {
      expect(item.gap.resolvedBy).toBe("human");
      expect(item.gap.researchEligible).toBe(false);
      expect(item.gap.area).not.toBe("approval");
      expect(item.status).toBe("OPEN");
      expect(item.lastReview).toBeNull();
    }
    expect(queue.map((item) => item.gap.gapId).sort()).toEqual(report.filter(isHumanOnlyGap).map((g) => g.gapId).sort());
    expect(report.some((g) => g.researchEligible)).toBe(true);
    expect(queue.some((item) => item.gap.researchEligible)).toBe(false);
    expect(report.some((g) => g.code === "approval-pending")).toBe(true);
    expect(queue.some((item) => item.gap.code === "approval-pending")).toBe(false);
    expect(queue.map((item) => item.gap.code)).toEqual(expect.arrayContaining([
      "artist-unconfirmed", "missing-required-field", "declaration-unanswered"
    ]));
  });

  test("refuses to resolve research-eligible gaps and the approval gate", async () => {
    const { gap } = await gapState();
    const researchGap = gap.research.gapReport.gaps.find((g) => g.researchEligible && g.fields.includes("label"));
    const approvalGap = gap.research.gapReport.gaps.find((g) => g.code === "approval-pending");
    if (!researchGap || !approvalGap) throw new Error("Fixture gaps missing.");

    const basis = { identityFingerprint: gap.research.identityFingerprint, gapDigest: "GAP-000000000000000000000000" };
    const decision = (gapId: string, action: HumanGapDecision["action"]): HumanGapDecision =>
      ({ ...decisionFor(gap, humanOnlyGapQueue(gap)[0].gap.gapId, action), gapId, basis });
    const research = applyHumanGapDecision(gap, decision(researchGap.gapId,
      { action: "SET_FIELD", field: "submitterName", value: "Nope" }));
    expect(research.ok ? null : research.rejection).toMatchObject({ code: "ACTION_NOT_ALLOWED", message: /MB-07/ });
    const approval = applyHumanGapDecision(gap, decision(approvalGap.gapId, { action: "DEFER" }));
    expect(approval.ok ? null : approval.rejection).toMatchObject({ code: "ACTION_NOT_ALLOWED", message: /Approval/ });
    expect(() => humanGapBasisFor(gap, approvalGap.gapId)).toThrow();
  });

  test("offers only the actions that fit each gap", async () => {
    const { gap } = await gapState();
    const byCode = (code: string) => humanOnlyGapQueue(gap).find((item) => item.gap.code === code);
    expect(byCode("artist-unconfirmed")?.allowedActions).toEqual(["CONFIRM_ARTIST", "DEFER"]);
    expect(byCode("missing-required-field")?.allowedActions).toEqual(["SET_FIELD", "DEFER"]);
    expect(byCode("declaration-unanswered")?.allowedActions).toEqual(["SET_FIELD", "ACKNOWLEDGE", "DEFER"]);
    expect(artistGap(gap).artistCandidates).toEqual(["Fictional Artist"]);

    const blocking = gapDecide(gap, "missing-required-field", { action: "ACKNOWLEDGE" }, { field: "email", note: "Seen." });
    expect(rejectionCode(applyHumanGapDecision(gap, blocking))).toBe("ACTION_NOT_ALLOWED");
    const wrongAction = gapDecide(gap, "artist-unconfirmed", { action: "SET_FIELD", field: "submitterName", value: "X" });
    expect(rejectionCode(applyHumanGapDecision(gap, wrongAction))).toBe("ACTION_NOT_ALLOWED");
    const wrongField = gapDecide(gap, "missing-required-field",
      { action: "SET_FIELD", field: "submitterName", value: "Fictional Submitter" }, { field: "email" });
    expect(rejectionCode(applyHumanGapDecision(gap, wrongField))).toBe("ACTION_NOT_ALLOWED");
  });
});

test.describe("MB-09 artist confirmation", () => {
  test("never infers the Exact Artist and records the explicit human selection", async () => {
    const { gap } = await gapState();
    expect(gap.research.recording.artist).toBe("");
    expect(gap.research.recording.artistAttribution?.confirmed).toBe(false);

    const next = accepted(applyHumanGapDecision(gap, gapDecide(gap, "artist-unconfirmed", {
      action: "CONFIRM_ARTIST",
      exactArtist: "Fictional Artist",
      primaryArtist: "Fictional Artist",
      secondaryArtist: "Fictional Guest",
      tertiaryArtist: "Fictional Third"
    })));
    const attribution = next.research.recording.artistAttribution;
    expect(next.research.recording.artist).toBe("Fictional Artist");
    expect(attribution).toMatchObject({
      confirmed: true,
      confirmedExactArtist: "Fictional Artist",
      primaryArtist: "Fictional Artist",
      secondaryArtist: "Fictional Guest",
      tertiaryArtist: "Fictional Third",
      confirmedSource: { trackArtist: "Fictional Artist", productArtist: "Fictional Artist" }
    });
    expect(humanOnlyGapQueue(next).some((item) => item.allowedActions.includes("CONFIRM_ARTIST"))).toBe(false);
    // The independent featured-artist gap is untouched: a featured artist is never inferred.
    expect(humanOnlyGapQueue(next).some((item) => item.gap.code === "featured-artist-unavailable")).toBe(true);
    expect(next.manualAuditTrail[0]).toMatchObject({ action: "CONFIRM_ARTIST", outcome: "ARTIST_CONFIRMED" });
  });

  test("requires roles in order, distinct names, and a non-empty Exact Artist", async () => {
    const { gap } = await gapState();
    const attempt = (action: Record<string, unknown>) => rejectionCode(applyHumanGapDecision(gap,
      gapDecide(gap, "artist-unconfirmed", { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist", ...action } as never)));
    expect(attempt({ secondaryArtist: "Fictional Guest" })).toBe("INVALID_VALUE");
    expect(attempt({ primaryArtist: "Fictional Artist", tertiaryArtist: "Fictional Third" })).toBe("INVALID_VALUE");
    expect(attempt({ primaryArtist: "Fictional Artist", secondaryArtist: "Fictional Artist" })).toBe("INVALID_VALUE");
    expect(attempt({ exactArtist: "   " })).toBe("INVALID_VALUE");
  });

  test("conflicting Orchard artists require an explicit choice and a note", async () => {
    const { gap } = await gapState({
      prepare: (record) => {
        record.artistAttribution = createArtistAttributionDecision("Fictional Artist", "Fictional Band");
      }
    });
    const item = artistGap(gap);
    expect(item.artistCandidates).toEqual(["Fictional Artist", "Fictional Band"]);
    expect(gap.research.recording.artist).toBe("");

    const choose = (note?: string) => decisionFor(gap, item.gap.gapId,
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Band", primaryArtist: "Fictional Band" },
      note === undefined ? {} : { note });
    expect(rejectionCode(applyHumanGapDecision(gap, choose()))).toBe("NOTE_REQUIRED");
    expect(rejectionCode(applyHumanGapDecision(gap, choose("   ")))).toBe("NOTE_REQUIRED");
    const next = accepted(applyHumanGapDecision(gap, choose("Label sheet credits the band as the release entity.")));
    expect(next.research.recording.artist).toBe("Fictional Band");
    expect(next.manualAuditTrail[0].note).toBe("Label sheet credits the band as the release entity.");
  });

  test("an Exact Artist outside the Orchard values needs a note, and missing provenance is never fabricated", async () => {
    const { gap } = await gapState();
    const outside = gapDecide(gap, "artist-unconfirmed", { action: "CONFIRM_ARTIST", exactArtist: "Somebody New" });
    expect(rejectionCode(applyHumanGapDecision(gap, outside))).toBe("NOTE_REQUIRED");

    const missing = await gapState({ prepare: (record) => { delete record.artistAttribution; } });
    const item = humanOnlyGapQueue(missing.gap).find((entry) => entry.allowedActions.includes("CONFIRM_ARTIST"));
    if (!item) throw new Error("Expected an artist gap that still needs Orchard provenance.");
    const result = applyHumanGapDecision(missing.gap, decisionFor(missing.gap, item.gap.gapId,
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist" }, { note: "Trying anyway." }));
    expect(rejectionCode(result)).toBe("PROVENANCE_REQUIRED");
    expect(missing.gap.research.recording.artistAttribution).toBeUndefined();
  });
});

test.describe("MB-09 audio confirmation", () => {
  test("offers evaluated candidates by opaque id, never by local path", async () => {
    const { gap } = await gapState(ambiguousAudio);
    const item = audioGap(gap);
    expect(item.gap.code).toBe("audio-ambiguous");
    expect(item.allowedActions).toEqual(["CONFIRM_AUDIO", "DEFER"]);
    expect(item.audioCandidates).toHaveLength(3);
    for (const candidate of item.audioCandidates) {
      expect(candidate.audioFileId).toMatch(/^AUDIO-[0-9A-F]{12}$/);
      expect(JSON.stringify(candidate)).not.toContain("fictional-audio");
    }
    expect(gap.research.recording.audioFilePath).toBeUndefined();
  });

  test("conflicting audio needs an acknowledgment flag and a note", async () => {
    const { gap } = await gapState(ambiguousAudio);
    const item = audioGap(gap);
    const conflicted = item.audioCandidates.find((candidate) => candidate.conflicts.length > 0);
    if (!conflicted) throw new Error("No conflicting candidate.");
    const pick = (acknowledgeConflicts: boolean | undefined, note?: string) => decisionFor(gap, item.gap.gapId, {
      action: "CONFIRM_AUDIO",
      audioFileId: conflicted.audioFileId,
      ...(acknowledgeConflicts === undefined ? {} : { acknowledgeConflicts })
    }, note === undefined ? {} : { note });

    expect(rejectionCode(applyHumanGapDecision(gap, pick(undefined, "note")))).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect(rejectionCode(applyHumanGapDecision(gap, pick(false, "note")))).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect(rejectionCode(applyHumanGapDecision(gap, pick(true)))).toBe("NOTE_REQUIRED");
    const next = accepted(applyHumanGapDecision(gap, pick(true, "Alternate master approved by the label.")));
    const match = next.research.recording.audioMatch;
    expect(match).toMatchObject({ humanConfirmed: true, status: "CONFIRMED" });
    expect(match?.acknowledgedConflicts).toEqual(conflicted.conflicts);
    expect(next.research.recording.audioFilePath).toContain("fictional-song-alt.wav");
    const entry = publicHumanGapAuditTrail(next)[0];
    expect(entry.outcome).toBe("AUDIO_CONFIRMED");
    expect(JSON.stringify(entry)).not.toContain("fictional-audio");
    expect(next.manualAuditTrail[0].replay).toEqual({
      action: "CONFIRM_AUDIO", audioFileId: conflicted.audioFileId, acknowledgeConflicts: true
    });
  });

  test("a clean candidate or explicit no-audio confirmation is accepted; unknown files are not", async () => {
    const { gap } = await gapState(ambiguousAudio);
    const item = audioGap(gap);
    const clean = item.audioCandidates.find((candidate) => candidate.conflicts.length === 0);
    if (!clean) throw new Error("No clean candidate.");

    const chosen = accepted(applyHumanGapDecision(gap, decisionFor(gap, item.gap.gapId,
      { action: "CONFIRM_AUDIO", audioFileId: clean.audioFileId })));
    expect(chosen.research.recording.audioMatch?.humanConfirmed).toBe(true);
    expect(chosen.manualAuditTrail[0].replay).toEqual({ action: "CONFIRM_AUDIO", audioFileId: clean.audioFileId });

    const none = accepted(applyHumanGapDecision(gap, decisionFor(gap, item.gap.gapId,
      { action: "CONFIRM_AUDIO", audioFileId: null })));
    expect(none.research.recording.audioMatch).toMatchObject({ status: "NO_AUDIO_CONFIRMED", filePath: null });
    expect(none.manualAuditTrail[0].outcome).toBe("NO_AUDIO_CONFIRMED");

    const unknown = applyHumanGapDecision(gap, decisionFor(gap, item.gap.gapId,
      { action: "CONFIRM_AUDIO", audioFileId: "AUDIO-000000000000" }));
    expect(rejectionCode(unknown)).toBe("INVALID_VALUE");
  });
});

test.describe("MB-09 declarations and field values", () => {
  test("declarations are never inferred and accept only an explicit yes or no", async () => {
    const { gap } = await gapState();
    const declarations = humanOnlyGapQueue(gap).filter((item) => item.gap.code === "declaration-unanswered");
    expect(declarations).toHaveLength(4);
    for (const item of declarations) {
      expect(["yes", "no"]).not.toContain(gap.research.recording[item.settableFields[0] as "canadianContentDeclaration"]);
    }
    for (const value of ["Yes", "YES", "true", "y", "", " yes", "unanswered"]) {
      expect(validateHumanGapValue("canadianContentDeclaration", value)).not.toBeNull();
    }
    expect(validateHumanGapValue("canadianContentDeclaration", "yes")).toBeNull();
    expect(validateHumanGapValue("canadianContentDeclaration", "no")).toBeNull();

    const field = "generativeAiAudioDeclaration";
    const bad = gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "Yes" }, { field });
    expect(rejectionCode(applyHumanGapDecision(gap, bad))).toBe("INVALID_VALUE");
    const next = accepted(applyHumanGapDecision(gap,
      gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "no" }, { field })));
    expect(next.research.recording[field]).toBe("no");
    expect(next.research.recording.canadianContentDeclaration).toBe(gap.research.recording.canadianContentDeclaration);
    expect(humanOnlyGapQueue(next).filter((item) => item.gap.code === "declaration-unanswered")).toHaveLength(3);
  });

  test("acknowledging a warning needs a note and leaves the warning and value in place", async () => {
    const { gap } = await gapState();
    const field = "christmasHanukkahDeclaration";
    const silent = gapDecide(gap, "declaration-unanswered", { action: "ACKNOWLEDGE" }, { field });
    expect(rejectionCode(applyHumanGapDecision(gap, silent))).toBe("NOTE_REQUIRED");
    const next = accepted(applyHumanGapDecision(gap,
      gapDecide(gap, "declaration-unanswered", { action: "ACKNOWLEDGE" }, { field, note: "Label will answer later." })));
    expect(next.research.recording).toEqual(gap.research.recording);
    expect(next.research.gapReport).toEqual(gap.research.gapReport);
    const item = humanOnlyGapQueue(next).find((entry) => entry.gap.fields.includes(field));
    expect(item?.status).toBe("ACKNOWLEDGED");
    expect(item?.lastReview).toMatchObject({ action: "ACKNOWLEDGE" });
    const again = gapDecide(next, "declaration-unanswered", { action: "ACKNOWLEDGE" }, { field, note: "Again." });
    expect(rejectionCode(applyHumanGapDecision(next, again))).toBe("ALREADY_DECIDED");
    // The human can still answer it afterwards.
    accepted(applyHumanGapDecision(next,
      gapDecide(next, "declaration-unanswered", { action: "SET_FIELD", field, value: "yes" }, { field })));
  });

  test("rejects invalid contact, text, and date values", async () => {
    const { gap } = await gapState();
    const setEmail = (value: string) => applyHumanGapDecision(gap,
      gapDecide(gap, "missing-required-field", { action: "SET_FIELD", field: "email", value }, { field: "email" }));
    const setName = (value: string) => applyHumanGapDecision(gap,
      gapDecide(gap, "missing-required-field", { action: "SET_FIELD", field: "submitterName", value }, { field: "submitterName" }));
    for (const value of ["", "not-an-email", "a@b", " fictional@example.test", "a b@example.test"]) {
      expect(rejectionCode(setEmail(value))).toBe("INVALID_VALUE");
    }
    for (const value of ["", "  padded ", "line\nbreak", "contact me at fictional@example.test", "C:\\Users\\x\\file.wav",
      "x".repeat(501)]) {
      expect(rejectionCode(setName(value))).toBe("INVALID_VALUE");
    }
    expect(validateHumanGapValue("officialReleaseDate", "02/30/2026")).not.toBeNull();
    expect(validateHumanGapValue("officialReleaseDate", "2026-11-15")).not.toBeNull();
    expect(validateHumanGapValue("officialReleaseDate", "11/15/2026")).toBeNull();
    expect(rejectionCode(setEmail("submitter@example.test"))).toBeNull();
    expect(rejectionCode(setName("Fictional Submitter"))).toBeNull();
  });
});

test.describe("MB-09 stale, duplicate, and rejected decisions", () => {
  test("rejects duplicate review ids across manual and research decisions", async () => {
    const { gap } = await gapState();
    const first = gapDecide(gap, "missing-required-field",
      { action: "SET_FIELD", field: "submitterName", value: "Fictional Submitter" }, { field: "submitterName", reviewId: "dup-1" });
    const next = accepted(applyHumanGapDecision(gap, first));
    const replay = gapDecide(next, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email", reviewId: "dup-1" });
    expect(rejectionCode(applyHumanGapDecision(next, replay))).toBe("DUPLICATE_REVIEW");

    const research = applyResearchReviewDecision(next,
      decide(next.research, "label", "APPROVE_SUGGESTED_VALUE", { reviewId: "dup-1" }));
    expect(research.ok ? null : research.rejection.code).toBe("DUPLICATE_REVIEW");
    const researched = applyResearchReviewDecision(next,
      decide(next.research, "label", "APPROVE_SUGGESTED_VALUE", { reviewId: "research-1" }));
    if (!researched.ok) throw new Error(researched.rejection.message);
    const manualReuse = gapDecide(researched.state, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email", reviewId: "research-1" });
    expect(rejectionCode(applyHumanGapDecision(researched.state, manualReuse))).toBe("DUPLICATE_REVIEW");
  });

  test("rejects stale, mismatched, and repeated decisions", async () => {
    const { gap } = await gapState();
    const field = "canadianContentDeclaration";
    const prepared = gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "yes" }, { field });
    const deferred = accepted(applyHumanGapDecision(gap,
      gapDecide(gap, "declaration-unanswered", { action: "DEFER" }, { field, note: "Asking the label." })));
    expect(humanOnlyGapQueue(deferred).find((item) => item.gap.fields.includes(field))?.status).toBe("DEFERRED");
    const deferAgain = gapDecide(deferred, "declaration-unanswered", { action: "DEFER" }, { field });
    expect(rejectionCode(applyHumanGapDecision(deferred, deferAgain))).toBe("ALREADY_DECIDED");

    const answered = accepted(applyHumanGapDecision(deferred, { ...prepared, basis: humanGapBasisFor(deferred, prepared.gapId) }));
    // The gap is resolved now; the same decision prepared earlier no longer applies.
    expect(rejectionCode(applyHumanGapDecision(answered, { ...prepared, reviewId: "late-copy" }))).toBe("STALE_DECISION");

    const forgedBasis = { ...gapDecide(gap, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email" }) };
    expect(rejectionCode(applyHumanGapDecision(gap, { ...forgedBasis, basis: { ...forgedBasis.basis, gapDigest: "GAP-000" } })))
      .toBe("STALE_DECISION");
    expect(rejectionCode(applyHumanGapDecision(gap,
      { ...forgedBasis, basis: { ...forgedBasis.basis, identityFingerprint: "nope" } }))).toBe("STALE_DECISION");
    expect(rejectionCode(applyHumanGapDecision(gap, { ...forgedBasis, recordingId: "another-recording" })))
      .toBe("MISMATCHED_DECISION");
    expect(rejectionCode(applyHumanGapDecision(gap, { ...forgedBasis, gapId: "another-recording:x:email" })))
      .toBe("MISMATCHED_DECISION");
    expect(rejectionCode(applyHumanGapDecision(gap, { ...forgedBasis, reviewedAt: "yesterday" }))).toBe("INVALID_DECISION");
    expect(rejectionCode(applyHumanGapDecision(gap, { ...forgedBasis, action: { action: "APPROVE" } as never })))
      .toBe("INVALID_DECISION");
  });

  test("a manual identity change makes older research decisions stale", async () => {
    const { gap } = await gapState({
      prepare: (record) => {
        record.artistAttribution = createArtistAttributionDecision("Fictional Artist", "Fictional Band");
      }
    });
    const research = decide(gap.research, "label", "APPROVE_SUGGESTED_VALUE");
    const item = artistGap(gap);
    const next = accepted(applyHumanGapDecision(gap, decisionFor(gap, item.gap.gapId,
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Band" }, { note: "Release credits the band." })));
    expect(next.research.identityFingerprint).not.toBe(gap.research.identityFingerprint);
    const result = applyResearchReviewDecision(next, research);
    expect(result.ok ? null : result.rejection.code).toBe("STALE_DECISION");
    expect(result.state).toBe(next);
  });

  test("a rejected action returns the identical state", async () => {
    const { gap } = await gapState();
    const before = JSON.stringify(gap);
    const bad = gapDecide(gap, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "nope" }, { field: "email" });
    const result = applyHumanGapDecision(gap, bad);
    expect(result.ok).toBe(false);
    expect(result.state).toBe(gap);
    expect(JSON.stringify(result.state)).toBe(before);
    expect(gap.manualAuditTrail).toEqual([]);
    expect(gap.reviewEvents.every((event) => event.kind === "RESEARCH")).toBe(true);
  });
});

test.describe("MB-09 immutability and audit", () => {
  for (const [raw, redacted] of [["a@b", "[redacted email]"], ["/a", "[redacted local path]"]]) {
    test(`rejects notes that exceed the limit after redacting ${raw}`, async () => {
      const { gap } = await gapState();
      const before = JSON.stringify(gap);
      const note = `${"x".repeat(2000 - redacted.length)} ${raw}`;
      expect(note.length).toBeLessThan(2000);
      const result = applyHumanGapDecision(gap, gapDecide(gap, "missing-required-field",
        { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email", note }));
      expect(rejectionCode(result)).toBe("INVALID_DECISION");
      expect(result.state).toBe(gap);
      expect(JSON.stringify(gap)).toBe(before);
    });
  }

  test("accepted actions return new frozen state and leave the input and original snapshot untouched", async () => {
    const { gap, workflow } = await gapState();
    const before = JSON.stringify(gap);
    const next = accepted(applyHumanGapDecision(gap, gapDecide(gap, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" },
      { field: "email", note: "Email submitter@example.test confirmed by phone." })));

    expect(JSON.stringify(gap)).toBe(before);
    expect(next).not.toBe(gap);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.research.recording)).toBe(true);
    expect(Object.isFrozen(next.manualAuditTrail[0])).toBe(true);
    expect(next.research.originalRecording).toEqual(workflow.recording);
    expect(next.research.recording.email).toBe("submitter@example.test");
    expect(() => { (next.research.recording as { email?: string }).email = "x"; }).toThrow();

    const [entry] = publicHumanGapAuditTrail(next);
    expect(entry).toMatchObject({
      sequence: 1,
      reviewer: { reviewerId: "dana", displayName: "Dana (fictional reviewer)" },
      reviewedAt: REVIEWED_AT,
      action: "SET_FIELD",
      outcome: "VALUE_APPLIED",
      recordingId: gap.recordingId,
      gapCode: "missing-required-field",
      changedFields: ["email"],
      previousValues: { email: null },
      resultingValues: { email: "[redacted contact information]" },
      previousApprovalStatus: "DRAFT",
      resultingApprovalStatus: "DRAFT"
    });
    expect(entry).not.toHaveProperty("replay");
    expect(JSON.stringify(publicHumanGapAuditTrail(next))).not.toContain("submitter@example.test");
    expect(next.manualAuditTrail[0].note).not.toContain("submitter@example.test");
    expect(next.reviewEvents.at(-1)).toMatchObject({ kind: "MANUAL", auditSequence: 1 });
  });

  test("audit entries carry the evidence of the resolved gap", async () => {
    const { gap } = await gapState();
    const field = "independentLabelDeclaration";
    const item = humanOnlyGapQueue(gap).find((entry) => entry.gap.fields.includes(field));
    const next = accepted(applyHumanGapDecision(gap,
      gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "yes" }, { field })));
    expect(next.manualAuditTrail[0].evidence).toEqual(item?.gap.evidence);
    expect(next.manualAuditTrail[0].gapDigest).toBe(humanGapBasisFor(gap, item!.gap.gapId).gapDigest);
  });
});

test.describe("MB-09 combined MB-07 and MB-09 review", () => {
  test("interleaves research and manual decisions in their original order", async () => {
    const { gap } = await gapState(attributed);
    let state = gap;
    const label = applyResearchReviewDecision(state, decide(state.research, "label", "APPROVE_SUGGESTED_VALUE"));
    if (!label.ok) throw new Error(label.rejection.message);
    state = label.state;
    state = accepted(applyHumanGapDecision(state, gapDecide(state, "artist-unconfirmed",
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist", primaryArtist: "Fictional Artist" })));
    // Confirming the artist already on the record leaves its identity unchanged, so research stays current.
    expect(state.research.identityFingerprint).toBe(gap.research.identityFingerprint);
    const upc = applyResearchReviewDecision(state, decide(state.research, "albumUPC", "REJECT_SUGGESTION",
      { note: "Distributor UPC differs." }));
    if (!upc.ok) throw new Error(upc.rejection.message);
    state = upc.state;
    const field = "canadianContentDeclaration";
    state = accepted(applyHumanGapDecision(state,
      gapDecide(state, "declaration-unanswered", { action: "SET_FIELD", field, value: "yes" }, { field })));

    expect(state.reviewEvents.map((event) => `${event.sequence}:${event.kind}:${event.auditSequence}`))
      .toEqual(["1:RESEARCH:1", "2:MANUAL:1", "3:RESEARCH:2", "4:MANUAL:2"]);
    expect(state.research.recording).toMatchObject({
      label: "Fictional Label", artist: "Fictional Artist", canadianContentDeclaration: "yes", approvalStatus: "DRAFT"
    });
    expect(state.research.recording.albumUPC).toBe(gap.research.recording.albumUPC);
    const summary = humanGapReviewSummary(state);
    expect(summary.events).toEqual({ research: 2, manual: 2 });
    expect(summary.recordingApprovalRequired).toBe(true);
    expect(summary.outstanding.some((item) => item.code === "artist-unconfirmed")).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("fictional-audio");
  });

  test("a combined batch applies in order and reports rejections without stopping", async () => {
    const { gap } = await gapState(attributed);
    const field = "canadianContentDeclaration";
    const batch = applyCombinedReviewDecisions(gap, [
      { kind: "RESEARCH", decision: decide(gap.research, "label", "APPROVE_SUGGESTED_VALUE") },
      { kind: "MANUAL", decision: gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "maybe" }, { field }) },
      { kind: "MANUAL", decision: gapDecide(gap, "declaration-unanswered", { action: "SET_FIELD", field, value: "no" }, { field }) }
    ]);
    expect(batch.applied.map((item) => `${item.kind}:${item.eventSequence}`)).toEqual(["RESEARCH:1", "MANUAL:2"]);
    expect(batch.rejected).toHaveLength(1);
    expect(batch.rejected[0]).toMatchObject({ kind: "MANUAL", rejection: { code: "INVALID_VALUE" } });
    expect(batch.state.research.recording[field]).toBe("no");
  });

  test("existing MB-07 history becomes the first research events", async () => {
    const base = await setup(attributed);
    const label = decide(base.state, "label", "APPROVE_SUGGESTED_VALUE");
    const reviewed = applyHumanReviewDecision(base.state, label);
    if (!reviewed.ok) throw new Error(reviewed.rejection.message);
    const gap = startHumanGapReview(reviewed.state);
    expect(gap.research).toEqual(reviewed.state);
    expect(gap.reviewEvents).toEqual([{ sequence: 1, kind: "RESEARCH", reviewId: label.reviewId, auditSequence: 1 }]);
    expect(gap.manualAuditTrail).toEqual([]);
  });
});

test.describe("MB-09 approval boundary", () => {
  test("no manual action approves a recording", async () => {
    const { gap } = await gapState(attributed);
    let state = gap;
    state = accepted(applyHumanGapDecision(state, gapDecide(state, "artist-unconfirmed",
      { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist" })));
    state = accepted(applyHumanGapDecision(state, gapDecide(state, "missing-required-field",
      { action: "SET_FIELD", field: "email", value: "submitter@example.test" }, { field: "email" })));
    state = accepted(applyHumanGapDecision(state, gapDecide(state, "missing-required-field",
      { action: "SET_FIELD", field: "submitterName", value: "Fictional Submitter" }, { field: "submitterName" })));
    for (const field of ["canadianContentDeclaration", "christmasHanukkahDeclaration", "generativeAiAudioDeclaration",
      "independentLabelDeclaration"] as const) {
      state = accepted(applyHumanGapDecision(state,
        gapDecide(state, "declaration-unanswered", { action: "SET_FIELD", field, value: "no" }, { field })));
    }
    expect(state.research.recording.approvalStatus).toBe("DRAFT");
    expect(state.research.recordingApprovalRequired).toBe(true);
    expect(state.manualAuditTrail.every((entry) => entry.resultingApprovalStatus === "DRAFT")).toBe(true);
    expect(state.research.gapReport.gaps.some((g) => g.code === "approval-pending")).toBe(true);
  });

  test("a change to an approved recording invalidates its approval; a deferral does not", async () => {
    const { gap } = await gapState({ current: (record) => { record.approvalStatus = "APPROVED"; } });
    expect(gap.research.recording.approvalStatus).toBe("APPROVED");
    const field = "independentLabelDeclaration";
    const deferred = accepted(applyHumanGapDecision(gap,
      gapDecide(gap, "declaration-unanswered", { action: "DEFER" }, { field })));
    expect(deferred.research.recording.approvalStatus).toBe("APPROVED");

    const changed = accepted(applyHumanGapDecision(deferred,
      gapDecide(deferred, "declaration-unanswered", { action: "SET_FIELD", field, value: "yes" }, { field })));
    expect(changed.research.recording.approvalStatus).toBe("NEEDS_REVIEW");
    expect(changed.research.recordingApprovalRequired).toBe(true);
    expect(changed.manualAuditTrail.at(-1)).toMatchObject({
      previousApprovalStatus: "APPROVED", resultingApprovalStatus: "NEEDS_REVIEW"
    });
  });
});
