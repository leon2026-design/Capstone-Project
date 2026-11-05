
/**
 * TFB-135: Contact Safe Merge Resolution Tests
 * Test manual field decisions without editing Google Sheets.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load the Apps Script module.
const source = fs.readFileSync(
	path.join(__dirname, "..", "ContactSafeMerge.js"),
	"utf8"
);

const context = vm.createContext({});
vm.runInContext(source, context);

const contactSafeMergeResolvePlan = vm.runInContext(
	"contactSafeMergeResolvePlan",
	context
);

//Create an existing contact.
function makePrimary(overrides = {}) {
	return {
		"Contact ID": "CT-001",
		"Name / DJ Alias": "Alex Smith",
		"Email": "alex@example.com",
		"Phone": "6145551000",
		"Station / Venue / Organization": "WXYZ",
		"City": "Columbus",
		"Sources": "Report A",
		"Review Status": "Reviewed",
		sheetRow: 4,
		...overrides
	};
}

//Create a second contact.
function makeDuplicate(overrides = {}) {
	return makePrimary({
		"Contact ID": "CT-002",
		sheetRow: 5,
		...overrides
	});
}

//Create a mock saved backup for local tests only.
function makeBackup(primary, duplicate, overrides = {}) {
	return {
		mergeId: "MG-001",
		primaryContactId: "CT-001",
		duplicateContactId: "CT-002",
		status: "BACKUP_SAVED",
		backupVerified: true,
		primaryBefore: { ...primary },
		duplicateBefore: { ...duplicate },
		...overrides
	};
}

//Build a resolved plan from sample records.
function resolve(primaryChanges = {}, duplicateChanges = {}, decisions = {}) {
	const primary = makePrimary(primaryChanges);
	const duplicate = makeDuplicate(duplicateChanges);

	return contactSafeMergeResolvePlan(
		makeBackup(primary, duplicate),
		primary,
		duplicate,
		decisions
	);
}

let passed = 0;
let failed = 0;

//Run a local test.
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

//Test 1: A plan with no changes still cannot be written.
test("Resolve plan with no blockers", () => {
	const result = resolve();

	assert.equal(result.mergeId, "MG-001");
	assert.equal(result.primaryContactId, "CT-001");
	assert.equal(result.duplicateContactId, "CT-002");
	assert.equal(result.resolvedFields.length, 0);
	assert.equal(result.allFieldDecisionsProvided, true);
	assert.equal(result.requiresTrustedApprovalVerification, true);
	assert.equal(result.readyForDataWrite, false);
});

//Test 2: Approve an additional email.
test("Approve new email", () => {
	const result = resolve(
		{},
		{ Email: "second@example.com" },
		{ Email: "APPROVE" }
	);

	assert.equal(
		result.mergedContact.Email,
		"alex@example.com\nsecond@example.com"
	);

	assert.equal(result.resolvedFields[0].decision, "APPROVE");
});

//Test 3: Keep the existing email.
test("Keep primary email", () => {
	const result = resolve(
		{},
		{ Email: "second@example.com" },
		{ Email: "KEEP_PRIMARY" }
	);

	assert.equal(result.mergedContact.Email, "alex@example.com");
});

//Test 4: Approve an additional phone.
test("Approve new phone", () => {
	const result = resolve(
		{},
		{ Phone: "6145552000" },
		{ Phone: "APPROVE" }
	);

	assert.equal(
		result.mergedContact.Phone,
		"6145551000\n6145552000"
	);
});

//Test 5: Keep the existing phone.
test("Keep primary phone", () => {
	const result = resolve(
		{},
		{ Phone: "6145552000" },
		{ Phone: "KEEP_PRIMARY" }
	);

	assert.equal(result.mergedContact.Phone, "6145551000");
});

//Test 6: Approve an additional station.
test("Approve new station", () => {
	const field = "Station / Venue / Organization";

	const result = resolve(
		{},
		{ [field]: "KABC" },
		{ [field]: "APPROVE" }
	);

	assert.equal(result.mergedContact[field], "WXYZ\nKABC");
});

//Test 7: Keep the existing station.
test("Keep primary station", () => {
	const field = "Station / Venue / Organization";

	const result = resolve(
		{},
		{ [field]: "KABC" },
		{ [field]: "KEEP_PRIMARY" }
	);

	assert.equal(result.mergedContact[field], "WXYZ");
});

//Test 8: Resolve a city conflict using duplicate value.
test("Use duplicate city for conflict", () => {
	const result = resolve(
		{},
		{ City: "Cleveland" },
		{ City: "USE_DUPLICATE" }
	);

	assert.equal(result.mergedContact.City, "Cleveland");
});

//Test 9: Resolve a city conflict using primary value.
test("Keep primary city for conflict", () => {
	const result = resolve(
		{},
		{ City: "Cleveland" },
		{ City: "KEEP_PRIMARY" }
	);

	assert.equal(result.mergedContact.City, "Columbus");
});

//Test 10: Process several decisions together.
test("Resolve mixed field decisions", () => {
	const result = resolve(
		{},
		{
			Email: "second@example.com",
			Phone: "6145552000",
			City: "Cleveland"
		},
		{
			Email: "APPROVE",
			Phone: "KEEP_PRIMARY",
			City: "USE_DUPLICATE"
		}
	);

	assert.equal(result.resolvedFields.length, 3);

	assert.equal(
		result.mergedContact.Email,
		"alex@example.com\nsecond@example.com"
	);

	assert.equal(result.mergedContact.Phone, "6145551000");
	assert.equal(result.mergedContact.City, "Cleveland");
	assert.equal(result.readyForDataWrite, false);
});

//Test 11: Require every field decision.
test("Reject missing field decisions", () => {
	assert.throws(() => resolve(
		{},
		{
			Email: "second@example.com",
			City: "Cleveland"
		},
		{
			Email: "APPROVE"
		}
	), /Missing field decision/);
});

//Test 12: Validate email, phone and station decision types.
test("Reject invalid contact detail decision", () => {
	assert.throws(() => resolve(
		{},
		{ Email: "second@example.com" },
		{ Email: "USE_DUPLICATE" }
	), /Invalid field approval decision/);
});

//Test 13: Validate conflict decision types.
test("Reject invalid conflict decision", () => {
	assert.throws(() => resolve(
		{},
		{ City: "Cleveland" },
		{ City: "APPROVE" }
	), /Invalid conflict resolution/);
});

//Test 14: Do not allow decisions for unrelated fields.
test("Reject unexpected field decisions", () => {
	assert.throws(() => resolve(
		{},
		{},
		{ Sources: "APPROVE" }
	), /Unexpected field decision/);
});

//Test 15: Reject malformed decisions and stale backups.
test("Reject invalid decisions and stale backup", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	for (const decisions of [null, [], "APPROVE"]) {
		assert.throws(() =>
			contactSafeMergeResolvePlan(
				backup,
				primary,
				duplicate,
				decisions
			)
		);
	}

	primary.Email = "changed@example.com";

	assert.throws(() =>
		contactSafeMergeResolvePlan(
			backup,
			primary,
			duplicate,
			{}
		),
		/Contact changed since backup/
	);
});

//Test 16: Never modify original data during resolution.
test("Do not mutate original contacts or backup", () => {
	const primary = makePrimary();

	const duplicate = makeDuplicate({
		Email: "second@example.com",
		City: "Cleveland"
	});

	const backup = makeBackup(primary, duplicate);

	const before = JSON.stringify({
		primary,
		duplicate,
		backup
	});

	const result = contactSafeMergeResolvePlan(
		backup,
		primary,
		duplicate,
		{
			Email: "APPROVE",
			City: "KEEP_PRIMARY"
		}
	);

	assert.equal(
		JSON.stringify({ primary, duplicate, backup }),
		before
	);

	assert.equal(result.readyForDataWrite, false);
});

//Display test results.
console.log("\nContactSafeMergeResolution Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 16 TESTS PASSED!");
}
