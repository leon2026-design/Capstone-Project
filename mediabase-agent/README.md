# Mediabase mock form

This prototype uses fictional metadata and a local HTML form only. The
Playwright automation prepares and verifies the form but never submits it or
connects to Mediabase.

## Field mapping

The mock labels follow the rendered New Music Notification form at
`https://www2.mediabase.com/mbapp/NewMusicNotification`:

| Mock field | Record property | Notes |
| --- | --- | --- |
| Name | `submitterName` | Required |
| Company | `company` | Optional |
| Remember Me | `rememberInformation` | No/Yes radio group |
| Phone # | `phone` | Optional |
| Email | `email` | Required |
| Exact Artist | `artist` | Required; must equal any confirmed `artistAttribution.confirmedExactArtist` |
| Featured Artist | `featuredArtist` | Optional; managed through Vydia and never derived from Orchard artist columns |
| Label Listing | `label` | Optional |
| Exact Title | `title` | Required |
| Version/Mix | `version` | Optional |
| Official Release Date (mm/dd/yyyy) | `officialReleaseDate` | Required; validated as `mm/dd/yyyy` |
| Track ISRC | `isrc` | Optional |
| Album Title (if applicable) | `albumTitle` | Optional |
| Album UPC | `albumUPC` | Optional |
| Album Release Date (mm/dd/yyyy) | `albumReleaseDate` | Optional |
| Declaration questions | `*Declaration` properties | `yes`, `no`, or `null` for unanswered |
| Artist website URL | `artistWebsite` | Optional |
| Additional comments about this song? | `comments` | Optional |
| Hide Until | `hideUntil` | Text for date/time and time zone or `Until Further Notice` |
| Upload song audio here. | `audioFilePath` | Optional; the mock accepts one file; must agree with any reviewed `audioMatch` |

The official page is rendered dynamically and may require access or session
context. The field labels and controls documented here were verified from its
rendered form. Production-side validation, upload processing, submission
behavior, account requirements, and the exact accepted syntax for the Hide
Until date/time and time-zone text still require manual verification. This
mock intentionally does not claim to reproduce those undocumented behaviors.

## Orchard CSV import review policy

### Artist attribution (sponsor-confirmed)

Brad clarified the Orchard artist columns:

- `TRACK ARTIST` is the track performer.
- `PRODUCT ARTIST` is the main release entity.
- Brad determines primary, secondary, and tertiary artist attribution.
- Featured-artist designations are managed through Vydia.

Each imported recording carries an `artistAttribution` decision
(`src/metadata/artistAttribution.ts`) that keeps both source values distinct.
The importer always leaves the Mediabase Exact Artist (`artist`) blank and sets
`requiresConfirmation: true`; the source values are only offered to the
reviewer as `candidateExactArtists` suggestions:

| Source values | `status` | `candidateExactArtists` | Exact Artist (`artist`) after import |
| --- | --- | --- | --- |
| Both present and equal (case/whitespace-insensitive) | `AGREES` | One value | Blank until confirmed |
| Only `TRACK ARTIST` | `TRACK_ARTIST_ONLY` | Track artist | Blank until confirmed |
| Only `PRODUCT ARTIST` | `PRODUCT_ARTIST_ONLY` | Product artist | Blank until confirmed |
| Both present and different | `CONFLICT` | Both values | Blank until confirmed; also emits an `artist-conflict` warning |
| Neither present | `MISSING` | None | Blank until confirmed; also emits a `missing-required-field` warning |

The importer never assumes the track performer (or the release entity) is
Brad's primary artist or the Mediabase Exact Artist, even when the two columns
agree. `primaryArtist`, `secondaryArtist`, and `tertiaryArtist` stay `null`
until a reviewer records them, and `featuredArtist` is never derived from
either Orchard artist column (`featuredArtistSource` is `VYDIA`).

Every imported recording can only be approved with an explicit selection:

```ts
reviewAndApproveRecord(record, reviewData, {
  confirmArtistAttribution: {
    exactArtist: "The Harbor Lights",
    primaryArtist: "The Harbor Lights", // optional, Brad's decision
    secondaryArtist: null,
    tertiaryArtist: null
  }
});
```

Setting `artist` in `reviewData`, injecting an `artistAttribution` object, or
editing `requiresConfirmation` does not count as confirmation; the approval
gate checks `artistAttribution.confirmed`, which only
`confirmArtistAttribution` sets. Once confirmed, the selection is preserved on
re-approval; changing `artist` requires a new explicit confirmation, and
`validateRecordForPreparation` rejects a record whose `artist` differs from the
confirmed Exact Artist.

`confirmArtistAttribution` also records the `TRACK ARTIST` / `PRODUCT ARTIST`
values it confirmed (`confirmedSource`). The confirmation stays valid across
unrelated edits, but if either Orchard artist value later changes, the record is
blocked until the Exact Artist is confirmed again. A decision marked
`confirmed` without going through `confirmArtistAttribution` (no
`confirmedSource`, an empty Exact Artist, or a `status` that does not match the
artist values) is rejected as inconsistent.

Provenance is recorded in `recordSource` and does not depend on the mutable
`recordingId`. The importer stamps `recordSource: "ORCHARD"`, and every
recording requires a confirmed decision by default: deleting or omitting
`artistAttribution`, changing the recording ID, or dropping `recordSource`
blocks approval, and a nonempty `artist` alone never counts as confirmation.
**Legacy exception:** only a record explicitly marked `recordSource: "MANUAL"`
whose ID is not in the importer's `ORCHARD-<16 hex>` format
(`isLegacyManualRecord`), such as the already approved
`fixtures/example-record.json` (`TEST-001`), may omit `artistAttribution`.
`reviewAndApproveRecord` ignores `recordSource` in review data, so a review
cannot grant the exception. Like `approvalStatus`, `recordSource` is plain
prototype data; deliberately forging it is covered by the deferred
authenticated-approval work.

### ISRC

Imported ISRC state is retained separately from the validated form value.
Malformed nonempty source values block approval until corrected and
revalidated. A genuinely missing source ISRC may remain blank only after the
reviewer explicitly confirms it during approval.

## Local audio metadata extraction

