# TFB-172 / MB-I1 Integration Review

## Integration scope
- Branch: integration/tfb-172-mb11
- Approved development baseline: ab69bff6ece20d984be51aa5a25366678efa5c14
- Original MB-11 implementation: 8ac100df689bc408dacc8f454f962973dfa1adae
- Integrated source tip, including complex remix-name fix: 2db86c871a6ca31d86de80359697c3d809e0ea8a
- Source history and dependency changes reviewed before integration.
- Git combined the branches without conflicts.

## Validation
Environment: macOS, Node 22.23.4, npm 10.9.9.
Dependencies installed from the lockfile with installation scripts disabled.

- TypeScript check: passed.
- Chromium regression checks: 80 passed in 16.3 seconds.
- Test files: audio-preparation, wav-preparation, client-metadata-contract,
  audio-matching, mb10-submission, sample-audit, version-designation.

Passing synthetic tests cover original-file preservation, MPEG/PCM payload
preservation, artwork, unknown metadata, WAV ancillary chunks, naming,
metadata read-back, unsupported-format rejection, and complex mix names.

MB-10 checks passed for explicit approval, stale approvals, duplicate
prevention, receipt reconciliation, and blocking non-loopback destinations.

These results validate synthetic fixtures and local mock behavior.
They do not establish sponsor-file, Tag Editor, or production compatibility.

## Existing library assessment
The reviewed lockfile pins music-metadata 12.3.2, node-id3 0.2.9,
and mpg123-decoder 1.0.3. music-metadata requires Node 22 or newer.

The prior pinned-checkout comparison found that both the custom ID3 writer
and node-id3 update preserved the tested source buffer, private frame,
and MPEG payload, with correct title read-back. The custom writer retained
ID3v2.4; node-id3 update converted that fixture to ID3v2.3.

The integration tests also pass for artwork, legacy-tag conflicts,
WAV metadata, and audio preservation using the existing implementation.
Equivalent behavior from a replacement library writer has not been
established. Retain the existing writers for this integration.

Read-back uses node-id3 and music-metadata, with some shared custom parsing.
Verification independence is therefore partial.

## Remaining blockers and limitations
Track sponsor decisions under MB-C1, including publisher mappings,
artist/remixer representation, content-rating encoding, exact Tag Editor
product/version, and destination compatibility.

Unsupported or unconfirmed mappings must continue to block preparation.
Original-file preservation remains required.

The prepared-audio policy permits an explicit override; final configuration
must be reviewed against the confirmed sponsor contract.

Sponsor-audio evidence remains associated with TFB-147.
Production readiness and final policy approval are not established here.

## Disposition
Local integration validation passed for the scope above.
Ready for Leon's technical review after the integration commit is recorded.
No merge into main or production Mediabase submission was performed.
