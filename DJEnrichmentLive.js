/**
 * MA-06 live enrichment entry point. It is deliberately separate from runMarketingAgent():
 * a slow or failed search never blocks report import or the actionable-list refresh.
 *
 * Script Properties (in addition to the OpenAI research properties):
 *   CONTACT_DATABASE_SPREADSHEET_ID   required (same contact spreadsheet as the Marketing Agent)
 *   MA06_PLATFORMS                    optional, see DJ_ENRICHMENT_LIVE_DEFAULT_PLATFORMS
 *   MA06_MAX_CONTACTS_PER_RUN         optional, default 3, maximum 10
 *   MA06_MAX_PAGE_FETCHES             optional, public pages inspected per DJ, default 4 (0-6)
 *   MA06_CONTACT_IDS                  optional comma-separated Contact IDs to restrict research
 *   MA06_TIME_BUDGET_SECONDS          optional, default 210; no new request starts after it
 */

const DJ_ENRICHMENT_LIVE_LEASE = "MA06_ENRICHMENT_LEASE";
// Longer than the 6-minute Apps Script limit, so an expired lease's execution has ended.
const DJ_ENRICHMENT_LIVE_LEASE_MS = 7 * 60 * 1000;
const DJ_ENRICHMENT_LIVE_DEFAULT_PLATFORMS = "INSTAGRAM,TIKTOK,FACEBOOK,X,YOUTUBE,MIXCLOUD,SOUNDCLOUD,WEBSITE,RADIO_DIRECTORY,BUSINESS_EMAIL";
const DJ_ENRICHMENT_RUN_LOG_SHEET = "DJ_Enrichment_Run_Log";
const DJ_ENRICHMENT_RUN_LOG_HEADERS = [
	"Run ID", "Started At", "Completed At", "Model", "Jobs Queued", "Jobs Processed",
	"OpenAI Requests", "Cached Searches", "Web Search Calls", "Seconds",
	"Input Tokens", "Output Tokens", "Estimated USD", "Outcome", "Details JSON"
];
// One row per live search (not per cached platform job): why a contact did or did not resolve.
const DJ_ENRICHMENT_DIAGNOSTICS_SHEET = "DJ_Enrichment_Search_Diagnostics";
const DJ_ENRICHMENT_DIAGNOSTICS_HEADERS = [
	"Recorded At", "Run ID", "Job ID", "Contact ID", "Outcome", "Queries Planned", "Queries Run",
	"Sources", "Social Sources", "Identity Pages", "Model Candidates", "Accepted Instagram/TikTok",
	"Accepted Other Channels", "Page Candidates", "Rejected Reasons", "Pages JSON",
	"Input Tokens", "Output Tokens", "Seconds", "Error"
];

function djEnrichmentLiveSettings_(props) {
	const get = name => djEnrichmentText(props.getProperty(name));
	const platforms = (get("MA06_PLATFORMS") || DJ_ENRICHMENT_LIVE_DEFAULT_PLATFORMS)
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
		const pendingJobs = djEnrichmentReadTable(ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS)
			.rows.filter(row => row[5] === "QUEUED");
		const seenContacts = new Set();
		const completedJobs = new Set();
		// A request may take its full timeout, so stop starting new ones well before the 6-minute limit.
		const config = djEnrichmentOpenAIConfig_();
		// Each inspected page can involve two 20-second fetches (one same-site redirect).
		const networkReserveMs = (config.timeoutSeconds + config.maxPages * 40) * 1000;
		const budgetMs = Math.max(0, Math.min(settings.budgetMs, 330000 - networkReserveMs));
		if (!budgetMs) throw new Error("Research timeout and page-fetch settings leave no safe Apps Script execution budget.");
		while (summary.processed.length < jobLimit && Date.now() - started < budgetMs) {
			const next = pendingJobs.find(row => !completedJobs.has(row[0]));
			if (!next) break;
			const contact = next[1] || next[2];
			if (!seenContacts.has(contact) && seenContacts.size >= settings.maxContacts) break;
			seenContacts.add(contact);
			const result = djEnrichmentProcessQueued(ss, [provider], {
				maxProviderRequests: 1, maxAttempts: 3, maxResultsPerProvider: 5,
				// One OpenAI request plus bounded page inspections (each may follow one redirect).
				maxApiCallsPerRun: 1 + 2 * djEnrichmentOpenAIConfig_().maxPages
			});
			if (!result.results.length) break;
			result.results.forEach(item => completedJobs.add(item.jobId));
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
			try {
				djEnrichmentLiveRecordDiagnostics_(ss, summary.runId, provider ? provider.diagnostics : []);
			} catch (logError) {
				console.error("MA-06 search diagnostics unavailable: " + logError.message);
			}
		}
		djEnrichmentLiveLease_(lease);
	}
}

