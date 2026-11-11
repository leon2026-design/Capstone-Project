// MA-05: DJ Identity Review Tests
// Test identity review records, manual decisions, and review history.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Mock Google Sheets for local testing.
class MockSheet {
	constructor(name) {
		this.name = name;
		this.rows = [];
		this.frozenRows = 0;
	}

	getLastRow() {
		let last = this.rows.length;

		while (last > 0 && this.rows[last - 1].every(value => value === "" || value == null)) {
			last--;
		}

		return last;
	}

	getRange(row, column, numRows = 1, numColumns = 1) {
		const sheet = this;

		return {
			getDisplayValues() {
				return Array.from({ length: numRows }, (_, i) =>
					Array.from({ length: numColumns }, (_, j) => {
						const value = (sheet.rows[row + i - 1] || [])[column + j - 1];

						if (value instanceof Date) {
							return value.toISOString();
						}

						return String(value == null ? "" : value);
					})
				);
			},

			setValues(values) {
				assert.equal(values.length, numRows);

				for (let i = 0; i < numRows; i++) {
					assert.equal(values[i].length, numColumns);

					const rowIndex = row + i - 1;

					while (sheet.rows.length <= rowIndex) {
						sheet.rows.push([]);
					}

					const target = sheet.rows[rowIndex];

					for (let j = 0; j < numColumns; j++) {
						const columnIndex = column + j - 1;

						while (target.length <= columnIndex) {
							target.push("");
						}

						target[columnIndex] = values[i][j];
					}
				}
			}
		};
	}

	getDataRange() {
		const height = Math.max(1, this.getLastRow());
		const width = Math.max(1, ...this.rows.map(row => row.length));

		return this.getRange(1, 1, height, width);
	}

	appendRow(values) {
		this.rows.push([...values]);
	}

	setFrozenRows(count) {
		this.frozenRows = count;
	}
}

// Mock spreadsheet containing multiple sheets.
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

// Mock Apps Script services.
let nextUuid = 0;
let locksAcquired = 0;
let locksReleased = 0;

const context = vm.createContext({
	LockService: {
		getScriptLock() {
			return {
				waitLock() {
					locksAcquired++;
				},

				releaseLock() {
					locksReleased++;
				}
			};
		}
	},

	Utilities: {
		getUuid() {
			return "TEST-" + (++nextUuid);
		}
	}
});

// Load the actual project modules.
const files = [
	"ContactMatcher.js",
	"DJIdentityResolver.js",
	"DJIdentityReview.js"
];

for (const filename of files) {
	const filePath = path.join(__dirname, "..", filename);
	const code = fs.readFileSync(filePath, "utf8");

	vm.runInContext(code, context, { filename });
}

const resolveIdentity = context.djResolveIdentity;
const saveReview = context.djIdentitySaveReview;
const reviewDecision = context.djIdentityReviewDecision;

// Create a spreadsheet with sample contacts.
function setup() {
	const ss = new MockSpreadsheet();
	const master = ss.insertSheet("Master_Contacts");

	master.rows = [
		["Contact ID", "Name / DJ Alias"],
		["CT-001", "DJ Alex"],
		["CT-002", "DJ Mike"]
	];

	return ss;
}

// Create a sample MA-04 observation.
function makeObservation(fields = {}) {
	return {
		observationId: "OBS-001",
		djReportedName: "DJ Alex",
		sourceReportId: "REPORT-001",
		sourcePage: 4,
		sourceSection: "Downloaded No Feedback",
		sourceUrl: "https://example.com/report",
		...fields
	};
}

// Create an uncertain identity matching result.
function makeResult(fields = {}) {
	return {
		observationId: "OBS-001",
		reportedName: "DJ Alex",
		status: "POSSIBLE_MATCH",
		decision: "REVIEW",
		contactId: null,

		candidates: [{
			contactId: "CT-001",
			status: "POSSIBLE_MATCH",
			matchScore: 30,
			matchingFields: ["Name + Organization"],
			conflictingFields: [],
			safeToAutoLink: false
		}],

		socialProfiles: [{
			platform: "INSTAGRAM",
			profileUrl: "https://instagram.com/djalex",
			verificationStatus: "PENDING_REVIEW"
		}],

		...fields
	};
}

// Read a saved review record.
function getReview(ss, row = 2) {
	const sheet = ss.getSheetByName("DJ_Identity_Review");

	return sheet ? sheet.rows[row - 1] : null;
}

// Read the review history sheet.
function getHistory(ss) {
	return ss.getSheetByName("DJ_Identity_Review_History");
}

let passed = 0;
let failed = 0;

// Run a test and display the result.
function runTest(name, callback) {
	try {
		callback();

		console.log("PASS: " + name);
		passed++;
	} catch (error) {
		console.log("FAIL: " + name);
		console.log("  " + error.message);
		failed++;
	}
}