`extractAudioMetadata(path)` in `src/audio/audioMetadata.ts` reads local WAV
and MP3 files with [`music-metadata`](https://github.com/borewit/music-metadata).
Files are opened read-only and tags are never written back. The actual format
is detected from file content (RIFF/WAVE or ID3/MPEG Layer III frames), not the
extension; `extensionMatchesFormat` reports any mismatch.

Extracted fields: `filePath`, `fileName`, `format`, `durationSeconds`,
`sampleRate`, `bitDepth`, `channels`, `artist`, `albumArtist`, `title`, `album`,
`genre`, `year`, `date`, `comments`, `isrc`
(normalized, only when every embedded value agrees on one valid ISRC),
`rawIsrcs` (exact embedded values), and `version` (only from an explicit ID3
`TIT3` subtitle tag; never inferred from the title). Unavailable values are
`null`. MP3 `bitDepth` is `null` because compressed audio has no fixed bit
depth. WAV artist/title/album are read from RIFF `LIST/INFO` or an embedded
`id3 ` chunk; RIFF INFO has no ISRC field, so WAV ISRCs come from `id3 ` only.

Failures are returned, not thrown, as `{ status: "ERROR", error }` with
`MISSING_FILE`, `UNSUPPORTED_FORMAT`, or `INVALID_AUDIO`.
`MISSING_FILE` also covers files that become unreadable after the initial
file check, including failures opening the file or reading its header.
`extractAudioMetadataBatch(paths)` processes paths in sorted order and continues
after a per-file error.

## Matching audio files to Orchard recordings

`matchAudioToRecording` / `matchAudioToRecordings` in
`src/audio/audioMatcher.ts` compare extraction results against recordings
deterministically (results do not depend on input order):

1. **`ISRC`** – a valid embedded ISRC equals the Orchard ISRC and there is no
   conflicting identity evidence. Automatic.
2. **`EXACT_METADATA`** – normalized embedded artist, title, and version all
   agree (the artist may match the Exact Artist, `TRACK ARTIST`, or
   `PRODUCT ARTIST`; the version may come from the `TIT3` tag or a title such as
   `Title (Radio Edit)`). Automatic when conflict-free.
3. **`PARTIAL_METADATA`** / **`FILENAME`** – review-only suggestions; never
   automatic.

Conflicts that block automatic matching include: an embedded ISRC that
contradicts the Orchard ISRC, a malformed or multiple embedded ISRCs, an
embedded ISRC belonging to another Orchard recording in the batch, a differing
embedded artist or title, and any version difference. Version cues such as
Radio Edit, Remix, Extended, Club Mix, Instrumental, Acoustic, Live, Clean,
and Explicit are detected in tags, titles, and filenames, so a Radio Edit is
never matched automatically to a Remix or another version.

| Result `status` | Meaning |
| --- | --- |
| `MATCHED` | Exactly one conflict-free `ISRC`/`EXACT_METADATA` candidate |
| `AMBIGUOUS` | More than one automatic candidate, more than one suggestion, or one file auto-matching several recordings |
| `NEEDS_REVIEW` | One suggestion with partial, filename-only, or conflicting evidence |
| `NO_MATCH` | No candidates; invalid or missing files are listed in `rejectedFiles` |

`applyAudioMatch(record, result)` stores an `audioMatch` decision and sets
`audioFilePath` only for `MATCHED`. It never overwrites a human-confirmed
selection or a manually supplied `audioFilePath`. `confirmAudioSelection(record,
result, filePath)` records an explicit human choice among evaluated
candidates (`acknowledgeConflicts: true` is required for a conflicting
candidate); pass `null` to confirm that no audio should be attached.
Approval is blocked while `audioMatch.status` is `AMBIGUOUS` or
`NEEDS_REVIEW`, and preparation is blocked if `audioFilePath` differs from the
reviewed match. Matching never changes `approvalStatus`, Orchard ISRCs, or
artist attribution.

### Reconciling stored decisions with current evidence

A stored `audioMatch` may be older than the audio folder. `assessAudioDecision(
record, currentResult)` returns the effective decision that the gap analyzer
and form preparation both use:

- **Automatic matches** (`AUTO_MATCHED`, or no stored decision) follow the
  current result. If the current status, selected file, or candidate set
  differs from the stored decision, the match is reported as
  `stale-automatic-match`; a newly `AMBIGUOUS` or `NEEDS_REVIEW` result also
  requires a human selection. Re-run `applyAudioMatch` with the current result
  to refresh it.
- **Human selections** (`humanConfirmed: true`) are never overwritten. New
  candidate files, newly unacknowledged conflicts (ISRC, artist, title, or
  version) on the selected file, or the selected file becoming unreadable block
  approval until `confirmAudioSelection` is called again.

Pass the current result to the gates:

```ts
const current = matchAudioToRecording(record, await extractAudioMetadataBatch(paths));
validateRecordForPreparation(record, { audioMatchResult: current });
await prepareMediabaseForm(page, record, { audioMatchResult: current });
reviewAndApproveRecord(record, reviewData, { audioMatchResult: current });
```

Without `audioMatchResult` the gates check only the stored decision, as before.

`audioFilePath` is only a local path. Nothing is uploaded automatically: the
local mock form attaches the file to its file input but is never submitted, and
there is no live Mediabase automation.

## Metadata gap analysis

`analyzeMetadataGaps(record, context)` in `src/metadata/metadataGapAnalyzer.ts`
is a read-only check run before any research agent. It is synchronous and pure:
it never mutates inputs, reads files, calls the network, or changes
`approvalStatus`. Audio evidence is supplied by the caller:

```ts
const extractions = await extractAudioMetadataBatch(audioPaths);
const matches = matchAudioToRecordings(records, extractions);
const reports = analyzeMetadataGapsBatch(records, {
  audioExtractions: extractions, // used to verify the selected audioFilePath
  audioMatchResults: matches,    // matched to records by recordingId
  expectedArtistRoles: []        // e.g. ["primary"] only when Brad's workflow requires it
});
const sheetRows = [[...METADATA_GAP_SHEET_COLUMNS], ...toMetadataGapSheetRows(reports)];
```

Each report contains `recordingId`, `approvalStatus`, `readiness`, a severity
`summary`, and sorted `gaps`. Batch reports are sorted by `recordingId`, so the
output does not depend on record or context order.

| `readiness` | Meaning |
| --- | --- |
| `BLOCKED` | At least one blocking gap other than pending approval |
| `AWAITING_APPROVAL` | No other blocking gaps; a human must still approve the record |
| `READY` | Approved and passes `validateRecordForPreparation`; warnings may remain |

`READY` means the record passes the current prototype workflow checks. It is
**not** cryptographically verified human approval: `approvalStatus` and other
record fields are plain mutable data, so a caller can still set `"APPROVED"`
directly. Authenticated approval is deferred to the human-review interface.

The analyzer re-runs `validateRecordForPreparation` (with the current audio
match result) as a safety net, so it may be stricter than the preparation gate
but never looser. Shared validation lives in the runtime-neutral
`src/metadata/recordValidation.ts`; the analyzer does not load Playwright.
`src/browser/mediabaseForm.ts` re-exports these functions for existing callers.
Each gap has:

| Property | Values |
| --- | --- |
| `gapId` | Stable `<recordingId>:<code>:<fields>` |
| `code` | Reuses Orchard codes (`missing-isrc`, `invalid-isrc`, `artist-conflict`, `missing-required-field`) plus analyzer codes such as `artist-unconfirmed`, `audio-ambiguous`, `audio-isrc-conflict`, `declaration-unanswered` |
| `severity` | `blocking`, `warning`, `informational` |
| `category` | `missing`, `invalid`, `conflicting`, `needs-human-review` |
| `area` | `submission`, `identifiers`, `artist-attribution`, `audio`, `release`, `declarations`, `approval` |
| `resolvedBy` | Who may apply the fix: `deterministic-rule` (mechanical) or `human`; never a research agent |
| `researchEligible` | The gap is open and a research agent may investigate it and propose evidence; grants no authority to apply anything |
| `agentMayResolve` | Always `false` |
| `requiresHumanConfirmation` | `true` when `resolvedBy` is `human` or the gap is research-eligible |
| `suggestedValue` | Deterministic replacement (e.g. `2026-11-15` → `11/15/2026`, normalized ISRC); never applied automatically |
| `evidence` | `{ source, field, value, fileId? }` from `record`, `orchard`, `artist-attribution`, `audio-metadata`, or `audio-match` |
| `recommendedAction` | Next step for the reviewer |

Reports are safe to share with Google Sheets or a research agent. Submitter
emails are replaced with `[redacted email]`, and local audio files appear only
by file name plus an opaque `fileId` (`audioFileId(path)`, e.g.
`AUDIO-5E4CDCBBD922`); directory paths are removed from all evidence and
descriptions. Records are not changed, so full `audioFilePath` values remain
available internally for matching and Playwright file attachment.

Research eligibility is separate from authority to apply a change
(`RESEARCH_AGENT_POLICY`). `researchEligible` answers "may an agent
investigate?"; `resolvedBy`, `agentMayResolve: false`, and
`requiresHumanConfirmation` answer "who decides?". For example, an
unacknowledged conflicting embedded ISRC is `researchEligible: true`,
`resolvedBy: "human"`, and blocking; once a reviewer acknowledges it, it
becomes informational and no longer research-eligible. A research agent **may**
investigate gaps
(including conflicting ISRCs), search approved sources, explain discrepancies,
and suggest corrections with evidence. It **must not** choose an authoritative
value, overwrite metadata, resolve conflicts without human confirmation, or
approve recordings.

Research eligibility:

- **Potentially researchable:** missing label, official/album release dates,
  album title, album UPC, missing or malformed ISRCs, and conflicting embedded
  ISRCs. Research results are proposals only; a human confirms every value.
- **Human-only:** Exact Artist confirmation and Brad's primary/secondary/
  tertiary hierarchy, Featured Artist (Vydia), declarations, submitter details,
  audio selection (ambiguous, conflicting, or missing files), and approval.
- **Deterministic:** ISRC normalization, `mm/dd/yyyy` reformatting of ISO or
  unpadded dates, whitespace cleanup, and UPC check-digit validation.

No research agent may approve records or override a human decision. Optional
empty fields (company, phone, version, website, comments, Hide Until) are not
reported. An empty Featured Artist is informational only; it is never assumed
to be required.

## Gemini metadata research framework (MB-05B.1, offline)

`src/metadata/metadataResearch.ts` turns MB-05A reports into focused research
tasks and validates structured provider responses. It is runtime-neutral and
does not load Playwright. No Gemini SDK, API key, model selection, live
research, retries, or cost tracking is implemented.

```ts
import { analyzeMetadataGaps } from "./src/metadata/metadataGapAnalyzer";
import {
  buildMetadataResearchTasks,
  researchMetadata
} from "./src/metadata/metadataResearch";
import { MockMetadataResearchProvider } from "./src/metadata/mockResearchProvider";

const report = analyzeMetadataGaps(record);
const tasks = buildMetadataResearchTasks(record, report);
const { proposals, failures } = await researchMetadata(tasks, new MockMetadataResearchProvider());
// No fixture => INSUFFICIENT_EVIDENCE, suggestedValue: null, PENDING_REVIEW.
// Neither the record nor the original report is changed.
```

### Research requests and provider contract

Each task has a stable `taskId`, `recordingId`, `gapId`, one researched `field`,
a focused question, public identifying metadata, original source evidence,
allowed source categories, and explicit restrictions. Tasks require both the
gap's `researchEligible` flag and an allowlisted gap-code/field combination.
Supported fields are `isrc`, `label`, `officialReleaseDate`, `albumTitle`,
`albumUPC`, and `albumReleaseDate`. Mechanical corrections are skipped, as are
Brad's artist decisions, Featured Artist (Vydia), declarations, approval,
submitter details, and audio selection.

Only public recording/release fields and Orchard Track/Product Artist names
are included as context; names are identifiers, not proposed hierarchy
decisions. Contact details, comments, websites, approval state, audio paths,
and unrelated evidence are omitted. Emails and absolute Windows, UNC, and
POSIX paths embedded in included text are redacted again at this boundary.
Sensitive identifiers cause explicit errors rather than silently changing the
recording/gap linkage. Original records retain their full operational data.

`MetadataResearchProvider.research(task)` returns `Promise<unknown>`.
`validateMetadataResearchResponse` validates that untrusted value against
`MetadataResearchResponse`. A future Gemini adapter must parse its structured
JSON into an object before returning it; JSON strings are not accepted here.
Responses contain exactly:

| Property | Contract |
| --- | --- |
| `recordingId`, `gapId`, `field` | Must exactly match the request |
| `suggestedValue` | String or `null`; ISRC, UPC, and dates reuse existing validators |
| `evidence` | Source claims: `{ sourceId, url, category, quote, supportedValue }` |
| `explanation` | Nonempty explanation; remains provider-authored, not independently verified prose |
| `confidence` | `LOW`, `MEDIUM`, `HIGH`, or `UNKNOWN`; never proof |
| `conflictingEvidence` | Claims supporting alternative values |
| `outcome` | `PROPOSED`, `INSUFFICIENT_EVIDENCE`, or `CONFLICTING_EVIDENCE` |

Source categories are `official-artist`, `official-label`, `distributor`,
`identifier-registry`, and `published-catalog`. A citation needs a source
identifier and quotation; a URL is optional, but when supplied must be a
well-formed HTTPS URL without credentials or sensitive data. Categories and
URL syntax are **not** source verification or a production domain allowlist.
Unknown keys, unrelated IDs/fields, approval/artist patches, fabricated
verification flags, malformed values, and sensitive response text are rejected.
Validation errors and provider errors are surfaced per task, not silently converted
into successful proposals or allowed to discard other tasks' results.

`researchMetadata` returns `{ proposals, failures }`. Each array is ordered by
`taskId`, regardless of input order. Successful proposals retain strict validation.
Each failure contains `taskId`, `recordingId`, `gapId`, `errorCode`
(`PROVIDER_ERROR` or `INVALID_RESPONSE`), a fixed safe `description`,
`status: "UNRESOLVED"`, and `retryEligible: true`. Identifiers are sanitized;
raw exceptions, provider payloads, validation details, prompts, and API keys
are never copied into failure descriptions. Failed tasks produce no proposal,
do not change their source gap, and can be passed to a future retry using their
original task IDs. No automatic retries are implemented. Duplicate task IDs
remain a batch-input error and are rejected before contacting the provider.

### Evidence trust and unresolved proposals

A provider-supplied URL, quotation, or source category is only a
`PROVIDER_CLAIM`. A plausible or invented URL is never treated as verified just
because it is well formed, and a high-confidence claim without adequate
evidence becomes `INSUFFICIENT_EVIDENCE` with `suggestedValue: null`. Claimed
candidate values remain visible in evidence for later investigation.

The optional third argument to `researchMetadata` is a trusted caller-owned
`VerifiedResearchEvidence[]`, obtained independently of the research provider.
Each attestation includes `verificationId` and must match the exact recording,
field, source identifier, URL, category, quotation, and supported value.
Only matched claims become `INDEPENDENTLY_VERIFIED`. At least one exact,
verified supporting claim is required for `PROPOSED`; high confidence never
substitutes for this. Verification is separate from Brad's approval.

MB-05B.1 defined the **verification contract**; MB-05B.2 adds the live
verifier described below (`src/research/sourceVerifier.ts`).
Never populate the trusted array by copying or trusting provider output.
Tests use fictional independent attestations and `example.test` citations,
not claims of real-world research. Attestations carry the task's
`identityFingerprint` (a hash of recording ID, artist, title, version, Track
Artist, and Product Artist), so they stop applying as soon as any identifying
metadata changes.

Conflicting claims remain `CONFLICTING_EVIDENCE`, even if the provider calls
them `PROPOSED`; contradictory trusted attestations cannot be hidden by
omitting them from a response. ISRC-conflict tasks always remain conflicting
and human-resolved, even with verified supporting evidence. Research can
suggest a supported candidate but cannot choose the authoritative ISRC.
Without verified support, no suggested value is accepted.

### Offline mock and future exception-based review

`MockMetadataResearchProvider` accepts fictional response fixtures keyed by
`taskId`. It clones inputs/outputs, returns stable results, and makes no network
requests. Missing fixtures explicitly report insufficient evidence. Fixtures
can also contain invalid output to exercise rejection tests; they never grant
evidence verification by themselves.

Every accepted `MetadataResearchProposal` contains a stable `proposalId`,
validated evidence with verification status, `unresolvedReasons`, and:

- `reviewStatus: "PENDING_REVIEW"`
- `requiresHumanReview: true`
- `agentMayResolve: false`
- `conflictRequiresHumanResolution: true` for conflicting outcomes

`MetadataReviewAction` defines the review intents:
`APPROVE_SUGGESTED_VALUE`, `EDIT_SUGGESTED_VALUE` (requires `editedValue`),
`REJECT_SUGGESTION`, and `DEFER_DECISION`, linked to the proposal/recording/gap/
field. This module never executes them; MB-07 (below) validates and applies
them with an audit trail. Approving a suggestion never implicitly approves a
record or acknowledges an ISRC conflict.

The future UI should display completed evidence-backed proposals, alternatives,
and verification/uncertainty labels so Brad reviews exceptions rather than
filling blank forms. Remaining integrations after MB-05B.2 are an approved
source list agreed with Brad, task/proposal persistence and stale-result
handling, and a human-review UI with controlled application and renewed
MB-05A validation. No Sheets, emails, live Mediabase, or production Apps Script
integration is included.

## Live Gemini research and evidence verification (MB-05B.2)

Gemini investigates and prepares; Brad decides. MB-05B.2 connects the
MB-05B.1 framework to Gemini through the official `@google/genai` SDK, adds an
independent source verifier, and wraps both in a budgeted orchestrator. All
MB-05B.1 restrictions still apply: every result is `PENDING_REVIEW`, nothing
modifies a record, approval, artist hierarchy, declarations, or audio
selection, and nothing touches live Mediabase.

| Module | Role |
| --- | --- |
| `src/research/geminiResearchProvider.ts` | Gemini provider: config, prompt, response schema, grounding/usage extraction, safe error classification. |
| `src/research/sourceVerifier.ts` | Fetches cited pages from approved hosts and checks quote, value, and recording identity. |
| `src/research/researchOrchestrator.ts` | `runMetadataResearch()`: modes, retries, backoff, budgets, verification, per-task results. |
| `src/research/researchProvider.ts` | Shared grounding/usage types and `ResearchProviderError` (safe codes only). |
| `scripts/liveResearchDemo.ts` | Opt-in demonstration with a fictional recording. |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | required for live mode | Gemini Developer API key. Put it in `mediabase-agent/.env` (git-ignored) or the shell environment. Never commit it. |
| `MEDIABASE_GEMINI_MODEL` | `gemini-3.5-flash-lite` | Stable text model. Preview, experimental, `-latest`, and media models are rejected. |
| `MEDIABASE_GEMINI_GOOGLE_SEARCH` | `true` | Enables the Google Search grounding tool. |
| `MEDIABASE_GEMINI_TIMEOUT_MS` | `60000` | Per-request timeout (1000–300000). |
| `MEDIABASE_GEMINI_MAX_OUTPUT_TOKENS` | `8192` | Output cap (256–65536). |
| `MEDIABASE_APPROVED_SOURCES` | empty | Comma-separated `host=category`; prefix `*.` to include subdomains, e.g. `*.example-label.com=official-label,isrc.example.org=identifier-registry`. Categories: `official-artist`, `official-label`, `distributor`, `identifier-registry`, `published-catalog`. |

Vertex AI / Enterprise mode is intentionally rejected. Configuration errors are
raised before any request and never include the key.

### How a task is researched

```ts
import { createGeminiResearchProviderFromEnv } from "./src/research/geminiResearchProvider";
import { runMetadataResearch } from "./src/research/researchOrchestrator";
import { parseApprovedSources, SourceVerifier } from "./src/research/sourceVerifier";

const result = await runMetadataResearch(tasks, {
  mode: "live",                       // or "mock" (offline provider) or "dry-run" (no calls)
  provider: createGeminiResearchProviderFromEnv(),
  verifier: new SourceVerifier({ approvedSources: parseApprovedSources(process.env.MEDIABASE_APPROVED_SOURCES) }),
  limits: { maxTasks: 5, maxProviderCalls: 8, maxRetries: 2 }
});
// result.results[i]: { status, attempts, proposal, failure, grounding, verification, usage }
```

1. **Provider.** One `generateContent` call per attempt with the Google Search
   tool, a JSON response schema pinned to the task's recording/gap/field, and a
   system instruction that treats task data and web content as untrusted, asks
   for verbatim quotes, and forbids invented citations or resolving ISRC
   conflicts. SDK retries and automatic function-call continuation are off so
   the orchestrator owns the call budget. The prompt contains only the redacted
   task view (no emails, paths, approval state, or unrelated record data).
   Grounding sources and search-query counts are copied exactly as returned;
   none are synthesized.
2. **Validation.** The parsed JSON goes through the unchanged MB-05B.1
   `validateMetadataResearchResponse`. Only free-text `explanation` line breaks
   are flattened; values, quotes, and URLs are never altered.
3. **Independent verification.** For each cited claim the verifier requires:
   an `https` URL without credentials or custom port; a host on the approved
   list whose configured category equals the claimed category; a host that
   search grounding actually returned (`requireGrounding`); public DNS results
   for every hop (no loopback, private, link-local, CGNAT, or mapped private
   addresses); manual redirects re-checked at every hop (max 3); a 10 s timeout;
   a 1 MB streamed size cap; and a text/HTML/JSON content type. It then checks
   that the retrieved visible text (scripts/styles removed) contains the quote,
   that the quote contains the claimed value in a field-aware way (ISRC
   alphanumerics, UPC/EAN digits, ISO or written-out dates, phrase match for
   label/album), and that the recording identity (title or album, an artist,
   and the version for recording-level fields) appears near the quote. Only
   then is a `VerifiedResearchEvidence` attestation created, bound to the task's
   `identityFingerprint`. Attestations are never copied from Gemini output.
4. **Revalidation.** The response is validated again with those attestations.
   A proposal stays `INSUFFICIENT_EVIDENCE` with `suggestedValue: null` unless a
   supporting claim was independently verified; verified contradicting sources
   force `CONFLICTING_EVIDENCE`; ISRC conflicts are always human-resolved.

Per-source reports (`verification.reports`) use these statuses: `VERIFIED`,
`NO_URL`, `UNSAFE_URL`, `SOURCE_NOT_APPROVED`, `CATEGORY_MISMATCH`,
`NOT_GROUNDED`, `REDIRECT_BLOCKED`, `PRIVATE_ADDRESS`, `FETCH_FAILED`,
`HTTP_ERROR`, `TIMEOUT`, `TOO_LARGE`, `UNSUPPORTED_CONTENT`, `QUOTE_NOT_FOUND`,
`VALUE_NOT_IN_QUOTE`, `IDENTITY_NOT_FOUND`, `IDENTITY_SNAPSHOT_MISMATCH`, and
`NOT_CHECKED_LIMIT`. Each report states its role (`SUPPORTING`/`CONFLICTING`)
and whether it contradicts the suggestion. The task-level summary is
`VERIFIED`, `PARTIALLY_VERIFIED`, `UNVERIFIED`, or `NOT_ATTEMPTED`, plus
`verifiedOfficialSource` (verified support from a non-catalog category).

### Retries, budgets, and failures

| Limit | Default | Notes |
| --- | --- | --- |
| `maxTasks` | 10 | Tasks beyond this fail as `BUDGET_EXHAUSTED`. |
| `maxProviderCalls` | 20 | Hard cap on Gemini requests per batch, retries included. |
| `maxRetries` | 2 | For rate limits, timeouts, and transient 5xx/network errors. |
| `maxInvalidResponseRetries` | 0 | Malformed/invalid output is not retried by default (max 2). |
| `initialBackoffMs` / `maxBackoffMs` | 2000 / 60000 | Exponential; rate limits honor Gemini's `retryDelay` up to the cap. |
| `minRequestIntervalMs` | 0 | Optional spacing between calls. |

Per-task failure isolation is preserved. Failures use safe codes only
(`RATE_LIMITED`, `QUOTA_EXHAUSTED`, `TIMEOUT`, `PROVIDER_ERROR`, `INVALID_RESPONSE`,
`AUTHENTICATION_ERROR`, `CONFIGURATION_ERROR`, `BUDGET_EXHAUSTED`,
`BATCH_ABORTED`); raw SDK messages, prompts, and keys are discarded. A
credential or configuration error stops the remaining tasks (`BATCH_ABORTED`)
instead of repeating the same failing call. Confirmed quota exhaustion is
`QUOTA_EXHAUSTED` and is never automatically retried, even if a retry hint is
also present. Confirmation requires structured Google RPC details: a
`QuotaFailure` violation with a zero allowance or a per-day quota identifier,
or a Google `ErrorInfo` reason of `QUOTA_EXHAUSTED` / `DAILY_LIMIT_EXCEEDED`.
A generic 429, `RESOURCE_EXHAUSTED`, ambiguous `QUOTA_EXCEEDED`, or free-text
quota message alone remains `RATE_LIMITED` with bounded retries.
Only typed `RetryInfo.retryDelay` details supply backoff hints.

Provider failures include optional safe `diagnostics` with `httpStatus`
(or `null` for network errors), an allowlisted `category`, and `retryable`
(whether the failure is eligible for automatic retry, subject to batch limits).
Timeouts remain `TIMEOUT`, including HTTP 408/504 and abort/timeout exceptions,
not HTTP 429. No raw messages, RPC metadata, prompts, keys, or credentials are
exported. Every failure stays `UNRESOLVED` and `retryEligible: true`, meaning it
can be manually rescheduled once its underlying problem has been addressed;
this is distinct from automatic retryability.
The existing offline `researchMetadata()` is unchanged.

### Local demonstration (opt-in)

```sh
npm run research:demo                                  # dry run: no Gemini call, no network
npm run research:demo:live                             # one live call, default field "label"
npm run research:demo:live -- --field isrc --max-calls 2
```

The demo uses a fictional Orchard recording, researches one eligible gap, caps
calls at `--max-calls` (default 1, hard maximum 3), prints the proposal,
grounding, verification reports, and usage, and confirms the record and its
`DRAFT` approval status are unchanged. It never imports browser automation and
never contacts Mediabase. It lives outside `tests/`, so Playwright never runs
it. Because the recording is fictional, the expected honest answer is
`INSUFFICIENT_EVIDENCE`.

### Costs and usage

- Each attempt is one billed `generateContent` request; usage reports prompt,
  output, thinking, tool-prompt, and total tokens plus executed search queries.
- On Gemini 3-series models, Google Search grounding is billed per executed
  search query once the free monthly allowance is used. Check the current
  Gemini API pricing page before running batches.
- Free-tier keys may have no Search grounding quota. Gemini then returns 429
  `RESOURCE_EXHAUSTED` immediately. It is reported as non-retried
  `QUOTA_EXHAUSTED` only when structured details confirm exhaustion; otherwise
  it remains `RATE_LIMITED` with bounded retries. Set `MEDIABASE_GEMINI_GOOGLE_SEARCH=false` to test
  the ungrounded path; without grounding, no claim can be verified.
- Keep `maxProviderCalls` small; the worst case per batch is
  `maxProviderCalls` requests.

### Verification limitations

- **Approved sources default to empty** (fail closed): with no configured hosts
  every citation stays a `PROVIDER_CLAIM`. Brad must choose the hosts.
- **Grounding redirect URIs are not followed.** On the Gemini Developer API
  grounding chunks are `vertexaisearch.cloud.google.com` redirect links whose
  title is usually the source domain; the verifier matches on that domain and
  fetches the model-cited direct URL itself.
- **Heuristic semantics.** Matching is textual: quote present, value in quote,
  identity terms within about 2,000 characters. It does not understand page
  layout, so a page listing several releases could still mislead it; Brad's
  review remains mandatory. Pages that need JavaScript to render will fail as
  `QUOTE_NOT_FOUND`.
- **DNS rebinding** between the address check and the fetch is mitigated only by
  the host allowlist; there is no pinned-IP connection.
- Verification is a snapshot of one retrieval; it does not prove the page will
  stay the same and is invalidated whenever identifying metadata changes.

## Running checks

```sh
npm run typecheck
npx playwright test --reporter=line
```

Audio tests generate minimal fictional WAV/MP3 files at runtime
(`tests/support/audioFixtures.ts`) in Playwright's output directory; no real
recordings are committed.


## MB-06: Recording Workflow Integration

`src/workflow/recordingWorkflow.ts` connects the existing audio matcher,
gap analyzer, research task builder, MusicBrainz adapter, and research
orchestrator for one recording.

The result includes the unchanged recording snapshot, current audio match,
gap report, research tasks/results, provider findings, and pending review
decisions.

### Behavior

- MusicBrainz recording and release selections must be explicit.
- MusicBrainz allows at most two lookup calls per workflow run.
- Research uses one orchestrator batch, preserving its budgets and failure handling.
- Unverified MusicBrainz findings do not resolve gaps; those tasks remain eligible for research.
- Conflicting candidate values are flagged while retaining both providers' evidence.
- Partial dates remain evidence rather than complete date candidates.
- Dry-run mode does not invoke either provider.
- No suggestions or audio matches are applied. Attribution, audio selections,
  and approval remain unchanged.
- The workflow does not access live Mediabase.

This implements workflow preparation; MB-07 (below) consumes its pending decisions.
MusicBrainz source verification and live end-to-end research remain separate work.
The returned result includes local operational data and should not be published
or sent wholesale to a research provider.

### Offline demonstration

Uses a fictional Orchard import, simulated audio metadata, and mock providers.
It demonstrates a deliberate date conflict and checks that inputs remain
unchanged and the recording stays DRAFT.

```sh
npx tsx scripts/recordingWorkflowDemo.ts
```

### Checks

```sh
npm run typecheck
npx playwright test --reporter=line
```

## MB-07: Human Review and Approval Workflow

`src/workflow/humanReview.ts` lets a human reviewer act on MB-06
`metadataDecisions`. It is pure and offline: inputs are never mutated, every
returned state is a new deeply frozen snapshot, and nothing contacts a
provider or Mediabase or submits anything.

```ts
const workflow = await runRecordingWorkflow(record, audio, options); // MB-06
let state = startHumanReview(workflow, audio);
const basis = reviewBasisFor(state, decisionId); // capture when showing the decision
const result = applyHumanReviewDecision(state, {
  reviewId, decisionId, source: "RESEARCH", action, // action: MetadataReviewAction
  reviewer: { reviewerId: "brad" }, reviewedAt: "2026-11-04T15:30:00.000Z", basis
});
// or: processPendingReviews(state, decisions) -> { state, applied, rejected }
```

`source` is required because MusicBrainz and research proposals for the same
task share a `proposalId`.

### Review actions

| Action | Effect |
| --- | --- |
| `APPROVE_SUGGESTED_VALUE` | Applies the proposal's independently verified `suggestedValue`. Not allowed for conflicting decisions or proposals without a verified suggestion. |
| `EDIT_SUGGESTED_VALUE` | Applies the reviewer's `editedValue`. Requires a note when evidence conflicts or no verified suggestion exists. |
| `REJECT_SUGGESTION` | Marks that finding rejected; the recording is unchanged. |
| `DEFER_DECISION` | Leaves the decision open (`DEFERRED`); it can be decided later. |

A decision's status is `VALUE_ACCEPTED` once a value is applied,
`ALL_SUGGESTIONS_REJECTED` when every finding is rejected, otherwise
`DEFERRED` or `PENDING_REVIEW`. `researchReview.status` becomes `COMPLETE`
when no decision is pending or deferred.

### Validation and rejection

Each decision is fully validated before anything changes; a rejected decision
returns the unchanged state and `{ reviewId, code, message }`:

- `INVALID_DECISION`: missing reviewer identity, non-ISO-8601-UTC timestamp,
  unknown action/source, `editedValue` on a non-edit action, or oversized note.
- `INVALID_VALUE`: values must satisfy the existing rules: `mm/dd/yyyy` dates
  (`isValidDate`), normalized 12-character ISRCs, UPCs with a valid check digit
  (`isValidUpc`), and text without surrounding whitespace, control characters,
  emails, or local paths.
- `UNKNOWN_DECISION` / `MISMATCHED_DECISION`: the proposal, source, recording,
  gap, and field must all belong to the targeted pending decision.
- `STALE_DECISION`: the recording's identity fingerprint, the field's current
  value, or the findings shown (`findingsDigest`) changed after the basis was
  captured; the proposal was researched for a different identity; or the gap
  it addressed is no longer open.
- `DUPLICATE_REVIEW` / `ALREADY_DECIDED`: a `reviewId` can be recorded once,
  and accepted values or rejected suggestions cannot be decided again.
- `CONFLICT_REQUIRES_EXPLICIT_RESOLUTION` / `NOTE_REQUIRED` /
  `NO_VERIFIED_SUGGESTION`: conflicts are never resolved by approval.

### Data integrity

- Only the reviewed field changes (plus `isrcValidation`, marked reviewed, for
  ISRCs); any other difference aborts the decision.
- `originalRecording` keeps the MB-06 snapshot; MB-06 decisions, evidence,
  verification labels, and source URLs are kept unchanged.
- After each applied value the audio match and gap report are recalculated
  with the same audio evidence.
- Research review never sets `approvalStatus` to `APPROVED`. If an approved
  recording's value changes it returns to `NEEDS_REVIEW`. Final approval
  remains the separate `reviewAndApproveRecord` step.
- MB-06 `gapDecisions` (human-only gaps) are not handled here.

### Audit trail

Each recorded action appends an immutable `ReviewAuditEntry`: sequence,
`reviewId`, reviewer, timestamp, action and outcome, recording/decision/
proposal/task/gap identifiers, source, field, assessment and candidate values,
suggested and edited values, value origin, previous and resulting values,
previous and resulting approval status, identity fingerprint, every evidence
item of the decision (with source URL, verification status, and role), and
the reviewer note (emails and local paths redacted). Rejected decisions are
returned to the caller and not added to the trail.

MB-08 (below) persists the state and audit trail, plus a separate log of
refused decisions.

### Offline demonstration

Uses fictional data, mock providers, and a fictional verifier. It approves,
edits, resolves the date conflict with a note, defers a decision, and shows
rejected conflict, invalid-UPC, and replayed decisions. The recording stays
DRAFT.

```sh
npm run review:demo
```

## MB-08: Persistent Review Storage and Audit History

MB-08 saves MB-07 review sessions locally and restores them between
sessions. It reuses the MB-07 types and rules unchanged, works offline,
and never approves, submits, or contacts Mediabase or any network service.

- `src/storage/reviewStorageBackend.ts`: the replaceable
  `ReviewStorageBackend` interface (`read`, atomic `replace`, `withLock`,
  `keys`), with a local JSON-file backend and an in-memory backend.
- `src/workflow/reviewSessionStore.ts`: `createReviewSessionStore(backend)`
  adds revisions, conflict detection, integrity checks, and append-only audit
  history on top of any backend.

```ts
const store = createReviewSessionStore(createJsonFileReviewStorage(".review-sessions"), {
  integrityKey: process.env.REVIEW_STORE_KEY // optional, at least 16 bytes; see below
});

let state = startHumanReview(workflow, audio);            // MB-07
// Applies decisions through MB-07 unchanged and logs every refused decision.
let progress = applyReviewDecisionsWithRefusalLog({ state, refusedDecisions: [] }, decisions);
const saved = await store.save(progress.state, {
  expectedRevision: 0, sessionId: "desk-1", refusedDecisions: progress.refusedDecisions
});

// Later, after restarting:
const loaded = await store.load(recordingId);
if (loaded.ok) {
  progress = applyReviewDecisionsWithRefusalLog(loaded.session, [decision]);
  await store.save(progress.state, {
    expectedRevision: loaded.session.revision, refusedDecisions: progress.refusedDecisions
  });
}
```

`/.review-sessions/` is git-ignored; saved sessions contain the full
recording snapshot, including contact details, so keep them out of version
control.

### What is saved

Each recording is one document holding the whole `HumanReviewState`:
- the original MB-06 snapshot and the current snapshot with accepted values
- every pending decision with its evidence, verification labels, and source
  URLs, plus each finding's status (pending, approved, edited, rejected,
  deferred)
