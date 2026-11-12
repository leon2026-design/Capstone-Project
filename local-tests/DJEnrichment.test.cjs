// MA-06: deterministic enrichment pipeline tests.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MockSheet {
	constructor(name) {
		this.name = name;
		this.rows = [];
		this.frozenRows = 0;
	}

	getLastRow() {
		let last = this.rows.length;
		while (last > 0 && this.rows[last - 1].every(value =>
			value === "" || value == null
		)) last--;
		return last;
	}

	getLastColumn() {
		return Math.max(1, ...this.rows.map(row => row.length));
	}

	getRange(row, column, numRows = 1, numColumns = 1) {
		const sheet = this;
		return {
			getDisplayValues() {
				return Array.from({ length: numRows }, (_, i) =>
					Array.from({ length: numColumns }, (_, j) => {
						const value = (sheet.rows[row + i - 1] || [])[column + j - 1];
						return value instanceof Date
							? value.toISOString()
							: String(value == null ? "" : value);
					})
				);
			},
			setValues(values) {
				assert.equal(values.length, numRows);
				values.forEach((valuesRow, i) => {
					assert.equal(valuesRow.length, numColumns);
					const rowIndex = row + i - 1;
					while (sheet.rows.length <= rowIndex) sheet.rows.push([]);
					const target = sheet.rows[rowIndex];
					valuesRow.forEach((value, j) => {
						const columnIndex = column + j - 1;
						while (target.length <= columnIndex) target.push("");
						target[columnIndex] = value;
					});
				});
			},
			setValue(value) {
				this.setValues([[value]]);
			}
		};
	}

	getDataRange() {
		const height = Math.max(1, this.getLastRow());
		return this.getRange(1, 1, height, this.getLastColumn());
	}

	appendRow(values) {
		this.rows.push([...values]);
	}

	setFrozenRows(count) {
		this.frozenRows = count;
	}
}

class MockSpreadsheet {
	constructor() {
		this.sheets = new Map();
	}
	getSheetByName(name) {
		return this.sheets.get(name) || null;
	}
	insertSheet(name) {
		const sheet = new MockSheet(name);
		this.sheets.set(name, sheet);
		return sheet;
	}
}

let nextUuid = 0;
let lastFetchedUrl = "";
const context = vm.createContext({
	URL,
	UrlFetchApp: {
		fetch(url) {
			lastFetchedUrl = url;
			return { getResponseCode: () => 200 };
		}
	},
	LockService: {
		getScriptLock() {
			return { waitLock() {}, releaseLock() {} };
		}
	},
	Utilities: {
		getUuid() {
			return "TEST-" + (++nextUuid);
		}
	}
});

for (const filename of [
	"apiInventory.js",
	"ContactMatcher.js",
	"DJIdentityResolver.js",
	"DJSocialProfileStore.js",
	"DJEnrichment.js"
]) {
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, "..", filename), "utf8"),
		context,
		{ filename }
	);
}

function setup() {
	const ss = new MockSpreadsheet();
	const master = ss.insertSheet("Master_Contacts");
	master.rows = [
		[
			"Contact ID", "Name / DJ Alias",
			"Station / Venue / Organization", "City", "Country",
			"Campaign Status", "Campaign Rating", "Campaign Feedback",
			"Do Not Research"
		],
		[
			"CT-001", "DJ Example", "Example Radio", "Columbus",
			"United States", "Downloaded", "", "", ""
		],
		[
			"CT-002", "DJ Alex", "Example Radio", "Columbus",
			"United States", "", "", "", ""
		],
		[
			"CT-003", "DJ Protected", "Example Radio", "Columbus",
			"United States", "Downloaded", "", "", "yes"
		]
	];
	return ss;
}

function target(fields = {}) {
	return {
		contactId: "CT-001",
		name: "DJ Example",
		station: "Example Radio",
		city: "Columbus",
		country: "United States",
		priority: 4,
		priorityCategory: "PROVIDER_REPORTED_DOWNLOAD",
		...fields
	};
}