// Test 1: Create a review sheet and save a pending identity.
runTest("Create identity review sheet", () => {
	const ss = setup();

	const row = saveReview(ss, makeObservation(), makeResult());
	const sheet = ss.getSheetByName("DJ_Identity_Review");

	assert.equal(row, 2);
	assert.ok(sheet);
	assert.equal(sheet.frozenRows, 1);
	assert.equal(getReview(ss)[0], "OBS-001");
	assert.equal(getReview(ss)[10], "PENDING");
});

// Test 2: Preserve matching evidence and social profiles.
runTest("Preserve identity matching evidence", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const row = getReview(ss);
	const candidates = JSON.parse(row[8]);
	const profiles = JSON.parse(row[9]);

	assert.equal(candidates[0].contactId, "CT-001");
	assert.equal(candidates[0].matchScore, 30);
	assert.equal(candidates[0].matchingFields[0], "Name + Organization");
	assert.equal(profiles[0].platform, "INSTAGRAM");
	assert.equal(profiles[0].verificationStatus, "PENDING_REVIEW");
});

// Test 3: Exact links should not be placed in the review queue.
runTest("Skip confirmed identity links", () => {
	const ss = setup();

	const result = makeResult({
		status: "EXACT_MATCH",
		decision: "LINK",
		contactId: "CT-001"
	});

	const row = saveReview(ss, makeObservation(), result);

	assert.equal(row, null);
	assert.equal(ss.getSheetByName("DJ_Identity_Review"), null);
});

// Test 4: Save an unresolved DJ without a contact match.
runTest("Save unresolved DJ identity", () => {
	const ss = setup();

	const result = makeResult({
		status: "NO_MATCH",
		decision: "UNRESOLVED",
		candidates: []
	});

	saveReview(ss, makeObservation(), result);

	assert.equal(getReview(ss)[6], "NO_MATCH");
	assert.equal(getReview(ss)[7], "");
	assert.equal(getReview(ss)[10], "PENDING");
});

// Test 5: Repeated imports should not create duplicate reviews.
runTest("Prevent duplicate review records", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());
	const secondRow = saveReview(ss, makeObservation(), makeResult());

	assert.equal(secondRow, 2);
	assert.equal(ss.getSheetByName("DJ_Identity_Review").getLastRow(), 2);
});

// Test 6: The same observation ID cannot refer to another report.
runTest("Reject conflicting source report", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const another = makeObservation({
		sourceReportId: "REPORT-002"
	});

	assert.throws(() => {
		saveReview(ss, another, makeResult());
	}, /different source report/);
});

// Test 7: Missing or conflicting observation IDs must be rejected.
runTest("Validate observation IDs", () => {
	const ss = setup();

	assert.throws(() => {
		saveReview(ss, makeObservation(), makeResult({
			observationId: ""
		}));
	}, /Invalid observation ID/);

	assert.throws(() => {
		saveReview(ss, makeObservation(), makeResult({
			observationId: "OBS-999"
		}));
	}, /Invalid observation ID/);
});

// Test 8: Invalid resolver decisions must be rejected.
runTest("Reject invalid resolver decision", () => {
	const ss = setup();

	assert.throws(() => {
		saveReview(ss, makeObservation(), makeResult({
			decision: "MERGE"
		}));
	}, /Invalid identity resolution decision/);
});

// Test 9: Existing sheet headers must be validated.
runTest("Reject incorrect review sheet headers", () => {
	const ss = setup();
	const sheet = ss.insertSheet("DJ_Identity_Review");

	sheet.rows = [["Wrong Header", "Reported Name"]];

	assert.throws(() => {
		saveReview(ss, makeObservation(), makeResult());
	}, /Incorrect headers/);
});

// Test 10: Formula-like imported text must remain literal.
runTest("Escape spreadsheet formulas", () => {
	const ss = setup();

	const result = makeResult({
		reportedName: '=HYPERLINK("test")'
	});

	saveReview(ss, makeObservation(), result);

	assert.equal(getReview(ss)[1], '\'=HYPERLINK("test")');
});

// Test 11: Approve a suggested contact and record the decision.
runTest("Approve manual identity link", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const result = reviewDecision(
		ss, "OBS-001", "CONFIRM_LINK", "CT-001", "Wenhe", "Verified manually"
	);

	assert.equal(result.status, "APPROVED_LINK");
	assert.equal(result.contactId, "CT-001");

	const row = getReview(ss);

	assert.equal(row[10], "APPROVED_LINK");
	assert.equal(row[11], "CT-001");
	assert.equal(row[12], "Wenhe");
	assert.equal(Object.prototype.toString.call(row[13]), "[object Date]");
    assert.ok(!Number.isNaN(row[13].getTime()));

	const history = getHistory(ss);

	assert.equal(history.getLastRow(), 2);
	assert.equal(history.rows[1][3], "CONFIRM_LINK");
	assert.equal(history.rows[1][5], "CT-001");
});