- the recalculated gap report and audio match
- the complete audit trail, including human `REJECT_SUGGESTION` decisions
  (outcome `SUGGESTION_REJECTED`)
- an append-only refusal log of decisions MB-07 refused (duplicate,
  stale, mismatched, conflicting, invalid value, and so on). Each entry keeps
  its sequence, `recordedAt`, review/decision/proposal IDs, source, action,
  field, reviewer, `reviewedAt`, submitted value, note, and the MB-07
  rejection code and message. A refused decision never changes the state.
  Free text is redacted (emails, local paths, control characters) and
  length-limited before it is stored.

A header records the recording ID, revision, `savedAt`, optional `sessionId`,
audit entry and refusal counts, a SHA-256 content checksum (covering the
state and refusal log), and an optional signature.

`applyReviewDecisionsWithRefusalLog(progress, decisions)` applies decisions
through `applyHumanReviewDecision` and appends each refusal to the log;
`recordRefusedDecision(log, decision, rejection)` records one refusal
directly. Pass the complete log as `refusedDecisions` when saving; if it is
omitted, the stored log is kept unchanged.

### Revisions and conflicts

- The `recordingId` is already stable (`ORCHARD-?` IDs are derived from the
  import). The storage key is a SHA-256 hash of it, so raw identifiers never
  become file names and keys are always path-safe.
