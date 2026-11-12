# Marketing Agent v1.0 integration (MA-INT-01)

## Deployment

1. Use a test Apps Script project and private test copies first. Do not push this
   branch to the production project until the actual-report checks below pass.
   Keep report files, credentials, spreadsheet contents, and local clasp
   credentials out of Git.
2. Deploy the repository's root JavaScript files and `appsscript.json`. With
   clasp, check the selected project and run `clasp status` before `clasp push`.
   `.claspignore` excludes Mediabase, local tests, and other local files.
   The manifest already enables Advanced Drive **v2**, used to convert Word
   documents into a temporary Google Doc/PDF. Enable the corresponding Drive API
   in the linked Google Cloud project if required.
3. Configure these **Script Properties** in the Apps Script editor:

   | Property | Value |
   | --- | --- |
   | `GEMINI_API_KEY` | Existing Gemini credential; never commit it |
   | `PARSER_INPUT_FOLDER` | Private Drive folder for uploaded PDF/Word files |
   | `PARSER_OUTPUT_FOLDER` | Different private folder for successfully processed originals |
   | `SPREADSHEET_DATA_EXTRACTION` | Existing extraction spreadsheet ID |
   | `CONTACT_DATABASE_SPREADSHEET_ID` | Different, existing contact spreadsheet ID |

4. The contact spreadsheet must contain `Master_Contacts` with these headers
   (additional existing columns are preserved):

   ```text
   Contact ID | Name / DJ Alias | Role | Station / Venue / Organization | City | State / Region | Country | Email | Phone | Social Accounts | Sources | Review Status | Review Notes | Last Updated
   ```

5. As the account with folder/spreadsheet access, run
   `installMarketingAgentTrigger` **once** and complete Google's authorization.
   It validates configuration and replaces only this account's timers for
   `runScripts`, `runAutomatedFunctions`, and `runMarketingAgent` with one
   five-minute `runMarketingAgent` timer. Other accounts must remove their own
   legacy Marketing timers; Apps Script cannot enumerate another owner's timers.
6. Thereafter Brad only uploads reports into the input folder and opens
   **DJ_Actionable_Contacts** in the contact spreadsheet. No extraction, import,
   or linker function needs to be run individually.

The two legacy entry points now delegate to the same Marketing workflow. It
does not schedule unrelated radio-director discovery, ISRC enrichment, or
whole-spreadsheet sorting. Their existing functions remain available separately.
PDF, `.docx`, and legacy `.doc` are supported by the contact workflow. Unrelated
files are left untouched. Existing CSV extraction still runs once, separately
from PDF/Word contact importing.

## Data and review behavior

- Each report is extracted once, imported once, then its original file is moved
  only after import success. Word conversion never replaces the original source
  ID/URL with a generated PDF's identity.
- Existing MA-04 history remains in `Master_Contacts`. New history also retains
  flat report-specific fields (normalized header keys), explicit download/listen
  flags/counts, comments, ratings, favorite track/remix, and original provenance.
- Unique nonconflicting email matches and already-verified social matches link
  safely. A name alone, unverified social match, competing contact, or conflicting
  identity goes to the existing `DJ_Identity_Review` and `DJ_FollowUp_Queue`.
  The agent never invokes contact merge operations.
- Record decisions using the existing `djIdentityReviewDecision` workflow
  (`CONFIRM_LINK`, `NO_LINK`, or `NEEDS_RESEARCH`). On the next timer, approved
  links flow through the existing engagement linker. Unresolved recipients stay
  visible with a blank Contact ID and `IDENTITY_REVIEW`; they do not stop others.
- The actionable tab has one row per resolved contact/report response, plus
  unresolved observations. It includes all required identity, campaign, feedback,
  contact, source, timestamp, and follow-up fields. It is a regenerated view, not
  a reviewer-editable source of truth.
- `VERIFIED` means the master has been marked Reviewed/Verified or has an
  explicitly verified stored social profile. A safe match is not itself proof
  of email deliverability or social ownership. Other contacts are `UNVERIFIED`;
  unresolved observations are `UNRESOLVED_IDENTITY`.
- Explicit affirmative download evidence wins: `THANK_YOU_DOWNLOAD`, regardless
  of rating. Any written comment independently qualifies for
  `RESPOND_TO_FEEDBACK`, not automatic positive-sentiment inference. Other
  categories are `FOLLOW_UP_LISTEN` and `NO_CONFIRMED_ENGAGEMENT`.
  Favorites, ratings, planned downloads in comments, zero counts, and negative
  download statuses never prove a download.

