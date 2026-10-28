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
| Exact Artist | `artist` | Required |
| Featured Artist | `featuredArtist` | Optional |
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
| Upload song audio here. | `audioFilePath` | Optional; the mock accepts one file |

The official page is rendered dynamically and may require access or session
context. The field labels and controls documented here were verified from its
rendered form. Production-side validation, upload processing, submission
behavior, account requirements, and the exact accepted syntax for the Hide
Until date/time and time-zone text still require manual verification. This
mock intentionally does not claim to reproduce those undocumented behaviors.

## Orchard CSV import review policy

The Orchard importer uses `TRACK ARTIST` as the provisional track-level
`artist` value when it is populated and falls back to `PRODUCT ARTIST` only
when the track artist is absent. Both source values remain in the import
report. When both are present and differ, the importer emits an
`artist-conflict` warning for human verification. `PRODUCT ARTIST` is never
automatically mapped to `featuredArtist`. This mapping remains subject to
sponsor confirmation.

Imported ISRC state is retained separately from the validated form value.
Malformed nonempty source values block approval until corrected and
revalidated. A genuinely missing source ISRC may remain blank only after the
reviewer explicitly confirms it during approval.
