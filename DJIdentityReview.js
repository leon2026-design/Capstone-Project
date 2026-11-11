
// MA-05: DJ Social Profile Store Tests
// Test social profile storage, verification, duplicate prevention, and history.

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

						if (Object.prototype.toString.call(value) === "[object Date]") {
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

					const index = row + i - 1;

					while (sheet.rows.length <= index) {
						sheet.rows.push([]);
					}

					const target = sheet.rows[index];

					for (let j = 0; j < numColumns; j++) {
						const col = column + j - 1;

						while (target.length <= col) {
							target.push("");
						}

						target[col] = values[i][j];
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

// Mock spreadsheet with multiple sheets.
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
	"DJSocialProfileStore.js"
];

for (const filename of files) {
	const filePath = path.join(__dirname, "..", filename);
	const code = fs.readFileSync(filePath, "utf8");

	vm.runInContext(code, context, { filename });
}

const saveProfile = context.djSocialProfileSave;
const reviewProfile = context.djSocialProfileReview;
const getVerified = context.djSocialProfileGetVerified;
const resolveIdentity = context.djResolveIdentity;

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
		sourceSection: "DJs",
		sourceUrl: "https://example.com/report",
		...fields
	};
}

// Create a sample identity resolution result.
function makeResult(fields = {}) {
	return {
		observationId: "OBS-001",
		reportedName: "DJ Alex",
		status: "POSSIBLE_MATCH",
		decision: "REVIEW",
		contactId: null,
		candidates: [],
		socialProfiles: [{
			platform: "INSTAGRAM",
			profileUrl: "https://instagram.com/djalex",
			evidenceSource: "REPORT_COMMENT",
			verificationStatus: "PENDING_REVIEW"
		}],
		...fields
	};
}

// Read the social profile sheet.
function getProfileSheet(ss) {
	return ss.getSheetByName("DJ_Social_Profiles");
}

// Read a saved social profile.
function getProfile(ss, row = 2) {
	const sheet = getProfileSheet(ss);

	return sheet ? sheet.rows[row - 1] : null;
}

// Add an identity review record for testing.
function addIdentityReview(ss, status, contactId) {
	const sheet = ss.insertSheet("DJ_Identity_Review");

	sheet.rows = [
		["Observation ID", "Review Status", "Selected Contact ID"],
		["OBS-001", status, contactId]
	];

	return sheet;
}

let passed = 0;
let failed = 0;

