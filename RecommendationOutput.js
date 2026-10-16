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
    const artist = item.primaryArtist || item.featuredArtist || "";
    const score = Number(item.recommendationScore);
    const confidence = String(item.confidenceLevel || "").trim();
    const reason = String(item.recommendationReason || "").trim();
    const station = String(item.radioStation || "").trim();
    const genre = String(item.primaryGenre || "").trim();
    const sources = String(item.sources || "").trim();

    if (!artist || !item.trackName || !genre || !station || !reason) {
      throw new Error(
        `Recommendation ${index + 1} is missing a required output field.`
      );
    }

    if (
      item.recommendationScore === "" ||
      item.recommendationScore === null ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 100
    ) {
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
      item.trackName,
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
  sheet.clearContents();
  sheet
    .getRange(1, 1, 1, RECOMMENDATION_OUTPUT_HEADERS.length)
    .setValues([RECOMMENDATION_OUTPUT_HEADERS])
    .setFontWeight("bold");

  if (rows.length > 0) {
    sheet
      .getRange(2, 1, rows.length, RECOMMENDATION_OUTPUT_HEADERS.length)
      .setValues(rows);
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, RECOMMENDATION_OUTPUT_HEADERS.length);
}