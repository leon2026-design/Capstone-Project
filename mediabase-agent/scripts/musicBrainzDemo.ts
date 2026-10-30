import { lookupMusicBrainzByIsrc } from "../src/research/musicBrainzLookup";

async function main() {
  const isrc = process.argv[2];

  if (!isrc) {
    console.error(
      "Provide an ISRC: npx tsx scripts/musicBrainzDemo.ts YOUR_ISRC"
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

  const result = await lookupMusicBrainzByIsrc(record, {
    userAgent:
      "CapstoneMediabaseAgent/1.0 (https://github.com/leon2026-design/Capstone-Project)"
  });

  console.log(JSON.stringify(result, null, 2));
  console.log("Record unchanged:", JSON.stringify(record) === before);
  console.log("Approval status:", record.approvalStatus);

  if (result.status === "FAILED" || result.status === "INVALID_ISRC") {
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("MusicBrainz demo could not complete.");
  process.exitCode = 1;
});