/**
 * @fileoverview Music Metadata Processor (MusicBrainz Edition)
 * Final version with full MLC/BMI header string and 21-column mapping.
 */

function processISRCMusicMetadata() {
  // --- CONFIGURATION ---
  const TARGET_SPREADSHEET_ID =
  PropertiesService.getScriptProperties()
    .getProperty("TARGET_SPREADSHEET_ID");
  const TARGET_SHEET_NAME = 'ISRC_Metadata'; 
  const EXPORT_SHEET_NAME = 'BMI_MLC_EXPORT'; 
  
  const SOURCE_FOLDER_ID =
  PropertiesService.getScriptProperties()
    .getProperty("SOURCE_FOLDER_ID");

  const PROCESSED_FOLDER_ID =
  PropertiesService.getScriptProperties()
    .getProperty("PROCESSED_FOLDER_ID");
  const USER_EMAIL = "capstone2026group@gmail.com"; 

  const targetSS = SpreadsheetApp.openById(TARGET_SPREADSHEET_ID);
  
  // 1. Initialize Primary Sheet
  let outputSheet = targetSS.getSheetByName(TARGET_SHEET_NAME);
  if (!outputSheet) {
    outputSheet = targetSS.insertSheet(TARGET_SHEET_NAME);
  }

  // 2. Initialize BMI/MLC Sheet with the full requested header string
  let exportSheet = targetSS.getSheetByName(EXPORT_SHEET_NAME);
  const fullMLCHeaders = [
    "PRIMARY TITLE", "*MLC SONG CODE", "MEMBERS SONG ID", "ISWC", "AKA TITLE", 
    "†AKA TITLE TYPE CODE", "†WRITER LAST NAME", "*WRITER FIRST NAME", "WRITER IPI NUMBER", 
    "WRITER ROLE CODE", "*MLC PUBLISHER NUMBER", "PUBLISHER NAME", "*PUBLISHER IPI NUMBER", 
    "*ADMINISTRATOR MLC PUBLISHER NUMBER", "ADMINISTRATOR NAME", "†ADMINISTRATOR IPI NUMBER", 
    "†COLLECTION SHARE", "*RECORDING TITLE", "†RECORDING ARTIST NAME", "†RECORDING ISRC", "RECORDING LABEL"
  ];

  if (!exportSheet) {
    exportSheet = targetSS.insertSheet(EXPORT_SHEET_NAME);
    exportSheet.appendRow(fullMLCHeaders);
  }

  const outputHeaders = ["Title", "ISRC", "Artist", "UPC", "Album", "Genre", "Year", "Label", "Album Artist", "Comment", "ExportedToMLC/BMI"];
  const processedISRCs = new Set();
  const lastRow = outputSheet.getLastRow();

  // --- SCAN AND BACKFILL EXISTING DATA ---
  if (lastRow > 1) {
    const dataRange = outputSheet.getRange(2, 1, lastRow - 1, outputHeaders.length);
    dataRange.sort({column: 6, ascending: true}); 

    const sheetData = dataRange.getValues();
    let sheetNeedsUpdate = false;

    for (let i = 0; i < sheetData.length; i++) {
      const row = sheetData[i];
      const isrc = String(row[1]).trim(); 
      if (isrc) {
        processedISRCs.add(isrc);
        if (!row[5] || !row[6]) {
          const mbData = fetchMusicBrainzData(isrc, USER_EMAIL);
          if (mbData.genre || mbData.year) {
            if (!row[5]) sheetData[i][5] = mbData.genre;
            if (!row[6]) sheetData[i][6] = mbData.year;
            sheetNeedsUpdate = true;
            Utilities.sleep(1500);
          }
        }
      }
    }
    if (sheetNeedsUpdate) dataRange.setValues(sheetData);
  } else {
    outputSheet.appendRow(outputHeaders);
  }

  // --- PROCESS NEW CSV FILES FROM DRIVE ---
  const sourceFolder = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const processedFolder = DriveApp.getFolderById(PROCESSED_FOLDER_ID);
  const files = sourceFolder.getFilesByType(MimeType.CSV);

  const formatArtists = (val) => {
    if (!val) return "";
    return val.toString().replace(/[/;|]/g, ",").split(",").map(s => s.trim()).filter(Boolean).join(", ");
  };

  const finalData = [];

  while (files.hasNext()) {
    const file = files.next();
    const csvContent = file.getBlob().getDataAsString();
    const csvData = Utilities.parseCsv(csvContent);
    
    if (csvData.length < 2) {
      file.moveTo(processedFolder);
      continue;
    }

    const headers = csvData[0].map(h => h.replace(/^\ufeff/, "").trim());
    const rows = csvData.slice(1);
    const getIdx = (name) => headers.indexOf(name);
    
    const idx = {
      isrc: getIdx("ISRC"),
      track: getIdx("TRACK"),
      pArtist: getIdx("PRODUCT ARTIST"),
      tArtist: getIdx("TRACK ARTIST"),
      upc: getIdx("DISPLAY UPC"),
      product: getIdx("PRODUCT"),
      label: getIdx("LABEL IMPRINT")
    };

    if (idx.isrc !== -1) {
      rows.forEach(row => {
        const isrc = String(row[idx.isrc]).trim();
        if (isrc && !processedISRCs.has(isrc)) {
          processedISRCs.add(isrc);
          const mbData = fetchMusicBrainzData(isrc, USER_EMAIL);
          
          finalData.push([
            row[idx.track] || "", 
            isrc, 
            formatArtists(row[idx.pArtist]), 
            row[idx.upc] || "", 
            row[idx.product] || "", 
            mbData.genre, 
            mbData.year, 
            row[idx.label] || "", 
            formatArtists(row[idx.tArtist]), 
            "", 
            false // Flag for Export
          ]);
          Utilities.sleep(1500);
        }
      });
    }
    file.moveTo(processedFolder);
  }

  if (finalData.length > 0) {
    outputSheet.getRange(outputSheet.getLastRow() + 1, 1, finalData.length, outputHeaders.length).setValues(finalData);
  }

  // --- BMI/MLC EXPORT SYNC ---
  const updatedLastRow = outputSheet.getLastRow();
  if (updatedLastRow > 1) {
    const fullRange = outputSheet.getRange(2, 1, updatedLastRow - 1, outputHeaders.length);
    const fullData = fullRange.getValues();
    const exportRows = [];
    let statusNeedsUpdate = false;

    for (let i = 0; i < fullData.length; i++) {
      if (fullData[i][10] === false || fullData[i][10] === "") {
        const title = fullData[i][0];
        const isrc = fullData[i][1];
        const artist = fullData[i][8]; // Album Artist
        const label = fullData[i][7];

        // Create a 21-column row matching the headers
        // We place the data in columns 18, 19, 20, and 21 (Indices 17-20)
        let newExportRow = new Array(fullMLCHeaders.length).fill("");
        newExportRow[17] = title;
        newExportRow[18] = artist;
        newExportRow[19] = isrc;
        newExportRow[20] = label;

        exportRows.push(newExportRow);
        fullData[i][10] = true;
        statusNeedsUpdate = true;
      }
    }

    if (exportRows.length > 0) {
      exportSheet.getRange(exportSheet.getLastRow() + 1, 1, exportRows.length, fullMLCHeaders.length).setValues(exportRows);
      console.log(`Synced ${exportRows.length} rows to the full MLC header sheet.`);
    }

    if (statusNeedsUpdate) {
      fullRange.setValues(fullData);
    }
  }
}

/**
 * MusicBrainz API Fetcher
 */
function fetchMusicBrainzData(isrc, email) {
  const result = { year: "", genre: "" };
  const url = `https://musicbrainz.org/ws/2/recording/?query=isrc:${isrc}&fmt=json`;
  try {
    const response = trackedFetch("MusicBrainz", url, {
  "headers": {
    "User-Agent": `MusicMetadataScript/1.7 ( ${email} )`
  },
  "muteHttpExceptions": true
});
    if (response.getResponseCode() !== 200) return result;
    const data = JSON.parse(response.getContentText());
    if (data.recordings && data.recordings.length > 0) {
      const rec = data.recordings[0];
      if (rec.releases && rec.releases.length > 0) {
        const date = rec.releases.find(rel => rel.date)?.date || "";
        if (date) result.year = date.substring(0, 4);
      }
      if (rec.tags && rec.tags.length > 0) {
        const topTag = rec.tags.sort((a, b) => b.count - a.count)[0];
        result.genre = topTag.name;
      }
    }
  } catch (e) {
    console.warn(`API Exception for ${isrc}: ${e.message}`);
  }
  return result;
}