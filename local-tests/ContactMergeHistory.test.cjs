
/**
 * TFB-135: Contact Merge History Local Tests
 * Test persistent backup logic using mock Google Sheets.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let uuidCounter = 0;

//Create an Apps Script test environment.
const context = vm.createContext({
	Utilities: {
		getUuid: () => "test-uuid-" + (++uuidCounter)
	}
});

//Load both modules into the same environment.
for (const filename of [
	"ContactSafeMerge.js",
	"ContactMergeHistory.js"
]) {
	const source = fs.readFileSync(
		path.join(__dirname, "..", filename),
		"utf8"
	);

	vm.runInContext(source, context);
}

const {
	contactSafeMergeCreateSnapshot,
	contactMergeHistoryEnsureSheet,
	contactMergeHistorySaveBackup,
	contactMergeHistorySerializeContact,
	contactMergeHistorySafeCell
} = vm.runInContext(
	`({
		contactSafeMergeCreateSnapshot,
		contactMergeHistoryEnsureSheet,
		contactMergeHistorySaveBackup,
		contactMergeHistorySerializeContact,
		contactMergeHistorySafeCell
	})`,
	context
);

//Simulate a Google Sheets worksheet.
class MockSheet {
	constructor(name, maxRows = 100) {
		this.name = name;
		this.rows = [];
		this.maxRows = maxRows;
		this.frozenRows = 0;
	}

	getLastRow() {
		return this.rows.length;
	}

	getMaxRows() {
		return this.maxRows;
	}

	setFrozenRows(count) {
		this.frozenRows = count;
	}

	insertRowsAfter(row, count) {
		assert.equal(row, this.maxRows);
		this.maxRows += count;
	}

	getRange(startRow, startCol, rowCount = 1, colCount = 1) {
		return {
			setValues: values => {
				assert.equal(values.length, rowCount);

				for (let r = 0; r < rowCount; r++) {
					assert.equal(values[r].length, colCount);

					const rowIndex = startRow + r - 1;

					if (rowIndex >= this.maxRows) {
						throw new Error("Not enough rows.");
					}

					while (this.rows.length <= rowIndex) {
						this.rows.push([]);
					}

					for (let c = 0; c < colCount; c++) {
						this.rows[rowIndex][startCol + c - 1] =
							values[r][c];
					}
				}
			},

			getDisplayValues: () => {
				const result = [];

				for (let r = 0; r < rowCount; r++) {
					const row = this.rows[startRow + r - 1] || [];
					const values = [];

					for (let c = 0; c < colCount; c++) {
						const value = row[startCol + c - 1];

						values.push(
							value == null ? "" : String(value)
						);
					}

					result.push(values);
				}

				return result;
			}
		};
	}
}

//Simulate a Google Spreadsheet.
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

//Create the primary contact.
function makePrimary(overrides = {}) {
	return {
		"Contact ID": "CT-001",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Station / Venue / Organization": "WXYZ",
		"Sources": "Report A",
		"Review Status": "Reviewed",
		sheetRow: 4,
		...overrides
	};
}

//Create the duplicate contact.
function makeDuplicate(overrides = {}) {
	return {
		"Contact ID": "CT-002",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@radio.com",
		"Phone": "6145552000",
		"Station / Venue / Organization": "KABC",
		"Sources": "Report B",
		"Review Status": "Reviewed",
		sheetRow: 5,
		...overrides
	};
}

//Create a manually approved review record.
function makeReview(overrides = {}) {
	return {
		"Match ID": "MATCH-001",
		"Existing Contact ID": "CT-001",
		"Incoming Record ID": "CT-002",
		"Review Status": "Confirm Duplicate",
		"Reviewer": "Test Reviewer",
		"Review Date": "2026-11-04",
		...overrides
	};
}

//Create a snapshot using the actual Safe Merge function.
function makeSnapshot(overrides = {}) {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	return Object.assign(snapshot, overrides);
}

let passed = 0;
let failed = 0;

//Run a test.
function test(name, callback) {
	try {
		callback();
		passed++;
		console.log("PASS: " + name);
	} catch (error) {
		failed++;
		console.error("FAIL: " + name);
		console.error(error.message);
	}
}

//Test 1: Create the history sheet.
test("Create Merge_History sheet", () => {
	const ss = new MockSpreadsheet();
	const sheet = contactMergeHistoryEnsureSheet(ss);

	assert.equal(sheet.name, "Merge_History");
	assert.equal(sheet.rows[0].length, 13);
	assert.equal(sheet.rows[0][0], "Merge ID");
	assert.equal(sheet.rows[0][10], "Merge Status");
	assert.equal(sheet.frozenRows, 1);
});

//Test 2: Reuse an existing sheet.
test("Reuse existing history sheet", () => {
	const ss = new MockSpreadsheet();

	const first = contactMergeHistoryEnsureSheet(ss);
	const second = contactMergeHistoryEnsureSheet(ss);

	assert.equal(first, second);
	assert.equal(first.rows.length, 1);
});

//Test 3: Reject incorrect headers.
test("Reject incorrect history headers", () => {
	const ss = new MockSpreadsheet();
	const sheet = ss.insertSheet("Merge_History");

	sheet.rows.push(["Wrong Header"]);

	assert.throws(() => contactMergeHistoryEnsureSheet(ss));
	assert.equal(sheet.rows[0][0], "Wrong Header");
});

//Test 4: Reject missing spreadsheet.
test("Reject missing spreadsheet", () => {
	assert.throws(() => contactMergeHistoryEnsureSheet(null));
});

//Test 5: Save a verified backup.
test("Save and verify contact backup", () => {
	const ss = new MockSpreadsheet();

	const result = contactMergeHistorySaveBackup(
		ss,
		makeSnapshot()
	);

	const sheet = ss.getSheetByName("Merge_History");

	assert.ok(result.mergeId.startsWith("MG-"));
	assert.equal(result.rowNumber, 2);
	assert.equal(result.status, "BACKUP_SAVED");
	assert.equal(result.backupVerified, true);
	assert.equal(sheet.rows.length, 2);
	assert.equal(sheet.rows[1][10], "BACKUP_SAVED");
});

//Test 6: Preserve both original contacts.
test("Preserve original contact data", () => {
	const ss = new MockSpreadsheet();

	contactMergeHistorySaveBackup(ss, makeSnapshot());

	const row = ss.getSheetByName("Merge_History").rows[1];

	const primary = JSON.parse(row[7]);
	const duplicate = JSON.parse(row[8]);

	assert.equal(primary["Contact ID"], "CT-001");
	assert.equal(duplicate["Contact ID"], "CT-002");

	assert.equal(primary.Email, "alex@example.com");
	assert.equal(duplicate.Email, "alex@radio.com");

	assert.equal(
		primary["Station / Venue / Organization"],
		"WXYZ"
	);

	assert.equal(
		duplicate["Station / Venue / Organization"],
		"KABC"
	);
});

//Test 7: Preserve source information.
test("Preserve sources and original row positions", () => {
	const ss = new MockSpreadsheet();

	contactMergeHistorySaveBackup(ss, makeSnapshot());

	const row = ss.getSheetByName("Merge_History").rows[1];

	const primary = JSON.parse(row[7]);
	const duplicate = JSON.parse(row[8]);

	assert.equal(primary.Sources, "Report A");
	assert.equal(duplicate.Sources, "Report B");

	assert.equal(primary.sheetRow, 4);
	assert.equal(duplicate.sheetRow, 5);
});

//Test 8: Preserve manual review information.
test("Preserve manual approval details", () => {
	const ss = new MockSpreadsheet();

	contactMergeHistorySaveBackup(ss, makeSnapshot());

	const row = ss.getSheetByName("Merge_History").rows[1];

	assert.equal(row[1], "CT-001");
	assert.equal(row[2], "CT-002");
	assert.equal(row[3], "MATCH-001");
	assert.equal(row[4], "Test Reviewer");

	assert.equal(typeof row[5].getTime, "function");
	assert.equal(typeof row[6].getTime, "function");
});

//Test 9: Keep the merged state empty before applying.
test("Do not mark a merge as applied", () => {
	const ss = new MockSpreadsheet();

	contactMergeHistorySaveBackup(ss, makeSnapshot());

	const row = ss.getSheetByName("Merge_History").rows[1];

	assert.equal(row[9], "");
	assert.equal(row[10], "BACKUP_SAVED");
	assert.equal(row[11], "");
	assert.equal(row[12], "");
});

//Test 10: Prevent duplicate Match IDs.
test("Prevent repeated backup for the same match", () => {
	const ss = new MockSpreadsheet();

	contactMergeHistorySaveBackup(ss, makeSnapshot());

	assert.throws(() =>
		contactMergeHistorySaveBackup(ss, makeSnapshot())
	);

	assert.equal(
		ss.getSheetByName("Merge_History").rows.length,
		2
	);
});

//Test 11: Allow separate approved matches.
test("Allow different Match IDs", () => {
	const ss = new MockSpreadsheet();

	const first = contactMergeHistorySaveBackup(
		ss,
		makeSnapshot()
	);

	const second = contactMergeHistorySaveBackup(
		ss,
		makeSnapshot({
			matchId: "MATCH-002"
		})
	);

	assert.notEqual(first.mergeId, second.mergeId);
	assert.equal(
		ss.getSheetByName("Merge_History").rows.length,
		3
	);
});

//Test 12: Reject invalid snapshot status.
test("Require an unpersisted snapshot", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactMergeHistorySaveBackup(ss, null)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ persisted: true })
		)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ persisted: undefined })
		)
	);
});

//Test 13: Reject invalid contact IDs.
test("Reject invalid contact IDs", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ primaryContactId: "" })
		)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ duplicateContactId: "CT-001" })
		)
	);
});

//Test 14: Require review information.
test("Require match and reviewer information", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ matchId: "" })
		)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ reviewer: "" })
		)
	);
});

//Test 15: Reject invalid dates.
test("Reject invalid backup dates", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ reviewDate: "invalid" })
		)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({ createdAt: "invalid" })
		)
	);
});

//Test 16: Reject mismatched backup records.
test("Reject mismatched snapshot IDs", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({
				primaryBefore: makePrimary({
					"Contact ID": "CT-999"
				})
			})
		)
	);

	assert.throws(() =>
		contactMergeHistorySaveBackup(
			ss,
			makeSnapshot({
				duplicateBefore: makeDuplicate({
					"Contact ID": "CT-999"
				})
			})
		)
	);
});

//Test 17: Reject unsupported or oversized data.
test("Reject invalid backup field values", () => {
	assert.throws(() =>
		contactMergeHistorySerializeContact({
			"Contact ID": "CT-001",
			Extra: { nested: "value" }
		})
	);

	assert.throws(() =>
		contactMergeHistorySerializeContact({
			"Contact ID": "CT-001",
			Score: Infinity
		})
	);

	const ss = new MockSpreadsheet();

	const snapshot = makeSnapshot();

	snapshot.primaryBefore.Email = "a".repeat(46000);

	assert.throws(() =>
		contactMergeHistorySaveBackup(ss, snapshot)
	);
});

//Test 18: Protect spreadsheet values and expand rows.
test("Escape formulas and expand sheet capacity", () => {
	assert.equal(
		contactMergeHistorySafeCell("=1+1"),
		"'=1+1"
	);

	assert.equal(
		contactMergeHistorySafeCell("+SUM(A1:A2)"),
		"'+SUM(A1:A2)"
	);

	assert.equal(
		contactMergeHistorySafeCell("normal text"),
		"normal text"
	);

	const ss = new MockSpreadsheet();
	const sheet = contactMergeHistoryEnsureSheet(ss);

	sheet.maxRows = 1;

	const result = contactMergeHistorySaveBackup(
		ss,
		makeSnapshot()
	);

	assert.equal(result.backupVerified, true);
	assert.equal(sheet.getMaxRows(), 2);
});

//Display final results.
console.log("\nContactMergeHistory Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 18 TESTS PASSED!");
}
