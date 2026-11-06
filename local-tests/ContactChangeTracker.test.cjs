const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load ContactChangeTracker.js.
const filePath = path.join(__dirname, "../ContactChangeTracker.js");
const code = fs.readFileSync(filePath, "utf8");

const context = {};
vm.runInNewContext(code, context);

const compareValue = context.contactChangeCompareValue;
const detectChanges = context.contactChangeDetectChanges;

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

//Test 1: Identical values should be unchanged.
test("Unchanged contact value", () => {
	const result = compareValue("John Smith", "John Smith");

	assert.equal(result, "UNCHANGED");
});

//Test 2: New information for an empty field.
test("Newly populated field", () => {
	const result = compareValue("", "6141234567");

	assert.equal(result, "NEWLY_POPULATED");
});

//Test 3: Different values should be flagged.
test("Conflicting contact value", () => {
	const result = compareValue(
		"john@gmail.com",
		"john@radio.com"
	);

	assert.equal(result, "CONFLICTING");
});

//Test 4: Empty incoming values should not replace data.
test("Ignore empty incoming value", () => {
	const result = compareValue("John Smith", "");

	assert.equal(result, "UNCHANGED");
});

//Test 5: Detect multiple contact changes.
test("Detect multiple field changes", () => {
	const existing = {
		"Name / DJ Alias": "John Smith",
		Email: "john@gmail.com",
		Phone: "",
		City: "Columbus"
	};

	const incoming = {
		"Name / DJ Alias": "John Smith",
		Email: "john@radio.com",
		Phone: "6141234567",
		City: "Columbus"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 2);

	assert.equal(changes[0].field, "Email");
	assert.equal(changes[0].changeType, "CONFLICTING");

	assert.equal(changes[1].field, "Phone");
	assert.equal(changes[1].changeType, "NEWLY_POPULATED");
});

//Test 6: Detect changes without modifying original data.
test("Preserve original contact data", () => {
	const existing = {
		Email: "john@gmail.com"
	};

	const incoming = {
		Email: "john@radio.com"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(existing.Email, "john@gmail.com");
	assert.equal(incoming.Email, "john@radio.com");
	assert.equal(changes[0].previousValue, "john@gmail.com");
	assert.equal(changes[0].proposedValue, "john@radio.com");
});


//Test 7: Different formatting should not count as a change.
test("Ignore formatting differences", () => {
	const existing = {
		Email: "John@Gmail.com",
		Phone: "(614) 123-4567"
	};

	const incoming = {
		Email: "john@gmail.com",
		Phone: "6141234567"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 0);
});


//Test 8: An existing email should not be treated as a change.
test("Multiple email addresses", () => {
	const existing = {
		Email: "john@gmail.com\njohn@radio.com"
	};

	const incoming = {
		Email: "john@radio.com"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 0);
});

//Test 9: Existing social accounts should not be treated as changes.
test("Multiple social accounts", () => {
	const existing = {
		"Social Accounts": "instagram.com/djexample\nfacebook.com/djexample"
	};

	const incoming = {
		"Social Accounts": "https://www.instagram.com/djexample/"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 0);
});

//Test 10: Existing phone numbers should not be treated as changes.
test("Multiple phone numbers", () => {
	const existing = {
		Phone: "6141234567\n7405558888"
	};

	const incoming = {
		Phone: "(614) 123-4567"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 0);
});

//Test 11: A different station may indicate outdated information.
test("Potentially outdated station", () => {
	const existing = {
		"Name / DJ Alias": "John Smith",
		"Station / Venue / Organization": "WXYZ"
	};

	const incoming = {
		"Name / DJ Alias": "John Smith",
		"Station / Venue / Organization": "KABC"
	};

	const changes = detectChanges(existing, incoming);

	assert.equal(changes.length, 1);
	assert.equal(changes[0].field, "Station / Venue / Organization");
	assert.equal(changes[0].changeType, "POTENTIALLY_OUTDATED");
	assert.equal(changes[0].previousValue, "WXYZ");
	assert.equal(changes[0].proposedValue, "KABC");

	//Keep the original station information.
	assert.equal(existing["Station / Venue / Organization"], "WXYZ");
});

//Print the test summary.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
	process.exitCode = 1;
}
