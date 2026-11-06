
/**
 * TFB-135: Contact Safe Merge Approval Tests
 * Validate manual approval before merging contacts.
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

const contactSafeMergeValidateApproval = vm.runInContext(
	"contactSafeMergeValidateApproval",
	context
);

//Create the primary contact.
function makePrimary() {
	return {
		"Contact ID": "CT-001",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@example.com",
		"Station / Venue / Organization": "WXYZ"
	};
}

//Create the duplicate contact.
function makeDuplicate() {
	return {
		"Contact ID": "CT-002",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@radio.com",
		"Station / Venue / Organization": "WXYZ"
	};
}

//Create a sample manual review record.
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

//Test 1: Accept a confirmed duplicate.
test("Accept confirmed duplicate", () => {
	const result = contactSafeMergeValidateApproval(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(result.approved, true);
	assert.equal(result.matchId, "MATCH-001");
	assert.equal(result.primaryContactId, "CT-001");
	assert.equal(result.duplicateContactId, "CT-002");
});

//Test 2: Preserve reviewer information.
test("Preserve reviewer details", () => {
	const result = contactSafeMergeValidateApproval(
		makePrimary(),
		makeDuplicate(),
		makeReview()
	);

	assert.equal(result.reviewer, "Test Reviewer");
	assert.equal(
		result.reviewDate,
		"2026-11-04T00:00:00.000Z"
	);
});

//Test 3: Reject missing review records.
test("Reject missing review record", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			null
		)
	);

	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			[]
		)
	);
});

//Test 4: Reject missing Match ID.
test("Reject missing Match ID", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({ "Match ID": "" })
		)
	);
});

//Test 5: Reject incorrect primary Contact ID.
test("Reject mismatched primary ID", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Existing Contact ID": "CT-999"
			})
		)
	);
});

//Test 6: Reject incorrect duplicate Contact ID.
test("Reject mismatched duplicate ID", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Incoming Record ID": "CT-999"
			})
		)
	);
});

//Test 7: Reject pending decisions.
test("Reject pending review", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Status": "Pending"
			})
		)
	);
});

//Test 8: Reject different individuals.
test("Reject different individuals", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Status": "Different Individuals"
			})
		)
	);
});

//Test 9: Reject changes needing further research.
test("Reject incomplete review", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Status": "Needs Further Research"
			})
		)
	);
});

//Test 10: Require a human reviewer.
test("Reject missing reviewer", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Reviewer": ""
			})
		)
	);
});

//Test 11: Require a valid review date.
test("Reject missing or invalid review date", () => {
	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Date": ""
			})
		)
	);

	assert.throws(() =>
		contactSafeMergeValidateApproval(
			makePrimary(),
			makeDuplicate(),
			makeReview({
				"Review Date": "invalid-date"
			})
		)
	);
});

//Test 12: Preserve original records.
test("Do not modify contact or review records", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const review = makeReview();

	const beforePrimary = JSON.stringify(primary);
	const beforeDuplicate = JSON.stringify(duplicate);
	const beforeReview = JSON.stringify(review);

	contactSafeMergeValidateApproval(
		primary,
		duplicate,
		review
	);

	assert.equal(JSON.stringify(primary), beforePrimary);
	assert.equal(JSON.stringify(duplicate), beforeDuplicate);
	assert.equal(JSON.stringify(review), beforeReview);
});

//Display final results.
console.log("\nContactSafeMergeApproval Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 12 TESTS PASSED!");
}