function fixtureProvider(context) {
	return context.djEnrichmentCreateFixtureProvider({
		"DJ Example|INSTAGRAM": [
			{
				platform: "INSTAGRAM",
				candidateUrl: "https://www.instagram.com/dj-example/",
				sourceUrl: "https://research.example/search-result/1",
				displayName: "DJ Example",
				station: "Example Radio"
			},
			{
				platform: "INSTAGRAM",
				candidateUrl: "https://www.instagram.com/example-promoter/",
				sourceUrl: "https://research.example/search-result/2",
				displayName: "Example Promoter",
				station: "Example Radio"
			}
		]
	});
}

const run = context.djEnrichmentRun;
const select = context.djEnrichmentSelectCandidates;
const review = context.djEnrichmentReview;
const transfer = context.djEnrichmentTransferApproved;

{
	const ss = setup();
	const result = run(ss, [target()], [], { platforms: ["INSTAGRAM"] });
	assert.equal(result.mode, "OFFLINE_RESEARCH_MODE");
	assert.equal(result.jobs.length, 1);
	assert.equal(result.jobs[0].query, "DJ Example instagram Example Radio Columbus United States");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Jobs").rows[1][5], "NEEDS_RESEARCH");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates"), null);
	assert.equal(context.djEnrichmentGetUsage(ss).totalRequests, 0);
}

{
	const ss = setup();
	const result = context.djEnrichmentQueueTargets(
		ss,
		[target(), target({ priority: 2 })],
		[],
		{ platforms: ["INSTAGRAM"] }
	);
	assert.equal(result.jobs.length, 1);
	assert.equal(result.excluded[0].status, "DUPLICATE_TARGET");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Jobs").getLastRow(), 2);
}

{
	const ss = setup();
	const offline = run(ss, [target()], [], { platforms: ["INSTAGRAM"] });
	const provider = fixtureProvider(context);
	const configured = run(
		ss, [target()], [provider], { platforms: ["INSTAGRAM"] }
	);
	assert.equal(configured.jobs[0].jobId, offline.jobs[0].jobId);
	assert.equal(configured.processed[0].status, "PENDING_REVIEW");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Jobs").getLastRow(), 2);
}

{
	const ss = setup();
	const result = context.djEnrichmentRunSelected(
		ss, [], { platforms: ["INSTAGRAM"] }
	);
	assert.equal(result.mode, "OFFLINE_RESEARCH_MODE");
	assert.equal(result.jobs.length, 2);
	assert.equal(result.processed.length, 0);
}

{
	const ss = setup();
	const provider = fixtureProvider(context);
	const result = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	assert.equal(result.providerRequests, 1);
	assert.equal(result.processed[0].status, "PENDING_REVIEW");
	const candidates = ss.getSheetByName("DJ_Enrichment_Candidates").rows;
	assert.equal(candidates.length, 3);
	assert.equal(candidates[1][12], "PENDING_REVIEW");
	assert.equal(candidates[2][12], "NEEDS_RESEARCH");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Evidence").rows.length, 4);
	assert.equal(context.djEnrichmentGetUsage(ss).totalRequests, 1);

	const repeat = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	assert.equal(repeat.jobs.length, 0);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates").rows.length, 3);
}

{
	const ss = setup();
	const provider = context.djEnrichmentCreateFixtureProvider({});
	const result = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	assert.equal(result.processed[0].status, "NOT_FOUND");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates"), null);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Jobs").rows[1][5], "NOT_FOUND");
}

{
	const ss = setup();
	let called = false;
	const provider = {
		providerId: "UNAUTHORIZED_SOURCE",
		authorized: false,
		supportedPlatforms: ["INSTAGRAM"],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search() {
			called = true;
			return { candidates: [] };
		}
	};
	const result = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	assert.equal(result.mode, "OFFLINE_RESEARCH_MODE");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Jobs").rows[1][5], "NEEDS_RESEARCH");
	assert.equal(called, false);
}

