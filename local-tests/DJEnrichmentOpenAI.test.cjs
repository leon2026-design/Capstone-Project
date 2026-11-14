// MA-06-LIVE-01: OpenAI web-search provider, TikTok profiles, import-linked transfer and
// the bounded live entry point. All HTTP responses are mocked; no live search is claimed here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MockSheet {
	constructor(name) { this.name = name; this.rows = []; }
	getLastRow() {
		let last = this.rows.length;
		while (last > 0 && this.rows[last - 1].every(value => value === "" || value == null)) last--;
		return last;
	}
	getLastColumn() { return Math.max(1, ...this.rows.map(row => row.length)); }
	getRange(row, column, numRows = 1, numColumns = 1) {
		const sheet = this;
		return {
			getDisplayValues() {
				return Array.from({ length: numRows }, (_, i) => Array.from({ length: numColumns }, (_, j) => {
					const value = (sheet.rows[row + i - 1] || [])[column + j - 1];
					return value instanceof Date ? value.toISOString() : String(value == null ? "" : value);
				}));
			},
			setValues(values) {
				values.forEach((valuesRow, i) => {
					while (sheet.rows.length <= row + i - 1) sheet.rows.push([]);
					const target = sheet.rows[row + i - 1];
					valuesRow.forEach((value, j) => {
						while (target.length <= column + j - 1) target.push("");
						target[column + j - 1] = value;
					});
				});
			},
			setValue(value) { this.setValues([[value]]); }
		};
	}
	getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), this.getLastColumn()); }
	appendRow(values) { this.rows.push([...values]); }
	setFrozenRows() {}
}

class MockSpreadsheet {
	constructor() { this.sheets = new Map(); }
	getSheetByName(name) { return this.sheets.get(name) || null; }
	insertSheet(name) { const sheet = new MockSheet(name); this.sheets.set(name, sheet); return sheet; }
}

const plain = value => JSON.parse(JSON.stringify(value));
const KEY = "sk-test-secret-key-1234567890";
const properties = new Map();
const requests = [];
let responses = [];
let activeSpreadsheet = null;
let uuid = 0;
const context = vm.createContext({
	URL,
	console: { log() {}, error() {} },
	UrlFetchApp: {
		fetch(url, options) {
			requests.push({ url, options, body: JSON.parse(options.payload) });
			const next = responses.shift();
			if (next instanceof Error) throw next;
			return {
				getResponseCode: () => next.code,
				getContentText: () => typeof next.body === "string" ? next.body : JSON.stringify(next.body)
			};
		}
	},
	LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
	PropertiesService: { getScriptProperties: () => ({
		getProperty: name => properties.has(name) ? properties.get(name) : null,
		setProperty: (name, value) => properties.set(name, value),
		deleteProperty: name => properties.delete(name)
	}) },
	SpreadsheetApp: { openById: () => activeSpreadsheet },
	Utilities: { getUuid: () => "U" + (++uuid) }
});

for (const filename of [
	"apiInventory.js", "ContactMatcher.js", "DJIdentityResolver.js", "DJSocialProfileStore.js",
	"DJEnrichment.js", "DJEnrichmentOpenAIProvider.js", "DJEnrichmentLive.js"
]) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), context, { filename });
}

function setup() {
	const ss = new MockSpreadsheet();
	ss.insertSheet("Master_Contacts").rows = [
		["Contact ID", "Name / DJ Alias", "Station / Venue / Organization", "City", "Country",
			"Email", "Social Accounts"],
		["CT-001", "DJ Example", "Example Radio", "Columbus", "United States",
			"private@example.invalid", "https://www.instagram.com/known-example/"]
	];
	ss.insertSheet("Import_Log").rows = [
		["Timestamp", "Run ID", "Source Tab", "Source URL", "Source Row",
			"Observation Key", "Outcome", "Contact IDs", "Details"],
		["2026-11-01", "R1", "Tab", "https://docs.example/tab", "2", "OBS-SAFE", "Created", "CT-001", "{}"],
		["2026-11-01", "R1", "Tab", "https://docs.example/tab", "3", "OBS-AMBIG", "Review identity", "CT-001, CT-009", "{}"]
	];
	properties.clear();
	properties.set("OPENAI_API_KEY", KEY);
	properties.set("CONTACT_DATABASE_SPREADSHEET_ID", "contacts-test");
	activeSpreadsheet = ss;
	requests.length = 0;
	responses = [];
	return ss;
}

const STATION = "https://exampleradio.example/djs/dj-example";
const INSTAGRAM = "https://www.instagram.com/djexample.official/";
const TIKTOK = "https://www.tiktok.com/@DJExample/video/123456";

