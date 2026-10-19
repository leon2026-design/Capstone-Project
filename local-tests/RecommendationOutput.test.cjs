
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// TFB-74: Recommendation Sorting Tests
// Mock Google Sheets to avoid modifying real data.

let output = [];

const sheet = {
  clearContents() {
    output = [];
  },

  getRange(row) {
    return {
      setValues(values) {
        if (row === 2) {
          output = values.map(r => [...r]);
        }
        return this;
      },

      setFontWeight() {
        return this;
      }
    };
  },

  setFrozenRows() {},
  autoResizeColumns() {}
};

// Mock Google Apps Script environment.
const context = {
  SPREADSHEET_DATA_EXTRACTION: "LOCAL_TEST",

  SpreadsheetApp: {
    openById() {
      return {
        getSheetByName() {
          return sheet;
        }
      };
    }
  }
};

// Load the actual RecommendationOutput.js file.
const filePath = path.join(
  __dirname,
  "..",
  "RecommendationOutput.js"
);

const source = fs.readFileSync(filePath, "utf8");

const write = vm.runInNewContext(
  source + "\nwriteRecommendationOutput",
  context
);

// Create sample recommendation data.
function makeRec(name, score) {
  return {
    primaryArtist: "Test Artist",
    trackName: "Test Song",
    primaryGenre: "Country",
    radioStation: name,
    recommendationScore: score,
    recommendationReason: "Reason " + name,
    confidenceLevel: "High",
    contactInfo: name + "@test.com",
    sources: "Test Source"
  };
}

// TEST 1: Sort by recommendation score.
write([
  makeRec("A", 65),
  makeRec("B", 92),
  makeRec("C", 78),
  makeRec("D", 85)
]);

assert.strictEqual(
  output.map(r => r[8]).join(","),
  "92,85,78,65"
);

console.log("PASS 1: Score sorting");

// TEST 2: Generate sequential ranks.
assert.strictEqual(
  output.map(r => r[0]).join(","),
  "1,2,3,4"
);

console.log("PASS 2: Rank generation");

// TEST 3: Verify station order.
assert.strictEqual(
  output.map(r => r[5]).join(","),
  "B,D,C,A"
);

console.log("PASS 3: Station order");

// TEST 4: Preserve contact information.
assert.strictEqual(
  output.map(r => r[14]).join(","),
  "B@test.com,D@test.com,C@test.com,A@test.com"
);

console.log("PASS 4: Data integrity");

// TEST 5: Handle equal recommendation scores.
write([
  makeRec("X", 90),
  makeRec("Y", 90)
]);

assert.strictEqual(
  output.map(r => r[5]).join(","),
  "X,Y"
);

console.log("PASS 5: Equal scores");

// TEST 6: Handle empty recommendations.
write([]);

assert.strictEqual(output.length, 0);

console.log("PASS 6: Empty recommendations");

// Final result.
console.log("\nALL 6 TESTS PASSED!");