{
	const ss = setup();
	const provider = {
		providerId: "MIXED_RESULTS",
		authorized: true,
		supportedPlatforms: ["INSTAGRAM"],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search() {
			return {
				candidates: [
					{
						platform: "INSTAGRAM",
						candidateUrl: "https://instagram.com/dj-example/",
						sourceUrl: "https://research.example/valid",
						displayName: "DJ Example",
						station: "Example Radio"
					},
					{
						platform: "INSTAGRAM",
						candidateUrl: "http://localhost/private",
						sourceUrl: "https://research.example/invalid",
						displayName: "DJ Example"
					}
				]
			};
		}
	};
	const result = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	assert.equal(result.processed[0].status, "PENDING_REVIEW");
	assert.equal(result.processed[0].rejectedCandidates.length, 1);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates").rows.length, 2);
}

{
	const ss = setup();
	const selected = select(ss, {
		platforms: ["INSTAGRAM"],
		maxCandidatesPerRun: 10
	});
	assert.equal(selected.jobs.length, 2);
	assert.equal(selected.jobs[0].contactId, "CT-001");
	assert.equal(selected.jobs[0].priority, 4);
	assert.equal(selected.jobs.some(item => item.contactId === "CT-003"), false);
	assert.equal(selected.jobs[1].contactId, "CT-002");

	const direct = context.djEnrichmentQueueTargets(
		ss, [target({ contactId: "CT-003" })], [], { platforms: ["INSTAGRAM"] }
	);
	assert.equal(direct.jobs.length, 0);
	assert.equal(direct.excluded[0].status, "POLICY_EXCLUDED");
}

{
	const ss = setup();
	const master = ss.getSheetByName("Master_Contacts");
	master.rows[1][5] = "Checked";
	master.rows[1][7] = "I will not play this or support the release.";
	const selected = select(ss, {
		platforms: ["INSTAGRAM"],
		maxCandidatesPerRun: 1
	});
	assert.equal(selected.jobs[0].priority, 1);
	assert.equal(selected.jobs[0].priorityCategory, "OTHER_ENGAGEMENT_REVIEW");
}

{
	const ss = setup();
	const observationId = "OBS-REAL-002";
	const importLog = ss.insertSheet("Import_Log");
	importLog.rows = [
		["Observation Key", "Details"],
		[
			observationId,
			JSON.stringify({
				candidate: {
					"Name / DJ Alias": "DJ Example",
					"Station / Venue / Organization": "Example Radio"
				}
			})
		]
	];
	const result = context.djEnrichmentQueueTargets(
		ss,
		[{
			observationId: observationId,
			name: "Unrelated Person",
			station: "Forged Station"
		}],
		[],
		{ platforms: ["INSTAGRAM"] }
	);
	assert.equal(result.jobs.length, 1);
	assert.equal(
		result.jobs[0].query,
		"DJ Example instagram Example Radio"
	);
}

{
	const ss = setup();
	context.djSocialProfileSave(ss, {
		observationId: "OBS-EXISTING",
		sourceReportId: "REPORT-EXISTING"
	}, {
		observationId: "OBS-EXISTING",
		socialProfiles: ["https://www.instagram.com/dj-example/"]
	});
	const social = ss.getSheetByName("DJ_Social_Profiles");
	const profileId = social.rows[1][0];
	context.djSocialProfileReview(
		ss, profileId, "VERIFY", "CT-001",
		"reviewer", "Confirmed existing profile."
	);
	const result = context.djEnrichmentQueueTargets(
		ss, [target()], [], { platforms: ["INSTAGRAM"] }
	);
	assert.equal(result.jobs.length, 0);
	assert.equal(result.excluded[0].status, "ALREADY_VERIFIED");
	assert.equal(social.rows[1][10], "VERIFIED");
}