function searchBody(candidates, options = {}) {
	return {
		status: "completed",
		usage: { input_tokens: 1200, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } },
		output: [
			...(options.noSearch ? [] : [{
				type: "web_search_call", status: "completed",
				action: { type: "search", query: "DJ Example", sources: (options.sources ||
					[STATION, INSTAGRAM, TIKTOK]).map(url => ({ type: "url", url })) }
			}]),
			{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates }), annotations: [] }] }
		]
	};
}

function candidate(fields) {
	return {
		platform: "INSTAGRAM", profile_url: INSTAGRAM, email: null, source_url: STATION,
		display_name: "DJ Example", profile_name: null, station: "Example Radio", city: null,
		region: null, country: null, evidence: [], ...fields
	};
}

function provider() {
	return context.djEnrichmentCreateOpenAIProvider({ platforms: ["INSTAGRAM", "TIKTOK", "BUSINESS_EMAIL"] });
}

function runFor(ss, prov, platforms = ["INSTAGRAM", "TIKTOK"], options = {}) {
	return context.djEnrichmentRun(ss, [{ contactId: "CT-001" }], [prov], { platforms, ...options });
}

// TikTok support and stricter profile parsing in MA-05.
{
	const profile = context.djIdentityProfile;
	assert.equal(profile(TIKTOK).profileUrl, "https://tiktok.com/@djexample");
	assert.equal(profile("https://m.tiktok.com/@dj.example").platform, "TIKTOK");
	assert.equal(profile("https://www.tiktok.com/tag/house"), null);
	assert.equal(profile("https://www.instagram.com/p/ABC123/"), null);
	assert.equal(profile("https://www.instagram.com/reel/ABC123"), null);
	assert.equal(profile("https://instagram.com/dj-example/").profileUrl, "https://instagram.com/dj-example");
	assert.equal(context.djEnrichmentNormalizeCandidateUrl(TIKTOK, "TIKTOK"), "https://tiktok.com/@djexample");
}

// A grounded search produces reviewable Instagram and TikTok candidates from one request.
{
	const ss = setup();
	responses.push({ code: 200, body: searchBody([
		candidate({ evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "Follow DJ Example on Instagram", source_url: STATION },
			{ type: "DJ_ALIAS_MATCH", excerpt: "DJ Example", source_url: INSTAGRAM }
		] }),
		candidate({ platform: "TIKTOK", profile_url: TIKTOK, source_url: TIKTOK,
			evidence: [{ type: "NAME_MATCH", excerpt: "DJExample", source_url: TIKTOK }] })
	]) });
	const prov = provider();
	const result = runFor(ss, prov);
	assert.equal(requests.length, 1, "one search serves both platform jobs");
	assert.equal(prov.usage.cachedSearches, 1);
	const request = requests[0];
	assert.equal(request.url, "https://api.openai.com/v1/responses");
	assert.equal(request.options.headers.Authorization, "Bearer " + KEY);
	assert.equal(request.url.includes(KEY), false);
	assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
	assert.equal(request.body.tool_choice, "required");
	assert.deepEqual(request.body.include, ["web_search_call.action.sources"]);
	assert.ok(request.options.timeoutSeconds > 0);
	const sent = JSON.parse(request.body.input);
	assert.deepEqual(sent.dj_names, ["DJ Example"]);
	assert.deepEqual(sent.known_public_profiles, ["https://instagram.com/known-example"]);
	assert.equal(request.body.input.includes("private@example.invalid"), false);
	assert.equal(request.body.input.includes("CT-001"), false);

	assert.deepEqual(plain(result.processed.map(item => item.status)), ["PENDING_REVIEW", "NEEDS_RESEARCH"],
		"unquoted name/station claims cannot raise the TikTok candidate to review");
	const rows = ss.getSheetByName("DJ_Enrichment_Candidates").rows.slice(1);
	assert.deepEqual(rows.map(row => row[5]), ["https://instagram.com/djexample.official", "https://tiktok.com/@djexample"]);
	const evidence = ss.getSheetByName("DJ_Enrichment_Evidence").rows.slice(1);
	assert.ok(evidence.some(row => row[2] === "OFFICIAL_CROSS_LINK" && row[6] === "STRONG"));
	assert.ok(evidence.some(row => row[2] === "NAME_MATCH" && row[6] === "INSUFFICIENT"));
	const usage = ss.getSheetByName("DJ_Enrichment_API_Usage").rows.slice(1);
	assert.equal(usage.length, 1);
	assert.equal(usage[0][2], "OPENAI_WEB_SEARCH");
	assert.equal(usage[0][7], "SUCCESS");
	assert.equal(prov.usage.inputTokens, 1200);
	assert.equal(prov.usage.webSearchCalls, 1);
}

