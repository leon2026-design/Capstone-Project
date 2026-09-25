/**
 * @fileoverview AI-Driven Spreadsheet Header Synchronizer 
 * 
 * @description Standardizes Google Sheet structures by using Gemini to intelligently 
 * map, rename, and split data columns (Names, Locations, etc.) across multiple tabs.
 * 
 * @param {string} SPREADSHEET_DATA_EXTRACTION The ID of the target Google Sheet.
 * @param {string} API_KEY Your Google AI Studio API Key.
 * @param {Array<string>} STANDARDIZED_HEADERS The target list of desired header names.
 * 
 * * @features
 * - Intelligent Header Mapping: Matches synonyms (e.g., "Phone #" to "Phone Number").
 * - Structural Splitting: Breaks "Full Name" into First/Last or "Location" into State/Country.
 * - Idempotency: Prevents "double-processing" by skipping already standardized columns.
 * - Performance: Uses local logic for simple splits to conserve API quota.
 */
function standardizeAndSplitHeaders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
  const sheets = ss.getSheets();
  
  sheets.forEach(sheet => {
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return;

    const headerRange = sheet.getRange(1, 1, 1, lastCol); 
    const currentHeaders = headerRange.getValues()[0];
    
    if (!currentHeaders || currentHeaders.length === 0) return;
    
    Logger.log(`--- Processing sheet: ${sheet.getName()} ---`);
    
    // 1. Get instructions. We pass the standard list so Gemini knows what NOT to change.
    const instructions = getGeminiInstructions(currentHeaders, STANDARDIZED_HEADERS);
    
    if (instructions) {
      // 2. Process right-to-left to keep column indices stable during insertions
      for (let i = currentHeaders.length - 1; i >= 0; i--) {
        const oldHeader = currentHeaders[i];
        
        // PROTECTION: If this column is already standardized, skip it!
        if (STANDARDIZED_HEADERS.includes(oldHeader)) {
           Logger.log(`Skipping "${oldHeader}" - already standard.`);
           continue;
        }

        const task = instructions[oldHeader];
        if (!task) continue;

        const colIndex = i + 1;
        Logger.log(`Action for "${oldHeader}": ${task.action}`);

        if (task.action === "split") {
          splitNameColumn(sheet, colIndex, task.renameTo);
        } else if (task.action === "splitLocation") {
          splitLocationColumn(sheet, colIndex, task.renameTo);
        } else if (task.action === "rename") {
          sheet.getRange(1, colIndex).setValue(task.renameTo);
        }
      }
      
      boldAndFreezeHeaders(sheet);
      Logger.log(`Finished ${sheet.getName()}`);
    }
  });
}

/**
 * Gemini Instructions Logic
 */
function getGeminiInstructions(currentHeaders, standardList) {
  const prompt = `
    Target Standard Headers: [${standardList.join(", ")}]
    Current Sheet Headers: [${currentHeaders.join(", ")}]

    Task: Create a JSON mapping for how to transform Current Headers into Target Headers.
    
    Rules:
    1. If a header is ALREADY in the Target list (e.g., "State"), DO NOT include it in the JSON.
    2. "Name" or "Full Name" -> {"action": "split", "renameTo": ["First Name", "Last Name"]}
    3. "Location", "State/Region", "Place" -> {"action": "splitLocation", "renameTo": ["State", "Country"]}
    4. Synonyms (e.g., "Mail" to "Email") -> {"action": "rename", "renameTo": "Standard Name"}

    Return ONLY a JSON object where keys are the Current Headers. Example:
    {"Full Name": {"action": "split", "renameTo": ["First Name", "Last Name"]}}
  `;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 }
  };

  try {
    const response = UrlFetchApp.fetch(GEMINI_URL, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    const resText = response.getContentText();
    const json = JSON.parse(resText);

    if (json.error) {
      Logger.log(`API Error: ${json.error.message}`);
      return null;
    }

    const rawText = json.candidates[0].content.parts[0].text;
    return JSON.parse(cleanJsonString(rawText));
  } catch (e) {
    Logger.log("Instruction Parsing Error: " + e.toString());
    return null;
  }
}

/**
 * Splits Location strings (e.g., "Ohio, USA") into two columns.
 */
function splitLocationColumn(sheet, colIndex, newHeaderNames) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  sheet.insertColumnAfter(colIndex);
  const dataRange = sheet.getRange(2, colIndex, lastRow - 1, 1);
  const rawValues = dataRange.getValues().flat();
  
  const prompt = `
    Split these locations into "state" and "country": [${rawValues.join(" | ")}].
    Return a JSON array of objects: [{"state": "...", "country": "..."}, ...].
    If only a country is found, leave state blank. If only a state, leave country blank.
    Return ONLY JSON.
  `;

  try {
    const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } };
    const response = UrlFetchApp.fetch(GEMINI_URL, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    const json = JSON.parse(response.getContentText());
    const rawText = json.candidates[0].content.parts[0].text;
    const results = JSON.parse(cleanJsonString(rawText));
    
    const stateValues = results.map(r => [r.state || ""]);
    const countryValues = results.map(r => [r.country || ""]);

    sheet.getRange(2, colIndex, stateValues.length, 1).setValues(stateValues);
    sheet.getRange(2, colIndex + 1, countryValues.length, 1).setValues(countryValues);
    
    sheet.getRange(1, colIndex).setValue(newHeaderNames[0]); // Usually "State"
    sheet.getRange(1, colIndex + 1).setValue(newHeaderNames[1]); // Usually "Country"
  } catch (e) {
    Logger.log("SplitLocation Error: " + e.toString());
  }
}

/**
 * Basic Name Split (No AI needed for simple space splits, saves quota)
 */
function splitNameColumn(sheet, colIndex, newHeaderNames) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return; 
  sheet.insertColumnAfter(colIndex);
  const values = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  
  const firstNames = [];
  const lastNames = [];

  values.forEach(row => {
    const full = String(row[0] || "").trim();
    const parts = full.split(" ");
    if (parts.length > 1) {
      firstNames.push([parts[0]]);
      lastNames.push([parts.slice(1).join(" ")]);
    } else {
      firstNames.push([full]);
      lastNames.push([""]);
    }
  });

  sheet.getRange(2, colIndex, firstNames.length, 1).setValues(firstNames);
  sheet.getRange(2, colIndex + 1, lastNames.length, 1).setValues(lastNames);
  sheet.getRange(1, colIndex).setValue(newHeaderNames[0]); 
  sheet.getRange(1, colIndex + 1).setValue(newHeaderNames[1]); 
}

/**
 * Helpers
 */
function cleanJsonString(str) {
  return str.replace(/```json/g, "").replace(/```/g, "").trim();
}

function boldAndFreezeHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol > 0) {
    sheet.getRange(1, 1, 1, lastCol).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
}