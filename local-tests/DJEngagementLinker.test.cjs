
// MA-05: DJ Engagement Linker Tests
// Test MA-04 campaign history, identity approval, and safe engagement linking.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");

const MASTER_HEADERS = [
	"Contact ID", "Name / DJ Alias", "Role",
	"Station / Venue / Organization", "City", "State / Region",
	"Country", "Email", "Phone", "Social Accounts",
	"Sources", "Review Status", "Review Notes", "Last Updated"
];

const REPORT_HEADERS = [
	"Name / DJ Alias", "First Name", "Last Name",
	"Radio Station", "Email Address", "Social Media Account",
	"Rating", "Favorite Track", "Comments", "Campaign Status",
	"Campaign / Release", "Report Generated At", "Activity Time",
	"Report Source ID", "Report Source URL", "Report Extracted At"
];

// Mock a Google Sheet.
class MockSheet {
	constructor(name, id, rows = []) {
		this.name = name;
		this.id = id;
		this.rows = rows.map(row => [...row]);
		this.maxRows = Math.max(2, rows.length);
		this.maxCols = 26;
		this.notes = new Map();
		this.hidden = new Set();
		this.writes = 0;
	}

	getName() {
		return this.name;
	}

	getSheetId() {
		return this.id;
	}

	getLastRow() {
		let count = this.rows.length;

		while (count > 0 &&
			!this.rows[count - 1].some(value => value !== "" && value != null)) {
			count--;
		}

		return count;
	}

	getLastColumn() {
		return Math.max(0, ...this.rows.map(row => {
			let count = row.length;

			while (count > 0 &&
				(row[count - 1] === "" || row[count - 1] == null)) {
				count--;
			}

			return count;
		}));
	}

	getMaxRows() {
		return this.maxRows;
	}

	getMaxColumns() {
		return this.maxCols;
	}

	insertRowsAfter(row, count) {
		this.maxRows += count;
	}

	insertColumnsAfter(column, count) {
		this.maxCols += count;
	}

	setFrozenRows() {}

	hideColumns(column) {
		this.hidden.add(column);
	}

	getDataRange() {
		return this.getRange(
			1,
			1,
			Math.max(1, this.getLastRow()),
			Math.max(1, this.getLastColumn())
		);
	}

	getRange(startRow, startCol, height = 1, width = 1) {
		assert.ok(startRow > 0 && startCol > 0);
		assert.ok(height > 0 && width > 0);
		assert.ok(startRow + height - 1 <= this.maxRows);
		assert.ok(startCol + width - 1 <= this.maxCols);

		const sheet = this;

		return {
			getValues() {
				return Array.from({ length: height }, (_, i) =>
					Array.from({ length: width }, (_, j) =>
						sheet.rows[startRow + i - 1]?.[startCol + j - 1] ?? ""
					)
				);
			},

			getDisplayValues() {
				return this.getValues().map(row =>
					row.map(value => {
						if (Object.prototype.toString.call(value) === "[object Date]") {
							return value.toISOString();
						}

						return String(value).replace(/^'(?==)/, "");
					})
				);
			},

			getValue() {
				return this.getValues()[0][0];
			},

			getNote() {
				return sheet.notes.get(startRow + "," + startCol) || "";
			},

			setNote(value) {
				sheet.notes.set(startRow + "," + startCol, value);
				sheet.writes++;
				return this;
			},

			setValues(values) {
				assert.equal(values.length, height);

				values.forEach((row, i) => {
					assert.equal(row.length, width);

					const index = startRow + i - 1;
					sheet.rows[index] ??= [];

					row.forEach((value, j) => {
						sheet.rows[index][startCol + j - 1] = value;
					});
				});

				sheet.writes++;
				return this;
			},

			setValue(value) {
				return this.setValues([[value]]);
			},

			getFormulas() {
				return this.getValues().map(row => row.map(() => ""));
			},

			setFontWeight() {
				return this;
			},

			setWrapStrategy() {
				return this;
			}
		};
	}

	appendRow(values) {
		this.rows.push([...values]);
		this.maxRows = Math.max(this.maxRows, this.rows.length);
		this.writes++;
	}
}

// Mock a spreadsheet containing multiple sheets.
class MockSpreadsheet {
	constructor(id, sheets = []) {
		this.id = id;
		this.sheets = sheets;
	}

	getId() {
		return this.id;
	}

	getUrl() {
		return "https://docs.google.com/spreadsheets/d/" + this.id + "/edit";
	}