- The first save uses `expectedRevision: 0`. Each later save must pass the
  revision it loaded; a successful save increments it. Saving an identical
  state returns `unchanged: true` without writing.
- `REVISION_CONFLICT`: another session saved first. Load the latest revision
  and re-apply new decisions through MB-07. Decisions about the same value
  then fail as `STALE_DECISION`, so nothing is silently overwritten.
- `HISTORY_REWRITE`: the saved audit trail and refusal log must each be a
  prefix of the new ones, and the original snapshot, pending decisions, and
  audio evidence cannot change. Audit entries and refusals can only be
  appended. A save that only adds refusals is still a new revision.
- `LOCKED`: saves for one recording are serialized with a lock file. Lock files
  are never removed based on age, because a process may still be active while
  paused. If a process has stopped and left a lock behind, remove that
  recording's `.lock` file before retrying the save.

### Integrity checks

A state is verified on every save and every load. The store rebuilds it from
its original snapshot and pending decisions, replays each audit entry through
`applyHumanReviewDecision`, and requires an exact match. A state MB-07 would
not produce is refused:
- a value without a human decision
- a changed unrelated field
- `APPROVED` set outside the final approval step
- a deleted or altered entry
- edited evidence or URLs
- an approval of conflicting evidence

Refusal log entries cannot be replayed (they changed nothing), so they are
checked for sequence, known codes and actions, timestamps, length, and
redaction instead.

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | No saved session for this recording. |
| `CORRUPTED_DATA` | Invalid JSON, malformed header, or checksum mismatch. |
| `INCOMPATIBLE_VERSION` | Not a review session document, or an unsupported `schemaVersion`. |
| `INTEGRITY_CHECK_FAILED` | Wrong recording, failed replay, malformed refusal log, or missing/invalid signature. |
| `INVALID_STATE` | `save` was given a state MB-07 did not produce, or a malformed refusal log; nothing is written. |
| `INVALID_REQUEST` | Bad `expectedRevision` or `sessionId`. |
| `REVISION_CONFLICT`, `HISTORY_REWRITE`, `LOCKED` | See above. |
| `STORAGE_ERROR` | The backend failed; only the OS error code is reported. |

