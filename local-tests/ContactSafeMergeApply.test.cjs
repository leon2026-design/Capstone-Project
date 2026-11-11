/**
 * TFB-135: Actual Merge Mock Integration Tests
 * Uses in-memory Google Sheets only.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

const HEADERS = [
	"Contact ID",
	"Name / DJ Alias",
	"Role",
	"Station / Venue / Organization",
	"City",
	"State / Region",
	"Country",
	"Email",
	"Phone",
	"Social Accounts",
	"Sources",
	"Review Status",
	"Review Notes",
	"Last Updated"
];

const REVIEW_HEADERS = [
	"Match ID",
	"Existing Contact ID",
	"Incoming Record ID",
	"Existing Name",
	"Incoming Name",
	"Matching Fields",
	"Conflicting Fields",
	"Match Score",
	"Review Status",
	"Reviewer",
	"Review Date"
];

const HISTORY_HEADERS = [
	"Merge ID",
	"Primary Contact ID",
	"Duplicate Contact ID",
	"Match ID",
	"Reviewer",
	"Review Date",
	"Backup Created At",
	"Primary Snapshot",
	"Duplicate Snapshot",
	"Merged Snapshot",
	"Merge Status",
	"Merge Applied At",
	"Undo At"
];

//Create a mock Google Sheet.
function makeSheet(initialRows) {
	const rows = initialRows.map(row => [...row]);

	const sheet = {
		rows: rows,
		deleteCount: 0,
		throwOnDelete: false,
		formulaRows: new Set(),

		getLastRow() {
			return rows.length;
		},
		
		getDataRange() {
			return sheet.getRange(
				1,
				1,
				rows.length,
				Math.max(1, ...rows.map(row => row.length))
	);
},
		getMaxRows() {
			return 100;
		},

		setFrozenRows() {},

		insertRowsAfter() {},

		getRange(startRow, startCol, height = 1, width = 1) {
			function read() {
				return Array.from({ length: height }, (_, i) =>
					Array.from({ length: width }, (_, j) =>
						(rows[startRow - 1 + i] || [])[startCol - 1 + j] ?? ""
					)
				);
			}

			function write(values) {
				assert.equal(values.length, height);

				values.forEach((valuesRow, i) => {
					assert.equal(valuesRow.length, width);

					const row = startRow - 1 + i;

					if (!rows[row]) {
						rows[row] = [];
					}

					valuesRow.forEach((value, j) => {
						rows[row][startCol - 1 + j] = value;
					});
				});
			}

			return {
				getValues: read,

				getDisplayValues() {
					return read().map(row => row.map(value =>
						value instanceof Date
							? value.toISOString()
							: String(value)
					));
				},

				getFormulas() {
					return read().map((row, i) => row.map(() =>
						sheet.formulaRows.has(startRow + i)
							? "=SUM(A1)"
							: ""
					));
				},

				getValue() {
					return read()[0][0];
				},

				setValue(value) {
					write([[value]]);
				},

				setValues: write
			};
		},

		deleteRow(row) {
			if (sheet.throwOnDelete) {
				throw new Error("Simulated delete failure");
			}

			rows.splice(row - 1, 1);
			sheet.deleteCount++;
		}
	};

	return sheet;
}

//Create a contact in database column order.
function contactRow(id, overrides = {}) {
	const contact = {
		"Contact ID": id,
		"Name / DJ Alias": "Alex Smith",
		"Role": "DJ",
		"Station / Venue / Organization": "WXYZ",
		"City": "Columbus",
		"State / Region": "Ohio",
		"Country": "US",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Social Accounts": "@alex",
		"Sources": "Report A",
		"Review Status": "Reviewed",
		"Review Notes": "",
		"Last Updated": "2026-11-04",
		...overrides
	};

	return HEADERS.map(header => contact[header]);
}

//Prepare a complete mock merge environment.
function fixture(options = {}) {
	const date = new Date("2026-11-04T18:00:00.000Z");

	const master = makeSheet([
		HEADERS,
		contactRow("CT-001", options.primary || {}),
		contactRow("CT-002", {
			Sources: "Report B",
			...options.duplicate
		})
	]);

	const review = makeSheet([
		REVIEW_HEADERS,
		[
			"MT-001",
			"CT-001",
			"CT-002",
			"Alex Smith",
			"Alex Smith",
			"Name",
			"",
			100,
			"Confirm Duplicate",
			"Brad",
			date
		]
	]);

	const history = makeSheet([HISTORY_HEADERS]);

	const sheets = {
		Master_Contacts: master,
		Potential_Duplicates: review,
		Merge_History: history
	};

	const ss = {
		getSheetByName(name) {
			return sheets[name] || null;
		},

		insertSheet(name) {
			sheets[name] = makeSheet([]);
			return sheets[name];
		}
	};

	const lock = {
		locked: false,

		tryLock() {
			this.locked = true;
			return true;
		},

		releaseLock() {
			this.locked = false;
		}
	};

	//Mock Google Apps Script services.
	const context = vm.createContext({
		Date,
		console,

		LockService: {
			getScriptLock: () => lock
		},

		SpreadsheetApp: {
			flush() {}
		},

		Utilities: {
			getUuid: () =>
				"00000000-0000-4000-8000-000000000001"
		}
	});

	//Load both existing project files.
	for (const file of [
		"ContactMergeHistory.js",
		"ContactSafeMerge.js"
	]) {
		vm.runInContext(
			fs.readFileSync(path.join(ROOT, file), "utf8"),
			context,
			{ filename: file }
		);
	}

	const fn = name => vm.runInContext(name, context);

	const primary = fn("contactSafeMergeReadMasterContact")(
		ss,
		"CT-001"
	);

	const duplicate = fn("contactSafeMergeReadMasterContact")(
		ss,
		"CT-002"
	);

	const reviewRecord = {
		"Match ID": "MT-001",
		"Existing Contact ID": "CT-001",
		"Incoming Record ID": "CT-002",
		"Review Status": "Confirm Duplicate",
		Reviewer: "Brad",
		"Review Date": date
	};

	//Save a real backup using the project function.
	const snapshot = fn("contactSafeMergeCreateSnapshot")(
		primary,
		duplicate,
		reviewRecord
	);

	const saved = fn("contactMergeHistorySaveBackup")(
		ss,
		snapshot
	);

	return {
		ss,
		master,
		review,
		history,
		lock,
		id: saved.mergeId,
		fn
	};
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
		console.error(error.stack || error.message);
	}
}

//Test 1: Apply a successful approved merge.
test("Merge two approved matching contacts", () => {
	const x = fixture();

	const result = x.fn("contactSafeMergeApplyApproved")(
		x.ss,
		x.id
	);

	assert.equal(result.status, "MERGED");
	assert.equal(result.undoAvailable, false);
	assert.equal(x.master.deleteCount, 1);
	assert.equal(x.master.rows.length, 2);
	assert.equal(x.master.rows[1][0], "CT-001");
	assert.equal(x.master.rows[1][10], "Report A\nReport B");
	assert.equal(x.history.rows[1][10], "MERGED");
	assert.ok(x.history.rows[1][9].includes(
		'"Contact ID":"CT-001"'
	));
	assert.equal(x.lock.locked, false);
});

//Test 2: Reject repeated merges.
test("Reject a second merge attempt", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id)
	);

	assert.equal(x.master.deleteCount, 1);
});

//Test 3: Reject data changed after backup.
test("Reject a changed contact after backup", () => {
	const x = fixture();

	x.master.rows[1][7] = "new@example.com";

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/changed since backup/
	);

	assert.equal(x.master.deleteCount, 0);
	assert.equal(x.history.rows[1][10], "BACKUP_SAVED");
});

//Test 4: Stop when field approval is required.
test("Reject additional email requiring field review", () => {
	const x = fixture({
		duplicate: {
			Email: "new@example.com"
		}
	});

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/requiring manual resolution/
	);

	assert.equal(x.master.deleteCount, 0);
	assert.equal(x.history.rows[1][10], "BACKUP_SAVED");
});

//Test 5: Reject revoked approval.
test("Reject revoked human approval", () => {
	const x = fixture();

	x.review.rows[1][8] = "Different Individuals";

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/not been manually approved/
	);

	assert.equal(x.master.deleteCount, 0);
});

//Test 6: Reject imported report row IDs.
test("Reject non-contact Incoming Record ID", () => {
	const x = fixture();

	x.review.rows[1][2] = "REPORT-ROW-55";

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/does not identify both contacts/
	);

	assert.equal(x.master.deleteCount, 0);
});

//Test 7: Prevent overwriting formulas.
test("Reject a contact row containing formulas", () => {
	const x = fixture();

	x.master.formulaRows.add(2);

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/formulas/
	);

	assert.equal(x.master.deleteCount, 0);
});

//Test 8: Detect interrupted merge operations.
test("Mark interrupted merge APPLYING without false success", () => {
	const x = fixture();

	x.master.throwOnDelete = true;

	assert.throws(() =>
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
		/Simulated delete failure/
	);

	assert.equal(x.history.rows[1][10], "APPLYING");
	assert.equal(x.master.deleteCount, 0);
	assert.equal(x.master.rows.length, 3);
	assert.equal(x.lock.locked, false);
});


/**
 * TFB-135: Undo Integration Tests
 * Run only against mock spreadsheet data.
 */

