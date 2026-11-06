
/**
 * TFB-135: Contact Safe Merge Local Tests
 * Test merge previews without modifying contact records.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load the Apps Script code.
const source = fs.readFileSync(
	path.join(__dirname, "..", "ContactSafeMerge.js"),
	"utf8"
);

const context = vm.createContext({});
vm.runInContext(source, context);

const {
	contactSafeMergePreview,
	contactSafeMergeSplitValues,
	contactSafeMergeUniqueValues,
	contactSafeMergeSameValue
} = vm.runInContext(
	"({ contactSafeMergePreview, contactSafeMergeSplitValues, contactSafeMergeUniqueValues, contactSafeMergeSameValue })",
	context
);

//Create a sample contact.
function makeContact(overrides = {}) {
	return {
		"Contact ID": "CT-001",
		"Name / DJ Alias": "Alex Smith",
		"Role": "DJ",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Station / Venue / Organization": "WXYZ",
		"Social Accounts": "@alex",
		"Sources": "Report A",
		"City": "Columbus",
		"State / Region": "Ohio",
		"Country": "United States",
		"Review Status": "Reviewed",
		"Review Notes": "Verified by staff",
		"Last Updated": "2026-11-01",
		sheetRow: 4,
		...overrides
	};
}

//Create a second contact.
function makeDuplicate(overrides = {}) {
	return makeContact({
		"Contact ID": "CT-002",
		sheetRow: 5,
		...overrides
	});
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

//Test 1: Keep the primary Contact ID.
test("Preserve primary Contact ID", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate()
	);

	assert.equal(result.survivingContactId, "CT-001");
	assert.equal(result.duplicateContactId, "CT-002");
	assert.equal(result.mergedContact["Contact ID"], "CT-001");
});

//Test 2: Combine different email addresses.
test("Preserve multiple email addresses", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			Email: "other@example.com"
		})
	);

	assert.equal(
		result.mergedContact.Email,
		"alex@example.com\nother@example.com"
	);

	assert.ok(result.reviewFields.includes("Email"));
});

//Test 3: Combine different phone numbers.
test("Preserve multiple phone numbers", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			Phone: "6145552000"
		})
	);

	assert.equal(
		result.mergedContact.Phone,
		"6145551000\n6145552000"
	);

	assert.ok(result.reviewFields.includes("Phone"));
});

//Test 4: Preserve multiple stations.
test("Preserve multiple stations", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			"Station / Venue / Organization": "KABC"
		})
	);

	assert.equal(
		result.mergedContact["Station / Venue / Organization"],
		"WXYZ\nKABC"
	);

	assert.ok(
		result.reviewFields.includes("Station / Venue / Organization")
	);
});

//Test 5: Preserve multiple social accounts.
test("Preserve multiple social accounts", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			"Social Accounts": "@alex_other"
		})
	);

	assert.equal(
		result.mergedContact["Social Accounts"],
		"@alex\n@alex_other"
	);
});

//Test 6: Preserve all sources.
test("Preserve multiple sources", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			Sources: "Report B"
		})
	);

	assert.equal(
		result.mergedContact.Sources,
		"Report A\nReport B"
	);
});

//Test 7: Remove repeated email addresses.
test("Remove duplicate email values", () => {
	const result = contactSafeMergePreview(
		makeContact({
			Email: "alex@example.com\nother@example.com"
		}),
		makeDuplicate({
			Email: "other@example.com\nthird@example.com"
		})
	);

	assert.equal(
		result.mergedContact.Email,
		"alex@example.com\nother@example.com\nthird@example.com"
	);
});

//Test 8: Ignore case when removing duplicates.
test("Deduplicate values case insensitively", () => {
	const result = contactSafeMergeUniqueValues(
		"Alex@Example.com",
		"alex@example.com"
	);

	assert.equal(result, "Alex@Example.com");
});

//Test 9: Trim spaces around multiline values.
test("Normalize multiline values", () => {
	const result = contactSafeMergeSplitValues(
		" first@example.com \n\n second@example.com "
	);

	assert.equal(result.length, 2);
	assert.equal(result[0], "first@example.com");
	assert.equal(result[1], "second@example.com");
});

//Test 10: Detect conflicting cities.
test("Detect city conflicts", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			City: "Cleveland"
		})
	);

	assert.equal(result.mergedContact.City, "Columbus");
	assert.equal(result.conflicts.length, 1);
	assert.equal(result.conflicts[0].field, "City");
	assert.equal(result.conflicts[0].primaryValue, "Columbus");
	assert.equal(result.conflicts[0].duplicateValue, "Cleveland");
	assert.equal(result.hasUnresolvedConflicts, true);
});

//Test 11: Detect conflicting names.
test("Detect name conflicts", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			"Name / DJ Alias": "Alex Johnson"
		})
	);

	assert.equal(
		result.mergedContact["Name / DJ Alias"],
		"Alex Smith"
	);

	assert.ok(
		result.conflicts.some(
			item => item.field === "Name / DJ Alias"
		)
	);
});

//Test 12: Detect multiple conflicts.
test("Record multiple field conflicts", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			City: "Cleveland",
			"State / Region": "Michigan",
			Country: "Canada"
		})
	);

	assert.equal(result.conflicts.length, 3);
	assert.equal(result.hasUnresolvedConflicts, true);
});

//Test 13: Fill an empty field in the preview.
test("Fill missing primary fields", () => {
	const result = contactSafeMergePreview(
		makeContact({
			Role: ""
		}),
		makeDuplicate({
			Role: "Radio DJ"
		})
	);

	assert.equal(result.mergedContact.Role, "Radio DJ");
});

//Test 14: Detect new contact information.
test("Flag new contact details for review", () => {
	const result = contactSafeMergePreview(
		makeContact({
			Email: "",
			Phone: "",
			"Station / Venue / Organization": ""
		}),
		makeDuplicate({
			Email: "new@example.com",
			Phone: "6145559999",
			"Station / Venue / Organization": "KABC"
		})
	);

	assert.ok(result.reviewFields.includes("Email"));
	assert.ok(result.reviewFields.includes("Phone"));
	assert.ok(
		result.reviewFields.includes("Station / Venue / Organization")
	);
	assert.equal(result.reviewFields.length, 3);
});

//Test 15: Avoid unnecessary review field flags.
test("Do not flag unchanged contact details", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate()
	);

	assert.equal(result.reviewFields.length, 0);
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.hasUnresolvedConflicts, false);
});

//Test 16: Require manual review for every merge.
test("Always require manual merge review", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate()
	);

	assert.equal(result.requiresManualReview, true);
});

//Test 17: Preserve system fields.
test("Preserve primary system fields", () => {
	const result = contactSafeMergePreview(
		makeContact(),
		makeDuplicate({
			"Review Status": "Needs Review",
			"Review Notes": "Different notes",
			"Last Updated": "2026-11-04",
			sheetRow: 99
		})
	);

	assert.equal(result.mergedContact["Review Status"], "Reviewed");
	assert.equal(result.mergedContact["Review Notes"], "Verified by staff");
	assert.equal(result.mergedContact["Last Updated"], "2026-11-01");
	assert.equal(result.mergedContact.sheetRow, 4);
});

//Test 18: Do not modify either original contact.
test("Do not mutate original contacts", () => {
	const primary = makeContact();
	const duplicate = makeDuplicate({
		Email: "other@example.com",
		City: "Cleveland"
	});

	const originalPrimary = JSON.stringify(primary);
	const originalDuplicate = JSON.stringify(duplicate);

	contactSafeMergePreview(primary, duplicate);

	assert.equal(JSON.stringify(primary), originalPrimary);
	assert.equal(JSON.stringify(duplicate), originalDuplicate);
});

//Test 19: Reject invalid contact records.
test("Reject invalid contact inputs", () => {
	assert.throws(() =>
		contactSafeMergePreview(null, makeDuplicate())
	);

	assert.throws(() =>
		contactSafeMergePreview(makeContact(), null)
	);

	assert.throws(() =>
		contactSafeMergePreview([], makeDuplicate())
	);

	assert.throws(() =>
		contactSafeMergePreview(makeContact(), [])
	);

	assert.throws(() =>
		contactSafeMergePreview(
			makeContact({ "Contact ID": "" }),
			makeDuplicate()
		)
	);
});

//Test 20: Prevent self-merge.
test("Prevent merging the same contact", () => {
	assert.throws(() =>
		contactSafeMergePreview(
			makeContact(),
			makeDuplicate({
				"Contact ID": "CT-001"
			})
		)
	);
});

//Display final results.
console.log("\nContactSafeMerge Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 20 TESTS PASSED!");
}