// Test 12: An unknown contact cannot be approved.
runTest("Reject unknown Contact ID", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewDecision(
			ss, "OBS-001", "CONFIRM_LINK", "CT-999", "Wenhe", "Checked"
		);
	}, /does not exist/);

	assert.equal(getReview(ss)[10], "PENDING");
});

// Test 13: Linking to an unlisted contact requires an explanation.
runTest("Require notes for alternative contact", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewDecision(
			ss, "OBS-001", "CONFIRM_LINK", "CT-002", "Wenhe", ""
		);
	}, /Notes are required/);

	assert.equal(getReview(ss)[10], "PENDING");
});

// Test 14: Allow a documented manual correction.
runTest("Approve alternative contact with notes", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const result = reviewDecision(
		ss,
		"OBS-001",
		"CONFIRM_LINK",
		"CT-002",
		"Wenhe",
		"Verified that this DJ belongs to CT-002"
	);

	assert.equal(result.status, "APPROVED_LINK");
	assert.equal(result.contactId, "CT-002");
	assert.equal(getReview(ss)[14], "Verified that this DJ belongs to CT-002");
});

// Test 15: A reviewer can reject an identity association.
runTest("Reject identity association", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const result = reviewDecision(
		ss, "OBS-001", "NO_LINK", "", "Wenhe", "Different individuals"
	);

	assert.equal(result.status, "UNRESOLVED");
	assert.equal(result.contactId, null);
	assert.equal(getReview(ss)[11], "");

	const history = getHistory(ss);

	assert.equal(history.rows[1][3], "NO_LINK");
});

// Test 16: Research can be followed by a final decision.
runTest("Review identity after further research", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	const first = reviewDecision(
		ss, "OBS-001", "NEEDS_RESEARCH", "", "Wenhe", "Check social profile"
	);

	assert.equal(first.status, "NEEDS_RESEARCH");

	const second = reviewDecision(
		ss, "OBS-001", "CONFIRM_LINK", "CT-001", "Wenhe", "Profile verified"
	);

	assert.equal(second.status, "APPROVED_LINK");
	assert.equal(getHistory(ss).getLastRow(), 3);
});

// Test 17: Finalized decisions cannot be overwritten.
runTest("Prevent changing finalized decisions", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	reviewDecision(
		ss, "OBS-001", "CONFIRM_LINK", "CT-001", "Wenhe", "Approved"
	);

	assert.throws(() => {
		reviewDecision(
			ss, "OBS-001", "NO_LINK", "", "Wenhe", "Change decision"
		);
	}, /already finalized/);

	assert.equal(getReview(ss)[10], "APPROVED_LINK");
});

// Test 18: Review decisions require valid inputs.
runTest("Validate manual review decisions", () => {
	const ss = setup();

	saveReview(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewDecision(ss, "OBS-001", "INVALID", "", "Wenhe", "");
	}, /valid decision/);

	assert.throws(() => {
		reviewDecision(ss, "OBS-001", "NO_LINK", "", "", "");
	}, /reviewer/);

	assert.throws(() => {
		reviewDecision(ss, "OBS-001", "CONFIRM_LINK", "", "Wenhe", "");
	}, /Selected Contact ID/);

	assert.throws(() => {
		reviewDecision(ss, "OBS-001", "NO_LINK", "CT-001", "Wenhe", "");
	}, /Selected Contact ID/);
});

// Test 19: Duplicate Contact IDs in Master_Contacts must be rejected.
runTest("Reject duplicate master contact IDs", () => {
	const ss = setup();
	const master = ss.getSheetByName("Master_Contacts");

	master.rows.push(["CT-001", "Another DJ"]);

	saveReview(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewDecision(
			ss, "OBS-001", "CONFIRM_LINK", "CT-001", "Wenhe", "Check"
		);
	}, /Duplicate Contact ID/);
});

// Test 20: The review system must work with the actual resolver.
runTest("Resolver and review integration", () => {
	const ss = setup();

	const contacts = [{
		"Contact ID": "CT-001",
		"Name / DJ Alias": "DJ Alex",
		"Station / Venue / Organization": "WXYZ",
		Email: "alex@radio.com"
	}];

	const observation = makeObservation({
		station: "WXYZ",
		email: "alex@gmail.com"
	});

	const result = resolveIdentity(observation, contacts);

	assert.equal(result.decision, "REVIEW");

	const row = saveReview(ss, observation, result);

	assert.equal(row, 2);
	assert.equal(getReview(ss)[10], "PENDING");
	assert.equal(getReview(ss)[7], "CT-001");
});

// Verify that all acquired locks were released.
runTest("Release script locks after review operations", () => {
	assert.equal(locksAcquired, locksReleased);
});

// Print the test summary.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed === 0) {
	console.log("ALL " + passed + " TESTS PASSED!");
} else {
	console.log(failed + " TESTS FAILED!");
	process.exitCode = 1;
}
