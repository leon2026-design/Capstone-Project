/**
 * DATA CLEANER: SORT & DEDUPLICATE
 *
 * 1. Sorts data by the first column (A-Z).
 * 2. Removes rows that are 100% identical across all columns.
 * 3. Preserves formulas by deleting duplicate rows directly
 *    instead of clearing and rewriting the sheet.
 */


/**
 * Clean and sort ONE sheet.
 * This helper is also used by the regression tests.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 *        The sheet to clean and sort.
 */
function cleanAndSortSheet(sheet) {
  const range = sheet.getDataRange();

  // Skip completely blank sheets.
  if (range.isBlank()) {
    return;
  }

  const lastRow = range.getLastRow();
  const lastCol = range.getLastColumn();

  // Skip sheets that only contain a header row.
  if (lastRow <= 1) {
    return;
  }

  // --------------------------------------------------
  // STEP 1: SORT BY FIRST COLUMN
  // --------------------------------------------------

  // Start from row 2 so the header row is protected.
  const dataRange = sheet.getRange(
    2,
    1,
    lastRow - 1,
    lastCol
  );

  dataRange.sort({
    column: 1,
    ascending: true
  });

  // --------------------------------------------------
  // STEP 2: FIND DUPLICATE ROWS
  // --------------------------------------------------

  const values = dataRange.getValues();

  const duplicateRows = [];
  const seen = new Set();

  values.forEach((row, index) => {
    // Create a normalized string representation
    // of the complete row.
    const rowString = row
      .map(cell => String(cell).trim())
      .join("|--|");

    if (seen.has(rowString)) {
      // +2 because index 0 corresponds to spreadsheet row 2.
      duplicateRows.push(index + 2);
    } else {
      seen.add(rowString);
    }
  });

  // --------------------------------------------------
  // STEP 3: DELETE DUPLICATE ROWS
  // --------------------------------------------------

  // Delete from bottom to top so row numbers do not shift.
  for (let i = duplicateRows.length - 1; i >= 0; i--) {
    sheet.deleteRow(duplicateRows[i]);
  }

  console.log(
    `Cleaned "${sheet.getName()}": Removed ${duplicateRows.length} duplicates.`
  );
}


/**
 * Clean and sort ALL sheets in the production spreadsheet.
 */
function cleanAndSortAllSheets() {
  const ss = SpreadsheetApp.openById(
    SPREADSHEET_DATA_EXTRACTION
  );

  const allSheets = ss.getSheets();

  allSheets.forEach(sheet => {
    cleanAndSortSheet(sheet);
  });
}