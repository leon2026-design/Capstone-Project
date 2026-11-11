
// MA-05: DJ Identity Resolver Tests
// Test identity matching, social profiles, and manual review decisions.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load ContactMatcher.js and DJIdentityResolver.js.
const context = vm.createContext({});

const files = [
	"ContactMatcher.js",
	"DJIdentityResolver.js"
];

for (const filename of files) {
	const filePath = path.join(__dirname, "..", filename);
	const code = fs.readFileSync(filePath, "utf8");

	vm.runInContext(code, context, { filename });
}

const resolve = context.djResolveIdentity;

// Create a contact with default empty fields.
function makeContact(id, fields = {}) {
	return {
		"Contact ID": id,
		"Name / DJ Alias": "",
		"Station / Venue / Organization": "",
		Email: "",
		Phone: "",
		City: "",
		"State / Region": "",
		Country: "",
		"Social Accounts": "",
		...fields
	};
}

// Create a DJ observation for testing.
function makeObservation(fields = {}) {
	return {
		observationId: "OBS-001",
		...fields
	};
}

let passed = 0;
let failed = 0;

// Run a test and display the result.
function runTest(name, callback) {
	try {
		callback();

		console.log("PASS: " + name);
		passed++;
	} catch (error) {
		console.log("FAIL: " + name);
		console.log("  " + error.message);
		failed++;
	}
}