{
	const ss = setup();
	assert.throws(
		() => context.djEnrichmentQueueTargets(
			ss, [target({ contactId: "CT-404" })], [], { platforms: ["INSTAGRAM"] }
		),
		/Contact ID does not exist/
	);
	assert.throws(
		() => context.djEnrichmentQueueTargets(
			ss, [target({ contactId: "", observationId: "made-up" })],
			[], { platforms: ["INSTAGRAM"] }
		),
		/not present in MA-05/
	);
	ss.getSheetByName("Master_Contacts").rows[1][1] = "Alex";
	ss.getSheetByName("Master_Contacts").rows[1][2] = "";
	ss.getSheetByName("Master_Contacts").rows[1][3] = "";
	ss.getSheetByName("Master_Contacts").rows[1][4] = "";
	const result = context.djEnrichmentQueueTargets(
		ss,
		[target()],
		[],
		{ platforms: ["INSTAGRAM"] }
	);
	assert.equal(result.jobs.length, 0);
	assert.equal(result.excluded[0].status, "INSUFFICIENT_IDENTITY_DATA");
}

{
	const ss = setup();
	const provider = {
		providerId: "TEMP_FAILURE",
		authorized: true,
		supportedPlatforms: ["INSTAGRAM"],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search() {
			const error = new Error("temporary provider outage");
			error.retryable = true;
			throw error;
		}
	};
	const queued = context.djEnrichmentQueueTargets(
		ss, [target()], [provider], { platforms: ["INSTAGRAM"] }
	);
	const first = context.djEnrichmentProcessQueued(
		ss, [provider], { maxAttempts: 2, maxProviderRequests: 1 }
	);
	assert.equal(first.results[0].status, "QUEUED");
	const second = context.djEnrichmentProcessQueued(
		ss, [provider], { maxAttempts: 2, maxProviderRequests: 1 }
	);
	assert.equal(second.results[0].status, "SOURCE_UNAVAILABLE");
	assert.equal(context.djEnrichmentGetUsage(ss).totalRequests, 2);
	assert.ok(queued.jobs.length === 1);
}

{
	const ss = setup();
	const provider = fixtureProvider(context);
	context.djEnrichmentQueueTargets(
		ss, [target()], [provider], { platforms: ["INSTAGRAM"] }
	);
	ss.getSheetByName("DJ_Enrichment_Jobs").rows[1][5] = "PROCESSING";
	const resumed = context.djEnrichmentResume(
		ss, [provider], { maxProviderRequests: 1 }
	);
	assert.equal(resumed.results[0].status, "PENDING_REVIEW");
	assert.equal(
		ss.getSheetByName("DJ_Enrichment_Jobs").rows[1][5],
		"PENDING_REVIEW"
	);
}

{
	const ss = setup();
	let fetchCount = 0;
	const provider = {
		providerId: "AUTHORIZED_TEST",
		authorized: true,
		authorizedHosts: ["api.example"],
		supportedPlatforms: ["INSTAGRAM"],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search(query, requestContext) {
			requestContext.fetch(
				"PROFILE_SEARCH",
				"https://api.example/search?q=DJ%20Example",
				{}
			);
			fetchCount++;
			return { candidates: [] };
		}
	};
	const result = run(
		ss, [target()], [provider],
		{ platforms: ["INSTAGRAM"], maxApiCallsPerRun: 1 }
	);
	assert.equal(result.apiCalls, 1);
	assert.equal(fetchCount, 1);
	assert.equal(lastFetchedUrl, "https://api.example/search?q=DJ%20Example");
	assert.equal(context.djEnrichmentGetUsage(ss).apiCalls, 1);
	assert.equal(
		context.djEnrichmentGetUsage(ss).apiCallsByProvider.AUTHORIZED_TEST,
		1
	);
}

