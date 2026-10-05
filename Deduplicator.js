/**
 * DATA CLEANER: SORT & DEDUPLICATE
 * 1. Iterates through all sheets.
 * 2. Sorts data by the first column (A-Z).
 * 3. Removes rows that are 100% identical across all columns.
 */
function cleanAndSortAllSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
  const allSheets = ss.getSheets();

  allSheets.forEach(sheet => {
    const range = sheet.getDataRange();
    if (range.isBlank()) return;

    const lastRow = range.getLastRow();
    const lastCol = range.getLastColumn();

    // Skip sheets that only have a header row or are empty
    if (lastRow <= 1) return;

    // --- STEP 1: SORT BY FIRST COLUMN ---
    // We start from row 2 to protect the header row
    const dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
    dataRange.sort({column: 1, ascending: true});

    // --- STEP 2: REMOVE DUPLICATES ---
    // This looks at the entire row content to determine if it's a duplicate
    const values = dataRange.getValues();
    const duplicateRows = [];
    const seen = new Set();

    values.forEach((row, index) => {
      // Create a unique string representation of the row to compare
      const rowString = row.map(cell => String(cell).trim()).join("|--|");
      
      if (seen.has(rowString)) {
        // +2 because data starts on spreadsheet row 2
        duplicateRows.push(index + 2);
      } else {
        seen.add(rowString);
      }
    });

    // --- STEP 3: UPDATE SHEET ---
    // Clear the old data (below headers) and write the unique, sorted rows back
    for (let i = duplicateRows.length - 1; i >= 0; i--) {
  sheet.deleteRow(duplicateRows[i]);
}

console.log(`Cleaned "${sheet.getName()}": Removed ${duplicateRows.length} duplicates.`);


    });
}