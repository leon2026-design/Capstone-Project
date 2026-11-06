# MB-11 Sponsor Decisions

These are client requirements and prototype behavior, not a statement of
Mediabase production policy.

## Confirmed

- Both MP3 and WAV are source formats; neither format implies a master or a
  distribution copy. Do not transcode or change audio samples.
- Upload names use the reviewed title, applicable version, and extension, not
  an artist prefix, internal ID, or ISRC.
- “Rye M” refers to Rye Music and is a publisher-related client concept.
  Preserve the original value and provenance; do not infer that similarly
  named legal entities or record labels are interchangeable.
- Treat the sponsor-specified metadata as mandatory in the current contract.
  Missing, conflicting, or unconfirmed values require a warning and human
  review rather than invented data.
- Try to establish clean/explicit status from evidence. Radio, DJ, mix, and
  AI labels alone do not establish it.
- Keep original files unchanged and prepare separate artifacts.

## Provisional implementation assumptions

- The reviewed title and explicit reviewed decisions outrank unreviewed
  filename clues. A filename by itself cannot establish clean/explicit status;
  contradictory evidence blocks preparation.
- Version and additional-artist fields are not applicable when no such reviewed
  information is present. Their presence does not authorize inventing a mix
  or artist representation.
- Filename comparison uses Unicode normalization and case folding for
  collision checks. Name length is a conservative prototype limit, not a
  destination guarantee.
- An ISRC must be accompanied by matching artist, title, and version evidence
  for automatic selection. Conflicting same-ISRC durations or identities
  require review.

## Still awaiting sponsor confirmation

1. Exact Tag Editor product and version.
2. Accepted ID3 versions, custom frames, and WAV tag-reader compatibility.
3. Embedded publisher field for Rye Music and individually authorized aliases.
4. Artist, featured-artist, and remixer representations.
5. Genre vocabulary and authoritative source.
6. Clean/explicit encoding in each format.
7. Rights and submission restrictions for white-label or bootleg recordings.
8. Destination format acceptance, character policy, and filename limits.
9. Which currently mandatory fields may later be optional.

## Technically unsupported

- The current strict contract blocks known publisher and clean/explicit values
  with `UNSUPPORTED_TAG_MAPPING`; neither is silently treated as embedded.
- WAV tag writing currently fails closed; no conversion is attempted.
- Unapproved publisher aliases and additional-artist encoding are not inferred.

## Verified by automated tests

- Source-preserving MP3 preparation, independent tag read-back, MPEG payload
  comparison, and decoding are covered by synthetic tests.
- Missing mandatory metadata, clean/explicit ambiguity, approved publisher
  aliases, title naming, and same-ISRC conflicts are covered by synthetic tests.
- Mock submission remains loopback-only and requires explicit final approval.
  The demo's separate fictional technical-test contract is not the sponsor
  contract and does not resolve its outstanding mappings.
