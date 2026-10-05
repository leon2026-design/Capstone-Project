const API_KEY = "AIzaSyBqW8yF5y5lQ4OdYuN_M9IsMMg1Dx5aPJY"; 
const SHEET_NAME = "Sheet1"; 

function findProgramDirectorsWithVerification() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  // 1. SETUP EXTENDED HEADERS
  const headers = ["Program Director", "Contact Info", "Source", "Confidence (1-10)", "Verification Note"];
  sheet.getRange(1, 6, 1, 5).setValues([headers]).setFontWeight("bold");

  const data = sheet.getDataRange().getValues();
  let rowsToProcess = [];
  let stationListText = "";

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && (!data[i][5] || data[i][5] === "")) {
      rowsToProcess.push({ rowNum: i + 1, station: data[i][0] });
      stationListText += `- ${data[i][0]} (${data[i][3]}, ${data[i][4]})\n`;
    }
  }

  if (rowsToProcess.length === 0) return;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  // 2. THE PROMPT & TOOL CONFIG
  const prompt = `Research the Program Directors for these iHeartRadio stations:
${stationListText}

For each station, return exactly one line in this format:
Station Name | PD Name | Contact/Socials | Source URL | Confidence Score | Verification Reason (e.g., 'Matches 2026 LinkedIn update')`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }] // THIS ENABLES REAL-TIME VERIFICATION
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  };

  const response = UrlFetchApp.fetch(url, options);
  const resObj = JSON.parse(response.getContentText());

  // 3. PARSE AND UPDATE
  if (resObj.candidates && resObj.candidates[0].content) {
    const resultText = resObj.candidates[0].content.parts[0].text.trim();
    const lines = resultText.split("\n");

    lines.forEach(line => {
      const parts = line.split("|");
      if (parts.length >= 6) {
        const stationName = parts[0].trim();
        const row = rowsToProcess.find(r => stationName.includes(r.station));
        
        if (row) {
          sheet.getRange(row.rowNum, 6).setValue(parts[1].trim()); // PD Name
          sheet.getRange(row.rowNum, 7).setValue(parts[2].trim()); // Contact
          sheet.getRange(row.rowNum, 8).setValue(parts[3].trim()); // Source
          sheet.getRange(row.rowNum, 9).setValue(parts[4].trim()); // Confidence
          sheet.getRange(row.rowNum, 10).setValue(parts[5].trim()); // Verification Note
        }
      }
    });
  }
}