Unreadable documents are never overwritten; a save on top of one fails until
the file is fixed.

Notes, reviewer identity, and timestamps (in audit entries and refusals) are
free text, so replay cannot tell whether they were edited. With `integrityKey`, each document is signed with
HMAC-SHA256, and an edit to any part of it fails to load. Without the key,
only accidental corruption (checksum) and inconsistent states (replay) are
detected. Keep the key outside the repository.

### Safe writes and privacy

- Each save writes a temporary file, flushes it to disk, and renames it over
  the previous file. If a save fails or is interrupted, the earlier revision
  stays intact; leftover temporary files are ignored and cleaned up on the
  next save.
- Folders are created with mode `0700` and files with `0600` where the OS
  supports it.
- Reviewer notes are already redacted by MB-07; refusal log text is redacted
  by MB-08 before it is stored.
- `list()` returns only the recording ID, revision, save time, counts, and
  status. Error messages contain no file paths or recording contents.

### Limitations

- Files are not encrypted at rest. Contact details and local audio paths are
  stored because resuming requires the exact snapshot.
- Locking is file-based and meant for one machine or one shared folder; it is
  not a distributed lock.
- Refused decisions are only persisted when the caller records them
  (`applyReviewDecisionsWithRefusalLog` or `recordRefusedDecision`) and
  passes the log to `save`; calling `applyHumanReviewDecision` directly
  still returns refusals without logging them.
