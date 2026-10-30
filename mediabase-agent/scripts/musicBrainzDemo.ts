import {
  lookupMusicBrainzByIsrc,
  lookupMusicBrainzReleases
} from "../src/research/musicBrainzLookup";

async function main() {
  const isrc = process.argv[2];
  const selectedRecordingId = process.argv[3];

  if (!isrc) {
    console.error(
      "Usage: npx tsx scripts/musicBrainzDemo.ts ISRC [MUSICBRAINZ_RECORDING_ID]"
    );
    process.exitCode = 1;
    return;
  }

  const record = Object.freeze({
    recordingId: "MUSICBRAINZ-LIVE-DEMO",
    isrc,
    approvalStatus: "DRAFT" as const
  });

  const before = JSON.stringify(record);
  const options = {
    userAgent:
      "CapstoneMediabaseAgent/1.0 (https://github.com/leon2026-design/Capstone-Project)"
  };

  const result = await lookupMusicBrainzByIsrc(record, options);

  console.log("ISRC lookup:");
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "FAILED" || result.status === "INVALID_ISRC") {
    process.exitCode = 1;
  } else if (selectedRecordingId) {
    const candidate = result.candidates.find(
      (item) => item.musicBrainzId === selectedRecordingId
    );

    if (!candidate) {
      console.error("Selected recording ID is not among the ISRC candidates.");
      process.exitCode = 1;
    } else {
      const releases = await lookupMusicBrainzReleases(
        candidate.musicBrainzId,
        options
      );

      console.log("Release lookup for the explicitly selected candidate:");
      console.log(JSON.stringify(releases, null, 2));

      if (
        releases.status === "FAILED" ||
        releases.status === "INVALID_RECORDING_ID"
      ) {
        process.exitCode = 1;
      }
    }
  } else {
    console.log(
      "To inspect releases, rerun with a candidate's MusicBrainz recording ID."
    );
  }

  console.log("Record unchanged:", JSON.stringify(record) === before);
  console.log("Approval status:", record.approvalStatus);
}

main().catch(() => {
  console.error("MusicBrainz demo could not complete.");
  process.exitCode = 1;
});