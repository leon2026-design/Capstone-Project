// //function testSplitNameColumn() {
//   const ss = SpreadsheetApp.openById("1NtbEGwKM7-Xp34i4mmcpg3YXxstt8iIthNJbzMSe7zE");
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