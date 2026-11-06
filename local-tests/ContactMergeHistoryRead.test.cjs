
/**
 * TFB-135: Contact Merge History Read Tests
 * Verify saved contact backups using mock Google Sheets.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let uuidCounter = 0;

//Create a shared Apps Script test environment.
const context = vm.createContext({
	Utilities: {
		getUuid: () => "test-uuid-" + (++uuidCounter)
	}
});

//Load both modules.
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
	contactMergeHistoryReadBackup
} = vm.runInContext(
	`({
		contactSafeMergeCreateSnapshot,
		contactMergeHistoryEnsureSheet,
		contactMergeHistorySaveBackup,
		contactMergeHistoryReadBackup
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
function makePrimary() {
	return {
		"Contact ID": "CT-001",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Station / Venue / Organization": "WXYZ",
		"Sources": "Report A",
		sheetRow: 4
	};
}

//Create the duplicate contact.
function makeDuplicate() {
	return {
		"Contact ID": "CT-002",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@radio.com",
		"Phone": "6145552000",
		"Station / Venue / Organization": "KABC",
		"Sources": "Report B",
		sheetRow: 5
	};
}

//Create an approved review record.
function makeReview() {
	return {
		"Match ID": "MATCH-001",
		"Existing Contact ID": "CT-001",
		"Incoming Record ID": "CT-002",
		"Review Status": "Confirm Duplicate",
		"Reviewer": "Test Reviewer",
		"Review Date": "2026-11-04"
	};
}

//Create and save a test backup.
function createSavedBackup(ss) {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	return contactMergeHistorySaveBackup(ss, snapshot);
}

let passed = 0;
let failed = 0;

//Run one test.
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

//Test 1: Read an existing backup.
test("Read saved merge backup", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.mergeId, saved.mergeId);
	assert.equal(result.rowNumber, 2);
	assert.equal(result.backupVerified, true);
});

//Test 2: Preserve contact identifiers.
test("Preserve both contact IDs", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.primaryContactId, "CT-001");
	assert.equal(result.duplicateContactId, "CT-002");
	assert.equal(result.matchId, "MATCH-001");
});

//Test 3: Restore original email information.
test("Read original email values", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(
		result.primaryBefore.Email,
		"alex@example.com"
	);

	assert.equal(
		result.duplicateBefore.Email,
		"alex@radio.com"
	);
});

//Test 4: Restore station information.
test("Read original station values", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(
		result.primaryBefore["Station / Venue / Organization"],
		"WXYZ"
	);

	assert.equal(
		result.duplicateBefore["Station / Venue / Organization"],
		"KABC"
	);
});

//Test 5: Preserve sources and row positions.
test("Read sources and original row positions", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.primaryBefore.Sources, "Report A");
	assert.equal(result.duplicateBefore.Sources, "Report B");
	assert.equal(result.primaryBefore.sheetRow, 4);
	assert.equal(result.duplicateBefore.sheetRow, 5);
});

//Test 6: Preserve backup status.
test("Read BACKUP_SAVED status", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.status, "BACKUP_SAVED");
	assert.equal(result.reviewer, "Test Reviewer");
});

//Test 7: Recognize a merged record.
test("Recognize MERGED status", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	sheet.rows[1][10] = "MERGED";

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.status, "MERGED");
});

//Test 8: Recognize an undone record.
test("Recognize UNDONE status", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	sheet.rows[1][10] = "UNDONE";

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.status, "UNDONE");
});

//Test 9: Reject an empty Merge ID.
test("Reject missing Merge ID", () => {
	const ss = new MockSpreadsheet();
	createSavedBackup(ss);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, "")
	);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, null)
	);
});

//Test 10: Reject unknown Merge IDs.
test("Reject unknown Merge ID", () => {
	const ss = new MockSpreadsheet();
	createSavedBackup(ss);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, "MG-UNKNOWN")
	);
});

//Test 11: Reject an empty history sheet.
test("Reject history with no backups", () => {
	const ss = new MockSpreadsheet();
	contactMergeHistoryEnsureSheet(ss);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, "MG-001")
	);
});

//Test 12: Reject duplicate Merge IDs.
test("Reject duplicate Merge IDs", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	sheet.rows.push([...sheet.rows[1]]);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);
});

//Test 13: Reject unexpected merge status.
test("Reject invalid merge status", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	sheet.rows[1][10] = "UNKNOWN_STATUS";

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);
});

//Test 14: Reject missing or corrupted JSON.
test("Reject missing or invalid snapshots", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	const originalPrimary = sheet.rows[1][7];
	const originalDuplicate = sheet.rows[1][8];

	sheet.rows[1][7] = "";

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);

	sheet.rows[1][7] = "{invalid JSON";

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);

	sheet.rows[1][7] = originalPrimary;
	sheet.rows[1][8] = "";

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);

	sheet.rows[1][8] = originalDuplicate;
});

//Test 15: Reject mismatched contact IDs.
test("Reject backup with incorrect contact IDs", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");

	const primary = JSON.parse(sheet.rows[1][7]);
	primary["Contact ID"] = "CT-999";

	sheet.rows[1][7] = JSON.stringify(primary);

	assert.throws(() =>
		contactMergeHistoryReadBackup(ss, saved.mergeId)
	);
});

//Test 16: Read without modifying stored data.
test("Do not modify history while reading", () => {
	const ss = new MockSpreadsheet();
	const saved = createSavedBackup(ss);

	const sheet = ss.getSheetByName("Merge_History");
	const before = JSON.stringify(sheet.rows);

	const result = contactMergeHistoryReadBackup(
		ss,
		saved.mergeId
	);

	assert.equal(result.backupVerified, true);
	assert.equal(JSON.stringify(sheet.rows), before);
});

//Display final test results.
console.log("\nContactMergeHistoryRead Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 16 TESTS PASSED!");
}
