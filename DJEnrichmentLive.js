/**
 * MA-06 live enrichment entry point. It is deliberately separate from runMarketingAgent():
 * a slow or failed search never blocks report import or the actionable-list refresh.
 *
 * Script Properties (in addition to the OpenAI research properties):
 *   CONTACT_DATABASE_SPREADSHEET_ID   required (same contact spreadsheet as the Marketing Agent)
 *   MA06_PLATFORMS                    optional, default "INSTAGRAM,TIKTOK"
 *   MA06_MAX_CONTACTS_PER_RUN         optional, default 3, maximum 10
 *   MA06_CONTACT_IDS                  optional comma-separated Contact IDs to restrict research
 *   MA06_TIME_BUDGET_SECONDS          optional, default 210; no new request starts after it
 */

const DJ_ENRICHMENT_LIVE_LEASE = "MA06_ENRICHMENT_LEASE";
// Longer than the 6-minute Apps Script limit, so an expired lease's execution has ended.
const DJ_ENRICHMENT_LIVE_LEASE_MS = 7 * 60 * 1000;
const DJ_ENRICHMENT_RUN_LOG_SHEET = "DJ_Enrichment_Run_Log";
const DJ_ENRICHMENT_RUN_LOG_HEADERS = [
	"Run ID", "Started At", "Completed At", "Model", "Jobs Queued", "Jobs Processed",
	"OpenAI Requests", "Cached Searches", "Web Search Calls", "Seconds",
	"Input Tokens", "Output Tokens", "Estimated USD", "Outcome", "Details JSON"
];

function djEnrichmentLiveSettings_(props) {
	const get = name => djEnrichmentText(props.getProperty(name));
	const platforms = (get("MA06_PLATFORMS") || "INSTAGRAM,TIKTOK")
		.split(",").map(value => djEnrichmentText(value).toUpperCase()).filter(Boolean);
	return {
		platforms: platforms,
		maxContacts: Math.max(1, Math.min(10, Number(get("MA06_MAX_CONTACTS_PER_RUN")) || 3)),
		contactIds: get("MA06_CONTACT_IDS").split(",").map(djEnrichmentText).filter(Boolean),
		budgetMs: Math.max(30, Math.min(300, Number(get("MA06_TIME_BUDGET_SECONDS")) || 210)) * 1000
	};
}

function djEnrichmentLiveLease_(lease) {
	const lock = LockService.getScriptLock();
	lock.waitLock(10000);
	try {
		const props = PropertiesService.getScriptProperties();
		let current = null;
		try { current = JSON.parse(props.getProperty(DJ_ENRICHMENT_LIVE_LEASE) || "null"); } catch (_) {}
		if (lease) {
			if (current && current.id === lease.id) props.deleteProperty(DJ_ENRICHMENT_LIVE_LEASE);
			return null;
		}
		if (current && Number(current.expiresAt) > Date.now()) return null;
		const claimed = { id: Utilities.getUuid(), expiresAt: Date.now() + DJ_ENRICHMENT_LIVE_LEASE_MS };
		props.setProperty(DJ_ENRICHMENT_LIVE_LEASE, JSON.stringify(claimed));
		return claimed;
	} finally {
		lock.releaseLock();
	}
}

/**
 * Researches a small batch of actionable contacts, resuming unfinished jobs first.
 * Run it from the editor or a time-driven trigger; overlapping executions are skipped.
 */