function djEnrichmentLiveRecordDiagnostics_(ss, runId, diagnostics) {
	if (!diagnostics || !diagnostics.length) return;
	const contacts = new Map(djEnrichmentReadTable(ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS)
		.rows.map(row => [row[0], row[1] || row[2]]));
	const rows = diagnostics.map(item => [
		djEnrichmentNow(), runId, item.jobId, contacts.get(item.jobId) || "", item.outcome,
		(item.queriesPlanned || []).join(" | "), (item.queriesRun || []).join(" | "),
		item.sources || 0, item.socialSources || 0, item.identityPages || 0, item.modelCandidates || 0,
		item.acceptedPriority || 0, item.acceptedOther || 0, item.pageCandidates || 0,
		(item.rejected || []).join(","), JSON.stringify(item.pages || []),
		item.inputTokens || 0, item.outputTokens || 0, item.seconds || 0, item.error || ""
	]);
	djEnrichmentLock(() => {
		const sheet = djEnrichmentEnsureSheet(ss, DJ_ENRICHMENT_DIAGNOSTICS_SHEET, DJ_ENRICHMENT_DIAGNOSTICS_HEADERS);
		rows.forEach(row => djEnrichmentAppend(sheet, row));
	});
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
	const allCalls = djEnrichmentReadTable(ss, DJ_ENRICHMENT_API_USAGE_SHEET, DJ_ENRICHMENT_API_USAGE_HEADERS)
		.rows.filter(row => row[2] === provider);
	const calls = allCalls.filter(row => row[4] !== "page.inspect");
	const pageCalls = allCalls.filter(row => row[4] === "page.inspect");
	const runs = djEnrichmentReadTable(ss, DJ_ENRICHMENT_RUN_LOG_SHEET, DJ_ENRICHMENT_RUN_LOG_HEADERS).rows;
	// Latest search outcome per contact (a contact may be searched again after a requeue).
	const latestOutcome = new Map();
	djEnrichmentReadTable(ss, DJ_ENRICHMENT_DIAGNOSTICS_SHEET, DJ_ENRICHMENT_DIAGNOSTICS_HEADERS).rows
		.filter(row => row[3]).forEach(row => latestOutcome.set(row[3], row[4]));
	const outcomes = {};
	latestOutcome.forEach(outcome => { outcomes[outcome] = (outcomes[outcome] || 0) + 1; });
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
		contactsWithFacebookCandidates: contacts(live.filter(row => row[4] === "FACEBOOK")),
		contactsWithXCandidates: contacts(live.filter(row => row[4] === "X")),
		contactsWithYouTubeCandidates: contacts(live.filter(row => row[4] === "YOUTUBE")),
		contactsWithAlternativeChannels: contacts(live.filter(row =>
			["FACEBOOK", "X", "YOUTUBE", "MIXCLOUD", "SOUNDCLOUD", "WEBSITE", "RADIO_DIRECTORY", "BUSINESS_EMAIL"].includes(row[4]))),
		searchOutcomesByContact: outcomes,
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
		pageFetches: pageCalls.length,
		pageFetchOutcomes: pageCalls.reduce((all, row) => {
			const key = String(row[7]).split(":")[0];
			all[key] = (all[key] || 0) + 1;
			return all;
		}, {}),
		averageLatencySeconds: latencies.length
			? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length / 100) / 10 : null,
		maxLatencySeconds: latencies.length ? Math.round(Math.max(...latencies) / 100) / 10 : null,
		webSearchCalls: sum(8),
		inputTokens: sum(10),
		outputTokens: sum(11),
		estimatedUsd: Math.round(sum(12) * 1e4) / 1e4
	};
}
