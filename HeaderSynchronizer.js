/** Standardize known headers and simple person names without Gemini. */
function standardizeAndSplitHeaders() {
  const lookup = buildHeaderAliasLookup();

  const combinedNames = new Set(
    COMBINED_NAME_ALIASES.map(normalizeKey)
  );

  const ss = SpreadsheetApp.openById(
    SPREADSHEET_DATA_EXTRACTION
  );

  ss.getSheets().forEach(sheet => {
    const columnCount = sheet.getLastColumn();
    if (!columnCount) return;

    const headers = sheet.getRange(
      1, 1, 1, columnCount
    ).getValues()[0];

    const counts = new Map();
    let combinedCount = 0;

    // Detect columns that already represent the same field.
    headers.forEach(header => {
      const key = normalizeKey(header);
      const canonical = lookup.get(key);

      if (canonical) {
        counts.set(
          canonical,
          (counts.get(canonical) || 0) + 1
        );
      }

      if (combinedNames.has(key)) {
        combinedCount++;
      }
    });

    // Work right to left so inserted columns don't shift pending work.
    for (let i = headers.length - 1; i >= 0; i--) {
      const header = String(headers[i]);
      const key = normalizeKey(header);
      if (!key) continue;

      const canonical = lookup.get(key);

      if (canonical) {
        if (canonical === header) continue;

        // Preserve both columns if multiple columns represent one field.
        if (counts.get(canonical) > 1) {
          console.warn(
            'Kept duplicate field ' + header +
            ' in ' + sheet.getName()
          );
          continue;
        }

        sheet.getRange(1, i + 1).setValue(canonical);

      } else if (combinedNames.has(key)) {
        // Avoid creating a second First Name or Last Name column.
        if (
          combinedCount === 1 &&
          !counts.has('First Name') &&
          !counts.has('Last Name')
        ) {
          splitNameColumn(
            sheet,
            i + 1,
            ['First Name', 'Last Name']
          );
        } else {
          console.warn(
            'Kept combined name column ' + header +
            ' in ' + sheet.getName()
          );
        }

      } else {
        // Keep unfamiliar and combined-location columns intact.
        console.warn(
          'Review header ' + header +
          ' in ' + sheet.getName()
        );
      }
    }

    boldAndFreezeHeaders(sheet);
  });
}

// Preserve the existing first-word/rest-of-name rule.
// A single-word name gets an empty Last Name.
function splitNameColumn(sheet, colIndex, newHeaderNames) {
  const rowCount = Math.max(0, sheet.getLastRow() - 1);

  const rows = rowCount
    ? sheet.getRange(2, colIndex, rowCount, 1).getValues()
    : [];

  const splitRows = rows.map(([value]) => {
    const parts = String(value ?? '').trim().split(/\s+/);

    return [
      parts[0],
      parts.slice(1).join(' ')
    ];
  });

  sheet.insertColumnAfter(colIndex);

  sheet.getRange(
    1, colIndex, 1, 2
  ).setValues([newHeaderNames]);

  if (splitRows.length) {
    sheet.getRange(
      2, colIndex, splitRows.length, 2
    ).setValues(splitRows);
  }
}

function boldAndFreezeHeaders(sheet) {
  const columns = sheet.getLastColumn();

  if (columns) {
    sheet.getRange(
      1, 1, 1, columns
    ).setFontWeight('bold');

    sheet.setFrozenRows(1);
  }
}