	getSheets() {
		return this.sheets;
	}

	getSheetByName(name) {
		return this.sheets.find(sheet => sheet.getName() === name) || null;
	}

	insertSheet(name) {
		const sheet = new MockSheet(name, this.sheets.length + 100);
		this.sheets.push(sheet);
		return sheet;
	}
}

// Make a realistic processed campaign report record.
function sourceRecord(changes = {}) {
	return {
		"Name / DJ Alias": "Test DJ",
		"Email Address": "dj@example.test",
		"Rating": "5",
		"Favorite Track": "Radio Remix",
		"Comments": "Nice track",
		"Campaign Status": "",
		"Campaign / Release": "Release A",
		"Report Generated At": "October 29th, 2026 15:07",
		"Report Source ID": "REPORT_A",
		"Report Source URL": "https://drive.google.com/file/d/REPORT_A/view",
		"Report Extracted At": "2026-11-07T10:00:00.000Z",
		...changes
	};
}

// Make an activity report requiring identity review.
function pendingReport(changes = {}) {
	return sourceRecord({
		"Email Address": "different@example.test",
		"Rating": "",
		"Favorite Track": "",
		"Comments": "",
		"Campaign Status": "Downloaded No Feedback",
		"Campaign / Release": "Release B",
		"Report Generated At": "November 5, 2026",
		"Report Source ID": "REPORT_B",
		"Report Source URL": "https://drive.google.com/file/d/REPORT_B/view",
		...changes
	});
}

// Build a complete local MA-04 and MA-05 environment.
function setup() {
	const master = new MockSheet(
		"Master_Contacts",
		1,
		[[...MASTER_HEADERS]]
	);

	const source = new MockSpreadsheet("SOURCE");
	const database = new MockSpreadsheet("DATABASE", [master]);

	const properties = {
		SPREADSHEET_DATA_EXTRACTION: "SOURCE",
		CONTACT_DATABASE_SPREADSHEET_ID: "DATABASE",
		CONTACT_REPORT_TAB_IDS: "",
		GEMINI_API_KEY: "LOCAL_TEST"
	};

	const clock = {
		now: Date.parse("2026-11-07T12:00:00.000Z")
	};

	class ClockDate extends Date {
		constructor(...args) {
			super(...(args.length ? args : [clock.now]));
		}

		static now() {
			return clock.now;
		}
	}

	let locked = false;

	const context = vm.createContext({
		Date: ClockDate,

		console: {
			log() {},
			warn() {},
			error() {}
		},

		PropertiesService: {
			getScriptProperties() {
				return {
					getProperty(name) {
						return properties[name] ?? null;
					}
				};
			}
		},

		SpreadsheetApp: {
			openById(id) {
				assert.ok(id === "SOURCE" || id === "DATABASE");
				return id === "SOURCE" ? source : database;
			},

			flush() {},

			WrapStrategy: {
				WRAP: "WRAP"
			}
		},

		LockService: {
			getScriptLock() {
				return {
					waitLock() {
						assert.equal(locked, false, "Script lock is already held");
						locked = true;
					},

					tryLock() {
						if (locked) {
							return false;
						}

						locked = true;
						return true;
					},

					releaseLock() {
						assert.equal(locked, true, "Script lock was not held");
						locked = false;
					}
				};
			}
		},

		Utilities: {
			DigestAlgorithm: {
				SHA_256: "sha256"
			},

			Charset: {
				UTF_8: "utf8"
			},

			getUuid() {
				return crypto.randomUUID();
			},

			computeDigest(algorithm, text, encoding) {
				return crypto.createHash(algorithm)
					.update(text, encoding)
					.digest();
			},

			base64EncodeWebSafe(value) {
				return Buffer.from(value).toString("base64url");
			},

			base64Encode(value) {
				return Buffer.from(value).toString("base64");
			}
		},

		trackedFetch() {
			throw new Error("Unexpected external API call.");
		}
	});

	// Load the real implementation files.
	const files = [
		"Constants.js",
		"DataExtractor.js",
		"ContactMatcher.js",
		"Parser.js",
		"ContactImporter.js",
		"DJIdentityResolver.js",
		"DJIdentityReview.js",
		"DJSocialProfileStore.js",
		"DJEngagementLinker.js"
	];

	for (const filename of files) {
		vm.runInContext(
			fs.readFileSync(path.join(ROOT, filename), "utf8"),
			context,
			{ filename }
		);
	}

	function addReport(records, id) {
		const sheet = new MockSheet(
			"campaign_report_" + id,
			id,
			[
				[...REPORT_HEADERS],
				...records.map(record =>
					REPORT_HEADERS.map(header => record[header] ?? "")
				)
			]
		);

		source.sheets.push(sheet);

		properties.CONTACT_REPORT_TAB_IDS = source.sheets
			.map(item => item.getSheetId())
			.join(",");

		return sheet;
	}

	function contact(index = 1) {
		return Object.fromEntries(
			master.rows[0].map((header, i) => [
				header,
				master.rows[index]?.[i] ?? ""
			])
		);
	}

	function history(index = 1) {
		return JSON.parse(contact(index)["Campaign History Data"] || "[]");
	}

	function audit() {
		const sheet = database.getSheetByName("DJ_Engagement_Links");

		return sheet ? sheet.rows.slice(1) : [];
	}

	return {
		context,
		master,
		source,
		database,
		addReport,
		contact,
		history,
		audit,
		isLocked: () => locked
	};
}

// Import one confirmed contact and one uncertain DJ response.
function fixture() {
	const t = setup();

	t.addReport([sourceRecord()], 111);
	t.context.importReportContacts();

	t.contactId = t.contact()["Contact ID"];

	t.addReport([pendingReport()], 112);
	t.context.importReportContacts();

	const pending = t.context.djEngagementPendingReviews(t.database);

	assert.equal(pending.length, 1);

	t.observation = pending[0];
	t.observationId = pending[0].observationId;

	return t;
}

// Save a real identity review and make a manual decision.
function reviewIdentity(t, decision = "CONFIRM_LINK", contactId = t.contactId) {
	const observation = {
		...t.observation,
		sourceReportId: "REPORT_B",
		sourcePage: 2
	};

	const result = {
		observationId: t.observationId,
		reportedName: observation.djReportedName,
		status: "POSSIBLE_MATCH",
		decision: "REVIEW",
		contactId: null,
		candidates: [{
			contactId: t.contactId,
			status: "POSSIBLE_MATCH"
		}],
		socialProfiles: []
	};

	t.context.djIdentitySaveReview(t.database, observation, result);

	return t.context.djIdentityReviewDecision(
		t.database,
		t.observationId,
		decision,
		decision === "CONFIRM_LINK" ? contactId : "",
		"Reviewer",
		"Confirmed against source report"
	);
}

let passed = 0;
let failed = 0;

// Run one test and display the result.
function test(name, callback) {
	try {
		callback();
		console.log("PASS: " + name);
		passed++;
	} catch (error) {
		console.log("FAIL: " + name);
		console.log("  " + (error.stack || error.message));
		failed++;
	}
}

// Test 1: Read existing campaign history from MA-04.
test("Read confirmed MA-04 campaign history", () => {
	const t = fixture();

	const activity = t.context.djEngagementReadContact(
		t.database,
		t.contactId
	);

	assert.equal(activity.length, 1);
	assert.equal(activity[0].reportId, "file:REPORT_A");
	assert.equal(activity[0].campaign, "Release A");
	assert.equal(activity[0].rating, "5");
	assert.equal(activity[0].comments, "Nice track");
});

// Test 2: Preserve reported status and never invent activity time.
test("Preserve original activity evidence", () => {
	const t = fixture();

	const activity = t.context.djEngagementReadContact(
		t.database,
		t.contactId
	);

	assert.equal(activity[0].reportedStatus, "");
	assert.equal(activity[0].activityTime, "");
	assert.equal(activity[0].favoriteTrack, "Radio Remix");
});

// Test 3: Read unresolved observations from Import_Log.
test("Find pending MA-04 identity reviews", () => {
	const t = fixture();
	const pending = t.context.djEngagementPendingReviews(t.database);

	assert.equal(pending.length, 1);
	assert.equal(pending[0].observationId, t.observationId);
	assert.equal(pending[0].djReportedName, "Test DJ");
	assert.equal(pending[0].email, "different@example.test");
	assert.equal(pending[0].candidateContactIds, t.contactId);
});

// Test 4: Different emails and the same name must not auto-link.
test("Do not automatically link uncertain DJs", () => {
	const t = fixture();

	assert.equal(t.master.getLastRow(), 2);
	assert.equal(t.history().length, 1);
	assert.equal(t.audit().length, 0);
});

// Test 5: Unknown contacts must not return campaign history.
test("Reject unknown Contact ID", () => {
	const t = fixture();

	assert.throws(() => {
		t.context.djEngagementReadContact(t.database, "CT-UNKNOWN");
	}, /Contact ID not found/);
});

// Test 6: A missing observation ID must be rejected.
test("Reject missing Observation Key", () => {
	const t = fixture();

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			""
		);
	}, /Observation Key is required/);
});

