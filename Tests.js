// //function testSplitNameColumn() {
//   const ss = SpreadsheetApp.openById(
//     PropertiesService.getScriptProperties().getProperty("TEST_SPREADSHEET_ID")
//   );
//   const sheet = ss.getSheetByName("Sheet1");

//   splitNameColumn(
//     sheet,
//     1,
//     ["First Name", "Last Name"]
//   );
// }

// function testNormalizeKey() {
//   const tests = [
//     "Email Address",
//     "E-mail",
//     "email_address",
//     "Phone #",
//     "Track Name",
//     "Music Genre",
//     "First Name"
//   ];

//   tests.forEach(value => {
//     console.log(`${value} -> ${normalizeKey(value)}`);
//   });
// }

// function testFallbackMatching() {
//   const sourceHeaders = [
//     "Email Address",
//     "Phone Number",
//     "Track Name",
//     "Music Genre",
//     "Comments"
//   ];

//   const targetFields = [
//     "Email Address",
//     "Phone Number",
//     "Track Name",
//     "Music Genre",
//     "Comments"
//   ];

//   const result = fallbackMatching(sourceHeaders, targetFields);

//   console.log(JSON.stringify(result, null, 2));
// }

// function testFallbackMatchingMessy() {
//   const sourceHeaders = [
//     "E-mail",
//     "Phone #",
//     "Track",
//     "Genre",
//     "Feedback"
//   ];

//   const targetFields = [
//     "Email Address",
//     "Phone Number",
//     "Track Name",
//     "Music Genre",
//     "Comments"
//   ];

//   const result = fallbackMatching(sourceHeaders, targetFields);

//   console.log(JSON.stringify(result, null, 2));
// }

// function testMusicBrainzLookup() {
//   const result = fetchMusicBrainzData(
//     "USUM71703861",
//     "capstone2026group@gmail.com"
//   );

//   console.log(JSON.stringify(result, null, 2));
// }
function runScriptsNoAI() {
  processNewPDFs();
  processISRCMusicMetadata();
  cleanAndSortAllSheets();
}


/**
 *  Unit tests for ISRC normalization and validation.
 *
 * To run locally, run:
 *
 * node -e "const fs = require('fs'); const vm = require('vm'); const code = fs.readFileSync('ISRCMusicBrainzExtractor.js', 'utf8') + '\n' + fs.readFileSync('Tests.js', 'utf8'); vm.runInNewContext(code + '\ntestNormalizeISRC();', { console });"
 *
 * Expected result: 9 PASS messages and
 * "All ISRC normalization tests passed."
 *
 *
 */
function testNormalizeISRC() {
  const tests = [
    ["USUM71703861", "USUM71703861"],
    ["usum71703861", "USUM71703861"],
    ["US-UM7-17-03861", "USUM71703861"],
    [" USUM71703861 ", "USUM71703861"],
    ["INVALID-ISRC", null],
    ["", null],
    [null, null],
    ["USUM7170386", null],
    ["USUM717038611", null]
  ];

  tests.forEach(([input, expected]) => {
    const actual = normalizeISRC(input);

    if (actual !== expected) {
      throw new Error(
        `FAILED for ${input}: expected ${expected}, got ${actual}`
      );
    }

    console.log(`PASS: ${input} -> ${actual}`);
  });

  console.log("All ISRC normalization tests passed.");
}