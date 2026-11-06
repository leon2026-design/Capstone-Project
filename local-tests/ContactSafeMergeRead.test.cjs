
/**
 * TFB-135: Read Master Contacts Tests
 * Test safe reads using a mock spreadsheet only.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load ContactSafeMerge.js.
const source = fs.readFileSync(
	path.join(__dirname, "..", "ContactSafeMerge.js"),
	"utf8"
);

const context = vm.createContext({});
vm.runInContext(source, context);

const readContact = vm.runInContext(
	"contactSafeMergeReadMasterContact",
	context
);

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

//Create a database row in the expected header order.
function makeRow(id, overrides = {}) {
	const values = {
		"Contact ID": id,
		"Name / DJ Alias": "Alex Smith",
		"Role": "DJ",
		"Station / Venue / Organization": "WXYZ",
		"City": "Columbus",
		"State / Region": "Ohio",
		"Country": "United States",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Social Accounts": "@alex",
		"Sources": "Report A",
		"Review Status": "Reviewed",
		"Review Notes": "",
		"Last Updated": "2026-11-04",
		...overrides
	};

	return HEADERS.map(header => values[header]);
}

//Mock only the read methods used by the function.
function makeSpreadsheet(rows = [], options = {}) {
	const headers = options.headers || HEADERS;
	const calls = [];

	const sheet = {
		getLastRow() {
			return options.lastRow === undefined
				? rows.length + 1
				: options.lastRow;
		},

		getRange(row, column, count, width) {
			calls.push({ row, column, count, width });

			return {
				getDisplayValues() {
					assert.equal(row, 1);
					return [[...headers]];
				},

				getValues() {
					assert.equal(row, 2);
					assert.equal(count, rows.length);
					return rows.map(values => [...values]);
				}
			};
		}
	};

	return {
		calls,

		getSheetByName(name) {
			assert.equal(name, "Master_Contacts");
			return options.missingSheet ? null : sheet;
		}
	};
}

let passed = 0;
let failed = 0;

//Run one independent test.
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

//Test 1: Read a matching contact.
test("Read a contact by Contact ID", () => {
	const ss = makeSpreadsheet([makeRow("CT-001")]);
	const record = readContact(ss, "CT-001");

	assert.equal(record["Contact ID"], "CT-001");
	assert.equal(record["Name / DJ Alias"], "Alex Smith");
	assert.equal(record.Email, "alex@example.com");
	assert.equal(record.sheetRow, 2);
});

//Test 2: Find a contact below the first data row.
test("Read the correct row among multiple contacts", () => {
	const ss = makeSpreadsheet([
		makeRow("CT-001"),
		makeRow("CT-002", { Email: "second@example.com" }),
		makeRow("CT-003")
	]);

	const record = readContact(ss, "CT-002");

	assert.equal(record.Email, "second@example.com");
	assert.equal(record.sheetRow, 3);
});

//Test 3: Return real Date values rather than formatted text.
test("Preserve Date values from getValues", () => {
	const timestamp = new Date("2026-11-04T18:00:00.000Z");

	const ss = makeSpreadsheet([
		makeRow("CT-001", { "Last Updated": timestamp })
	]);

	const record = readContact(ss, "CT-001");

	assert.equal(record["Last Updated"], timestamp);

	assert.equal(
		record["Last Updated"].toISOString(),
		timestamp.toISOString()
	);
});

//Test 4: Reject a missing contact.
test("Reject an unknown Contact ID", () => {
	const ss = makeSpreadsheet([makeRow("CT-001")]);

	assert.throws(
		() => readContact(ss, "CT-999"),
		/exactly one matching Contact ID/
	);
});

//Test 5: Reject duplicate IDs.
test("Reject duplicate Contact IDs", () => {
	const ss = makeSpreadsheet([
		makeRow("CT-001"),
		makeRow("CT-001")
	]);

	assert.throws(
		() => readContact(ss, "CT-001"),
		/exactly one matching Contact ID/
	);
});

//Test 6: Reject invalid input.
test("Require spreadsheet and Contact ID", () => {
	const ss = makeSpreadsheet([makeRow("CT-001")]);

	assert.throws(
		() => readContact(null, "CT-001"),
		/Spreadsheet is required/
	);

	assert.throws(
		() => readContact(ss, ""),
		/Contact ID is required/
	);

	assert.throws(
		() => readContact(ss, "  "),
		/Contact ID is required/
	);
});

//Test 7: Reject absent database sheet.
test("Reject missing Master_Contacts sheet", () => {
	const ss = makeSpreadsheet([], {
		missingSheet: true
	});

	assert.throws(
		() => readContact(ss, "CT-001"),
		/sheet not found/
	);
});

//Test 8: Reject missing headers.
test("Reject a sheet without headers", () => {
	const ss = makeSpreadsheet([], {
		lastRow: 0
	});

	assert.throws(
		() => readContact(ss, "CT-001"),
		/has no headers/
	);
});

//Test 9: Reject incorrect header order.
test("Reject changed Master_Contacts header order", () => {
	const headers = [...HEADERS];

	[headers[0], headers[1]] = [
		headers[1],
		headers[0]
	];

	const ss = makeSpreadsheet(
		[makeRow("CT-001")],
		{ headers }
	);

	assert.throws(
		() => readContact(ss, "CT-001"),
		/Unexpected Master_Contacts headers/
	);
});

//Test 10: Reject header-only database.
test("Reject an empty Master_Contacts database", () => {
	const ss = makeSpreadsheet([]);

	assert.throws(
		() => readContact(ss, "CT-001"),
		/Contact not found/
	);
});

//Test 11: Preserve all expected fields.
test("Return all 14 database columns", () => {
	const ss = makeSpreadsheet([makeRow("CT-001")]);
	const record = readContact(ss, "CT-001");

	for (const header of HEADERS) {
		assert.equal(
			Object.hasOwn(record, header),
			true
		);
	}

	assert.equal(Object.keys(record).length, 15);
});

//Test 12: Never write to Google Sheets.
test("Read only without modifying spreadsheet data", () => {
	const rows = [makeRow("CT-001")];
	const before = JSON.stringify(rows);
	const ss = makeSpreadsheet(rows);

	readContact(ss, "CT-001");

	assert.equal(JSON.stringify(rows), before);
	assert.equal(ss.calls.length, 2);
	assert.equal(ss.calls[0].row, 1);
	assert.equal(ss.calls[1].row, 2);
});

//Display test results.
console.log("\nContactSafeMergeRead Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 12 TESTS PASSED!");
}