// Run a test and display the result.
function test(name, callback) {
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

// Test 1: Create the profile sheet and save a new account.
test("Create social profile sheet", () => {
	const ss = setup();

	const ids = saveProfile(ss, makeObservation(), makeResult());
	const sheet = getProfileSheet(ss);

	assert.equal(ids.length, 1);
	assert.ok(ids[0].startsWith("DJSP-"));
	assert.equal(sheet.getLastRow(), 2);
	assert.equal(sheet.frozenRows, 1);
	assert.equal(getProfile(ss)[10], "PENDING_REVIEW");
});

// Test 2: An observation without profiles creates no records.
test("Skip missing social profiles", () => {
	const ss = setup();
	const result = makeResult({ socialProfiles: [] });

	const ids = saveProfile(ss, makeObservation(), result);

	assert.equal(ids.length, 0);
	assert.equal(getProfileSheet(ss), null);
});

// Test 3: Instagram, Facebook, and SoundCloud stay separate.
test("Preserve different social platforms", () => {
	const ss = setup();

	const result = makeResult({
		socialProfiles: [
			"instagram.com/djalex",
			"facebook.com/djalex",
			"soundcloud.com/djalex"
		]
	});

	const ids = saveProfile(ss, makeObservation(), result);

	assert.equal(ids.length, 3);
	assert.equal(getProfileSheet(ss).getLastRow(), 4);

	const platforms = [
		getProfile(ss, 2)[2],
		getProfile(ss, 3)[2],
		getProfile(ss, 4)[2]
	].sort();

	assert.deepEqual(platforms, [
		"FACEBOOK",
		"INSTAGRAM",
		"SOUNDCLOUD"
	]);
});

// Test 4: Reimporting the same profile does not create duplicates.
test("Prevent duplicate profile imports", () => {
	const ss = setup();

	const first = saveProfile(ss, makeObservation(), makeResult());
	const second = saveProfile(ss, makeObservation(), makeResult());

	assert.equal(first[0], second[0]);
	assert.equal(getProfileSheet(ss).getLastRow(), 2);
});

// Test 5: One profile can be reported in different observations.
test("Preserve separate observation evidence", () => {
	const ss = setup();

	const first = saveProfile(ss, makeObservation(), makeResult());

	const second = saveProfile(
		ss,
		makeObservation({
			observationId: "OBS-002",
			sourceReportId: "REPORT-002"
		}),
		makeResult({
			observationId: "OBS-002"
		})
	);

	assert.notEqual(first[0], second[0]);
	assert.equal(getProfileSheet(ss).getLastRow(), 3);
});

// Test 6: The same observation cannot change its source report.
test("Reject conflicting source reports", () => {
	const ss = setup();

	saveProfile(ss, makeObservation(), makeResult());

	assert.throws(() => {
		saveProfile(
			ss,
			makeObservation({
				sourceReportId: "REPORT-999"
			}),
			makeResult()
		);
	}, /Conflicting source report/);
});

// Test 7: Observation IDs must match.
test("Validate observation IDs", () => {
	const ss = setup();

	assert.throws(() => {
		saveProfile(
			ss,
			makeObservation(),
			makeResult({
				observationId: "OBS-999"
			})
		);
	}, /Invalid observation ID/);
});

// Test 8: Unsupported social profile URLs must be rejected.
test("Reject unsupported social profiles", () => {
	const ss = setup();

	assert.throws(() => {
		saveProfile(
			ss,
			makeObservation(),
			makeResult({
				socialProfiles: ["https://unknown.example/djalex"]
			})
		);
	}, /Invalid or unsupported social profile/);
});

// Test 9: Preserve profile source information.
test("Preserve social profile evidence", () => {
	const ss = setup();

	saveProfile(ss, makeObservation(), makeResult());

	const row = getProfile(ss);

	assert.equal(row[1], "OBS-001");
	assert.equal(row[2], "INSTAGRAM");
	assert.equal(row[4], "REPORT_COMMENT");
	assert.equal(row[5], "REPORT-001");
	assert.equal(row[6], "4");
	assert.equal(row[7], "DJs");
	assert.equal(row[8], "https://example.com/report");
});

// Test 10: Imported text must not become spreadsheet formulas.
test("Escape spreadsheet formulas", () => {
	const ss = setup();

	saveProfile(
		ss,
		makeObservation({
			sourceSection: '=HYPERLINK("test")'
		}),
		makeResult()
	);

	assert.equal(getProfile(ss)[7], '\'=HYPERLINK("test")');
});

// Test 11: Unverified profiles cannot become verified automatically.
test("Require manual verification", () => {
	const ss = setup();

	saveProfile(
		ss,
		makeObservation(),
		makeResult({
			socialProfiles: [{
				profileUrl: "instagram.com/djalex",
				verificationStatus: "VERIFIED"
			}]
		})
	);

	assert.equal(getProfile(ss)[10], "PENDING_REVIEW");
	assert.equal(getProfile(ss)[9], "");
});

// Test 12: Verify an account for an existing contact.
test("Approve verified social profile", () => {
	const ss = setup();

	const ids = saveProfile(ss, makeObservation(), makeResult());

	const result = reviewProfile(
		ss,
		ids[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Confirmed profile ownership"
	);

	assert.equal(result.status, "VERIFIED");
	assert.equal(result.contactId, "CT-001");

	const row = getProfile(ss);

	assert.equal(row[9], "CT-001");
	assert.equal(row[10], "VERIFIED");
	assert.equal(row[11], "Reviewer");
	assert.equal(Object.prototype.toString.call(row[12]), "[object Date]");
	assert.ok(!Number.isNaN(row[12].getTime()));

	const history = ss.getSheetByName("DJ_Social_Profile_History");

	assert.equal(history.getLastRow(), 2);
	assert.equal(history.rows[1][4], "VERIFY");
});

// Test 13: A profile cannot link to a missing contact.
test("Reject unknown Contact ID", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"VERIFY",
			"CT-999",
			"Reviewer",
			"Checked"
		);
	}, /does not exist/);

	assert.equal(getProfile(ss)[10], "PENDING_REVIEW");
});

// Test 14: A pending identity review blocks profile verification.
test("Block unresolved identity review", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	addIdentityReview(ss, "PENDING", "");

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"VERIFY",
			"CT-001",
			"Reviewer",
			"Checked"
		);
	}, /conflicts with identity review/);
});

// Test 15: Approved identity review allows the matching contact.
test("Accept approved identity review", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	addIdentityReview(ss, "APPROVED_LINK", "CT-001");

	const result = reviewProfile(
		ss,
		ids[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Verified account"
	);

	assert.equal(result.status, "VERIFIED");
	assert.equal(result.contactId, "CT-001");
});

// Test 16: Profile verification cannot conflict with approved identity.
test("Reject conflicting approved contact", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	addIdentityReview(ss, "APPROVED_LINK", "CT-001");

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"VERIFY",
			"CT-002",
			"Reviewer",
			"Checked"
		);
	}, /conflicts with identity review/);
});