- Final approval (`reviewAndApproveRecord`) is not stored here.
- A future change to MB-07 rules may make older sessions fail replay. They
  then report `INTEGRITY_CHECK_FAILED` instead of being reinterpreted.
- Only local JSON and in-memory backends exist. Another backend only needs to
  implement `ReviewStorageBackend`.

### Offline demonstration

Uses fictional data in a temporary folder. The demo:
1. Starts a session.
2. Applies approve, edit, reject, and defer decisions, and logs MB-07's
   refusal of an approval of conflicting evidence.
3. Saves the session with its refusal log.
4. Discards the in-memory session to simulate closing the app.
5. Restores the session and its refusals, and shows that a replayed decision
   is still refused (and logged).
6. Resolves the deferred decision and saves revision 2.
7. Shows that an outdated session cannot overwrite revision 2.
8. Confirms the first four audit entries and the first refusal are unchanged.

The recording stays DRAFT and nothing is submitted. Pass `-- --keep` to keep
the folder for inspection.

```sh
npm run review:persistence:demo
```


## MB-09: Persistent Human-Only Metadata Gap Resolution

MB-09 lets a human resolve the metadata gaps MB-06 marks as human-only. It
extends MB-06 through MB-08 rather than replacing them:
- MB-06 (`recordingWorkflow.ts`) still finds the gaps.
- MB-07 (`humanReview.ts`, unchanged) still reviews research suggestions.
- MB-08 (`reviewSessionStore.ts`) now also stores the combined history.

MB-09 never approves, submits, uploads audio, or contacts Mediabase or any
network service.

- `src/workflow/humanGapReview.ts`:
  - `startHumanGapReview(mb07State)` wraps an MB-07 state.
  - `humanOnlyGapQueue(state)` lists the open human-only gaps with their
    allowed actions and audio candidates.
  - `humanGapBasisFor(state, gapId)` returns what the reviewer saw.
  - `applyHumanGapDecision(state, decision)` applies one decision.
  - `applyResearchReviewDecision` and `applyCombinedReviewDecisions`
    interleave MB-07 and MB-09 decisions.
- `src/workflow/reviewSessionStore.ts`:
  - `loadCombined`, `saveCombined`, and `upgrade` handle schema version 2.
  - `applyCombinedReviewDecisionsWithRefusalLog` records refusals of both
    kinds.

```ts
let state = startHumanGapReview(startHumanReview(workflow, audio)); // MB-07 -> MB-09
const queue = humanOnlyGapQueue(state);
const item = queue.find((item) => item.allowedActions.includes("CONFIRM_ARTIST"));
if (!item) throw new Error("No artist gap is available for confirmation.");
const result = applyHumanGapDecision(state, {
  reviewId: "r-42", recordingId: state.recordingId, gapId: item.gap.gapId,
  basis: humanGapBasisFor(state, item.gap.gapId),
  reviewer: { reviewerId: "dana" }, reviewedAt: new Date().toISOString(),
  action: { action: "CONFIRM_ARTIST", exactArtist: "Fictional Artist", primaryArtist: "Fictional Artist" }
});
if (result.ok) state = result.state; // otherwise result.rejection.code explains why; state is unchanged
await store.saveCombined(state, { expectedRevision, refusedDecisions });
```

### Which gaps MB-09 resolves

A gap is handled by MB-09 only when all three conditions hold:
- `gap.resolvedBy === "human"`
- the gap is not research-eligible (`!gap.researchEligible`)
- the gap is not in the `approval` area

Research-eligible gaps stay with MB-07. `approval-pending` and other approval
gates are never resolved here; they belong to the separate final approval
step.

### Actions

| Action | Allowed when | Rules |
| --- | --- | --- |
| `SET_FIELD` | The gap names one of: `submitterName`, `email`, `title`, `featuredArtist`, `officialReleaseDate`, `albumReleaseDate`, or a yes/no declaration | Only a field of the active gap can be set. Values use the existing project rules: MM/DD/YYYY dates, a valid email, `yes`/`no` declarations, limits on length and control characters, and no emails or local paths in other text fields. Setting a field to its current value is refused. |
| `CONFIRM_ARTIST` | Artist-attribution gaps | Calls `confirmArtistAttribution()`. The reviewer must select the Exact Artist explicitly; primary, secondary, and tertiary artists are optional explicit assignments. An Orchard `CONFLICT`, or an Exact Artist that Orchard did not offer, requires a note. Without Orchard attribution the decision is refused with `PROVENANCE_REQUIRED`; nothing is invented. |
| `CONFIRM_AUDIO` | Audio gaps | Calls `confirmAudioSelection()` with an evaluated candidate's opaque `audioFileId`, or with `null` to confirm that no audio is attached. A candidate with conflicting metadata requires `acknowledgeConflicts: true` and a note. The file is never read, copied, or uploaded. |
| `ACKNOWLEDGE` | Warning and informational gaps | Requires a note. The finding stays in the gap report, marked as acknowledged. Blocking gaps cannot be acknowledged. |
| `DEFER` | Any human-only gap | Records the deferral only. The recording and approval status do not change. |

Unanswered declarations are never filled in automatically. Research
confidence is not treated as approval, and Gemini or MusicBrainz suggestions
are never accepted by MB-09.

Each decision carries a `basis`: the recording identity fingerprint and a
digest of the gap and its current values. A decision is refused, leaving the
state unchanged, if any of these apply:

| Code | Reason |
| --- | --- |
| `STALE_DECISION` | The basis no longer matches. |
| `DUPLICATE_REVIEW` | The review ID was already used by an MB-07 or MB-09 decision. |
| `MISMATCHED_DECISION` | The decision belongs to another recording. |
| `ACTION_NOT_ALLOWED` | The action or field is not allowed for this gap. |
| `ALREADY_DECIDED` | The gap is already acknowledged or deferred. |
| `INVALID_VALUE` | The value fails validation. |
| `NOTE_REQUIRED` or `ACKNOWLEDGEMENT_REQUIRED` | A required note or acknowledgment is missing. |
| `INVALID_DECISION` | The decision is malformed. |

Accepted decisions return a new frozen state and an audit entry.

### Research and manual review together

`HumanGapReviewState` contains:
- the MB-07 state, whose `recording` reflects both kinds of change
- the manual audit trail
- `reviewEvents`, one event per accepted decision in the order it was
  applied (`RESEARCH` or `MANUAL`, with the review ID and audit sequence)

Each manual audit entry also stores its `eventSequence`.

MB-07 decisions still go through `applyHumanReviewDecision` unchanged, and
research proposals are still checked against the recording identity and
evidence they were generated from. A manual change that alters the recording
identity makes older research decisions `STALE_DECISION`. For example,
confirming an Exact Artist that differs from the stored artist does this.

If a manual change touches an `APPROVED` recording, the recording returns to
`NEEDS_REVIEW` and must be approved again. MB-09 never sets `APPROVED`;
final approval (`reviewAndApproveRecord`) is still a separate, explicit
operation.

### Persistence and replay (schema version 2)

Combined sessions are saved as schema version 2 by `saveCombined` and read by
`loadCombined`. They use the same backend, storage keys, locks, atomic
replacement, `expectedRevision`, `REVISION_CONFLICT`, `HISTORY_REWRITE`,
`LOCKED`, SHA-256 checksum, and optional HMAC-SHA256 signature as MB-08. The
signature also covers the manual audit and event counts and `upgradedFrom`.

On every save and load the store rebuilds the session from the original MB-06
snapshot and pending research decisions. It then replays every event in its
recorded order: research events through MB-07 and manual events through
`applyHumanGapDecision`, so the same rules apply as when the decision was
made. The result must equal the stored state exactly.

