/**
 * Reads the test workbook and checks the actual output writer.
 */
function runRecommendationDatasetTest() {
    const ss = SpreadsheetApp.openById(
      SPREADSHEET_DATA_EXTRACTION
    );
  
    const tracks = readPhase1Table_(ss, "Tracks", 1);
    const stations = readPhase1Table_(ss, "Stations", 1);
  
    // The Score Fixtures table has its headers on row 5.
    const fixtures = readPhase1Table_(ss, "Score Fixtures", 5);
  
    // Each selection contains a track, station and score fixture ID.
    // Submit them out of score order, including two tied scores.
    const selections = [
      ["T01", "S01", "F06"],
      ["T01", "S08", "F07"],
      ["T01", "S03", "F02"]
    ];
  
    // Build the objects expected by writeRecommendationOutput().
    const recommendations = selections.map(selection => {
      const track = findPhase1Record_(
        tracks, "Track ID", selection[0]
      );
  
      const station = findPhase1Record_(
        stations, "Station ID", selection[1]
      );
  
      const fixture = findPhase1Record_(
        fixtures, "Fixture ID", selection[2]
      );
  
      const score = fixture["Expected Score"];
  
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(
          "Missing numeric test score for " + selection[2]
        );
      }
  
      return {
        primaryArtist: track["Primary Artist"],
        trackName: track["Track Name"],
        isrc: "",
        primaryGenre: track["Primary Genre"],
        radioStation: station["Radio Station"],
        stationFormat: station["Station Format"],
  
        market: [
          station["Market City"],
          station["Market State / Region"],
          station["Market Country"]
        ].filter(value => value !== "").join(", "),
  
        recommendationScore: score,
        recommendationReason:
          "Synthetic output test using " + selection[2],
        confidenceLevel: "High",
        reviewNotes:
          "Score supplied by a test fixture; not generated analysis.",
        programDirector: station["Program Director"],
        contactInfo: station["Contact Info"],
        sources: station["Sources"]
      };
    });
  
    // Run the actual output function and finish pending sheet writes.
    writeRecommendationOutput(recommendations);
    SpreadsheetApp.flush();
  
    // Read back what the writer actually placed in the spreadsheet.
    const outputSheet = ss.getSheetByName(
      RECOMMENDATION_OUTPUT_SHEET
    );
  
    const values = outputSheet.getDataRange().getValues();
  
    const actual = values.slice(1).map(row => [
      row[0],  // Rank
      row[5],  // Radio Station
      row[8],  // Recommendation Score
      row[9],  // Recommendation Level
      row[14], // Contact Info
      row[15]  // Sources
    ]);
  
    // Expected results are specified independently of the output.
    const expected = [
      [
        1,
        "TEST Country Three",
        80,
        "Strong Match",
        "pd03@example.com",
        "Synthetic station directory S03"
      ],
      [
        2,
        "TEST Country One",
        77.5,
        "Good Match",
        "pd01@example.com",
        "Synthetic station directory S01"
      ],
      [
        3,
        "TEST Country Eight",
        77.5,
        "Good Match",
        "pd08@example.com",
        "Synthetic station directory S08"
      ]
    ];
  
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        "Output test failed. Expected: " +
        JSON.stringify(expected) +
        "; actual: " +
        JSON.stringify(actual)
      );
    }
  
    if (
      JSON.stringify(values[0]) !==
      JSON.stringify(RECOMMENDATION_OUTPUT_HEADERS)
    ) {
      throw new Error(
        "Output headers do not match the defined headers."
      );
    }
  
    console.log(
      "PASS: Workbook records were converted into recommendations."
    );
    console.log(
      "PASS: Scores, sorting, ranks, levels, contacts and sources match."
    );
    console.log("Output spreadsheet: " + ss.getUrl());
  }
  
  /**
   * Converts spreadsheet rows into objects using the header names.
   */
  function readPhase1Table_(ss, tabName, headerRow) {
    const sheet = ss.getSheetByName(tabName);
  
    if (!sheet) {
      throw new Error("Missing dataset tab: " + tabName);
    }
  
    const values = sheet.getDataRange().getValues();
  
    if (values.length < headerRow) {
      throw new Error("Header row is missing in " + tabName);
    }
  
    const headers = values[headerRow - 1].map(value =>
      String(value).trim()
    );
  
    return values.slice(headerRow)
      .filter(row => row[0] !== "")
      .map(row => {
        const record = {};
  
        headers.forEach((header, index) => {
          if (header) {
            record[header] = row[index];
          }
        });
  
        return record;
      });
  }
  
  /**
   * Finds a track, station or scoring fixture by its test ID.
   */
  function findPhase1Record_(records, idField, id) {
    const record = records.find(row => row[idField] === id);
  
    if (!record) {
      throw new Error("Missing " + idField + ": " + id);
    }
  
    return record;
  }