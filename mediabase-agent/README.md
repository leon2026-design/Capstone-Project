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

## Running checks

```sh
npm run typecheck
npm test
```

Audio tests generate minimal fictional WAV/MP3 files at runtime
(`tests/support/audioFixtures.ts`) in Playwright's output directory; no real
recordings are committed.
