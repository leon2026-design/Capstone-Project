/**
 * Runs recommendation-writer tests using the Phase 1 workbook.
 * Automatically fills Actual Result and Status in Test Cases.
 *
 * Uses the existing SPREADSHEET_DATA_EXTRACTION setting.
 * Replaces Station_Recommendations in that test spreadsheet.
 */
function runRecommendationDatasetTest() {
    const ss = SpreadsheetApp.openById(
      SPREADSHEET_DATA_EXTRACTION
    );
  
    const caseSheet = ss.getSheetByName("Test Cases");
  
    if (!caseSheet) {
      throw new Error("Missing Test Cases tab.");
    }
  
    // Locate the case table and its result columns.
    const caseValues = caseSheet.getDataRange().getValues();
  
    const headerIndex = caseValues.findIndex(
      row => row[0] === "Case ID"
    );
  
    if (headerIndex === -1) {
      throw new Error("Missing Case ID header.");
    }
  
    const caseHeaders = caseValues[headerIndex];
  
    const actualColumn =
      caseHeaders.indexOf("Actual Result") + 1;
  
    const statusColumn =
      caseHeaders.indexOf("Status") + 1;
  
    if (!actualColumn || !statusColumn) {
      throw new Error(
        "Test Cases needs Actual Result and Status columns."
      );
    }
  
    // Find the spreadsheet row belonging to each case ID.
    const caseRows = [];
  
    for (
      let i = headerIndex + 1;
      i < caseValues.length;
      i++
    ) {
      if (/^C\d+$/.test(String(caseValues[i][0]))) {
        caseRows.push({
          id: String(caseValues[i][0]),
          row: i + 1
        });
      }
    }
  
    // Write a result into the matching test-case row.
    function recordResult(entry, status, message) {
      caseSheet
        .getRange(entry.row, actualColumn)
        .setValue(message);
  
      caseSheet
        .getRange(entry.row, statusColumn)
        .setValue(status);
    }
  
    // Clear previous results so old passes are not reused.
    caseRows.forEach(entry => {
      recordResult(
        entry,
        "Not run",
        "Not executed in this run."
      );
    });
  
    SpreadsheetApp.flush();
  
    // Read the dataset's existing tables.
    const tracks = readPhase1Table_(ss, "Tracks", 1);
  
    const stations = readPhase1Table_(
      ss,
      "Stations",
      1
    );
  
    // Score Fixtures has its headers on row 5.
    const fixtures = readPhase1Table_(
      ss,
      "Score Fixtures",
      5
    );
  
    /**
     * Build one recommendation from selected dataset records.
     * Scores come from fixtures; this does not calculate relevance.
     */
    function makeRecommendation(
      trackId,
      stationId,
      fixtureId
    ) {
      const track = findPhase1Record_(
        tracks,
        "Track ID",
        trackId
      );
  
      const station = findPhase1Record_(
        stations,
        "Station ID",
        stationId
      );
  
      const fixture = findPhase1Record_(
        fixtures,
        "Fixture ID",
        fixtureId
      );
  
      const score = fixture["Expected Score"];
  
      if (
        typeof score !== "number" ||
        !Number.isFinite(score)
      ) {
        throw new Error(
          "Missing numeric test score for " + fixtureId
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
        ]
          .filter(value => value !== "")
          .join(", "),
  
        recommendationScore: score,
  
        recommendationReason:
          "Synthetic output test using " + fixtureId,
  
        confidenceLevel: "High",
  
        reviewNotes:
          "Fixture score supplied manually; not generated analysis.",
  
        programDirector: station["Program Director"],
        contactInfo: station["Contact Info"],
        sources: station["Sources"]
      };
    }
  
    // Create three recommendations in deliberately unsorted order.
    function baseline() {
      return [
        makeRecommendation("T01", "S01", "F06"),
        makeRecommendation("T01", "S08", "F07"),
        makeRecommendation("T01", "S03", "F02")
      ];
    }
  
    // Read the actual output written to the spreadsheet.
    function readOutput() {
      SpreadsheetApp.flush();
  
      const sheet = ss.getSheetByName(
        RECOMMENDATION_OUTPUT_SHEET
      );
  
      return sheet
        ? sheet.getDataRange().getValues()
        : [];
    }
  
    // Call the real writer, then read its output.
    function writeAndRead(items) {
      writeRecommendationOutput(items);
      return readOutput();
    }
  
    // Fail a test when actual values differ from expected values.
    function equal(actual, expected, message) {
      if (
        JSON.stringify(actual) !==
        JSON.stringify(expected)
      ) {
        throw new Error(
          message +
          "; expected " +
          JSON.stringify(expected) +
          ", got " +
          JSON.stringify(actual)
        );
      }
    }
  
    /**
     * Verify that invalid input is rejected with the expected error
     * and does not change the existing output.
     */
    function rejects(items, expectedMessage) {
      const before = readOutput();
      let rejected = false;
  
      try {
        writeRecommendationOutput(items);
      } catch (error) {
        if (
          !expectedMessage.test(String(error.message))
        ) {
          throw error;
        }
  
        rejected = true;
      }
  
      if (!rejected) {
        throw new Error(
          "Invalid recommendation was accepted."
        );
      }
  
      equal(
        readOutput(),
        before,
        "Validation changed existing output"
      );
    }
  
    // Each function returns the Actual Result text if it passes.
    const tests = {
      C16: function() {
        const values = writeAndRead(baseline());
  
        equal(
          values[0],
          RECOMMENDATION_OUTPUT_HEADERS,
          "Incorrect headers"
        );
  
        const actual = values.slice(1).map(row => [
          row[0],  // Rank
          row[5],  // Station
          row[8],  // Score
          row[9],  // Level
          row[14], // Contact
          row[15]  // Source
        ]);
  
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
  
        equal(
          actual,
          expected,
          "Sorting, ranks, levels or station details differ"
        );
  
        return (
          "S03,S01,S08; scores 80,77.5,77.5; ranks 1,2,3. " +
          "Headers, levels, contacts and sources match."
        );
      },
  
      C10: function() {
        rejects(
          [
            makeRecommendation(
              "T04",
              "S01",
              "F06"
            )
          ],
          /required output field/
        );
  
        return (
          "Writer rejected missing primary genre and preserved " +
          "previous output. Recommendation-generation " +
          "validation was not tested."
        );
      },
  
      C11: function() {
        rejects(
          [
            makeRecommendation(
              "T06",
              "S01",
              "F06"
            )
          ],
          /required output field/
        );
  
        rejects(
          [
            makeRecommendation(
              "T07",
              "S01",
              "F06"
            )
          ],
          /required output field/
        );
  
        return (
          "Writer rejected missing artist and missing track; " +
          "previous output was unchanged."
        );
      },
  
      C17: function() {
        const item = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        item.primaryArtist = "  Avery Stone  ";
        item.trackName = "  Neon Skies  ";
  
        const values = writeAndRead([item]);
  
        equal(
          values.length,
          2,
          "Old recommendation rows remain"
        );
  
        equal(
          [values[1][1], values[1][2]],
          ["Avery Stone", "Neon Skies"],
          "Names were not trimmed"
        );
  
        equal(
          values[0],
          RECOMMENDATION_OUTPUT_HEADERS,
          "Headers changed"
        );
  
        return (
          "Artist and track trimmed correctly; one output row " +
          "remains with unchanged headers."
        );
      },
  
      C18: function() {
        const invalidScores = [
          "   ",
          false,
          null,
          undefined,
          "abc",
          -1,
          101
        ];
  
        invalidScores.forEach(score => {
          const item = makeRecommendation(
            "T01",
            "S01",
            "F06"
          );
  
          item.recommendationScore = score;
  
          rejects(
            [item],
            /score from 0 to 100/
          );
        });
  
        // Numeric strings should be converted to numbers.
        const numericString = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        numericString.recommendationScore = "77.5";
  
        equal(
          writeAndRead([numericString])[1][8],
          77.5,
          "Numeric string was not converted"
        );
  
        // Zero is a valid score.
        const zero = makeRecommendation(
          "T01",
          "S01",
          "F05"
        );
  
        const zeroRow = writeAndRead([zero])[1];
  
        equal(
          [zeroRow[8], zeroRow[9]],
          [0, "Weak Match"],
          "Valid zero was not handled correctly"
        );
  
        return (
          "Blank, boolean, null, undefined, nonnumeric and " +
          "out-of-range scores rejected without changing output. " +
          "Numeric string and zero accepted."
        );
      },
  
      C19: function() {
        const missingReason = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        missingReason.recommendationReason = "   ";
  
        rejects(
          [missingReason],
          /required output field/
        );
  
        const invalidConfidence = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        invalidConfidence.confidenceLevel = "Certain";
  
        rejects(
          [invalidConfidence],
          /High, Medium, or Low confidence/
        );
  
        return (
          "Blank reason and invalid confidence rejected; " +
          "previous output unchanged."
        );
      },
  
      C20: function() {
        const item = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        item.sources = "";
  
        rejects(
          [item],
          /source when contact details are included/
        );
  
        return (
          "Contact details without a source rejected; " +
          "previous output unchanged."
        );
      },
  
      C21: function() {
        const item = makeRecommendation(
          "T01",
          "S02",
          "F06"
        );
  
        item.confidenceLevel = "Medium";
  
        const row = writeAndRead([item])[1];
  
        equal(
          [row[13], row[14], row[11]],
          ["", "", "Medium"],
          "Optional contact cells or confidence are incorrect"
        );
  
        return (
          "Missing optional contacts accepted; contact cells blank " +
          "and Medium confidence retained. Score supplied by F06."
        );
      },
  
      C22: function() {
        writeAndRead(baseline());
  
        equal(
          writeAndRead([]),
          [RECOMMENDATION_OUTPUT_HEADERS],
          "Empty input did not leave only headers"
        );
  
        return (
          "Empty array removed old recommendation rows " +
          "and retained headers."
        );
      },
  
      C26: function() {
        const item = makeRecommendation(
          "T01",
          "S01",
          "F06"
        );
  
        item.primaryArtist = "";
        item.featuredArtist = "Guest Artist";
  
        rejects(
          [item],
          /required output field/
        );
  
        return (
          "Featured artist did not substitute for missing primary " +
          "artist; previous output unchanged."
        );
      }
    };
  
    // These cases need a defined rule before they can be evaluated.
    const decisions = {
      C12:
        "Missing-location scoring needs an agreed missing-factor " +
        "rule and the analysis function.",
  
      C13:
        "Unknown station-format treatment needs an agreed rule " +
        "and the analysis function.",
  
      C15:
        "Define missing-factor scoring before calculating an " +
        "expected numeric score.",
  
      C24:
        "Decide whether production calls are per track or " +
        "rankings reset per track."
    };
  
    // Explain why unsupported cases are not being run.
    caseRows.forEach(entry => {
      if (decisions[entry.id]) {
        recordResult(
          entry,
          "Needs decision",
          decisions[entry.id]
        );
  
      } else if (!tests[entry.id]) {
        let reason =
          "Not automated: recommendation matching/scoring " +
          "function is not connected to this runner.";
  
        if (entry.id === "C23") {
          reason =
            "Not automated: full workflow integration requires a " +
            "separate test; this runner calls only the output writer.";
        }
  
        if (entry.id === "C27") {
          reason =
            "Not automated: simulate write failure in the local " +
            "mock tests. Current writer clears existing data " +
            "before writing.";
        }
  
        recordResult(
          entry,
          "Not run",
          reason
        );
      }
    });
  
    let passed = 0;
    let failed = 0;
  
    // Start with the main sorting test.
    const orderedIds = [
      "C16",
      "C10",
      "C11",
      "C17",
      "C18",
      "C19",
      "C20",
      "C21",
      "C22",
      "C26"
    ];
  
    // Run every supported case and record Pass or Fail.
    orderedIds.forEach(id => {
      const entry = caseRows.find(
        row => row.id === id
      );
  
      if (!entry) {
        throw new Error(
          "Missing test case row: " + id
        );
      }
  
      try {
        const message = tests[id]();
  
        recordResult(
          entry,
          "Pass",
          message
        );
  
        passed++;
  
        console.log(
          "PASS " + id + ": " + message
        );
  
      } catch (error) {
        recordResult(
          entry,
          "Fail",
          String(error.message)
        );
  
        failed++;
  
        console.log(
          "FAIL " + id + ": " + error.message
        );
      }
    });
  
    // Leave the three baseline recommendations visible afterward.
    try {
      writeAndRead(baseline());
  
    } catch (error) {
      console.log(
        "Could not restore sample output: " +
        error.message
      );
  
      throw error;
    }
  
    SpreadsheetApp.flush();
  
    console.log(
      "Finished: " +
      passed +
      " passed; " +
      failed +
      " failed."
    );
  
    console.log(
      "See Test Cases for Actual Result and Status. " +
      "Other cases were not passed automatically."
    );
  
    // Make the execution show a failure if any automated test failed.
    if (failed) {
      throw new Error(
        failed +
        " automated writer test(s) failed. See Test Cases."
      );
    }
  }
  
  /**
   * Converts spreadsheet rows into objects using the header names.
   */
  function readPhase1Table_(ss, tabName, headerRow) {
    const sheet = ss.getSheetByName(tabName);
  
    if (!sheet) {
      throw new Error(
        "Missing dataset tab: " + tabName
      );
    }
  
    const values = sheet.getDataRange().getValues();
  
    if (values.length < headerRow) {
      throw new Error(
        "Missing header row in " + tabName
      );
    }
  
    const headers = values[headerRow - 1].map(
      value => String(value).trim()
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
   * Finds one record by its track, station or fixture ID.
   */
  function findPhase1Record_(records, idField, id) {
    const record = records.find(
      row => row[idField] === id
    );
  
    if (!record) {
      throw new Error(
        "Missing " + idField + ": " + id
      );
    }
  
    return record;
  }