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
    const uniqueRows = [];
    const seen = new Set();

    values.forEach(row => {
      // Create a unique string representation of the row to compare
      const rowString = row.map(cell => String(cell).trim()).join("|--|");
      
      if (!seen.has(rowString)) {
        uniqueRows.push(row);
        seen.add(rowString);
      }
    });

    // --- STEP 3: UPDATE SHEET ---
    // Clear the old data (below headers) and write the unique, sorted rows back
    dataRange.clearContent();
    if (uniqueRows.length > 0) {
      sheet.getRange(2, 1, uniqueRows.length, lastCol).setValues(uniqueRows);
    }
    
    console.log(`Cleaned "${sheet.getName()}": Removed ${values.length - uniqueRows.length} duplicates.`);
  });

  console.log("Cleanup complete! All sheets sorted and duplicates removed.");
}