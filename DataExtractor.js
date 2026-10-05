/**
 * AI-POWERED DATA CONSOLIDATOR (FLAT LIST)
 * Features:
 * 1. No Deduplication: Every row from every source is preserved.
 * 2. Field Mapping: Uses AI to ensure "FName" and "First Name" land in the same column.
 * 3. Individual Entries: Treats every row as a unique entity.
 */

function consolidateFieldData() {
  const ss = SpreadsheetApp.openById(requireScriptProperty("SPREADSHEET_DATA_EXTRACTION", SPREADSHEET_DATA_EXTRACTION));
  const allSheets = ss.getSheets();

  FIELDS_TO_MAKE_SHEETS_OF.forEach(fieldEntry => {
    let destSheet = ss.getSheetByName(fieldEntry) || ss.insertSheet(fieldEntry);
    destSheet.clear(); 

    // 1. Prepare Headers
    let requestedParts = [];
    fieldEntry.split(/,|and/).forEach(p => {
      const trimmed = p.trim();
      if (trimmed.toLowerCase() === "name") {
        requestedParts.push("First Name", "Last Name");
      } else if (trimmed) {
        requestedParts.push(trimmed);
      }
    });

    const displayHeaders = [...new Set(requestedParts)];
    const normalizedHeaderKeys = displayHeaders.map(h => normalizeKey(h));
    
    // 2. DATA COLLECTION: A simple array to hold every single row
    const allCollectedRows = [];

    allSheets.forEach(sourceSheet => {
      const sourceName = sourceSheet.getName();
      // Skip the destination sheets and the main overview sheet
      if (FIELDS_TO_MAKE_SHEETS_OF.includes(sourceName) || sourceName === "Sheet1") return;

      const sourceRange = sourceSheet.getDataRange();
      if (sourceRange.isBlank()) return;

      const sourceData = sourceRange.getValues();
      const sourceHeaders = sourceData[0].map(String);
      const sourceRows = sourceData.slice(1);

      // Map source columns to our target headers
      let aiMapping = getGeminiHeaderMapping(sourceHeaders, requestedParts) || 
                      fallbackMatching(sourceHeaders, requestedParts);

      sourceRows.forEach(row => {
        const rowData = {};
        let hasData = false;

        aiMapping.forEach(map => {
          let val = String(row[map.sourceIdx] || "").trim();
          if (!val) return;
          hasData = true;

          if (map.isCombinedName) {
            const parts = val.split(/\s+/);
            rowData[normalizeKey("First Name")] = parts[0] || "";
            rowData[normalizeKey("Last Name")] = parts.length > 1 ? parts.slice(1).join(" ") : "";
          } else {
            rowData[normalizeKey(map.targetField)] = val;
          }
        });

        // If the row isn't empty, add it to our master list
        if (hasData) {
          allCollectedRows.push(rowData);
        }
      });
    });

    // 3. BATCH WRITE
    const finalRows = allCollectedRows.map(obj => {
      return normalizedHeaderKeys.map(key => obj[key] || "");
    });

    if (displayHeaders.length > 0 && finalRows.length > 0) {
      const outputMatrix = [displayHeaders, ...finalRows];
      destSheet.getRange(1, 1, outputMatrix.length, displayHeaders.length).setValues(outputMatrix);
      
      // Formatting
      destSheet.getRange(1, 1, 1, displayHeaders.length).setFontWeight("bold").setBackground("#f3f3f3");
      destSheet.autoResizeColumns(1, displayHeaders.length);
      destSheet.setFrozenRows(1);
    }
  });
}

/**
 * AI Mapping & Fallback functions remain the same to ensure 
 * data lands in the correct columns regardless of source header naming.
 */
function getGeminiHeaderMapping(sourceHeaders, targetFields) {
  const prompt = `Map these source headers: [${sourceHeaders.join(", ")}] to these target fields: [${targetFields.join(", ")}]. 
  Instructions:
  - If source is "Name" and target has "First Name" and "Last Name", set isCombinedName to true.
  - Recognize that snake_case, jammed case, or abbreviations match.
  - Return JSON array ONLY: [{"sourceIdx": number, "targetField": string, "isCombinedName": boolean}].`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  try {
    const response = trackedFetch("Gemini", GEMINI_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    const resText = JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
    return JSON.parse(resText);
  } catch (e) { 
    console.error("AI Mapping failed, using fallback."); 
    return null;
  }
}

function fallbackMatching(sourceHeaders, targetFields) {
  const mapping = [];
  sourceHeaders.forEach((h, idx) => {
    const hNorm = normalizeKey(h);
    targetFields.forEach(tf => {
      const tfNorm = normalizeKey(tf);
      if (hNorm.includes(tfNorm) || tfNorm.includes(hNorm)) {
        mapping.push({ sourceIdx: idx, targetField: tf, isCombinedName: false });
      }
    });
  });
  return mapping;
}

function normalizeKey(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}