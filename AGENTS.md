# Project Overview

This is an Ohio State University computer science senior capstone for Brad Henry and Rye 51 Music. The repository contains two independent but related automation agents.

## Marketing Agent

- Uses Google Apps Script, Google Drive, Google Sheets, and the OpenAI and Gemini APIs.
- Automatically processes promotional reports, extracts DJ contacts and engagement, maintains campaign history, resolves identities, discovers professional social profiles, and generates actionable contact lists.
- Brad should ultimately interact through Google Sheets and Drive without needing the Apps Script editor.
- The implementation is primarily in the root-level `.js` files, with regression coverage in `local-tests/`.

## Mediabase Agent

- Uses Node.js, TypeScript, and Playwright in `mediabase-agent/`.
- Imports music metadata, matches audio recordings, identifies metadata gaps, researches missing information, supports human approval, and prepares Mediabase submissions.
- Never submit to production Mediabase without explicit authorization.

# Current Development State

- MA-01 through MA-06 and MA-INT-01 are the Marketing Agent milestones.
- MB-01 through MB-10 cover the existing Mediabase workflow.
- MB-11 covers sponsor-driven metadata and WAV preparation.
- Marketing Agent end-to-end report processing has been demonstrated live with an actual Inflyte report and 254 actionable contacts.
- Reprocessing the same report was demonstrated to be idempotent.
- MA-06 live-search development is on `feature/ma-06-live-search`.
- The MA-06-LIVE-02 comparison baseline is commit `2a4ce31`; preserve it for live benchmark comparisons.
- MA-06 supports expanded professional discovery, bounded source-page inspection, search diagnostics, and human verification.
- The MA-06-LIVE-02 local regression baseline is 181 passed and 0 failed. Run the full suite for the current checkout and report its exact results.
- MA-06 live candidate discovery is demonstrated, but final verified-profile coverage and publication into actionable contacts require further validation.
- Compatibility with Brad's actual Word report remains unverified.
- MA-UI-01, the Brad-facing Google Sheets interface, is planned but not implemented.

# Development Rules

- Read the existing implementation before modifying it.
- Preserve existing work and inspect `git status` before switching branches.
- Work on the appropriate feature branch. Never merge to `main` without explicit authorization.
- Do not modify unrelated Mediabase files while working on Marketing Agent tasks, or unrelated Marketing Agent files while working on Mediabase tasks.
- Prefer small, targeted changes and existing infrastructure over new frameworks.
- Do not introduce external services, paid subscriptions, or new infrastructure without approval.
- Never commit API credentials, OAuth tokens, real reports, private DJ contact data, or production configuration.
- Do not modify, stage, or delete the untracked `MB-11 Reworked` specification unless explicitly requested.

# Marketing Agent Safety

- Keep report extraction separate from social enrichment.
- Preserve resumable jobs, checkpoints, retry bounds, leases, and idempotency.
- Never invent contact details or social URLs.
- Search results and AI-generated claims are not independently verified evidence.
- A source containing a social link does not alone prove that it belongs to the correct DJ.
- Never approve a name-only match or treat confidence scores as identity probabilities.
- Preserve MA-06 approval and MA-05 verification requirements unless a separately approved verification policy replaces them.
- Only verified profiles should appear as verified contact channels in `DJ_Actionable_Contacts`.
- No automated outreach.

# Testing

Use the repository's existing local regression tests.

## Marketing suite

```powershell
node --test local-tests/*.cjs
```

## Focused Marketing tests

```powershell
node local-tests/DJEnrichment.test.cjs
node local-tests/DJEnrichmentOpenAI.test.cjs
node local-tests/MarketingIntegration.test.cjs
```

## Mediabase checks

Inspect `mediabase-agent/package.json` for the current commands. At this baseline, the primary checks are:

```powershell
cd mediabase-agent
npm run typecheck
npm test
```

Clearly distinguish mocked tests, synthetic tests, and real live tests. Never claim that passing local tests proves live deployment success.

# Google Apps Script Deployment

- Use the isolated test project and test resources.
- Inspect `.clasp.json` and confirm the target Script ID before any push.
- Run `clasp status` before deployment.
- Never assume the configured Script ID belongs to the isolated project.
- Do not modify production resources, credentials, triggers, or configuration without explicit authorization.
- Preserve the existing `.claspignore` rules.
- Do not expose `.clasprc.json` contents or Google OAuth credentials.
- Do not install duplicate scheduled triggers.
- Verify remote execution capability before attempting live tests.
- Keep API calls and live test batches bounded.

# Immediate Priorities

1. Complete MA-06 identity verification and source attribution.
2. Reduce unnecessary human review without weakening verification.
3. Demonstrate verified discovered social profiles appearing in `DJ_Actionable_Contacts`.
4. Complete a fixed-cohort live discovery benchmark with accurate coverage, correctness, latency, and cost metrics.
5. Build MA-UI-01, a simple Google Sheets interface for Brad.
6. Validate final deployment and continue MB-11 separately.

# Reporting Expectations

At the end of each task, report:

- Files changed.
- Tests run and exact results.
- Commit SHA and branch, if committed.
- Live deployment or execution status, if applicable.
- Remaining blockers and decisions that need approval.
