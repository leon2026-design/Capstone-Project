const SHEET_NAME = "Sheet1";

function findProgramDirectorsWithVerification() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
  const sheet = ss.getSheetByName(SHEET_NAME);

  const apiKey =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from Script Properties.");
  }

  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" was not found.`);
  }

  // 1. SETUP EXTENDED HEADERS
  const headers = [
    "Program Director",
    "Contact Info",
    "Source",
    "Confidence (1-10)",
    "Verification Note"
  ];

  sheet
    .getRange(1, 6, 1, 5)
    .setValues([headers])
    .setFontWeight("bold");

  const data = sheet.getDataRange().getValues();

  let rowsToProcess = [];
  let stationListText = "";

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && (!data[i][5] || data[i][5] === "")) {
      rowsToProcess.push({
        rowNum: i + 1,
        station: data[i][0]
      });

      stationListText +=
        `- ${data[i][0]} (${data[i][3]}, ${data[i][4]})\n`;
    }
  }

  if (rowsToProcess.length === 0) return;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  // 2. PROMPT & GOOGLE SEARCH TOOL
  const prompt = `Research the Program Directors for these iHeartRadio stations:
${stationListText}

For each station, return exactly one line in this format:
Station Name | PD Name | Contact/Socials | Source URL | Confidence Score | Verification Reason`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    tools: [
      {
        googleSearch: {}
      }
    ]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response =
    trackedFetch("Gemini + Google Search", url, options);

  const resObj = JSON.parse(response.getContentText());

  if (resObj.error) {
    console.error("Gemini API Error: " + resObj.error.message);
    return;
  }

  // 3. PARSE AND UPDATE
  if (resObj.candidates && resObj.candidates[0].content) {
    const resultText =
      resObj.candidates[0].content.parts[0].text.trim();

    const lines = resultText.split("\n");

    lines.forEach(line => {
      const parts = line.split("|");

      if (parts.length >= 6) {
        const stationName = parts[0].trim();

        const row = rowsToProcess.find(r =>
          stationName.includes(r.station)
        );

        if (row) {
          sheet.getRange(row.rowNum, 6)
            .setValue(parts[1].trim());

          sheet.getRange(row.rowNum, 7)
            .setValue(parts[2].trim());

          sheet.getRange(row.rowNum, 8)
            .setValue(parts[3].trim());

          sheet.getRange(row.rowNum, 9)
            .setValue(parts[4].trim());

          sheet.getRange(row.rowNum, 10)
            .setValue(parts[5].trim());
        }
      }
    });
  }
}


function findProgramDirectorsBatchNoSearch() {
  const ss =
    SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);

  const sheet =
    ss.getSheetByName(SHEET_NAME);

  const apiKey =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing from Script Properties.");
  }

  if (!sheet) {
    throw new Error(`Sheet "${SHEET_NAME}" was not found.`);
  }

  // 1. SETUP HEADERS
  sheet.getRange("F1")
    .setValue("Program Director")
    .setFontWeight("bold");

  sheet.getRange("G1")
    .setValue("Contact Info")
    .setFontWeight("bold");

  sheet.getRange("H1")
    .setValue("Source")
    .setFontWeight("bold");

  const data =
    sheet.getDataRange().getValues();

  let rowsToProcess = [];
  let stationListText = "";

  // 2. COLLECT ROWS
  for (let i = 1; i < data.length; i++) {
    const pdCell = data[i][5];
    const stationName = data[i][0];

    if (
      stationName &&
      (
        !pdCell ||
        pdCell === "" ||
        String(pdCell).includes("Failed")
      )
    ) {
      rowsToProcess.push({
        rowNum: i + 1,
        station: stationName,
        city: data[i][3],
        state: data[i][4]
      });

      stationListText +=
        `- ${stationName} in ${data[i][3]}, ${data[i][4]}\n`;
    }
  }

  if (rowsToProcess.length === 0) return;

  // 3. GEMINI API CALL
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  const prompt = `Research the Program Directors for these stations:
${stationListText}

For each station, provide:
1. PD Name
2. Social Media Handles
3. A Confidence Score (1-10)
4. A Verification Reason

REQUIRED FORMAT (One line per station, NO bullets):
Name (Title) | Email, Phone, Socials | Source URL`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response =
    trackedFetch("Gemini", url, options);

  const resObj =
    JSON.parse(response.getContentText());

  if (resObj.error) {
    console.error("Gemini API Error: " + resObj.error.message);
    return;
  }

  // 4. UPDATE SHEET
  if (resObj.candidates && resObj.candidates[0].content) {
    const resultText =
      resObj.candidates[0].content.parts[0].text.trim();

    const lines =
      resultText
        .split("\n")
        .map(line =>
          line.replace(/[\*\-]/g, "").trim()
        )
        .filter(line => line.includes("|"));

    rowsToProcess.forEach((item, index) => {
      if (lines[index]) {
        const parts =
          lines[index].split("|");

        const name =
          parts[0]
            ? parts[0].trim()
            : "Not Found";

        const contact =
          parts[1]
            ? parts[1].trim()
            : "None Found";

        const sourceUrl =
          parts[2]
            ? parts[2].trim()
            : "";

        sheet
          .getRange(item.rowNum, 6)
          .setValue(name);

        sheet
          .getRange(item.rowNum, 7)
          .setValue(contact);

        if (
          sourceUrl
            .toLowerCase()
            .startsWith("http")
        ) {
          sheet
            .getRange(item.rowNum, 8)
            .setFormula(
              `=HYPERLINK("${sourceUrl}", "View Source")`
            );
        } else {
          sheet
            .getRange(item.rowNum, 8)
            .setValue(
              sourceUrl || "Internal Records"
            );
        }
      }
    });
  }
}