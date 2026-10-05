/** Build the normalized alias lookup and reject conflicting definitions. */
function buildHeaderAliasLookup() {
  const lookup = new Map();

  Object.keys(HEADER_ALIASES).forEach(field => {
    if (!STANDARDIZED_HEADERS.includes(field)) {
      throw new Error(
        'Unknown standard header in HEADER_ALIASES: ' + field
      );
    }
  });

  STANDARDIZED_HEADERS.forEach(field => {
    [field, ...(HEADER_ALIASES[field] || [])].forEach(alias => {
      const key = normalizeKey(alias);

      if (!key || (lookup.has(key) && lookup.get(key) !== field)) {
        throw new Error('Empty or conflicting header alias: ' + alias);
      }

      lookup.set(key, field);
    });
  });

  COMBINED_NAME_ALIASES.forEach(alias => {
    if (lookup.has(normalizeKey(alias))) {
      throw new Error(
        'Combined name conflicts with a field alias: ' + alias
      );
    }
  });

  return lookup;
}

// Ignore capitalization, whitespace, and punctuation in header names.
function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Return {sourceIdx, targetField, isCombinedName} objects. */
function getDeterministicHeaderMapping(
  sourceHeaders,
  targetFields,
  lookup
) {
  lookup = lookup || buildHeaderAliasLookup();

  // Preserve requested output labels, such as "email"
  // instead of changing the destination label to "Email Address".
  const targets = new Map();

  targetFields.forEach(field => {
    const key = normalizeKey(
      lookup.get(normalizeKey(field)) || field
    );

    if (key && !targets.has(key)) {
      targets.set(key, field);
    }
  });

  const combinedNames = new Set(
    COMBINED_NAME_ALIASES.map(normalizeKey)
  );

  const canSplit =
    targets.has('firstname') && targets.has('lastname');

  const ranked = [];

  // Find the matching destination field for each source column.
  sourceHeaders.forEach((header, sourceIdx) => {
    const key = normalizeKey(header);
    if (!key) return;

    if (canSplit && combinedNames.has(key)) {
      ranked.push({
        sourceIdx,
        targetField: targets.get('firstname'),
        isCombinedName: true,
        priority: 0
      });
      return;
    }

    const canonical = lookup.get(key);
    const targetField = targets.get(
      normalizeKey(canonical || header)
    );

    if (targetField) {
      ranked.push({
        sourceIdx,
        targetField,
        isCombinedName: false,
        priority:
          canonical && key === normalizeKey(canonical) ? 2 : 1
      });
    }
  });

  // Combined names first, aliases next, standard headers last.
  // Later nonempty values take precedence during consolidation.
  // For equal-priority columns, the leftmost nonempty value wins.
  return ranked
    .sort(
      (a, b) =>
        a.priority - b.priority || b.sourceIdx - a.sourceIdx
    )
    .map(({ priority, ...mapping }) => mapping);
}

function consolidateFieldData() {
  const lookup = buildHeaderAliasLookup();
  const ss = SpreadsheetApp.openById(
    SPREADSHEET_DATA_EXTRACTION
  );

  const combinedNames = new Set(
    COMBINED_NAME_ALIASES.map(normalizeKey)
  );

  // Read each source sheet once.
  // Exclude master lists and Sheet1, as the existing function did.
  const sources = ss.getSheets()
    .filter(sheet =>
      !FIELDS_TO_MAKE_SHEETS_OF.includes(sheet.getName()) &&
      sheet.getName() !== 'Sheet1'
    )
    .map(sheet => {
      const values = sheet.getDataRange().getValues();
      const headers = (values[0] || []).map(String);

      const unknown = headers.filter(header => {
        const key = normalizeKey(header);
        return key &&
          !lookup.has(key) &&
          !combinedNames.has(key);
      });

      if (unknown.length) {
        console.warn(
          'Review report-specific headers in ' +
          sheet.getName() + ': ' + unknown.join(', ')
        );
      }

      return {
        headers,
        rows: values.slice(1)
      };
    });

  // Collect all output data before changing any destination.
  const outputs = FIELDS_TO_MAKE_SHEETS_OF.map(sheetName => {
    const fields = sheetName
      .split(/,|\s+and\s+/i)
      .flatMap(part => {
        const field = part.trim();
        if (!field) return [];

        return normalizeKey(field) === 'name'
          ? ['First Name', 'Last Name']
          : [field];
      });

    const headers = [...new Set(fields)];
    const keys = headers.map(normalizeKey);

    const firstField = headers.find(field =>
      lookup.get(normalizeKey(field)) === 'First Name'
    );

    const lastField = headers.find(field =>
      lookup.get(normalizeKey(field)) === 'Last Name'
    );

    const rows = [];

    sources.forEach(source => {
      const mapping = getDeterministicHeaderMapping(
        source.headers,
        headers,
        lookup
      );

      source.rows.forEach(sourceRow => {
        const values = new Map();

        mapping.forEach(map => {
          const value = String(
            sourceRow[map.sourceIdx] ?? ''
          ).trim();

          // Skip empty cells without discarding numeric zero.
          if (!value) return;

          if (map.isCombinedName) {
            const parts = value.split(/\s+/);

            values.set(
              normalizeKey(firstField),
              parts[0]
            );

            values.set(
              normalizeKey(lastField),
              parts.slice(1).join(' ')
            );
          } else {
            values.set(
              normalizeKey(map.targetField),
              value
            );
          }
        });

        const row = keys.map(key => values.get(key) ?? '');

        if (row.some(value => value !== '')) {
          rows.push(row);
        }
      });
    });

    return { sheetName, headers, rows };
  });

  outputs.forEach(({ sheetName, headers, rows }) => {
    if (!rows.length) {
      console.warn(
        'No mapped rows for ' + sheetName +
        '; existing output was kept.'
      );
      return;
    }

    const sheet =
      ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

    const matrix = [headers, ...rows];
    const oldRows = sheet.getLastRow();
    const oldCols = sheet.getLastColumn();

    // Expand the destination if the new output is larger.
    if (sheet.getMaxRows() < matrix.length) {
      sheet.insertRowsAfter(
        sheet.getMaxRows(),
        matrix.length - sheet.getMaxRows()
      );
    }

    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(
        sheet.getMaxColumns(),
        headers.length - sheet.getMaxColumns()
      );
    }

    // Write before clearing leftover cells from the previous output.
    sheet.getRange(
      1, 1, matrix.length, headers.length
    ).setValues(matrix);

    if (oldRows > matrix.length) {
      sheet.getRange(
        matrix.length + 1,
        1,
        oldRows - matrix.length,
        oldCols
      ).clearContent();
    }

    if (oldCols > headers.length) {
      sheet.getRange(
        1,
        headers.length + 1,
        matrix.length,
        oldCols - headers.length
      ).clearContent();
    }

    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f3f3f3');

    sheet.autoResizeColumns(1, headers.length);
    sheet.setFrozenRows(1);
  });
}