// Constructed URLs, unobserved sources, self cross-links and unquoted emails are rejected.
{
	const ss = setup();
	responses.push({ code: 200, body: searchBody([
		candidate({ profile_url: "https://instagram.com/guessed_handle" }),
		candidate({ source_url: "https://unseen.example/page" }),
		candidate({ source_url: INSTAGRAM, evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "self", source_url: INSTAGRAM }
		] }),
		candidate({ platform: "BUSINESS_EMAIL", profile_url: null, email: "bookings@exampleradio.example",
			evidence: [{ type: "PROFESSIONAL_ACTIVITY", excerpt: "Resident DJ", source_url: STATION }] })
	]) });
	const prov = provider();
	runFor(ss, prov, ["INSTAGRAM", "BUSINESS_EMAIL"]);
	assert.deepEqual(plain(prov.usage.rejected), {
		PROFILE_URL_NOT_IN_SEARCH_RESULTS: 1,
		SOURCE_NOT_IN_SEARCH_RESULTS: 1,
		UNQUOTED_DISPLAY_NAME: 1,
		UNQUOTED_STATION: 1,
		EMAIL_NOT_QUOTED_FROM_SOURCE: 1
	});
	const rows = ss.getSheetByName("DJ_Enrichment_Candidates").rows.slice(1);
	assert.equal(rows.length, 1);
	assert.equal(rows[0][12], "NEEDS_RESEARCH", "a profile cannot cross-link itself");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Evidence").rows.some(row => row[2] === "OFFICIAL_CROSS_LINK"), false);
}

// A profile the search didn't list is accepted only when a returned page quotes its exact link.
{
	const ss = setup();
	const linked = "https://instagram.com/linked_dj";
	responses.push({ code: 200, body: searchBody([
		candidate({ profile_url: linked, display_name: null, station: null, evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "Follow DJ Example: instagram.com/linked_dj", source_url: STATION }
		] }),
		candidate({ profile_url: "https://instagram.com/linked", display_name: null, station: null, evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "Follow DJ Example: instagram.com/linked_dj", source_url: STATION }
		] }),
		candidate({ profile_url: "https://instagram.com/unseen_dj", display_name: null, station: null, evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "instagram.com/unseen_dj", source_url: "https://unseen.example/a" }
		] })
	], { sources: [STATION] }) });
	const prov = provider();
	runFor(ss, prov, ["INSTAGRAM"]);
	assert.deepEqual(plain(prov.usage.rejected), { PROFILE_URL_NOT_IN_SEARCH_RESULTS: 2 },
		"a shorter handle prefix and a quote from an unreturned page are both rejected");
	const rows = ss.getSheetByName("DJ_Enrichment_Candidates").rows.slice(1);
	assert.deepEqual(rows.map(row => row[5]), [linked]);
	assert.ok(ss.getSheetByName("DJ_Enrichment_Evidence").rows.some(row =>
		row[2] === "OFFICIAL_CROSS_LINK" && row[6] === "STRONG"));
}

// A response without an executed web search is never accepted as evidence.
{
	const ss = setup();
	responses.push({ code: 200, body: searchBody([candidate({})], { noSearch: true }) });
	const result = runFor(ss, provider(), ["INSTAGRAM"]);
	assert.equal(result.processed[0].status, "QUEUED");
	assert.match(result.processed[0].error, /did not execute a web search/);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates"), null);
}

