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
`sampleRate`, `bitDepth`, `channels`, `artist`, `title`, `album`, `isrc`
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

`MetadataReviewAction` defines the future review interface's intents:
`APPROVE_SUGGESTED_VALUE`, `EDIT_SUGGESTED_VALUE` (requires `editedValue`),
`REJECT_SUGGESTION`, and `DEFER_DECISION`, linked to the proposal/recording/gap/
field. These are contracts only: there is no action executor, approval change,
or record mutation. Approving a suggestion must not implicitly approve a
record or acknowledge an ISRC conflict.

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