## Recovery and operational limits

- `Marketing_Run_Log` and Apps Script execution logs identify recoverable failures.
  Other reports continue, and output is refreshed before the run reports failure.
  `Import_Log` remains the observation/identity audit.
- `MA_REPORT_<Drive ID>` Script Properties checkpoint extracted/imported states.
  A retry resumes at import or archive without another Gemini call. Deterministic
  new Contact IDs also repair a row write interrupted before its audit entry.
  Unchanged observations and history are idempotent.
- Do not edit imported extraction tabs or overwrite source files in place.
  Upload a corrected report as a new Drive file so both reports retain provenance.
  Missing/corrupt checkpoints fail explicitly rather than guessing at identity.
- Runs never overlap. A run owns the `MA_RUN_LEASE` Script Property (owner id plus
  a seven-minute expiry, renewed at each save). A timer that fires while another run
  holds a live lease logs a skip and exits. A lease left by a killed execution
  expires and is reclaimed by a later timer. A run that lost its lease cannot save
  results. The script lock is held only for short checkpoint/sheet writes, never
  during a Gemini request. No destructive merge is automatic. A failed existing-contact update writes a complete row, while
  history is saved before its disposable summary. Retries repair incomplete
  history/summary writes from preserved report rows.
- The current MA-04 store retains its 40,000-character history-cell safety limit
  and one response per contact/report. Conflicting responses within one report
  fail visibly and retain the source for investigation rather than overwriting
  an existing history.
- Gemini extraction is resumable per section. A report is split into sections of
  about four pages (at most eight, the last one open-ended), requested one at a
  time with `UrlFetchApp` `timeoutSeconds: 90`. Each validated section is saved
  immediately to the `MA_Section_Staging` tab of the extraction spreadsheet, and
  its state is kept in the `MA_JOB_<Drive ID>` Script Property, keyed to a digest
  of the original file. A later run requests only unfinished sections. A changed
  file restarts its job. The importer never reads the staging tab.
- A timeout, network error, malformed response, HTTP 429, or HTTP 5xx is retryable:
  that section waits about 4, 9, 19, 39, then 59 minutes, while other sections and
  reports continue. Other HTTP errors, or six failed attempts, mark the section
  failed and block only its report. After fixing the cause, run
  `marketingRetryFailedReports()` (it refuses while a run is active).
- A new Gemini request starts only if it can finish within four minutes of run
  start, which reserves time for import and output within Google's six-minute
  limit. The report is imported only after every section is saved and its staged
  rows re-validate. Missing or damaged staged sections are requested again rather
  than importing a partial report. Each section attempt costs one Gemini request.
  Provider, Drive, Sheets, and Script Property quotas still apply. No new
  queue/enrichment subsystem is introduced.
- `UrlFetchApp` errors can include the request URL. `key`, `api_key`, and
  `access_token` query values are replaced with `[redacted]` before an error is
  stored in job state, written to `Marketing_Run_Log`, or logged.

## Validation

Run all Marketing regressions (Node's built-in runner, no dependency install):

```powershell
node --test local-tests\*.cjs
```

`local-tests/MarketingIntegration.test.cjs` exercises the real entry point,
parser, matcher, importer, MA-04 history, MA-05 reviews/linker/queue, and actionable
writer with mocked Google/Gemini boundaries and fictional recipients. It covers
new/known/ambiguous identities, low-rating downloaders, independent written
support, repeats, extraction/archive/contact/history failures and retries,
Word conversion/provenance, duplicate observations, safe social rules, trigger
installation, and completed output. Simulated Gemini cases cover slow and timed-out
sections, HTTP 503 backoff, permanent errors, overlapping timers, killed executions
with stale leases, late results from a lost lease, corrupted staging, and resuming
a partially completed report. These tests are **not a live demonstration**.

For actual acceptance, use private copies of Brad's Inflyte PDF and Word report:
install the timer, upload, wait for an actual scheduled execution, compare every
recipient and engagement section against the originals, verify archived sources
and the accessible Sheets tab, and requeue the same test file to verify no extra
extraction/contact/history. Exercise one recoverable failure, then restore the
test configuration. Do not commit any report or confidential sheet contents.
The PR must distinguish local results, actual-report results, and remaining
deployment/access blockers. MA-06 PR #32 remains separate.