A manual audit entry keeps the exact validated action (`replay`) so that
legitimate changes can be rebuilt. This internal field may hold a contact
value. `publicHumanGapAuditTrail()` and `humanGapReviewSummary()` omit it,
and their previous and resulting values redact emails and local paths.

Replay rejects all of the following with `INTEGRITY_CHECK_FAILED`:
- unreviewed metadata changes
- forged confirmations
- edited, deleted, or reordered history
- duplicate review IDs
- stale bases
- changed evidence
- approval status changed outside final approval

When saving, the stored research history, manual audit trail, events, and
refusals must each be a prefix of the new ones; otherwise the save fails
with `HISTORY_REWRITE`.

Refused manual decisions are appended to the same append-only refusal log
(`kind: "MANUAL"`, with the MB-09 rejection code). Their text is redacted and
length-limited, and the state is unchanged.

### Version-1 compatibility

`REVIEW_SESSION_SCHEMA_VERSION` is still `1`, and MB-08 sessions keep working
exactly as before:
- `load` and `save` read and write version 1 using the MB-08 replay rules.
- `load` reports `INCOMPATIBLE_VERSION` for a version-2 document, and `save`
  will not overwrite one.
- `loadCombined` and `saveCombined` report `UPGRADE_REQUIRED` for a version-1
  document.

To upgrade, call `upgrade(recordingId, { expectedRevision })` explicitly:
1. It verifies the version-1 document under its own rules.
2. It wraps it unchanged, keeping the original snapshot, research history,
   and refusals, with the existing audit entries as the first events.
3. It writes version 2 at the next revision.
4. It records `upgradedFrom` (the old schema version, revision, and content
   digest).

Nothing is reinterpreted or discarded, and an already upgraded document is
reported as `unchanged`.

### Limitations

- Without `integrityKey`, edits that stay internally consistent cannot be
  detected once the checksum is recomputed:
  - edited free text (notes, reviewer identity, timestamps)
  - reordering independent decisions and renumbering every sequence to match

  With the key, any edit fails to load.
- The internal replay data contains the exact values entered (including
  contact details). Files are not encrypted at rest, as in MB-08.
- There is no user interface; decisions are built by the caller (see
  `scripts/humanGapReviewDemo.ts`).
- Final approval and Mediabase submission are out of scope.

### Offline demonstration

The demo uses a fictional Orchard record, fictional reviewers, and simulated
audio metadata (three candidate files, one with conflicting metadata) in a
temporary folder. It:
1. Runs MB-06.
2. Creates an MB-07 session and accepts the verified label.
3. Saves it with MB-08 (version 1), then upgrades it explicitly.
4. Loads the saved session.
5. Confirms the Exact Artist (MB-09).
6. Rejects the research UPC (MB-07).
7. Answers a declaration (MB-09).
8. Selects the ISRC-matched audio file, after a refused unacknowledged
   selection of the conflicting file is logged.
9. Saves the combined history.
10. Simulates a restart, reloads and verifies the history, and shows that a
    stale session save gets `REVISION_CONFLICT`.
11. Prints the outstanding gaps and review status.

The recording stays DRAFT; nothing is uploaded or submitted.

```sh
npm run gap:demo
npx playwright test tests/human-gap-review.spec.ts tests/review-persistence.spec.ts --reporter=line
```

## MB-10: End-to-End Workflow and Mock Submission

MB-10 links the existing stages into one resumable, fully offline pipeline. It
does not reimplement research or review. It calls MB-06 through MB-09 and adds
four things: final readiness validation, an independent form preflight, a real
multipart upload to a local mock, and a persistent submission ledger.

```
Orchard CSV + audio files
  -> import + audio extraction/matching          (existing importers)
  -> MB-06 research and gap analysis              (recordingWorkflow.ts)
  -> MB-07 research review + MB-09 human-only gaps, saved by MB-08 (schema v2)
  -> explicit final approval by a person          (stored in the submission ledger)
  -> readiness validation, before any browser opens  (submissionReadiness.ts)
  -> Playwright form filling                      (prepareMediabaseForm)
  -> independent DOM preflight                    (formPreflight.ts)
  -> multipart upload to the loopback mock        (mockMediabaseServer.ts)
  -> receipt verification and confirmation        (submissionCoordinator.ts)
```

| File | Role |
| --- | --- |
| `src/workflow/submissionCoordinator.ts` | Orchestrator: `importRecordings`, `approvalBasis`, `approve`, `evaluate`, `submit`, `processQueue`, `reconcile`, `status`, `metrics` |
| `src/submission/submissionReadiness.ts` | Submission policy, content fingerprint, stable submission ID, readiness exceptions |
| `src/submission/audioTagVerification.ts` | Reads embedded tags in the selected file and compares them with the approved record |
| `src/submission/namingProfile.ts` | Injectable upload filename policy |
| `src/submission/formPreflight.ts` | Reads the rendered form independently and compares it field by field |
| `src/submission/mockMediabaseServer.ts` | Loopback-only multipart receiver with scripted outcomes |
| `src/submission/submissionLedger.ts` | Append-only, per-recording attempt history (digest and optional HMAC) |
| `src/submission/submissionSafety.ts` | Destination and network guards |

### States

Each recording moves through `IMPORTED`, `VALIDATING`, `NEEDS_ATTENTION`,
`READY`, `FILLING_FORM`, `PREFLIGHT_FAILED`, `SUBMITTING`, `SUBMITTED`,
`FAILED`, and `OUTCOME_UNKNOWN`. Every change is appended to the ledger's
`statusHistory`, with a timestamp and reason. Earlier entries are never
rewritten.

### Final approval is separate and explicit

- The coordinator never writes to the review session. In the review,
  `approvalStatus` stays `DRAFT`.
- Final approval is a separate decision. It names the approver and the time,
  and it is stored in the ledger.
- `approvalBasis()` binds an approval to three things: the review revision, a
  content fingerprint of the reviewed recording, and the SHA-256 of the
  selected audio bytes.
  - If any of these changes later, the approval becomes `APPROVAL_STALE` and a
    person must approve again.
- Approval is refused (`APPROVAL_REFUSED`) while any readiness exception
  remains. A duplicate approval ID is refused as well.

### Readiness validation (before the browser)

`assessSubmissionReadiness` reports structured exceptions. Nothing is invented
to clear them. It checks:
- unresolved MB-09 human-only gaps, and blocking MB-06 gaps
- the required submitter, artist, title and release-date fields
- that the exact artist attribution is confirmed and the ISRC is validated
- that all four declarations are answered
- that an audio file is selected and exists
- the MB-07 preparation rules
- the embedded audio tags. Missing, mismatched, and unsupported tags are
  reported separately. A conflict a person has acknowledged through MB-09 is
  kept as a warning; an unacknowledged conflict blocks.
- the upload filename, against the naming profile

Each exception is classified as `SPONSOR_DECISION` (a person must decide),
`RECOVERABLE`, or `INTEGRITY`.

Only two corrections are automatic, and each is recorded in the ledger with the
rule that allowed it:
- `applyAudioMatch:conflict-free-isrc`: at import, an audio file whose
  embedded ISRC matches is selected, but only if no other tag conflicts.
- A filename rename, only when the injected naming profile permits it.

The default profile (`SAFE_FILENAME_PROFILE`) only rejects unsafe names. It
makes no assumption about a destination naming convention. Inject one with
`createTemplateNamingProfile(id, "{isrc}{ext}")` or a custom
`UploadNamingProfile`.

### Independent preflight

After `prepareMediabaseForm` fills the page, `runFormPreflight` reads the
rendered DOM directly:
- every text value
- the checked radio in each group
- the attached file's name, and the number of attached files

It compares these with values derived from the approved record, not with what
was passed to the form filler. A difference produces typed failure codes,
including:
- `FIELD_VALUE_MISMATCH`, `FIELD_MISSING`, `UNEXPECTED_FIELD_VALUE`
- `RADIO_SELECTION_MISMATCH`
- `FILE_NAME_MISMATCH`, `FILE_SIZE_MISMATCH`, `FILE_DIGEST_MISMATCH`,
  `FILE_COUNT_MISMATCH`, `FILE_INPUT_MULTIPLE`
- `SUBMISSION_ID_MISMATCH`, `ALREADY_SUBMITTED`

Any failure blocks submission and sets `PREFLIGHT_FAILED`.

An optional `explainer` may describe a failure. Its output is advisory only and
cannot unblock the recording.

### Mock upload, outcomes, retries and reconciliation

- **The upload.** The mock page posts real `multipart/form-data`, including the
  audio bytes, to `startMockMediabaseServer()` on `127.0.0.1`.
- **The receipt.** The coordinator then looks up the receipt and verifies it:
  - the fields digest
  - the filename and file size
  - the SHA-256 of the received bytes
  - that exactly one file was received
- **The confirmation.** It is persisted only when the receipt verifies.
- **Scripted mock outcomes:** `success`, `validation-error` (422),
  `unavailable` (503), `delay`, `reset-before-receipt`, and
  `ambiguous-after-receipt`.