// Test 1: Matching email should link to the existing contact.
runTest("Exact email match", () => {
	const existing = makeContact("CT-001", {
		"Name / DJ Alias": "DJ Alex",
		Email: "Alex@Example.com"
	});

	const incoming = makeObservation({
		djReportedName: "DJ Alex",
		email: "alex@example.com"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.status, "EXACT_MATCH");
	assert.equal(result.decision, "LINK");
	assert.equal(result.contactId, "CT-001");
});

// Test 2: Same name and station with different emails needs review.
runTest("Same name and station with different emails", () => {
	const existing = makeContact("CT-001", {
		"Name / DJ Alias": "DJ Alex",
		"Station / Venue / Organization": "WXYZ",
		Email: "alex@radio.com"
	});

	const incoming = makeObservation({
		djReportedName: "DJ Alex",
		station: "WXYZ",
		email: "alex@gmail.com"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.status, "POSSIBLE_MATCH");
	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
});

// Test 3: Same name alone is not enough.
runTest("Same name only", () => {
	const existing = makeContact("CT-001", {
		"Name / DJ Alias": "DJ Alex"
	});

	const incoming = makeObservation({
		djReportedName: "DJ Alex"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.status, "NO_MATCH");
	assert.equal(result.decision, "UNRESOLVED");
	assert.equal(result.contactId, null);
});

// Test 4: Same station alone cannot confirm identity.
runTest("Same station only", () => {
	const existing = makeContact("CT-001", {
		"Station / Venue / Organization": "WXYZ"
	});

	const incoming = makeObservation({
		station: "WXYZ"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "UNRESOLVED");
	assert.equal(result.contactId, null);
});

// Test 5: Multiple exact matches require manual review.
runTest("Multiple exact email matches", () => {
	const contacts = [
		makeContact("CT-001", {
			Email: "dj@example.com"
		}),
		makeContact("CT-002", {
			Email: "dj@example.com"
		})
	];

	const incoming = makeObservation({
		email: "dj@example.com"
	});

	const result = resolve(incoming, contacts);

	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
	assert.equal(result.candidates.length, 2);
});

// Test 6: Exact match with another possible match needs review.
runTest("Exact match with another possible match", () => {
	const contacts = [
		makeContact("CT-001", {
			"Name / DJ Alias": "DJ Alex",
			Email: "alex@example.com"
		}),
		makeContact("CT-002", {
			"Name / DJ Alias": "DJ Alex",
			"Station / Venue / Organization": "WXYZ"
		})
	];

	const incoming = makeObservation({
		djReportedName: "DJ Alex",
		station: "WXYZ",
		email: "alex@example.com"
	});

	const result = resolve(incoming, contacts);

	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
	assert.equal(result.candidates.length, 2);
});

// Test 7: Unverified social media matches need manual review.
runTest("Unverified social media match", () => {
	const existing = makeContact("CT-001", {
		"Social Accounts": "instagram.com/djalex"
	});

	const incoming = makeObservation({
		instagram: "https://instagram.com/djalex"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
	assert.equal(
		result.candidates[0].reason,
		"SOCIAL_PROFILE_VERIFICATION_REQUIRED"
	);
});

// Test 8: Verified social profiles can establish identity.
runTest("Verified social media match", () => {
	const verifiedProfile = {
		profileUrl: "https://instagram.com/djalex",
		verificationStatus: "VERIFIED"
	};

	const existing = makeContact("CT-001", {
		"Social Accounts": "instagram.com/djalex",
		verifiedSocialProfiles: [verifiedProfile]
	});

	const incoming = makeObservation({
		socialProfiles: [verifiedProfile]
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.status, "EXACT_MATCH");
	assert.equal(result.decision, "LINK");
	assert.equal(result.contactId, "CT-001");
});

// Test 9: Different social platforms must remain separate.
runTest("Different social media platforms", () => {
	const existing = makeContact("CT-001", {
		"Social Accounts": "facebook.com/djalex"
	});

	const incoming = makeObservation({
		instagram: "instagram.com/djalex",
		soundcloud: "soundcloud.com/djalex"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "UNRESOLVED");
	assert.equal(result.socialProfiles.length, 2);

	const platforms = Array.from(
		result.socialProfiles,
		profile => profile.platform
	).sort();

	assert.deepEqual(platforms, [
		"INSTAGRAM",
		"SOUNDCLOUD"
	]);
});

// Test 10: Phone number alone is not enough.
runTest("Phone number only", () => {
	const existing = makeContact("CT-001", {
		Phone: "(614) 555-0100"
	});

	const incoming = makeObservation({
		phone: "614-555-0100"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "UNRESOLVED");
	assert.equal(result.contactId, null);
});

// Test 11: Shared office email requires manual review.
runTest("Shared office email", () => {
	const existing = makeContact("CT-001", {
		Email: "info@station.com"
	});

	const incoming = makeObservation({
		email: "info@station.com"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
});

// Test 12: Conflicting names require manual review.
runTest("Email match with conflicting names", () => {
	const existing = makeContact("CT-001", {
		"Name / DJ Alias": "DJ Alex",
		Email: "dj@example.com"
	});

	const incoming = makeObservation({
		djReportedName: "DJ Mike",
		email: "dj@example.com"
	});

	const result = resolve(incoming, [existing]);

	assert.equal(result.decision, "REVIEW");
	assert.equal(result.contactId, null);
});

// Test 13: Unknown DJ should remain unresolved.
runTest("Unknown DJ identity", () => {
	const incoming = makeObservation({
		djReportedName: "New DJ"
	});

	const result = resolve(incoming, []);

	assert.equal(result.status, "NO_MATCH");
	assert.equal(result.decision, "UNRESOLVED");
	assert.equal(result.observationId, "OBS-001");
});

// Test 14: Missing observation ID should cause an error.
runTest("Missing observation ID", () => {
	const incoming = {
		djReportedName: "DJ Alex"
	};

	assert.throws(() => {
		resolve(incoming, []);
	}, /observationId/);
});

// Test 15: Duplicate contact IDs should cause an error.
runTest("Duplicate Contact IDs", () => {
	const contacts = [
		makeContact("CT-001"),
		makeContact("CT-001")
	];

	assert.throws(() => {
		resolve(makeObservation(), contacts);
	}, /duplicate Contact ID/);
});

// Test 16: Social profiles from different platforms stay separate.
runTest("Preserve separate social profiles", () => {
	const incoming = makeObservation({
		socialProfiles: [
			"instagram.com/djalex",
			"facebook.com/djalex",
			"soundcloud.com/djalex"
		]
	});

	const result = resolve(incoming, []);

	assert.equal(result.socialProfiles.length, 3);

	const platforms = Array.from(
		result.socialProfiles,
		profile => profile.platform
	).sort();

	assert.deepEqual(platforms, [
		"FACEBOOK",
		"INSTAGRAM",
		"SOUNDCLOUD"
	]);
});

// Print the test summary.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed === 0) {
	console.log("ALL " + passed + " TESTS PASSED!");
} else {
	console.log(failed + " TESTS FAILED!");
	process.exitCode = 1;
}

