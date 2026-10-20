const RECOMMENDATION_OUTPUT_SHEET = "Station_Recommendations";

const RECOMMENDATION_OUTPUT_HEADERS = [
  "Rank",
  "Primary Artist",
  "Track Name",
  "ISRC",
  "Primary Genre",
  "Radio Station",
  "Station Format",
  "Market",
  "Recommendation Score",
  "Recommendation Level",
  "Recommendation Reason",
  "Confidence Level",
  "Review Notes",
  "Program Director",
  "Contact Info",
  "Sources"
];

/**
 * This function writes the recommendations to the output sheet.
 * Rank are currently left blank for the sorting task that follows.
 */
function writeRecommendationOutput(recommendations) {
  if (!Array.isArray(recommendations)) {
    throw new Error("Recommendations must be provided as an array.");
  }

  if (!SPREADSHEET_DATA_EXTRACTION) {
    throw new Error(
      "SPREADSHEET_DATA_EXTRACTION is missing from Script Properties."
    );
  }

  const rows = recommendations.map((item, index) => {
  const artist = String(item.primaryArtist || "").trim();
  const track = String(item.trackName || "").trim();


  const rawScore = item.recommendationScore;
  let score = NaN;

  if (typeof rawScore === "number") {
    score = rawScore;
  } else if (
    typeof rawScore === "string" &&
    rawScore.trim() !== ""
  ) {
    score = Number(rawScore);
  }
    const confidence = String(item.confidenceLevel || "").trim();
    const reason = String(item.recommendationReason || "").trim();
    const station = String(item.radioStation || "").trim();
    const genre = String(item.primaryGenre || "").trim();
    const sources = String(item.sources || "").trim();

    if (!artist || !track || !genre || !station || !reason) {
      throw new Error(
        `Recommendation ${index + 1} is missing a required output field.`
      );
    }

    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(
        `Recommendation ${index + 1} must have a score from 0 to 100.`
      );
    }

    if (!["High", "Medium", "Low"].includes(confidence)) {
      throw new Error(
        `Recommendation ${index + 1} must have High, Medium, or Low confidence.`
      );
    }

    if ((item.programDirector || item.contactInfo) && !sources) {
      throw new Error(
        `Recommendation ${index + 1} needs a source when contact details are included.`
      );
    }

    let level;
    if (score >= 80) {
      level = "Strong Match";
    } else if (score >= 60) {
      level = "Good Match";
    } else if (score >= 40) {
      level = "Possible Match";
    } else {
      level = "Weak Match";
    }

    return [
      "", // Rank is assigned by the sorting.
      artist,
      track,
      item.isrc || "",
      genre,
      station,
      item.stationFormat || "",
      item.market || "",
      score,
      level,
      reason,
      confidence,
      item.reviewNotes || "",
      item.programDirector || "",
      item.contactInfo || "",
      sources
    ];
  });

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
  let sheet = spreadsheet.getSheetByName(RECOMMENDATION_OUTPUT_SHEET);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(RECOMMENDATION_OUTPUT_SHEET);
  }

  // Refreshes this dedicated output tab only.
  const previousLastRow = sheet.getLastRow();
  const columnCount = RECOMMENDATION_OUTPUT_HEADERS.length;

  // Combine the headers and recommendation rows for one write.
  const output = [RECOMMENDATION_OUTPUT_HEADERS, ...rows];


  if (output.length > sheet.getMaxRows()) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      output.length - sheet.getMaxRows()
    );
  }

  if (columnCount > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      columnCount - sheet.getMaxColumns()
    );
  }

  sheet
    .getRange(1, 1, output.length, columnCount)
    .setValues(output);

  // Clear leftover rows when the new output is shorter.
  if (previousLastRow > output.length) {
    sheet
      .getRange(
        output.length + 1,
        1,
        previousLastRow - output.length,
        columnCount
      )
      .clearContent();
  }

  sheet
    .getRange(1, 1, 1, columnCount)
    .setFontWeight("bold");

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, columnCount);
}