// Test 17: A reviewer can reject a social profile.
test("Reject incorrect social profile", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	const result = reviewProfile(
		ss,
		ids[0],
		"REJECT",
		"",
		"Reviewer",
		"Not the correct DJ"
	);

	assert.equal(result.status, "REJECTED");
	assert.equal(result.contactId, null);
	assert.equal(getProfile(ss)[10], "REJECTED");
	assert.equal(getProfile(ss)[9], "");
});

// Test 18: A profile can be verified after further research.
test("Verify profile after further research", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	const first = reviewProfile(
		ss,
		ids[0],
		"NEEDS_RESEARCH",
		"",
		"Reviewer",
		"Check profile ownership"
	);

	assert.equal(first.status, "NEEDS_RESEARCH");

	const second = reviewProfile(
		ss,
		ids[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Ownership confirmed"
	);

	assert.equal(second.status, "VERIFIED");

	const history = ss.getSheetByName("DJ_Social_Profile_History");

	assert.equal(history.getLastRow(), 3);
});

// Test 19: Finalized verification cannot be overwritten.
test("Prevent overwriting final decisions", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	reviewProfile(
		ss,
		ids[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Confirmed"
	);

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"REJECT",
			"",
			"Reviewer",
			"Changed decision"
		);
	}, /already been reviewed/);

	assert.equal(getProfile(ss)[10], "VERIFIED");
});

// Test 20: Invalid verification decisions must be rejected.
test("Validate social profile decisions", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewProfile(
			ss, ids[0], "INVALID", "", "Reviewer", "Checked"
		);
	}, /valid decision/);

	assert.throws(() => {
		reviewProfile(
			ss, ids[0], "VERIFY", "", "Reviewer", "Checked"
		);
	}, /Invalid Contact ID/);

	assert.throws(() => {
		reviewProfile(
			ss, ids[0], "REJECT", "CT-001", "Reviewer", "Checked"
		);
	}, /Invalid Contact ID/);

	assert.throws(() => {
		reviewProfile(
			ss, ids[0], "VERIFY", "CT-001", "", "Checked"
		);
	}, /reviewer/);
});

// Test 21: Review notes must be provided.
test("Require social profile review notes", () => {
	const ss = setup();
	const ids = saveProfile(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"VERIFY",
			"CT-001",
			"Reviewer",
			""
		);
	}, /Review notes are required/);
});

// Test 22: Duplicate master contact IDs must be rejected.
test("Reject duplicate master contact IDs", () => {
	const ss = setup();
	const master = ss.getSheetByName("Master_Contacts");

	master.rows.push(["CT-001", "Another DJ"]);

	const ids = saveProfile(ss, makeObservation(), makeResult());

	assert.throws(() => {
		reviewProfile(
			ss,
			ids[0],
			"VERIFY",
			"CT-001",
			"Reviewer",
			"Checked"
		);
	}, /Duplicate Contact ID/);
});

// Test 23: Return only verified profiles for the selected contact.
test("Get verified social profiles", () => {
	const ss = setup();

	const first = saveProfile(
		ss,
		makeObservation(),
		makeResult()
	);

	const second = saveProfile(
		ss,
		makeObservation({
			observationId: "OBS-002",
			sourceReportId: "REPORT-002"
		}),
		makeResult({
			observationId: "OBS-002"
		})
	);

	reviewProfile(
		ss,
		first[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Confirmed"
	);

	reviewProfile(
		ss,
		second[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Confirmed"
	);

	const profiles = getVerified(ss, "CT-001");

	// Two observations of the same account should return one verified profile.
	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].platform, "INSTAGRAM");
	assert.equal(profiles[0].verificationStatus, "VERIFIED");
	assert.equal(getVerified(ss, "CT-002").length, 0);
});

// Test 24: Verified profiles can be reused by DJIdentityResolver.
test("Social profile and identity resolver integration", () => {
	const ss = setup();

	const ids = saveProfile(ss, makeObservation(), makeResult());

	reviewProfile(
		ss,
		ids[0],
		"VERIFY",
		"CT-001",
		"Reviewer",
		"Confirmed"
	);

	const verified = getVerified(ss, "CT-001");

	const existing = [{
		"Contact ID": "CT-001",
		"Name / DJ Alias": "DJ Alex",
		"Social Accounts": "instagram.com/djalex",
		verifiedSocialProfiles: verified
	}];

	const incoming = makeObservation({
		socialProfiles: [{
			profileUrl: "https://instagram.com/djalex",
			verificationStatus: "VERIFIED"
		}]
	});

	const result = resolveIdentity(incoming, existing);

	assert.equal(result.status, "EXACT_MATCH");
	assert.equal(result.decision, "LINK");
	assert.equal(result.contactId, "CT-001");
});

// Test 25: Verify that all script locks were released.
test("Release script locks", () => {
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
