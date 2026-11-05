
/**
 * TFB-135: Contact Safe Merge Plan Tests
 * Verify merge plans without changing Google Sheets.
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

const contactSafeMergePreparePlan = vm.runInContext(
	"contactSafeMergePreparePlan",
	context
);

//Create the primary contact.
function makePrimary(overrides = {}) {
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
		"Review Notes": "",
		"Last Updated": "2026-11-04",
		sheetRow: 4,
		...overrides
	};
}

//Create the duplicate contact.
function makeDuplicate(overrides = {}) {
	return makePrimary({
		"Contact ID": "CT-002",
		sheetRow: 5,
		...overrides
	});
}

//Create a mock verified backup.
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

//Prepare a plan for test contacts.
function makePlan(primaryOverrides = {}, duplicateOverrides = {}) {
	const primary = makePrimary(primaryOverrides);
	const duplicate = makeDuplicate(duplicateOverrides);
	const backup = makeBackup(primary, duplicate);

	return contactSafeMergePreparePlan(
		backup,
		primary,
		duplicate
	);
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

//Test 1: Prepare a basic merge plan.
test("Prepare a basic merge plan", () => {
	const plan = makePlan();

	assert.equal(plan.mergeId, "MG-001");
	assert.equal(plan.primaryContactId, "CT-001");
	assert.equal(plan.duplicateContactId, "CT-002");
	assert.equal(plan.mergedContact["Contact ID"], "CT-001");
});

//Test 2: Keep every plan subject to manual approval.
test("Always require manual merge approval", () => {
	const plan = makePlan();

	assert.equal(plan.requiresManualMergeApproval, true);
	assert.equal(plan.readyForDataWrite, false);
});

//Test 3: Accept a preview without field blockers.
test("Prepare plan with no field blockers", () => {
	const plan = makePlan();

	assert.equal(plan.blockers.length, 0);
	assert.equal(plan.hasBlockers, false);
	assert.equal(plan.readyForDataWrite, false);
});

//Test 4: Flag a new email.
test("Require approval for new email", () => {
	const plan = makePlan(
		{},
		{ Email: "other@example.com" }
	);

	assert.equal(
		plan.mergedContact.Email,
		"alex@example.com\nother@example.com"
	);

	assert.ok(plan.blockers.some(
		item => item.field === "Email" &&
			item.reason === "FIELD_APPROVAL_REQUIRED"
	));
});

//Test 5: Flag a new phone number.
test("Require approval for new phone", () => {
	const plan = makePlan(
		{},
		{ Phone: "6145559999" }
	);

	assert.ok(plan.blockers.some(
		item => item.field === "Phone" &&
			item.reason === "FIELD_APPROVAL_REQUIRED"
	));

	assert.equal(plan.hasBlockers, true);
});

//Test 6: Flag a new station.
test("Require approval for new station", () => {
	const plan = makePlan(
		{},
		{ "Station / Venue / Organization": "KABC" }
	);

	assert.equal(
		plan.mergedContact["Station / Venue / Organization"],
		"WXYZ\nKABC"
	);

	assert.ok(plan.blockers.some(
		item => item.field === "Station / Venue / Organization" &&
			item.reason === "FIELD_APPROVAL_REQUIRED"
	));
});

//Test 7: Flag all three important contact fields.
test("Require approval for multiple contact changes", () => {
	const plan = makePlan(
		{},
		{
			Email: "new@example.com",
			Phone: "6145559999",
			"Station / Venue / Organization": "KABC"
		}
	);

	assert.equal(plan.blockers.length, 3);
	assert.equal(plan.hasBlockers, true);

	assert.ok(plan.blockers.every(
		item => item.reason === "FIELD_APPROVAL_REQUIRED"
	));
});

//Test 8: Detect a conflicting city.
test("Detect unresolved city conflict", () => {
	const plan = makePlan(
		{},
		{ City: "Cleveland" }
	);

	assert.equal(plan.mergedContact.City, "Columbus");

	assert.ok(plan.blockers.some(
		item => item.field === "City" &&
			item.reason === "UNRESOLVED_CONFLICT" &&
			item.primaryValue === "Columbus" &&
			item.duplicateValue === "Cleveland"
	));
});

//Test 9: Detect a conflicting name.
test("Detect unresolved name conflict", () => {
	const plan = makePlan(
		{},
		{ "Name / DJ Alias": "Alex Johnson" }
	);

	assert.equal(
		plan.mergedContact["Name / DJ Alias"],
		"Alex Smith"
	);

	assert.ok(plan.blockers.some(
		item => item.field === "Name / DJ Alias" &&
			item.reason === "UNRESOLVED_CONFLICT"
	));
});

//Test 10: Detect different kinds of blockers.
test("Record conflicting fields and approval blockers", () => {
	const plan = makePlan(
		{},
		{
			City: "Cleveland",
			Role: "Program Director",
			Email: "new@example.com"
		}
	);

	assert.equal(plan.blockers.length, 3);
	assert.equal(plan.hasBlockers, true);

	assert.equal(
		plan.blockers.filter(
			item => item.reason === "UNRESOLVED_CONFLICT"
		).length,
		2
	);

	assert.equal(
		plan.blockers.filter(
			item => item.reason === "FIELD_APPROVAL_REQUIRED"
		).length,
		1
	);
});

//Test 11: Preserve multiple sources.
test("Preserve multiple contact sources", () => {
	const plan = makePlan(
		{},
		{ Sources: "Report B" }
	);

	assert.equal(
		plan.mergedContact.Sources,
		"Report A\nReport B"
	);

	assert.equal(plan.hasBlockers, false);
});

//Test 12: Preserve multiple social accounts.
test("Preserve multiple social accounts", () => {
	const plan = makePlan(
		{},
		{ "Social Accounts": "@alex_radio" }
	);

	assert.equal(
		plan.mergedContact["Social Accounts"],
		"@alex\n@alex_radio"
	);
});

//Test 13: Reject changed primary contact data.
test("Reject changed primary contact after backup", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.Email = "changed@example.com";

	assert.throws(() =>
		contactSafeMergePreparePlan(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 14: Reject changed duplicate contact data.
test("Reject changed duplicate contact after backup", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	duplicate["Station / Venue / Organization"] = "NEW STATION";

	assert.throws(() =>
		contactSafeMergePreparePlan(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 15: Reject unverified or invalid backup states.
test("Reject backups not ready for merge", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();

	for (const overrides of [
		{ backupVerified: false },
		{ status: "MERGED" },
		{ status: "UNDONE" },
		{ primaryContactId: "CT-999" }
	]) {
		assert.throws(() =>
			contactSafeMergePreparePlan(
				makeBackup(primary, duplicate, overrides),
				primary,
				duplicate
			)
		);
	}
});

//Test 16: Do not modify the original records.
test("Do not mutate contact or backup data", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate({
		Email: "other@example.com",
		City: "Cleveland"
	});

	const backup = makeBackup(primary, duplicate);

	const beforePrimary = JSON.stringify(primary);
	const beforeDuplicate = JSON.stringify(duplicate);
	const beforeBackup = JSON.stringify(backup);

	const plan = contactSafeMergePreparePlan(
		backup,
		primary,
		duplicate
	);

	assert.equal(JSON.stringify(primary), beforePrimary);
	assert.equal(JSON.stringify(duplicate), beforeDuplicate);
	assert.equal(JSON.stringify(backup), beforeBackup);

	assert.equal(plan.readyForDataWrite, false);
});

//Display final results.
console.log("\nContactSafeMergePlan Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 16 TESTS PASSED!");
}
