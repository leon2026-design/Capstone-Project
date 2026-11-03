
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

//Load the actual ContactMatcher.js code.
const filePath = path.join(__dirname, "../ContactMatcher.js");
const code = fs.readFileSync(filePath, "utf8");
const context = {};

vm.runInNewContext(code, context);

const { contactMatchClassify } = context;

//Create a contact with default empty fields.
function makeContact(fields = {}) {
  return {
    "Name / DJ Alias": "",
    "Station / Venue / Organization": "",
    Email: "",
    "Social Accounts": "",
    City: "",
    "State / Region": "",
    Country: "",
    Phone: "",
    ...fields
  };
}

let passed = 0;
let failed = 0;

//Run a test and display the result.
function test(name, expected, existing, incoming) {
  try {
    const result = contactMatchClassify(existing, incoming);

    assert.equal(result.status, expected);

    console.log("PASS: " + name);
    passed++;
  } catch (error) {
    console.log("FAIL: " + name);
    console.log("  " + error.message);
    failed++;
  }
}

//Test 1: Same email with different capitalization.
test(
  "Exact email match",
  "EXACT_MATCH",
  makeContact({ Email: "John@Gmail.com" }),
  makeContact({ Email: "john@gmail.com" })
);

//Test 2: Same social media account.
test(
  "Exact social media match",
  "EXACT_MATCH",
  makeContact({ "Social Accounts": "instagram.com/john" }),
  makeContact({ "Social Accounts": "instagram.com/john" })
);

//Test 3: Same name and station, different emails.
test(
  "Same name and station",
  "POSSIBLE_MATCH",
  makeContact({
    "Name / DJ Alias": "John Smith",
    "Station / Venue / Organization": "WXYZ",
    Email: "john@gmail.com"
  }),
  makeContact({
    "Name / DJ Alias": "John Smith",
    "Station / Venue / Organization": "WXYZ",
    Email: "john@radio.com"
  })
);

//Test 4: Same name and geographic location.
test(
  "Same name and location",
  "POSSIBLE_MATCH",
  makeContact({
    "Name / DJ Alias": "John Smith",
    City: "Columbus",
    "State / Region": "Ohio"
  }),
  makeContact({
    "Name / DJ Alias": "John Smith",
    City: "Columbus",
    "State / Region": "Ohio"
  })
);

//Test 5: Phone number alone is insufficient.
test(
  "Phone number only",
  "NO_MATCH",
  makeContact({ Phone: "6141234567" }),
  makeContact({ Phone: "6141234567" })
);

//Test 6: Same email but conflicting names.
test(
  "Email match with name conflict",
  "POSSIBLE_MATCH",
  makeContact({
    "Name / DJ Alias": "John Smith",
    Email: "shared@radio.com"
  }),
  makeContact({
    "Name / DJ Alias": "Mike Brown",
    Email: "shared@radio.com"
  })
);

//Test 7: Completely different contacts.
test(
  "Different individuals",
  "NO_MATCH",
  makeContact({
    "Name / DJ Alias": "John Smith",
    Email: "john@gmail.com"
  }),
  makeContact({
    "Name / DJ Alias": "Mike Brown",
    Email: "mike@gmail.com"
  })
);

//Test 8: Multiple emails belonging to one contact.
test(
  "Multiple email addresses",
  "EXACT_MATCH",
  makeContact({
    Email: "john@gmail.com\njohn@radio.com"
  }),
  makeContact({
    Email: "JOHN@RADIO.COM"
  })
);

//Test 9: Similar names at the same radio station.
test(
	"Nickname match with same station",
	"POSSIBLE_MATCH",
	makeContact({
		"Name / DJ Alias": "Michael Johnson",
		"Station / Venue / Organization": "WXYZ",
		Email: "michael@radio.example"
	}),
	makeContact({
		"Name / DJ Alias": "Mike Johnson",
		"Station / Venue / Organization": "WXYZ",
		Email: "mjohnson@radio.example"
	})
);

//Test 10: Same name without other matching evidence.
test(
	"Same name only",
	"NO_MATCH",
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john1@gmail.com"
	}),
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john2@gmail.com"
	})
);


//Test match score calculations.
function testScore(name, expectedScore, existing, incoming) {
	try {
		const result = contactMatchClassify(existing, incoming);

		assert.equal(result.matchScore, expectedScore);

		console.log("PASS: " + name);
		passed++;
	} catch (error) {
		console.log("FAIL: " + name);
		console.log("  " + error.message);
		failed++;
	}
}

//Test 11: Email + Name and Station + Phone = 90.
testScore(
	"Match score with multiple fields",
	90,
	makeContact({
		"Name / DJ Alias": "John Smith",
		"Station / Venue / Organization": "WXYZ",
		Email: "john@gmail.com",
		Phone: "6141234567"
	}),
	makeContact({
		"Name / DJ Alias": "John Smith",
		"Station / Venue / Organization": "WXYZ",
		Email: "JOHN@GMAIL.COM",
		Phone: "6141234567"
	})
);

//Test 12: Nickname + Station = 30.
testScore(
	"Nickname match score",
	30,
	makeContact({
		"Name / DJ Alias": "Michael Johnson",
		"Station / Venue / Organization": "WXYZ"
	}),
	makeContact({
		"Name / DJ Alias": "Mike Johnson",
		"Station / Venue / Organization": "WXYZ"
	})
);

//Test 13: Phone only = 10.
testScore(
	"Phone only match score",
	10,
	makeContact({
		Phone: "6141234567"
	}),
	makeContact({
		Phone: "6141234567"
	})
);


//Test 14: Same email with conflicting phone numbers.
test(
	"Email match with phone conflict",
	"POSSIBLE_MATCH",
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john@gmail.com",
		Phone: "6141234567"
	}),
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john@gmail.com",
		Phone: "6149998888"
	})
);

//Test 15: Same phone number with different formatting.
test(
	"Phone number formatting",
	"EXACT_MATCH",
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john.smith@example.com",
		Phone: "(614) 123-4567"
	}),
	makeContact({
		"Name / DJ Alias": "John Smith",
		Email: "john.smith@example.com",
		Phone: "6141234567"
	})
);

//Test 16: Same social account with different URL formatting.
test(
	"Social account URL formatting",
	"EXACT_MATCH",
	makeContact({
		"Name / DJ Alias": "John Smith",
		"Social Accounts": "https://www.instagram.com/djexample/"
	}),
	makeContact({
		"Name / DJ Alias": "John Smith",
		"Social Accounts": "instagram.com/djexample"
	})
);


//Test 17: A shared office email should require human review.
test(
	"Shared office email",
	"POSSIBLE_MATCH",
	makeContact({
		"Name / DJ Alias": "John Smith",
		"Station / Venue / Organization": "WXYZ",
		Email: "info@wxyz.com"
	}),
	makeContact({
		"Station / Venue / Organization": "WXYZ",
		Email: "info@wxyz.com"
	})
);



//Print the test summary.
console.log("\n========== TEST RESULTS ==========");
console.log("Passed: " + passed);
console.log("Failed: " + failed);

if (failed > 0) {
  process.exitCode = 1;
}