{
	const ss = setup();
	const result = run(ss, [target()], [], { platforms: ["BUSINESS_EMAIL"] });
	const candidateId = context.djEnrichmentAddManualCandidate(
		ss,
		result.jobs[0].jobId,
		{
			platform: "BUSINESS_EMAIL",
			candidateValue: "booking@example.org",
			sourceUrl: "https://example.org/contact",
			contactType: "BOOKING",
			professionalActivity: "Booking enquiries"
		},
		"researcher",
		"Public booking address listed on the official site."
	).enrichmentId;
	const candidate = context.djEnrichmentFindCandidate(ss, candidateId);
	assert.equal(candidate.row[6], "booking@example.org");
	assert.equal(candidate.row[8], "BOOKING");
	assert.equal(candidate.row[12], "NEEDS_RESEARCH");
	const history = ss.getSheetByName("DJ_Enrichment_Review_History");
	assert.equal(history.rows[1][3], "SUBMIT_MANUAL_CANDIDATE");
}

{
	const ss = setup();
	const result = run(ss, [target()], [], { platforms: ["INSTAGRAM"] });
	const jobId = result.jobs[0].jobId;
	const candidate = {
		platform: "INSTAGRAM",
		candidateUrl: "https://instagram.com/dj-example/",
		sourceUrl: "https://research.example/station",
		displayName: "Different Display Name",
		station: "Example Radio"
	};
	const first = context.djEnrichmentAddManualCandidate(
		ss, jobId, candidate, "researcher", "Station page found."
	);
	assert.equal(
		context.djEnrichmentFindCandidate(ss, first.enrichmentId).row[12],
		"NEEDS_RESEARCH"
	);
	context.djEnrichmentAddManualCandidate(
		ss,
		jobId,
		{
			...candidate,
			evidence: [{
				type: "OFFICIAL_CROSS_LINK",
				value: "https://instagram.com/dj-example/",
				sourceUrl: "https://research.example/artist"
			}]
		},
		"researcher",
		"Official artist page cross-links the same profile."
	);
	const upgraded = context.djEnrichmentFindCandidate(ss, first.enrichmentId);
	assert.equal(upgraded.row[12], "PENDING_REVIEW");
	assert.equal(ss.getSheetByName("DJ_Enrichment_Candidates").getLastRow(), 2);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Evidence").getLastRow(), 3);
}

{
	const ss = setup();
	const provider = fixtureProvider(context);
	run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	const candidateId = ss.getSheetByName("DJ_Enrichment_Candidates").rows[1][0];
	assert.deepEqual(
		{ ...review(ss, candidateId, "APPROVE", "reviewer", "Official station link checked.") },
		{ enrichmentId: candidateId, status: "APPROVED_FOR_MA05" }
	);
	assert.equal(
		ss.getSheetByName("DJ_Enrichment_Review_History").rows.length,
		2
	);
	assert.throws(
		() => review(ss, candidateId, "REJECT", "reviewer", "Changed mind."),
		/not awaiting review/
	);

	const identityReview = ss.insertSheet("DJ_Identity_Review");
	identityReview.rows = [
		[
			"Observation ID", "Review Status", "Selected Contact ID",
			"Reviewer", "Review Date"
		],
		["OBS-REAL-001", "APPROVED_LINK", "CT-001", "identity reviewer", "2026-11-11"]
	];
	const transferred = transfer(ss, candidateId, "OBS-REAL-001");
	assert.equal(transferred.contactId, "CT-001");
	assert.equal(transferred.observationId, "OBS-REAL-001");
	assert.equal(transferred.verificationStatus, "PENDING_REVIEW");
	const social = ss.getSheetByName("DJ_Social_Profiles");
	assert.equal(social.rows[1][1], "OBS-REAL-001");
	assert.equal(social.rows[1][4], "ENRICHMENT:SYNTHETIC_FIXTURE:" + candidateId);
	assert.equal(social.rows[1][5], "");
	assert.equal(social.rows[1][10], "PENDING_REVIEW");
	context.djSocialProfileReview(
		ss, transferred.profileIds[0], "VERIFY", "CT-001",
		"social reviewer", "Reviewed the cited official cross-link."
	);
	assert.equal(
		context.djSocialProfileGetVerified(ss, "CT-001").length,
		1
	);
	const repeatedTransfer = transfer(ss, candidateId, "OBS-REAL-001");
	assert.equal(repeatedTransfer.existing, true);
	assert.equal(repeatedTransfer.verificationStatus, "VERIFIED");
	assert.equal(social.getLastRow(), 2);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Evidence").rows.length, 4);
	assert.equal(ss.getSheetByName("DJ_Enrichment_Review_History").rows.length, 2);
}