function runDJEnrichmentLive() {
	const lease = djEnrichmentLiveLease_(null);
	if (!lease) {
		console.log("MA-06 enrichment: another enrichment run is active; skipped.");
		return { skipped: true };
	}
	const started = Date.now();
	const props = PropertiesService.getScriptProperties();
	const summary = { runId: "DJRUN-" + lease.id, queued: 0, processed: [], outcome: "COMPLETED" };
	let ss = null;
	let provider = null;
	try {
		ss = SpreadsheetApp.openById(djEnrichmentText(props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID")));
		const settings = djEnrichmentLiveSettings_(props);
		provider = djEnrichmentCreateOpenAIProvider({ platforms: settings.platforms });
		// With the lease held, PROCESSING jobs belong to an execution that already ended.
		djEnrichmentResume(ss, [provider], { maxProviderRequests: 0 });
		const queued = () => djEnrichmentReadTable(ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS)
			.rows.filter(row => row[5] === "QUEUED").length;
		if (!queued()) {
			const researched = new Map();
			djEnrichmentReadTable(ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS).rows
				.forEach(row => researched.set(row[1], (researched.get(row[1]) || new Set()).add(row[3])));
			const targets = djEnrichmentReadTargets(ss).filter(target => target.contactId &&
				(!settings.contactIds.length || settings.contactIds.includes(target.contactId)) &&
				!settings.platforms.every(platform =>
					(researched.get(target.contactId) || new Set()).has(platform)));
			summary.queued = djEnrichmentQueueTargets(ss, targets, [provider], {
				platforms: settings.platforms,
				maxCandidatesPerRun: settings.maxContacts * settings.platforms.length
			}).jobs.length;
		}
		const jobLimit = settings.maxContacts * settings.platforms.length;
		// A request may take its full timeout, so stop starting new ones well before the 6-minute limit.
		const budgetMs = Math.min(settings.budgetMs, 330000 - djEnrichmentOpenAIConfig_().timeoutSeconds * 1000);
		while (summary.processed.length < jobLimit && Date.now() - started < budgetMs) {
			const result = djEnrichmentProcessQueued(ss, [provider], {
				maxProviderRequests: 1, maxApiCallsPerRun: 1, maxAttempts: 3, maxResultsPerProvider: 5
			});
			if (!result.results.length) break;
			result.results.forEach(item => summary.processed.push({
				jobId: item.jobId, status: item.status,
				error: item.error ? djEnrichmentOpenAIError_(item.error).message.slice(0, 300) : undefined
			}));
			// A retryable provider error (rate limit, outage, timeout) is retried on a later run.
			if (result.results.some(item => item.status === "QUEUED")) break;
		}
		summary.remainingQueued = queued();
		return summary;
	} catch (error) {
		summary.outcome = "FAILED: " + djEnrichmentOpenAIError_(error && error.message || error).message.slice(0, 500);
		throw error;
	} finally {
		const usage = provider ? provider.usage : {};
		summary.usage = usage;
		console.log("MA-06 enrichment: " + JSON.stringify(summary));
		if (ss) {
			try {
				djEnrichmentLock(() => djEnrichmentAppend(
					djEnrichmentEnsureSheet(ss, DJ_ENRICHMENT_RUN_LOG_SHEET, DJ_ENRICHMENT_RUN_LOG_HEADERS),
					[summary.runId, new Date(started).toISOString(), djEnrichmentNow(), usage.model || "",
						summary.queued, summary.processed.length, usage.requests || 0, usage.cachedSearches || 0,
						usage.webSearchCalls || 0, usage.seconds || 0, usage.inputTokens || 0,
						usage.outputTokens || 0, usage.estimatedUsd == null ? "" : usage.estimatedUsd,
						summary.outcome, JSON.stringify({ processed: summary.processed, rejected: usage.rejected,
							remainingQueued: summary.remainingQueued })]
				));
			} catch (logError) {
				console.error("MA-06 run log unavailable: " + logError.message);
			}
		}
		djEnrichmentLiveLease_(lease);
	}
}

/**
 * Sends an MA-06-approved social profile to MA-05 as a PENDING_REVIEW profile. Uses the
 * candidate's observation, or a real Import_Log observation the importer safely linked to
 * the candidate's contact. MA-05 verification remains a separate reviewer decision.
 */
function djEnrichmentTransferToContact(ss, enrichmentId) {
	const record = djEnrichmentFindCandidate(ss, djEnrichmentText(enrichmentId));
	if (!record) throw new Error("Enrichment candidate not found.");
	const observationIds = record.row[3]
		? [record.row[3]]
		: djEnrichmentImportObservationsForContact(ss, record.row[2]);
	if (!observationIds.length) {
		throw new Error("No reviewed or safely import-linked observation exists for this contact.");
	}
	return djEnrichmentTransferApproved(ss, record.row[0], observationIds[0]);
}

/** Read-only feasibility metrics for the live enrichment test (counts only, no contact data). */
function reportDJEnrichmentLive() {
	const ss = SpreadsheetApp.openById(djEnrichmentText(
		PropertiesService.getScriptProperties().getProperty("CONTACT_DATABASE_SPREADSHEET_ID")));
	const report = djEnrichmentLiveMetrics(ss);
	console.log("MA-06 live metrics: " + JSON.stringify(report, null, 2));
	return report;
}

function djEnrichmentLiveMetrics(ss) {
	const provider = DJ_ENRICHMENT_OPENAI_PROVIDER_ID;
	const jobs = djEnrichmentReadTable(ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS)
		.rows.filter(row => row[4] === provider);
	const candidates = djEnrichmentReadTable(ss, DJ_ENRICHMENT_CANDIDATE_SHEET, DJ_ENRICHMENT_CANDIDATE_HEADERS)
		.rows.filter(row => row[9] === provider);
	const evidence = djEnrichmentReadTable(ss, DJ_ENRICHMENT_EVIDENCE_SHEET, DJ_ENRICHMENT_EVIDENCE_HEADERS).rows;
	const strongIds = new Set(evidence.filter(row => row[6] === "STRONG").map(row => row[1]));
	const calls = djEnrichmentReadTable(ss, DJ_ENRICHMENT_API_USAGE_SHEET, DJ_ENRICHMENT_API_USAGE_HEADERS)
		.rows.filter(row => row[2] === provider);
	const runs = djEnrichmentReadTable(ss, DJ_ENRICHMENT_RUN_LOG_SHEET, DJ_ENRICHMENT_RUN_LOG_HEADERS).rows;
	const contacts = rows => new Set(rows.map(row => row[2] || row[3])).size;
	const finished = jobs.filter(row => !["QUEUED", "PROCESSING"].includes(row[5]));
	const live = candidates.filter(row => row[12] !== "REJECTED");
	const latencies = calls.map(row => Date.parse(row[6]) - Date.parse(row[5])).filter(Number.isFinite);
	const sum = index => runs.reduce((total, row) => total + (Number(row[index]) || 0), 0);
	const byStatus = {};
	finished.forEach(row => { byStatus[row[5]] = (byStatus[row[5]] || 0) + 1; });
	return {
		contactsResearched: new Set(finished.map(row => row[1] || row[2])).size,
		jobsByStatus: byStatus,
		contactsWithInstagramCandidates: contacts(live.filter(row => row[4] === "INSTAGRAM")),
		contactsWithTikTokCandidates: contacts(live.filter(row => row[4] === "TIKTOK")),
		candidates: {
			total: candidates.length,
			strongEvidence: candidates.filter(row => strongIds.has(row[0])).length,
			pendingReview: candidates.filter(row => row[12] === "PENDING_REVIEW").length,
			needsResearch: candidates.filter(row => row[12] === "NEEDS_RESEARCH").length,
			conflicting: candidates.filter(row => row[12] === "CONFLICTING").length,
			approved: candidates.filter(row => row[12] === "APPROVED_FOR_MA05").length,
			rejected: candidates.filter(row => row[12] === "REJECTED").length
		},
		contactsWithSufficientEvidence: contacts(candidates.filter(row =>
			strongIds.has(row[0]) || ["PENDING_REVIEW", "APPROVED_FOR_MA05"].includes(row[12]))),
		apiCalls: calls.length,
		apiCallOutcomes: calls.reduce((all, row) => { all[row[7]] = (all[row[7]] || 0) + 1; return all; }, {}),
		averageLatencySeconds: latencies.length
			? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length / 100) / 10 : null,
		maxLatencySeconds: latencies.length ? Math.round(Math.max(...latencies) / 100) / 10 : null,
		webSearchCalls: sum(8),
		inputTokens: sum(10),
		outputTokens: sum(11),
		estimatedUsd: Math.round(sum(12) * 1e4) / 1e4
	};
}
