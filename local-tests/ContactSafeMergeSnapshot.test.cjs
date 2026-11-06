
/**
 * TFB-135: Contact Safe Merge Snapshot Tests
 * Verify backup data before performing a merge.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load the Safe Merge module.
const source = fs.readFileSync(
	path.join(__dirname, "..", "ContactSafeMerge.js"),
	"utf8"
);

const context = vm.createContext({});
vm.runInContext(source, context);

const contactSafeMergeCreateSnapshot = vm.runInContext(
	"contactSafeMergeCreateSnapshot",
	context
);

//Create a primary contact.
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

//Create a duplicate contact.
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

//Create an approved review record.
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

let passed = 0;
let failed = 0;

//Run an individual test.
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

//Test 1: Preserve both contact IDs.
test("Preserve both contact IDs", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(snapshot.primaryContactId, "CT-001");
	assert.equal(snapshot.duplicateContactId, "CT-002");
});

//Test 2: Preserve review information.
test("Preserve manual approval details", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(snapshot.matchId, "MATCH-001");
	assert.equal(snapshot.reviewer, "Test Reviewer");
	assert.equal(snapshot.reviewDate, "2026-11-04T00:00:00.000Z");
});

//Test 3: Preserve original email addresses.
test("Preserve original email values", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(snapshot.primaryBefore.Email, "alex@example.com");
	assert.equal(snapshot.duplicateBefore.Email, "alex@radio.com");
});

//Test 4: Preserve original station data.
test("Preserve original station values", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(
		snapshot.primaryBefore["Station / Venue / Organization"],
		"WXYZ"
	);

	assert.equal(
		snapshot.duplicateBefore["Station / Venue / Organization"],
		"KABC"
	);
});

//Test 5: Preserve sources and sheet positions.
test("Preserve sources and sheet positions", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(snapshot.primaryBefore.Sources, "Report A");
	assert.equal(snapshot.duplicateBefore.Sources, "Report B");
	assert.equal(snapshot.primaryBefore.sheetRow, 4);
	assert.equal(snapshot.duplicateBefore.sheetRow, 5);
});

//Test 6: Create an independent primary backup.
test("Create independent primary backup", () => {
	const primary = makePrimary();

	const snapshot = contactSafeMergeCreateSnapshot(
		primary,
		makeDuplicate(),
		makeReview()
	);

	primary.Email = "changed@example.com";

	assert.equal(snapshot.primaryBefore.Email, "alex@example.com");
	assert.notEqual(snapshot.primaryBefore, primary);
});

//Test 7: Create an independent duplicate backup.
test("Create independent duplicate backup", () => {
	const duplicate = makeDuplicate();

	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		duplicate,
		makeReview()
	);

	duplicate.Phone = "9999999999";

	assert.equal(snapshot.duplicateBefore.Phone, "6145552000");
	assert.notEqual(snapshot.duplicateBefore, duplicate);
});

//Test 8: Keep a valid snapshot creation date.
test("Record snapshot creation time", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(typeof snapshot.createdAt.getTime, "function");
	assert.ok(Number.isFinite(snapshot.createdAt.getTime()));
});

//Test 9: Mark backup as not persisted.
test("Do not claim backup is persisted", () => {
	const snapshot = contactSafeMergeCreateSnapshot(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(snapshot.persisted, false);
});

//Test 10: Reject an unapproved merge.
test("Reject unapproved snapshot creation", () => {
	assert.throws(() =>
		contactSafeMergeCreateSnapshot(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Status": "Pending"
			})
		)
	);
});

//Test 11: Reject mismatched contact IDs.
test("Reject incorrect contact approval", () => {
	assert.throws(() =>
		contactSafeMergeCreateSnapshot(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Incoming Record ID": "CT-999"
			})
		)
	);
});

//Test 12: Reject unsupported nested values.
test("Reject unsupported contact field types", () => {
	assert.throws(() =>
		contactSafeMergeCreateSnapshot(
			makePrimary({
				Extra: { nested: "value" }
			}),
			makeDuplicate(),
			makeReview()
		)
	);
});

//Display final test results.
console.log("\nContactSafeMergeSnapshot Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 12 TESTS PASSED!");
}