{
	const ss = setup();
	const provider = {
		providerId: "CONFLICTING_FIXTURE",
		authorized: true,
		supportedPlatforms: ["INSTAGRAM"],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search() {
			return {
				candidates: [{
					platform: "INSTAGRAM",
					candidateUrl: "https://instagram.com/other-dj/",
					sourceUrl: "https://research.example/conflict",
					displayName: "Other DJ",
					evidence: [{
						type: "CONFLICTING_IDENTITY",
						value: "The linked page names a different person.",
						sourceUrl: "https://research.example/conflict"
					}]
				}]
			};
		}
	};
	const result = run(ss, [target()], [provider], { platforms: ["INSTAGRAM"] });
	const candidateId = result.processed[0].enrichmentIds[0];
	assert.equal(result.processed[0].status, "CONFLICTING");
	assert.throws(
		() => review(ss, candidateId, "APPROVE", "reviewer", "Insufficient."),
		/cannot be approved/
	);
	assert.equal(
		review(ss, candidateId, "REJECT", "reviewer", "Identity conflict confirmed.")
			.status,
		"REJECTED"
	);
}

{
	const ss = setup();
	const runResult = run(ss, [target()], [], { platforms: ["INSTAGRAM"] });
	const jobId = runResult.jobs[0].jobId;
	assert.throws(
		() => context.djEnrichmentAddManualCandidate(
			ss, jobId,
			{
				platform: "INSTAGRAM",
				candidateUrl: "https://instagram.com.evil.example/dj/",
				sourceUrl: "https://research.example/result",
				displayName: "DJ Example"
			},
			"researcher",
			"Rejected invalid host"
		),
		/invalid or does not match/
	);
	assert.throws(
		() => context.djEnrichmentAddManualCandidate(
			ss, jobId,
			{
				platform: "INSTAGRAM",
				candidateUrl: "http://localhost/private",
				sourceUrl: "https://research.example/result",
				displayName: "DJ Example"
			},
			"researcher",
			"Rejected local URL"
		),
		/invalid or does not match/
	);
}

{
	const ss = setup();
	const result = run(ss, [target()], [], { platforms: ["WEBSITE"] });
	context.djEnrichmentAddManualCandidate(
		ss,
		result.jobs[0].jobId,
		{
			platform: "WEBSITE",
			candidateUrl: "https://example.org/dj",
			sourceUrl: "https://example.org/directory",
			evidence: [{
				type: "PROFESSIONAL_ACTIVITY",
				value: "=1+1",
				sourceUrl: "https://example.org/directory"
			}]
		},
		"researcher",
		"=untrusted note"
	);
	assert.equal(
		ss.getSheetByName("DJ_Enrichment_Evidence").rows[1][3],
		"'=1+1"
	);
	assert.equal(
		ss.getSheetByName("DJ_Enrichment_Review_History").rows[1][6],
		"'=untrusted note"
	);
}

{
	const ss = setup();
	const master = ss.getSheetByName("Master_Contacts");
	master.rows[0][0] = "Wrong Header";
	assert.throws(
		() => context.djEnrichmentSelectCandidates(ss, { platforms: ["INSTAGRAM"] }),
		/missing or duplicates Contact ID/
	);
	const invalidSheetSpreadsheet = setup();
	const sheet = invalidSheetSpreadsheet.insertSheet("DJ_Enrichment_Jobs");
	sheet.rows = [["Job ID", "Wrong"]];
	assert.throws(
		() => context.djEnrichmentQueueTargets(
			invalidSheetSpreadsheet,
			[target()], [], { platforms: ["INSTAGRAM"] }
		),
		/Incorrect headers in DJ_Enrichment_Jobs/
	);
}

console.log("DJEnrichment tests passed.");
