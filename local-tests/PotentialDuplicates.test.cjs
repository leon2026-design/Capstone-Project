const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load PotentialDuplicates.js.
const filePath = path.join(__dirname, "../PotentialDuplicates.js");
const code = fs.readFileSync(filePath, "utf8");

let uuidCount = 0;

const context = {
	Utilities: {
		getUuid: () => "test-" + (++uuidCount)
	}
};

vm.runInNewContext(code, context);

const saveDuplicate = context.contactMatchSavePotentialDuplicate;
const reviewDuplicate = context.contactMatchReviewDuplicate;

//Create a mock Google Spreadsheet.
function makeSpreadsheet() {
	const sheets = {};

	return {
		sheets,

		getSheetByName(name) {
			return sheets[name] || null;
		},

		insertSheet(name) {
			const sheet = {
				rows: [],
				frozenRows: 0,

				getRange(row, column, numRows, numColumns) {
					return {
						getValues() {
							return Array.from({ length: numRows }, (_, i) =>
								Array.from({ length: numColumns }, (_, j) =>
									sheet.rows[row - 1 + i]?.[column - 1 + j] ?? ""
								)
							);
						},

						setValues(values) {
							values.forEach((valuesRow, i) => {
								const rowIndex = row - 1 + i;

								if (!sheet.rows[rowIndex]) {
									sheet.rows[rowIndex] = [];
								}

								valuesRow.forEach((value, j) => {
									sheet.rows[rowIndex][column - 1 + j] = value;
								});
							});
						}
					};
				},

				getLastRow() {
					return this.rows.length;
				},

				setFrozenRows(count) {
					this.frozenRows = count;
				},

				appendRow(row) {
					this.rows.push([...row]);
				}
			};

			sheets[name] = sheet;
			return sheet;
		}
	};
}

let passed = 0;
let failed = 0;

//Run a test and display the result.
function test(name, fn) {
	try {
		fn();
		console.log("PASS: " + name);
		passed++;
	} catch (error) {
		console.log("FAIL: " + name);
		console.log("  " + error.message);
		failed++;
	}
}

//Create test contacts.
const existing = {
	"Contact ID": "CT-001",
	"Name / DJ Alias": "Michael Johnson"
};

const incoming = {
	"Name / DJ Alias": "Mike Johnson"
};

const matchResult = {
	status: "POSSIBLE_MATCH",
	matchScore: 30,
	matchingFields: ["Name + Organization"],
	conflictingFields: ["Name / DJ Alias"]
};

const ss = makeSpreadsheet();

//Test 1: Save a possible duplicate.
test("Save possible duplicate", () => {
	const matchId = saveDuplicate(
		ss, existing, incoming, "ROW-001", matchResult
	);

	const sheet = ss.getSheetByName("Potential_Duplicates");

	assert.equal(matchId, "MATCH-test-1");
	assert.equal(sheet.rows.length, 2);
	assert.equal(sheet.rows[1][1], "CT-001");
	assert.equal(sheet.rows[1][2], "ROW-001");
	assert.equal(sheet.rows[1][7], 30);
	assert.equal(sheet.rows[1][8], "Pending");
});

//Test 2: Check review sheet headers.
test("Review sheet headers", () => {
	const sheet = ss.getSheetByName("Potential_Duplicates");

	assert.equal(sheet.rows[0].length, 11);
	assert.equal(sheet.rows[0][0], "Match ID");
	assert.equal(sheet.rows[0][7], "Match Score");
	assert.equal(sheet.rows[0][10], "Review Date");
	assert.equal(sheet.frozenRows, 1);
});

//Test 3: Do not create duplicate review records.
test("Prevent duplicate review records", () => {
	const matchId = saveDuplicate(
		ss, existing, incoming, "ROW-001", matchResult
	);

	const sheet = ss.getSheetByName("Potential_Duplicates");

	assert.equal(matchId, "MATCH-test-1");
	assert.equal(sheet.rows.length, 2);
});

//Test 4: Ignore exact matches.
test("Ignore exact matches", () => {
	const result = saveDuplicate(
		ss, existing, incoming, "ROW-002",
		{ ...matchResult, status: "EXACT_MATCH" }
	);

	assert.equal(result, null);
	assert.equal(ss.getSheetByName("Potential_Duplicates").rows.length, 2);
});