// Test 7: Linking requires an actual identity approval.
test("Require manual identity approval", () => {
	const t = fixture();

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /DJ_Identity_Review|manual identity approval|missing or empty/i);

	assert.equal(t.history().length, 1);
	assert.equal(t.audit().length, 0);
	assert.equal(t.isLocked(), false);
});

// Test 8: A pending identity review does not authorize linking.
test("Reject pending identity review", () => {
	const t = fixture();

	const observation = {
		...t.observation,
		sourceReportId: "REPORT_B"
	};

	t.context.djIdentitySaveReview(t.database, observation, {
		observationId: t.observationId,
		reportedName: "Test DJ",
		status: "POSSIBLE_MATCH",
		decision: "REVIEW",
		candidates: [{ contactId: t.contactId }],
		socialProfiles: []
	});

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Manual identity approval is required/);
});

// Test 9: Further research is not an approval.
test("Reject identity needing more research", () => {
	const t = fixture();

	reviewIdentity(t, "NEEDS_RESEARCH");

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Manual identity approval is required/);
});

// Test 10: Rejected matches must not be linked.
test("Reject manually declined identity", () => {
	const t = fixture();

	reviewIdentity(t, "NO_LINK");

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Manual identity approval is required/);

	assert.equal(t.history().length, 1);
});