//Test 9: Restore both original contacts.
test("Undo a completed merge", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	const result = x.fn("contactSafeMergeUndo")(x.ss, x.id);

	assert.equal(result.status, "UNDONE");
	assert.equal(result.contactsRestored, 2);

	assert.equal(x.master.rows.length, 3);
	assert.equal(x.master.rows[1][0], "CT-001");
	assert.equal(x.master.rows[2][0], "CT-002");

	assert.equal(x.master.rows[1][10], "Report A");
	assert.equal(x.master.rows[2][10], "Report B");

	assert.equal(x.history.rows[1][10], "UNDONE");
	assert.ok(x.history.rows[1][12] instanceof Date);
	assert.equal(x.lock.locked, false);
});

//Test 10: Reject undo twice.
test("Reject repeated undo", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);
	x.fn("contactSafeMergeUndo")(x.ss, x.id);

	assert.throws(() =>
		x.fn("contactSafeMergeUndo")(x.ss, x.id)
	);

	assert.equal(x.master.rows.length, 3);
	assert.equal(x.history.rows[1][10], "UNDONE");
});

//Test 11: Protect new changes after merging.
test("Reject undo when contact changed after merge", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	x.master.rows[1][7] = "updated@example.com";

	assert.throws(() =>
		x.fn("contactSafeMergeUndo")(x.ss, x.id),
		/changed after merge/
	);

	assert.equal(x.master.rows.length, 2);
	assert.equal(x.history.rows[1][10], "MERGED");
});