// Provider errors: retryable vs permanent, with credentials redacted everywhere.
{
	const cases = [
		[{ code: 503, body: { error: { type: "server_error", message: "overloaded" } } }, "QUEUED"],
		[{ code: 429, body: { error: { code: "rate_limit_exceeded", message: "slow down" } } }, "QUEUED"],
		[{ code: 429, body: { error: { code: "insufficient_quota", message: "no credit" } } }, "SOURCE_UNAVAILABLE"],
		[{ code: 401, body: { error: { code: "invalid_api_key", message: "Incorrect key " + KEY } } }, "SOURCE_UNAVAILABLE"],
		[{ code: 200, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "QUEUED"],
		[{ code: 200, body: "not json" }, "QUEUED"],
		[new Error("Timeout: https://api.openai.com/v1/responses"), "QUEUED"]
	];
	for (const [response, status] of cases) {
		const ss = setup();
		responses.push(response);
		const result = runFor(ss, provider(), ["INSTAGRAM"]);
		assert.equal(result.processed[0].status, status, JSON.stringify(response.body || response.message));
		const sheets = [...ss.sheets.values()].map(sheet => JSON.stringify(sheet.rows)).join("");
		assert.equal(sheets.includes(KEY), false, "the API key never reaches a sheet");
	}
	const ss = setup();
	responses.push({ code: 200, body: { status: "completed", output: [
		{ type: "web_search_call", status: "completed", action: { type: "search", sources: [] } },
		{ type: "message", content: [{ type: "refusal", refusal: "cannot help" }] }
	] } });
	assert.equal(runFor(ss, provider(), ["INSTAGRAM"]).processed[0].status, "SOURCE_UNAVAILABLE");
}

// A safely import-linked observation satisfies the MA-05 transfer requirement; no fabricated IDs.
{
	const ss = setup();
	responses.push({ code: 200, body: searchBody([candidate({ platform: "TIKTOK", profile_url: TIKTOK,
		source_url: STATION, evidence: [
			{ type: "OFFICIAL_CROSS_LINK", excerpt: "TikTok", source_url: STATION },
			{ type: "STATION_AFFILIATION", excerpt: "Example Radio", source_url: STATION }
		] })]) });
	runFor(ss, provider(), ["TIKTOK"]);
	const id = ss.getSheetByName("DJ_Enrichment_Candidates").rows[1][0];
	assert.deepEqual([...context.djEnrichmentImportObservationsForContact(ss, "CT-001")], ["OBS-SAFE"]);
	assert.throws(() => context.djEnrichmentTransferToContact(ss, id), /must be approved/);
	context.djEnrichmentReview(ss, id, "APPROVE", "reviewer", "Station page links this TikTok.");
	const transferred = context.djEnrichmentTransferToContact(ss, id);
	assert.equal(transferred.observationId, "OBS-SAFE");
	assert.equal(transferred.contactId, "CT-001");
	assert.equal(transferred.verificationStatus, "PENDING_REVIEW");
	assert.equal(ss.getSheetByName("DJ_Social_Profiles").rows[1][2], "TIKTOK");
	assert.throws(() => context.djEnrichmentTransferApproved(ss, id, "OBS-AMBIG"), /safe import link/);
	context.djSocialProfileReview(ss, transferred.profileIds[0], "VERIFY", "CT-001",
		"reviewer", "Verified against the station page.");
	assert.deepEqual(plain(context.djSocialProfileGetVerified(ss, "CT-001").map(item => item.profileUrl)),
		["https://tiktok.com/@djexample"]);
}

// Entry point: bounded batch, run log, overlap protection and stale-lease recovery.
{
	const ss = setup();
	properties.set("MA06_MAX_CONTACTS_PER_RUN", "1");
	responses.push({ code: 200, body: searchBody([]) });
	const summary = context.runDJEnrichmentLive();
	assert.equal(summary.queued, 2);
	assert.deepEqual(plain(summary.processed.map(item => item.status)), ["NOT_FOUND", "NOT_FOUND"]);
	assert.equal(requests.length, 1);
	assert.equal(properties.has("MA06_ENRICHMENT_LEASE"), false, "the lease is released");
	const log = ss.getSheetByName("DJ_Enrichment_Run_Log").rows;
	assert.equal(log.length, 2);
	assert.equal(String(log[1][6]), "1");
	assert.equal(log[1][13], "COMPLETED");

	assert.equal(context.runDJEnrichmentLive().queued, 0, "already-researched contacts are not requeued");
	assert.equal(requests.length, 1);

	properties.set("MA06_ENRICHMENT_LEASE", JSON.stringify({ id: "other", expiresAt: Date.now() + 60000 }));
	assert.equal(context.runDJEnrichmentLive().skipped, true);

	const jobs = ss.getSheetByName("DJ_Enrichment_Jobs");
	jobs.rows[1][5] = "PROCESSING";
	jobs.rows[1][6] = 1;
	properties.set("MA06_ENRICHMENT_LEASE", JSON.stringify({ id: "dead", expiresAt: Date.now() - 1 }));
	responses.push({ code: 503, body: { error: { type: "server_error" } } });
	const recovered = context.runDJEnrichmentLive();
	assert.deepEqual(plain(recovered.processed.map(item => item.status)), ["QUEUED"]);
	assert.equal(jobs.rows[1][5], "QUEUED", "an orphaned job is resumed, then retried later after a 503");
	assert.equal(ss.getSheetByName("Master_Contacts").rows[1][6], "https://www.instagram.com/known-example/");
	const metrics = context.djEnrichmentLiveMetrics(ss);
	assert.equal(metrics.apiCalls, 2);
	assert.equal(metrics.jobsByStatus.NOT_FOUND, 1);
}

console.log("DJEnrichmentOpenAI tests passed");