// Test 11: Apply an approved engagement link.
test("Link manually approved DJ activity", () => {
	const t = fixture();

	reviewIdentity(t);

	const result = t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	assert.equal(result.status, "LINKED");
	assert.equal(result.contactId, t.contactId);
	assert.equal(result.reportId, "file:REPORT_B");
	assert.equal(t.history().length, 2);
	assert.equal(t.audit().length, 1);
	assert.equal(t.isLocked(), false);
});

// Test 12: Preserve the old campaign when linking a new one.
test("Keep previous campaign history", () => {
	const t = fixture();

	reviewIdentity(t);

	t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const ids = t.history().map(entry => entry.reportId).sort();

	assert.deepEqual(ids, ["file:REPORT_A", "file:REPORT_B"]);
});

// Test 13: Keep the original download status and empty activity time.
test("Do not invent download timestamps", () => {
	const t = fixture();

	reviewIdentity(t);

	t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const record = t.history().find(entry =>
		entry.reportId === "file:REPORT_B"
	);

	assert.equal(record.status, "Downloaded No Feedback");
	assert.equal(record.activityTime, "");
	assert.equal(record.rating, "");
	assert.equal(record.favoriteTrack, "");
});

// Test 14: Repeated linking must be idempotent.
test("Prevent duplicate engagement links", () => {
	const t = fixture();

	reviewIdentity(t);

	const first = t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const second = t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	assert.equal(first.status, "LINKED");
	assert.equal(second.status, "ALREADY_LINKED");
	assert.equal(t.audit().length, 1);
	assert.equal(t.history().length, 2);
});

// Test 15: The audit must preserve the human reviewer.
test("Preserve engagement approval evidence", () => {
	const t = fixture();

	reviewIdentity(t);

	t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const row = t.audit()[0];

	assert.equal(row[0], t.observationId);
	assert.equal(row[1], t.contactId);
	assert.equal(row[2], "file:REPORT_B");
	assert.equal(row[5], "Reviewer");
	assert.ok(row[6]);
	assert.equal(
		Object.prototype.toString.call(row[7]),
		"[object Date]"
	);
});

// Test 16: A changed source identity cannot reuse an old Observation Key.
test("Reject changed source identity", () => {
	const t = fixture();

	reviewIdentity(t);

	const sheet = t.source.getSheetByName("campaign_report_112");
	const emailCol = sheet.rows[0].indexOf("Email Address");

	sheet.rows[1][emailCol] = "changed@example.test";

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Expected exactly one unchanged source observation/);

	assert.equal(t.history().length, 1);
	assert.equal(t.audit().length, 0);
});

