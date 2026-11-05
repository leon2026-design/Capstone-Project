# MB-11 Sponsor Decisions

MB-11 deliberately fails closed where the destination's audio requirements are
not confirmed. The defaults in this prototype do not claim to represent
Mediabase production policy.

Please confirm:

1. **Tag Editor compatibility:** Which Tag Editor product and version should
   prepared files target? Are there restrictions on ID3 version or frames?
2. **“Rye M”:** What does this label mean, where does it appear in the tagging
   workflow, and which metadata field (if any) should represent it?
3. **Destination filenames:** What exact naming convention, character set,
   maximum length, and case policy should be configured for each destination?
   Until confirmed, no speculative destination convention is enabled.
4. **Clean/explicit status:** What is the authoritative source and field for
   clean/explicit status? Is a human decision required, and how should it be
   encoded in each supported audio format?
5. **Required tags:** Which fields are required for each destination, format,
   release type, and submission category? In particular, confirm treatment of
   album artist, comments, year, genre, and content rating.
6. **Artist representation:** How should primary, secondary, and tertiary
   artists be represented in embedded tags? Should featured artists be
   included, and if so, which reviewed source is authoritative?
7. **WAV preparation:** Is WAV tagging required? If so, which RIFF/INFO or
   embedded-ID3 fields and versions are accepted?
8. **Genre vocabulary:** Is there a controlled vocabulary or catalog source
   for genre values? No genre is inferred by this implementation.
9. **Original files:** Confirm that the originals must remain unchanged and
   that a separate prepared copy is the desired operational workflow.

## Current conservative behavior

- Only validated, reviewed, or explicitly approved values are copied.
- MP3 files receive ID3 updates in a separate artifact; unrelated ID3 frames,
  including artwork, are preserved by the selected library and covered by
  regression tests.
- WAV tagging currently fails closed with `UNSUPPORTED_TAG_WRITE`.
- `Rye M`, genre, and content rating remain unmapped unless explicitly
  configured with a trusted source and reviewer approval.
- Destination naming is an injected, versioned profile. The built-in profile
  is a technical example, not a confirmed sponsor convention.
- Source audio is never edited. Prepared MP3 frame payloads must be decodable
  and byte-for-byte unchanged from the source.
