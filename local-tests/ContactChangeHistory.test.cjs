/**
 * TFB-135: Contact Change History Local Tests
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load the Apps Script code in a test environment.
const source = fs.readFileSync(
	path.join(__dirname, "..", "ContactChangeHistory.js"),
	"utf8"
);

const context = vm.createContext({});
vm.runInContext(source, context);

const {
	contactHistoryEnsureSheet,
	contactHistoryRecordChanges,
	contactHistorySafeValue,
	contactHistoryReviewChange
} = vm.runInContext(
	"({ contactHistoryEnsureSheet, contactHistoryRecordChanges, contactHistorySafeValue, contactHistoryReviewChange })",
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
						throw new Error("Not enough sheet rows.");
					}

					while (this.rows.length <= rowIndex) {
						this.rows.push([]);
					}

					for (let c = 0; c < colCount; c++) {
						this.rows[rowIndex][startCol + c - 1] = values[r][c];
					}
				}
			},

			//Update a single cell.
			setValue: value => {
				if (rowCount !== 1 || colCount !== 1) {
					throw new Error("setValue requires one cell.");
				}

				const rowIndex = startRow - 1;

				if (rowIndex < 0 || rowIndex >= this.maxRows) {
					throw new Error("Invalid sheet row.");
				}

				while (this.rows.length <= rowIndex) {
					this.rows.push([]);
				}

				this.rows[rowIndex][startCol - 1] = value;
			},

			getDisplayValues: () => {
				const result = [];

				for (let r = 0; r < rowCount; r++) {
					const row = this.rows[startRow + r - 1] || [];
					const values = [];

					for (let c = 0; c < colCount; c++) {
						const value = row[startCol + c - 1];
						values.push(value == null ? "" : String(value));
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

//Create a sample contact change.
function makeChange(field, previousValue, proposedValue, changeType) {
	return {
		field,
		previousValue,
		proposedValue,
		changeType
	};
}

//Create a history record for review tests.
function createPendingChange(ss, contactId = "CT-100") {
	contactHistoryRecordChanges(
		ss,
		contactId,
		[
			makeChange(
				"Email",
				"old@example.com",
				"new@example.com",
				"CONFLICTING"
			)
		],
		"Test Report"
	);

	return ss.getSheetByName("Change_History");
}

let passed = 0;
let failed = 0;

//Run one test and report its result.
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
test("Create Change_History sheet", () => {
	const ss = new MockSpreadsheet();
	const sheet = contactHistoryEnsureSheet(ss);

	assert.equal(sheet.name, "Change_History");
	assert.equal(sheet.rows[0].length, 8);
	assert.equal(sheet.rows[0][0], "Contact ID");
	assert.equal(sheet.rows[0][6], "Review Status");
	assert.equal(sheet.frozenRows, 1);
});

//Test 2: Reuse an existing sheet.
test("Reuse existing history sheet", () => {
	const ss = new MockSpreadsheet();
	const first = contactHistoryEnsureSheet(ss);
	const second = contactHistoryEnsureSheet(ss);

	assert.equal(first, second);
	assert.equal(first.rows.length, 1);
});

//Test 3: Reject incorrect headers.
test("Reject incorrect sheet headers", () => {
	const ss = new MockSpreadsheet();
	const sheet = ss.insertSheet("Change_History");
	sheet.rows.push(["Wrong Header"]);

	assert.throws(() => contactHistoryEnsureSheet(ss));
	assert.equal(sheet.rows[0][0], "Wrong Header");
});

//Test 4: Reject missing spreadsheet.
test("Reject missing spreadsheet", () => {
	assert.throws(() => contactHistoryEnsureSheet(null));
});

//Test 5: Record a new email change.
test("Record pending email change", () => {
	const ss = new MockSpreadsheet();
	const changes = [
		makeChange(
			"Email",
			"old@example.com",
			"new@example.com",
			"CONFLICTING"
		)
	];

	const count = contactHistoryRecordChanges(
		ss,
		"CT-001",
		changes,
		"Report A"
	);

	const sheet = ss.getSheetByName("Change_History");
	const row = sheet.rows[1];

	assert.equal(count, 1);
	assert.equal(row[0], "CT-001");
	assert.equal(row[1], "Email");
	assert.equal(row[2], "old@example.com");
	assert.equal(row[3], "new@example.com");
	assert.equal(row[4], "Report A");
	assert.equal(row[6], "Pending");
	assert.equal(row[7], "");
	assert.equal(typeof row[5].getTime, "function");
});

//Test 6: Record multiple changes.
test("Record multiple contact changes", () => {
	const ss = new MockSpreadsheet();
	const changes = [
		makeChange("Email", "old@mail.com", "new@mail.com", "CONFLICTING"),
		makeChange("Phone", "", "6145551234", "NEWLY_POPULATED"),
		makeChange("City", "Columbus", "Cleveland", "CONFLICTING")
	];

	const count = contactHistoryRecordChanges(
		ss,
		"CT-002",
		changes,
		"Report B"
	);

	assert.equal(count, 3);
	assert.equal(ss.getSheetByName("Change_History").rows.length, 4);
});

//Test 7: Skip unchanged fields.
test("Skip unchanged fields", () => {
	const ss = new MockSpreadsheet();

	const count = contactHistoryRecordChanges(
		ss,
		"CT-003",
		[makeChange("Email", "a@mail.com", "a@mail.com", "UNCHANGED")],
		"Report C"
	);

	assert.equal(count, 0);
	assert.equal(ss.getSheetByName("Change_History").rows.length, 1);
});

//Test 8: Prevent repeated pending changes.
test("Prevent duplicate pending changes", () => {
	const ss = new MockSpreadsheet();
	const changes = [
		makeChange("Email", "old@mail.com", "new@mail.com", "CONFLICTING")
	];

	const first = contactHistoryRecordChanges(ss, "CT-004", changes, "Report D");
	const second = contactHistoryRecordChanges(ss, "CT-004", changes, "Report D");

	assert.equal(first, 1);
	assert.equal(second, 0);
	assert.equal(ss.getSheetByName("Change_History").rows.length, 2);
});

//Test 9: Prevent duplicates within one batch.
test("Prevent duplicates in the same batch", () => {
	const ss = new MockSpreadsheet();
	const change = makeChange("Phone", "", "6145551234", "NEWLY_POPULATED");

	const count = contactHistoryRecordChanges(
		ss,
		"CT-005",
		[change, change],
		"Report E"
	);

	assert.equal(count, 1);
});

//Test 10: Preserve different sources.
test("Record changes from different sources", () => {
	const ss = new MockSpreadsheet();
	const changes = [
		makeChange("Email", "old@mail.com", "new@mail.com", "CONFLICTING")
	];

	contactHistoryRecordChanges(ss, "CT-006", changes, "Report A");

	const count = contactHistoryRecordChanges(
		ss,
		"CT-006",
		changes,
		"Report B"
	);

	assert.equal(count, 1);
	assert.equal(ss.getSheetByName("Change_History").rows.length, 3);
});

//Test 11: Preserve reviewed history.
test("Keep reviewed history records", () => {
	const ss = new MockSpreadsheet();
	const changes = [
		makeChange("Email", "old@mail.com", "new@mail.com", "CONFLICTING")
	];

	contactHistoryRecordChanges(ss, "CT-007", changes, "Report F");

	const sheet = ss.getSheetByName("Change_History");
	sheet.rows[1][6] = "Approved";

	const count = contactHistoryRecordChanges(
		ss,
		"CT-007",
		changes,
		"Report F"
	);

	assert.equal(count, 1);
	assert.equal(sheet.rows[1][6], "Approved");
	assert.equal(sheet.rows[2][6], "Pending");
});

//Test 12: Reject invalid input.
test("Reject invalid change inputs", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactHistoryRecordChanges(ss, "", [], "Report A")
	);

	assert.throws(() =>
		contactHistoryRecordChanges(ss, "CT-008", [], "")
	);

	assert.throws(() =>
		contactHistoryRecordChanges(ss, "CT-008", null, "Report A")
	);
});

//Test 13: Reject changes without a field.
test("Reject missing change field", () => {
	const ss = new MockSpreadsheet();

	assert.throws(() =>
		contactHistoryRecordChanges(
			ss,
			"CT-009",
			[{ previousValue: "old", proposedValue: "new" }],
			"Report G"
		)
	);
});

//Test 14: Skip empty proposed values.
test("Skip empty proposed values", () => {
	const ss = new MockSpreadsheet();

	const count = contactHistoryRecordChanges(
		ss,
		"CT-010",
		[makeChange("Email", "old@mail.com", "", "CONFLICTING")],
		"Report H"
	);

	assert.equal(count, 0);
});

//Test 15: Protect against spreadsheet formulas.
test("Escape spreadsheet formulas", () => {
	assert.equal(contactHistorySafeValue("=1+1"), "'=1+1");
	assert.equal(contactHistorySafeValue("+SUM(A1:A2)"), "'+SUM(A1:A2)");
	assert.equal(contactHistorySafeValue("normal text"), "normal text");
});

//Test 16: Expand sheet row capacity.
test("Expand sheet when more rows are needed", () => {
	const ss = new MockSpreadsheet();
	const sheet = contactHistoryEnsureSheet(ss);
	sheet.maxRows = 1;

	const count = contactHistoryRecordChanges(
		ss,
		"CT-011",
		[makeChange("Phone", "", "6145551234", "NEWLY_POPULATED")],
		"Report I"
	);

	assert.equal(count, 1);
	assert.equal(sheet.getMaxRows(), 2);
});

//Test 17: Approve a pending change.
test("Approve pending change", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	const result = contactHistoryReviewChange(ss, 2, "Approved");

	assert.equal(result, "Approved");
	assert.equal(sheet.rows[1][6], "Approved");
	assert.equal(typeof sheet.rows[1][7].getTime, "function");
	assert.ok(Number.isFinite(sheet.rows[1][7].getTime()));
});

//Test 18: Reject a pending change.
test("Reject pending change", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	const result = contactHistoryReviewChange(ss, 2, "Rejected");

	assert.equal(result, "Rejected");
	assert.equal(sheet.rows[1][6], "Rejected");
	assert.equal(sheet.rows[1][7], "");
});

//Test 19: Mark a change for further research.
test("Mark change for further research", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	const result = contactHistoryReviewChange(
		ss,
		2,
		"Needs Further Research"
	);

	assert.equal(result, "Needs Further Research");
	assert.equal(sheet.rows[1][6], "Needs Further Research");
	assert.equal(sheet.rows[1][7], "");
});

//Test 20: Approve after further research.
test("Approve change after further research", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	contactHistoryReviewChange(ss, 2, "Needs Further Research");
	const result = contactHistoryReviewChange(ss, 2, "Approved");

	assert.equal(result, "Approved");
	assert.equal(sheet.rows[1][6], "Approved");
	assert.equal(typeof sheet.rows[1][7].getTime, "function");
});

//Test 21: Reject after further research.
test("Reject change after further research", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	contactHistoryReviewChange(ss, 2, "Needs Further Research");
	const result = contactHistoryReviewChange(ss, 2, "Rejected");

	assert.equal(result, "Rejected");
	assert.equal(sheet.rows[1][6], "Rejected");
	assert.equal(sheet.rows[1][7], "");
});

//Test 22: Prevent changes to final decisions.
test("Prevent reviewing finalized changes", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	contactHistoryReviewChange(ss, 2, "Approved");

	const originalDate = sheet.rows[1][7].getTime();

	assert.throws(() =>
		contactHistoryReviewChange(ss, 2, "Rejected")
	);

	assert.equal(sheet.rows[1][6], "Approved");
	assert.equal(sheet.rows[1][7].getTime(), originalDate);

	const secondSheet = createPendingChange(ss, "CT-101");
	assert.equal(secondSheet.rows[2][6], "Pending");

	contactHistoryReviewChange(ss, 3, "Rejected");

	assert.throws(() =>
		contactHistoryReviewChange(ss, 3, "Approved")
	);

	assert.equal(sheet.rows[2][6], "Rejected");
});

//Test 23: Reject invalid review decisions.
test("Reject invalid review decisions", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 2, "Automatically Approved")
	);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 2, "")
	);

	assert.equal(sheet.rows[1][6], "Pending");
	assert.equal(sheet.rows[1][7], "");
});

//Test 24: Reject invalid row numbers.
test("Reject invalid history row numbers", () => {
	const ss = new MockSpreadsheet();
	const sheet = createPendingChange(ss);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 1, "Approved")
	);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 0, "Approved")
	);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 3, "Approved")
	);

	assert.throws(() =>
		contactHistoryReviewChange(ss, 1.5, "Approved")
	);

	assert.throws(() =>
		contactHistoryReviewChange(ss, "2", "Approved")
	);

	assert.equal(sheet.rows[1][6], "Pending");
});

//Display final test results.
console.log("\nContactChangeHistory Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 24 TESTS PASSED!");
}
