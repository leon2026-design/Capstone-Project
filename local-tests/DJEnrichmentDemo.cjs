// Privacy-safe, offline MA-06 demonstration using fictional records.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MockSheet {
	constructor(name) {
		this.name = name;
		this.rows = [];
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
					Array.from({ length: numColumns }, (_, j) =>
						String(((sheet.rows[row + i - 1] || [])[column + j - 1]) ?? "")
					)
				);
			},
			setValues(values) {
				values.forEach((valuesRow, i) => {
					const rowIndex = row + i - 1;
					while (sheet.rows.length <= rowIndex) sheet.rows.push([]);
					valuesRow.forEach((value, j) => {
						const columnIndex = column + j - 1;
						while (sheet.rows[rowIndex].length <= columnIndex) {
							sheet.rows[rowIndex].push("");
						}
						sheet.rows[rowIndex][columnIndex] = value;
					});
				});
			},
			setValue(value) {
				this.setValues([[value]]);
			}
		};
	}
	getDataRange() {
		return this.getRange(1, 1, Math.max(1, this.getLastRow()), this.getLastColumn());
	}
	appendRow(values) {
		this.rows.push([...values]);
	}
	setFrozenRows() {}
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
const context = vm.createContext({
	URL,
	LockService: {
		getScriptLock() {
			return { waitLock() {}, releaseLock() {} };
		}
	},
	Utilities: {
		getUuid() {
			return "DEMO-" + (++nextUuid);
		}
	}
});

for (const filename of [
	"ContactMatcher.js",
	"DJIdentityResolver.js",
	"DJIdentityReview.js",
	"DJSocialProfileStore.js",
	"DJEnrichment.js"
]) {
	vm.runInContext(
		fs.readFileSync(path.join(__dirname, "..", filename), "utf8"),
		context,
		{ filename }
	);
}

const ss = new MockSpreadsheet();
const master = ss.insertSheet("Master_Contacts");
master.rows = [
	[
		"Contact ID", "Name / DJ Alias",
		"Station / Venue / Organization", "City", "Country"
	],
	["CT-DEMO-001", "DJ Example", "Example Radio", "Columbus", "United States"],
	["CT-DEMO-002", "DJ Unverified", "Sample Radio", "Columbus", "United States"]
];

const observation = {
	observationId: "OBS-SYNTHETIC-001",
	djReportedName: "DJ Example",
	sourceReportId: "REPORT-SYNTHETIC-001",
	sourcePage: 1,
	sourceSection: "Synthetic engagement"
};
context.djIdentitySaveReview(ss, observation, {
	observationId: observation.observationId,
	reportedName: observation.djReportedName,
	status: "POSSIBLE_MATCH",
	decision: "REVIEW",
	candidates: [{ contactId: "CT-DEMO-001" }],
	socialProfiles: []
});
context.djIdentityReviewDecision(
	ss,
	observation.observationId,
	"CONFIRM_LINK",
	"CT-DEMO-001",
	"Synthetic reviewer",
	"Confirmed the fictional contact for this offline demo."
);

const provider = context.djEnrichmentCreateFixtureProvider({
	"DJ Example|INSTAGRAM": [
		{
			platform: "INSTAGRAM",
			candidateUrl: "https://www.instagram.com/dj-example/",
			sourceUrl: "https://example-radio.test/djs",
			displayName: "DJ Example",
			station: "Example Radio",
			evidence: [{
				type: "OFFICIAL_CROSS_LINK",
				value: "https://www.instagram.com/dj-example/",
				sourceUrl: "https://example-radio.test/djs"
			}]
		},
		{
			platform: "INSTAGRAM",
			candidateUrl: "https://www.instagram.com/example-promotions/",
			sourceUrl: "https://example-radio.test/partners",
			displayName: "Example Promotions",
			station: "Example Radio",
			city: "Columbus"
		}
	]
});
const target = {
	contactId: "CT-DEMO-001",
	name: "Ignored in favor of Master_Contacts"
};
const result = context.djEnrichmentRun(
	ss, [target], [provider], { platforms: ["INSTAGRAM"] }
);
const candidates = ss.getSheetByName("DJ_Enrichment_Candidates").rows.slice(1);
const correct = candidates.find(row =>
	row[5].endsWith("/dj-example")
);
const incorrect = candidates.find(row =>
	row[5].endsWith("/example-promotions")
);

if (!correct || !incorrect ||
	correct[12] !== "PENDING_REVIEW" ||
	incorrect[12] !== "PENDING_REVIEW") {
	throw new Error("Fixture candidates did not enter manual review: " +
		JSON.stringify({ result: result, candidates: candidates }));
}

context.djEnrichmentReview(
	ss, correct[0], "APPROVE", "Synthetic reviewer",
	"Official station cross-link and matching alias."
);
context.djEnrichmentReview(
	ss, incorrect[0], "REJECT", "Synthetic reviewer",
	"Station affiliation alone does not establish that this is the DJ's account."
);

const transferred = context.djEnrichmentTransferApproved(
	ss, correct[0], observation.observationId
);
context.djSocialProfileReview(
	ss, transferred.profileIds[0], "VERIFY", "CT-DEMO-001",
	"Synthetic reviewer", "Confirmed against the official station link."
);

const repeated = context.djEnrichmentRun(
	ss, [target], [provider], { platforms: ["INSTAGRAM"] }
);
const offline = context.djEnrichmentRun(
	ss,
	[{
		contactId: "CT-DEMO-002",
		name: "Ignored in favor of Master_Contacts"
	}],
	[],
	{ platforms: ["INSTAGRAM"] }
);

console.log(JSON.stringify({
	mode: "OFFLINE_SYNTHETIC_FIXTURE",
	liveResearchPerformed: false,
	firstRunStatus: result.processed[0].status,
	candidateCount: candidates.length,
	approvedCandidateStatus:
		context.djEnrichmentFindCandidate(ss, correct[0]).row[12],
	rejectedCandidateStatus:
		context.djEnrichmentFindCandidate(ss, incorrect[0]).row[12],
	ma05ProfileStatus: transferred.verificationStatus,
	verifiedProfileCount: context.djSocialProfileGetVerified(
		ss, "CT-DEMO-001"
	).length,
	repeatedRunJobCount: repeated.jobs.length,
	repeatedRunCandidateCount:
		ss.getSheetByName("DJ_Enrichment_Candidates").getLastRow() - 1,
	offlineTaskStatus: offline.jobs.length
		? ss.getSheetByName("DJ_Enrichment_Jobs").rows.at(-1)[5]
		: "NO_TASK"
}, null, 2));