Retry rules:
- **Retried automatically.** Only an explicit "stored nothing, retryable"
  response (503 or 429) is retried, up to `maxAttempts` (default 3) with
  bounded delays. When retries run out, the status is `FAILED` with
  `TRANSPORT_RETRY_EXHAUSTED`.
- **Rejected by the destination.** A validation rejection is `FAILED` with a
  `DESTINATION_REJECTED` sponsor-decision exception. It is not retried, and the
  queue continues with the next recording.
- **Possibly received.** Any outcome that might have reached the server (a
  timeout, a lost connection, an unverifiable receipt, or a crash after the
  attempt started) becomes `OUTCOME_UNKNOWN`. It is never resent
  automatically. `reconcile()` looks up the receipt:
  - Found and verified: `SUBMITTED`.
  - Not found: `FAILED`. The person may then submit again explicitly.
  - Found but different: stays `OUTCOME_UNKNOWN` with an integrity exception.
- **Duplicates.** Each submission has a stable ID. It is derived from the
  recording, the destination, and the content fingerprint. Concurrent submits
  of the same recording are refused (`SUBMISSION_IN_PROGRESS`), and a
  `SUBMITTED` recording is never sent again (`alreadySubmitted: true`).

Finding for live testing: when a reused keep-alive connection resets before any
response bytes arrive, browsers may silently resend a POST. The mock
deduplicates on the submission ID and reports `duplicate: true`, which the
coordinator records as `DESTINATION_ALREADY_HAD_SUBMISSION`. Whether real
Mediabase deduplicates is unknown.

### Persistence and compatibility

- Review sessions use the MB-08/MB-09 store unchanged. Schema versions 1 and 2,
  replay, digests, and signatures are untouched.
- Submission state lives in a separate ledger, one key per recording and
  destination. It has the same guarantees as review storage:
  - revisions
  - append-only attempts and status history
  - a SHA-256 digest, plus an HMAC when a key is supplied
  - locking and atomic writes
- On restart, the coordinator resumes from the ledger. An attempt interrupted
  mid-flight becomes `OUTCOME_UNKNOWN`. Reviews are never applied twice and
  completed recordings are never resubmitted.
- Corrupted or tampered review or ledger files are refused as `INTEGRITY`
  exceptions.
- The ledger stores error codes, digests, and IDs. It does not store email
  addresses, notes, local paths, or raw server messages.

### Safety

- `assertLocalDestination` throws `LiveDestinationForbiddenError`
  (`LIVE_DESTINATION_FORBIDDEN`) for any non-loopback URL. Any
  `mediabase.com` host is always refused.
- `installLoopbackNetworkGuard(page)` aborts every non-loopback request the
  page makes. The mock page's own submit code also refuses non-loopback
  targets.
- Nothing in MB-10 contacts real Mediabase, uses an account, or calls a paid
  API.

### Metrics

`metrics()` returns:
- counters (imports, approvals, attempts, retries, and outcomes)
- per-stage timings (validation, form fill, preflight, network, receipt
  verification)
- research usage reported by the providers

`cost` is always `null`, because no API prices are configured and none are
estimated.

### Limitations, and what supervised live testing still needs

- **Mock success is not live success.** `SUBMITTED` here means only that the
  local mock received and verified the upload. A live submission needs a
  confirmation from real Mediabase, which is out of scope.
- **Real form not verified.** The real form's field names, file limits,
  confirmation format, and receipt lookup are unverified. A live destination
  needs its own `SubmissionDestination`, especially `lookupReceipt`, for
  reconciliation.
- **Live behavior unknown.** Real Mediabase's deduplication and retry behavior
  (see the finding above) must be checked under supervision.
- **Locks.**
  - JSON-file locks never expire (MB-08 behavior); remove a stale lock by hand.
  - The in-flight guard is per process. Across processes, the ledger lock
    serializes access.
- **Not encrypted.** Files are not encrypted at rest.

### Commands

```sh
npm run mb10:demo            # add -- --keep to inspect the saved JSON files
npx playwright test tests/mb10-submission.spec.ts --reporter=line
```

The demo uses three fictional recordings and real WAV files written to a
temporary folder:
- One recording submits on the first attempt.
- One recovers automatically: the audio match is applied at import, and a 503
  is retried.
- One is flagged because a person deferred a declaration, so approval is
  refused.

After a simulated restart it runs the queue. It verifies the SHA-256 of each
received file against its source, runs the queue again to show that nothing is
sent twice, and prints the ledger, timings, and counters.

## MB-11: Verified Audio Preparation

MB-11 prepares a separate, verified MP3 copy from already-reviewed metadata.
It preserves the MB-06 through MB-09 decision rules and MB-08 review-event
history; preparation manifests are stored separately and do not rewrite review
history or grant final approval.

```text
reviewed recording + selected source audio
  -> validate approved metadata and source tags
  -> write a separate ID3-tagged MP3 copy
  -> independently read tags back
  -> compare the complete MPEG frame payload and decode both files
  -> append a checksummed preparation manifest
  -> MB-10 verifies the manifest and requires separate final approval
  -> local mock submission only
```

`src/submission/audioPreparation.ts` exposes `prepareAudioArtifact` for one
record and `prepareAudioArtifactsBatch` for a batch. Batch preparation
continues after per-record failures and blocks destination filename
collisions. Output files are created without overwriting existing files.
`src/submission/audioPreparationStore.ts` appends versioned, per-recording
manifests through the existing review storage backend, with SHA-256 integrity
checks and optional HMAC-SHA256 signatures. Set an integrity key in the
application configuration to authenticate persisted manifests.

Tag selection uses an explicit, versioned `AudioTagProfile`. Values come only
from the reviewed recording, validated fields, Orchard provenance, or a
reviewer-approved explicit source. Existing tags that conflict with reviewed
identity data are not silently replaced; non-ISRC conflicts require an
identified reviewer, note, and field-level acknowledgment. The source audio
file is never changed. Existing ID3 metadata, including unrelated user frames
and artwork, is preserved and checked by tests.

The default `SPONSOR_METADATA_CONTRACT` is separately versioned and requires
the sponsor's reviewed metadata, including ISRC, release year, album and album
artist, genre, publisher information, comments, and clean/explicit status.
Additional artists and versions are required when applicable. It records
field-level evidence and distinguishes a known value from a supported
embedded mapping. Missing values and conflicts block the individual record.
In particular, the publisher and content-rating encodings are **not confirmed**:
even a known value cannot currently pass the strict contract as an embedded
tag. `Radio`, `DJ Version`, and `(AI)` are not clean/explicit decisions.
Publisher aliases require an individually approved, versioned rule; no legal
identity is inferred from similar names.

The default `SPONSOR_TITLE_NAMING_PROFILE` derives the upload name from the
reviewed title, applicable version, and detected extension. It rejects unsafe,
reserved, or overlong names rather than truncating or silently disambiguating
them. A prepared upload's name is checked against its manifest and actually
used by the form. `allowUploadRename` must still be explicitly enabled when
that name differs from the private artifact filename. Title-profile preparation
requires a shared preparation store, which serializes and checks names across
recordings as well as within a batch.

The prepared MP3 is independently read back, its MPEG Layer III frame stream
must exactly match the source, and both streams must decode with the same
sample rate, channel count, and decoded sample count. MB-10 can be configured
with `audioPreparationStore`; when present, it refuses approval/submission
unless a current prepared artifact and manifest verify. Final approval is
still a separate explicit human decision.

Destination naming is injectable and versioned via
`UploadNamingProfile`/`createConfigurableNamingProfile`. The title policy is a
sponsor requirement, not a claim about production Mediabase policy. The
included `BASIC_FILENAME_PROFILE` is a technical example only. An ISRC alone
no longer authorizes automatic audio selection, and conflicting identity or
duration among files sharing an ISRC requires review.

### MB-11 limitations and sponsor decisions

- MP3 tagging is supported. WAV tagging fails closed with
  `UNSUPPORTED_TAG_WRITE`; audio is not converted or re-encoded.
- The MP3 decoder verifies decodability and preserved frame payload; it is not
  a substitute for listening tests, loudness checks, or a full media-quality
  certification workflow.
- Publisher and clean/explicit frame mappings, genre vocabulary, exact
  multi-artist representation, and destination compatibility remain unresolved.
  The confirmed and outstanding decisions are tracked in
  [MB11_SPONSOR_DECISIONS.md](./MB11_SPONSOR_DECISIONS.md).
- Preparation manifests include the local artifact path so that MB-10 can
  resume. Restrict access to the local storage directory and avoid publishing
  manifests or logs; persisted files are integrity-protected but not encrypted
  at rest.
- The demo's upload is to the loopback mock only. A mock receipt is not a
  Mediabase confirmation, and no live Mediabase connection or submission is
  implemented.

### MB-11 commands

```sh
npm run mb11:demo
npm run mb11:demo -- --keep
npx playwright test tests/audio-preparation.spec.ts --reporter=line
npm run typecheck
```

The offline demo uses fictional records, a deliberately separate fictional
technical-test contract, and generated MP3 fixtures; it does not claim that
the unresolved strict sponsor mappings are supported. It shows a
successful preparation and local mock upload, a missing-tag correction sourced
from reviewed values, and an unresolved required genre that remains blocked.
It prints measured timings and configured usage counters; cost is not
estimated. No real Mediabase, paid API, or sponsor account is contacted.