//Test 12: Prevent duplicate Contact IDs.
test("Reject undo when duplicate ID already exists", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	x.master.rows.push(contactRow("CT-002"));

	assert.throws(() =>
		x.fn("contactSafeMergeUndo")(x.ss, x.id),
		/Duplicate contact already exists/
	);

	assert.equal(x.history.rows[1][10], "MERGED");
});

//Test 13: Protect spreadsheet formulas.
test("Reject undo when primary contains formulas", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	x.master.formulaRows.add(2);

	assert.throws(() =>
		x.fn("contactSafeMergeUndo")(x.ss, x.id),
		/formulas/
	);

	assert.equal(x.history.rows[1][10], "MERGED");
	assert.equal(x.master.rows.length, 2);
});

//Test 14: Detect interrupted restoration.
test("Detect interrupted undo without false success", () => {
	const x = fixture();

	x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);

	const originalGetRange = x.master.getRange.bind(x.master);

	//Simulate failure while restoring the deleted contact.
	x.master.getRange = function(...args) {
		const range = originalGetRange(...args);

		if (
			args[0] === 3 &&
			args[1] === 1 &&
			args[2] === 1 &&
			args[3] === HEADERS.length
		) {
			return {
				...range,
				setValues() {
					throw new Error("Simulated restore failure");
				}
			};
		}

		return range;
	};

	assert.throws(() =>
		x.fn("contactSafeMergeUndo")(x.ss, x.id),
		/Simulated restore failure/
	);

	assert.equal(x.history.rows[1][10], "UNDOING");
	assert.equal(x.master.rows.length, 2);
	assert.equal(x.lock.locked, false);
});

//Display final results.
console.log("\nContactSafeMergeApply Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL " + passed + " TESTS PASSED!");
}