//Test 5: Reject missing record IDs.
test("Reject missing record ID", () => {
	assert.throws(() => {
		saveDuplicate(
			ss, existing, incoming, "", matchResult
		);
	}, /Missing contact ID or incoming record ID/);
});

//Test 6: Preserve previous review decisions.
test("Preserve previous review decision", () => {
	const sheet = ss.getSheetByName("Potential_Duplicates");

	sheet.rows[1][8] = "Different Individuals";

	const matchId = saveDuplicate(
		ss, existing, incoming, "ROW-001", matchResult
	);

	assert.equal(matchId, "MATCH-test-1");
	assert.equal(sheet.rows.length, 2);
	assert.equal(sheet.rows[1][8], "Different Individuals");
});

//Create a separate spreadsheet for review tests.
const reviewSs = makeSpreadsheet();

//Test 7: Confirm a duplicate and save reviewer information.
test("Confirm duplicate", () => {
	const matchId = saveDuplicate(
		reviewSs, existing, incoming, "ROW-101", matchResult
	);

	const result = reviewDuplicate(
		reviewSs, matchId, "Confirm Duplicate", "Wenhe"
	);

	const sheet = reviewSs.getSheetByName("Potential_Duplicates");

	assert.equal(result, true);
	assert.equal(sheet.rows[1][8], "Confirm Duplicate");
	assert.equal(sheet.rows[1][9], "Wenhe");
	assert.ok(typeof sheet.rows[1][10]?.getTime === "function");
	assert.ok(!Number.isNaN(sheet.rows[1][10].getTime()));
});

//Test 8: Mark two contacts as different individuals.
test("Different individuals decision", () => {
	const matchId = saveDuplicate(
		reviewSs, existing, incoming, "ROW-102", matchResult
	);

	reviewDuplicate(
		reviewSs, matchId, "Different Individuals", "Wenhe"
	);

	const sheet = reviewSs.getSheetByName("Potential_Duplicates");

	assert.equal(sheet.rows[2][8], "Different Individuals");
});

//Test 9: Mark a contact pair for further research.
test("Needs further research decision", () => {
	const matchId = saveDuplicate(
		reviewSs, existing, incoming, "ROW-103", matchResult
	);

	reviewDuplicate(
		reviewSs, matchId, "Needs Further Research", "Wenhe"
	);

	const sheet = reviewSs.getSheetByName("Potential_Duplicates");

	assert.equal(sheet.rows[3][8], "Needs Further Research");
});

//Test 10: Reject an invalid review decision.
test("Reject invalid review decision", () => {
	const matchId = saveDuplicate(
		reviewSs, existing, incoming, "ROW-104", matchResult
	);

	assert.throws(() => {
		reviewDuplicate(
			reviewSs, matchId, "Delete Contact", "Wenhe"
		);
	}, /Invalid review decision/);
});

//Test 11: Do not overwrite a final review decision.
test("Prevent review decision overwrite", () => {
	const sheet = reviewSs.getSheetByName("Potential_Duplicates");
	const matchId = sheet.rows[1][0];

	assert.throws(() => {
		reviewDuplicate(
			reviewSs, matchId, "Different Individuals", "Other Reviewer"
		);
	}, /already been reviewed/);

	assert.equal(sheet.rows[1][8], "Confirm Duplicate");
	assert.equal(sheet.rows[1][9], "Wenhe");
});

//Test 12: Allow a final decision after further research.
test("Complete review after further research", () => {
	const sheet = reviewSs.getSheetByName("Potential_Duplicates");

	//ROW-103 was previously marked as Needs Further Research.
	const matchId = sheet.rows[3][0];

	const result = reviewDuplicate(
		reviewSs,
		matchId,
		"Confirm Duplicate",
		"Julian"
	);

	assert.equal(result, true);
	assert.equal(sheet.rows[3][8], "Confirm Duplicate");
	assert.equal(sheet.rows[3][9], "Julian");

	//Check the review date across VM contexts.
	assert.ok(typeof sheet.rows[3][10]?.getTime === "function");
	assert.ok(!Number.isNaN(sheet.rows[3][10].getTime()));
});

//Print the test summary.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
}
