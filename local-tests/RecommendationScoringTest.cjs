const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load your Apps Script code.
const code = fs.readFileSync(
  path.join(__dirname, "..", "RecommendationScoring.js"),
  "utf8"
);

// Run the code, then call its demo function.
vm.runInNewContext(
  code + "\ndemoPhase1Recommendations();",
  { console }
);