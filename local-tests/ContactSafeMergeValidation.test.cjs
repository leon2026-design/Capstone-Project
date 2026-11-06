
/**
 * TFB-135: Contact Safe Merge Validation Tests
 * Verify contact data before applying a merge.
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

const contactSafeMergeVerifyCurrentData = vm.runInContext(
	"contactSafeMergeVerifyCurrentData",
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
		"City": "Columbus",
		"Sources": "Report A",
		"Review Status": "Reviewed",
		"Last Updated": "2026-11-04",
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
		"City": "Columbus",
		"Sources": "Report B",
		"Review Status": "Reviewed",
		"Last Updated": "2026-11-04",
		sheetRow: 5,
		...overrides
	};
}

//Create a verified backup for testing.
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

//Test 1: Accept unchanged contacts.
test("Accept unchanged contact records", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	const result = contactSafeMergeVerifyCurrentData(
		backup,
		primary,
		duplicate
	);

	assert.equal(result.unchanged, true);
	assert.equal(result.primaryContactId, "CT-001");
	assert.equal(result.duplicateContactId, "CT-002");
});

//Test 2: Reject modified primary email.
test("Reject changed primary email", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.Email = "changed@example.com";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		),
		/Contact changed since backup/
	);
});

//Test 3: Reject modified duplicate email.
test("Reject changed duplicate email", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	duplicate.Email = "new@radio.com";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 4: Reject modified phone.
test("Reject changed phone number", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.Phone = "6145559999";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 5: Reject modified station.
test("Reject changed station information", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	duplicate["Station / Venue / Organization"] = "NEW STATION";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 6: Reject modified sources.
test("Reject changed source information", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.Sources = "Report A\nReport C";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 7: Reject modified review status.
test("Reject changed review status", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary["Review Status"] = "Needs Review";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 8: Reject modified Last Updated.
test("Reject changed Last Updated value", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	duplicate["Last Updated"] = "2026-11-05";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 9: Ignore changed sheet positions.
test("Allow sheet row position changes", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.sheetRow = 20;
	duplicate.sheetRow = 21;

	const result = contactSafeMergeVerifyCurrentData(
		backup,
		primary,
		duplicate
	);

	assert.equal(result.unchanged, true);
});

//Test 10: Reject incorrect contact IDs.
test("Reject mismatched contact IDs", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			makePrimary({ "Contact ID": "CT-999" }),
			duplicate
		)
	);

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			makeDuplicate({ "Contact ID": "CT-999" })
		)
	);
});

//Test 11: Reject missing or unverified backup.
test("Require verified backup", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			null,
			primary,
			duplicate
		)
	);

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			makeBackup(primary, duplicate, {
				backupVerified: false
			}),
			primary,
			duplicate
		)
	);
});

//Test 12: Reject invalid merge status.
test("Reject backups not ready for merge", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();

	for (const status of ["MERGED", "UNDONE", "UNKNOWN"]) {
		assert.throws(() =>
			contactSafeMergeVerifyCurrentData(
				makeBackup(primary, duplicate, { status }),
				primary,
				duplicate
			)
		);
	}
});

//Test 13: Reject missing current records.
test("Reject invalid current contact records", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			null,
			duplicate
		)
	);

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			[]
		)
	);
});

//Test 14: Reject added or removed fields.
test("Reject changed contact field structure", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	primary.NewField = "New information";

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);

	delete primary.NewField;
	delete primary.City;

	assert.throws(() =>
		contactSafeMergeVerifyCurrentData(
			backup,
			primary,
			duplicate
		)
	);
});

//Test 15: Preserve original data.
test("Do not modify contact records", () => {
	const primary = makePrimary();
	const duplicate = makeDuplicate();
	const backup = makeBackup(primary, duplicate);

	const beforePrimary = JSON.stringify(primary);
	const beforeDuplicate = JSON.stringify(duplicate);
	const beforeBackup = JSON.stringify(backup);

	contactSafeMergeVerifyCurrentData(
		backup,
		primary,
		duplicate
	);

	assert.equal(JSON.stringify(primary), beforePrimary);
	assert.equal(JSON.stringify(duplicate), beforeDuplicate);
	assert.equal(JSON.stringify(backup), beforeBackup);
});

//Test 16: Detect date serialization differences.
test("Handle equivalent Date and ISO backup values", () => {
	const date = new Date("2026-11-04T18:00:00.000Z");

	const primary = makePrimary({
		"Last Updated": date
	});

	const duplicate = makeDuplicate();

	//Simulate JSON serialization in Merge_History.
	const savedPrimary = JSON.parse(JSON.stringify(primary));

	const backup = makeBackup(primary, duplicate, {
		primaryBefore: savedPrimary
	});

	const result = contactSafeMergeVerifyCurrentData(
		backup,
		primary,
		duplicate
	);

	assert.equal(result.unchanged, true);
});

//Display final results.
console.log("\nContactSafeMergeValidation Test Results");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
} else {
	console.log("ALL 16 TESTS PASSED!");
}