// Test 17: The source spreadsheet must match the original import.
test("Reject incorrect source spreadsheet", () => {
	const t = fixture();

	reviewIdentity(t);

	const wrongSource = new MockSpreadsheet(
		"OTHER",
		t.source.getSheets()
	);

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			wrongSource,
			t.observationId
		);
	}, /Expected exactly one unchanged source observation/);

	assert.equal(t.history().length, 1);
});

// Test 18: A deleted source report must not be linked.
test("Reject missing source report tab", () => {
	const t = fixture();

	reviewIdentity(t);

	t.source.sheets = t.source.sheets.filter(sheet =>
		sheet.getSheetId() !== 112
	);

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Original source report tab was not found/);

	assert.equal(t.audit().length, 0);
});

// Test 19: The approved contact must still exist.
test("Reject stale approved Contact ID", () => {
	const t = fixture();

	reviewIdentity(t);

	t.master.rows.splice(1, 1);

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Approved Contact ID no longer exists/);

	assert.equal(t.audit().length, 0);
});

// Test 20: Duplicate Import_Log observation keys must be rejected.
test("Reject duplicate Import_Log records", () => {
	const t = fixture();

	const log = t.database.getSheetByName("Import_Log");
	const keyCol = log.rows[0].indexOf("Observation Key");
	const row = log.rows.find((record, index) =>
		index > 0 && record[keyCol] === t.observationId
	);

	log.appendRow([...row]);

	assert.throws(() => {
		t.context.djEngagementPendingReviews(t.database);
	}, /Duplicate pending Observation Key/);
});

// Test 21: Conflicting campaign history must not be overwritten.
test("Reject conflicting existing campaign activity", () => {
	const t = fixture();

	reviewIdentity(t);

	const historyCol = t.master.rows[0].indexOf("Campaign History Data");
	const existing = t.history();

	existing.push({
		...existing[0],
		reportId: "file:REPORT_B",
		campaign: "Different Release"
	});

	t.master.rows[1][historyCol] = JSON.stringify(existing);

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /already has different activity/);

	assert.equal(t.audit().length, 0);
});

// Test 22: Invalid JSON must not silently erase campaign history.
test("Reject invalid campaign history data", () => {
	const t = fixture();

	reviewIdentity(t);

	const historyCol = t.master.rows[0].indexOf("Campaign History Data");
	t.master.rows[1][historyCol] = "{invalid";

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Invalid Campaign History Data/);

	assert.equal(t.audit().length, 0);
});

// Test 23: Duplicate audit entries must not be accepted.
test("Reject duplicate engagement audit records", () => {
	const t = fixture();

	reviewIdentity(t);

	t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const sheet = t.database.getSheetByName("DJ_Engagement_Links");
	sheet.appendRow([...sheet.rows[1]]);

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Duplicate engagement link/);
});

// Test 24: An interrupted audit can be retried without losing history.
test("Recover after engagement audit write failure", () => {
	const t = fixture();

	reviewIdentity(t);

	const sheet = t.database.insertSheet("DJ_Engagement_Links");
	const headers = vm.runInContext(
		"DJ_ENGAGEMENT_LINK_HEADERS",
		t.context
	);

	sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

	const originalAppend = sheet.appendRow.bind(sheet);

	sheet.appendRow = function() {
		throw new Error("Simulated audit write failure");
	};

	assert.throws(() => {
		t.context.djEngagementLinkApproved(
			t.database,
			t.source,
			t.observationId
		);
	}, /Simulated audit write failure/);

	assert.equal(t.history().length, 2);
	assert.equal(t.audit().length, 0);
	assert.equal(t.isLocked(), false);

	sheet.appendRow = originalAppend;

	const result = t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	assert.equal(result.status, "LINKED");
	assert.equal(t.history().length, 2);
	assert.equal(t.audit().length, 1);
});

// Test 25: Imported activity should appear in the contact history reader.
test("Read newly linked engagement", () => {
	const t = fixture();

	reviewIdentity(t);

	t.context.djEngagementLinkApproved(
		t.database,
		t.source,
		t.observationId
	);

	const records = t.context.djEngagementReadContact(
		t.database,
		t.contactId
	);

	const linked = records.find(record =>
		record.reportId === "file:REPORT_B"
	);

	assert.ok(linked);
	assert.equal(linked.campaign, "Release B");
	assert.equal(linked.reportedStatus, "Downloaded No Feedback");
	assert.equal(linked.activityTime, "");
});

// Print test results.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed === 0) {
	console.log("ALL " + passed + " TESTS PASSED!");
} else {
	console.log(failed + " TESTS FAILED!");
	process.exitCode = 1;
}
