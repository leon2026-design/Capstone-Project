/**
 * Opt-in research demonstration. Never runs during tests (outside tests/).
 *
 *   npm run research:demo                       dry run: no Gemini call, no network
 *   npm run research:demo:live                  one live Gemini call (needs GEMINI_API_KEY)
 *   npm run research:demo:live -- --field isrc --max-calls 2
 *
 * The recording is fictional; Gemini should normally report insufficient evidence.
 * Nothing is approved, written, or submitted, and live Mediabase is never contacted.
 */
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { analyzeMetadataGaps } from "../src/metadata/metadataGapAnalyzer";
import { buildMetadataResearchTasks, RESEARCH_FIELDS, type ResearchField } from "../src/metadata/metadataResearch";
import { importOrchardCsv } from "../src/metadata/orchardImporter";
import { createGeminiResearchProviderFromEnv, GeminiConfigurationError } from "../src/research/geminiResearchProvider";
import { ResearchLimitsError, runMetadataResearch } from "../src/research/researchOrchestrator";
import { parseApprovedSources, SourceVerifier, SourceVerifierConfigurationError } from "../src/research/sourceVerifier";

const HARD_CALL_CAP = 3;

class DemoError extends Error {}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const field = (argument("--field") ?? "label") as ResearchField;
  if (!RESEARCH_FIELDS.includes(field)) throw new DemoError(`--field must be one of: ${RESEARCH_FIELDS.join(", ")}`);
  const maxCalls = Number(argument("--max-calls") ?? "1");
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_CALL_CAP) {
    throw new DemoError(`--max-calls must be an integer from 1 to ${HARD_CALL_CAP}.`);
  }
  if (live && existsSync(".env")) process.loadEnvFile(".env");

  const record = importOrchardCsv(
    "TRACK,TRACK ARTIST,PRODUCT ARTIST,PRODUCT,PRODUCT TYPE,VERSION\n" +
      "Paper Lanterns Over Vell,Oriel Fenwick,The Saltmarsh Choir,Harbor Lights Almanac,Album,Acoustic\n",
    "fictional-demo.csv"
  ).records[0];
  const before = structuredClone(record);
  const task = buildMetadataResearchTasks(record, analyzeMetadataGaps(record)).find((item) => item.field === field);
  if (!task) throw new DemoError(`The fictional record has no research-eligible "${field}" gap.`);

  const approvedSources = parseApprovedSources(process.env.MEDIABASE_APPROVED_SOURCES);
  const result = await runMetadataResearch([task], live
    ? {
        mode: "live",
        provider: createGeminiResearchProviderFromEnv(process.env),
        verifier: new SourceVerifier({ approvedSources }),
        limits: { maxTasks: 1, maxProviderCalls: maxCalls, maxRetries: Math.min(1, maxCalls - 1) }
      }
    : { mode: "dry-run" });

  const [taskResult] = result.results;
  console.log(JSON.stringify({
    mode: result.mode,
    model: result.model,
    task: { taskId: task.taskId, field: task.field, question: task.question },
    approvedSourceHosts: approvedSources.map((source) => `${source.host}=${source.category}`),
    status: taskResult.status,
    attempts: taskResult.attempts,
    grounding: taskResult.grounding,
    verification: taskResult.verification,
    proposal: taskResult.proposal,
    failure: taskResult.failure,
    usage: result.usage
  }, null, 2));

  const unchanged = isDeepStrictEqual(record, before);
  console.log(`\nRecord unchanged: ${unchanged}; approvalStatus: ${record.approvalStatus}; live Mediabase contacted: false`);
  if (!unchanged) process.exitCode = 1;
  if (!live) console.log("Dry run only. Re-run with `npm run research:demo:live` to make one budgeted Gemini call.");
}

main().catch((error: unknown) => {
  // Our own configuration messages never contain the key; anything else stays generic.
  const known = error instanceof DemoError || error instanceof GeminiConfigurationError ||
    error instanceof SourceVerifierConfigurationError || error instanceof ResearchLimitsError;
  console.error(known ? error.message : "Research demo failed. Check configuration and try again.");
  process.exitCode = 1;
});
