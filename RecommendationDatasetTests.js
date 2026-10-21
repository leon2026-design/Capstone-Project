/**
 * Reads every test from the Output Tests tab.
 * Runs the actual recommendation output function.
 * Writes Actual Result and Status beside each test.
 *
 * Uses the existing SPREADSHEET_DATA_EXTRACTION setting.
 * Replaces Station_Recommendations during testing.
 * Does not call Gemini or MusicBrainz.
 */
function runRecommendationDatasetTest() {
  const ss = SpreadsheetApp.openById(
    SPREADSHEET_DATA_EXTRACTION
  );

  const sheet = ss.getSheetByName("Output Tests");

  if (!sheet) {
    throw new Error(
      "Missing Output Tests tab. Import the new workbook first."
    );
  }

  const data = sheet.getDataRange().getValues();

  const headers = data[0].map(value =>
    String(value).trim()
  );

  // Accept either the renamed header or the original header.
  const errorHeader = headers.includes("Expected Error Message")
    ? "Expected Error Message"
    : "Expected Error Contains";

  // Match spreadsheet columns to the writer's input properties.
  const fieldMap = {
    "Primary Artist": "primaryArtist",
    "Track Name": "trackName",
    "ISRC": "isrc",
    "Primary Genre": "primaryGenre",
    "Radio Station": "radioStation",
    "Station Format": "stationFormat",
    "Market": "market",
    "Recommendation Score": "recommendationScore",
    "Recommendation Reason": "recommendationReason",
    "Confidence Level": "confidenceLevel",
    "Review Notes": "reviewNotes",
    "Program Director": "programDirector",
    "Contact Info": "contactInfo",
    "Sources": "sources",
    "Featured Artist (test only)": "featuredArtist"
  };

  // Confirm all columns required by the runner are present.
  const required = [
    "Test ID",
    "What It Tests",
    "Expected Outcome",
    "Actual Result",
    "Status",
    "Input Mode",
    "Expected Rank",
    "Expected Score",
    "Expected Level",
    errorHeader
  ].concat(Object.keys(fieldMap));

  required.forEach(name => {
    if (headers.indexOf(name) === -1) {
      throw new Error("Missing column: " + name);
    }
  });

  const actualIndex = headers.indexOf("Actual Result");

  if (headers.indexOf("Status") !== actualIndex + 1) {
    throw new Error(
      "Keep Status immediately after Actual Result."
    );
  }

  // Group rows sharing a Test ID into one test.
  const groups = new Map();
  let lastTestRow = 1;

  data.slice(1).forEach((values, index) => {
    const record = {};

    headers.forEach((header, col) => {
      record[header] = values[col];
    });

    const id = String(record["Test ID"] || "").trim();

    // Ignore notes and other rows that are not test records.
    if (!/^OUT\d+$/.test(id)) {
      return;
    }

    const input = {};

    Object.keys(fieldMap).forEach(header => {
      input[fieldMap[header]] = record[header];
    });

    const entry = {
      record: record,
      input: input,
      sheetRow: index + 2
    };

    if (!groups.has(id)) {
      groups.set(id, []);
    }

    groups.get(id).push(entry);
    lastTestRow = index + 2;
  });

  if (!groups.size) {
    throw new Error("No OUT test IDs were found.");
  }

  // Reset previous results before running the tests.
  const results = Array.from(
    { length: lastTestRow - 1 },
    () => ["", "Not run"]
  );

  sheet
    .getRange(2, actualIndex + 1, results.length, 2)
    .setValues(results);

  SpreadsheetApp.flush();

  // These are the headers expected from the production writer.
  const outputHeaders = [
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

  const trim = value =>
    String(value || "").trim();

  // Fail the test if actual values differ from expected values.
  function check(actual, expected, message) {
    if (
      JSON.stringify(actual) !== JSON.stringify(expected)
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

  // Read the output currently in the spreadsheet.
  function readOutput() {
    SpreadsheetApp.flush();

    const output = ss.getSheetByName(
      RECOMMENDATION_OUTPUT_SHEET
    );

    return output
      ? output.getDataRange().getValues()
      : [];
  }

  // Build one expected output row from its visible test record.
  function expectedRow(entry) {
    const record = entry.record;
    const input = entry.input;

    if (
      typeof record["Expected Rank"] !== "number" ||
      typeof record["Expected Score"] !== "number"
    ) {
      throw new Error(
        "Expected Rank and Expected Score must be numeric " +
        "for accepted records."
      );
    }

    return [
      record["Expected Rank"],
      trim(input.primaryArtist),
      trim(input.trackName),
      input.isrc || "",
      trim(input.primaryGenre),
      trim(input.radioStation),
      input.stationFormat || "",
      input.market || "",
      record["Expected Score"],
      record["Expected Level"],
      trim(input.recommendationReason),
      trim(input.confidenceLevel),
      input.reviewNotes || "",
      input.programDirector || "",
      input.contactInfo || "",
      trim(input.sources)
    ];
  }

  // Find a valid test group to use as previous output.
  // Rejection tests must preserve these existing records.
  const baseline = Array.from(groups.values()).find(
    entries =>
      entries[0].record["Expected Outcome"] === "Accept" &&
      entries[0].record["Input Mode"] === "Rows"
  );

  if (!baseline) {
    throw new Error(
      "Keep at least one accepted Rows test as the baseline."
    );
  }

  const baselineInput = baseline.map(
    entry => entry.input
  );

  let passed = 0;
  let failed = 0;

  // Run each test group.
  groups.forEach((entries, id) => {
    let status = "Pass";
    let message;

    try {
      const first = entries[0].record;
      const mode = first["Input Mode"];
      const outcome = first["Expected Outcome"];

      // Rows within one group must use the same test settings.
      entries.forEach(entry => {
        check(
          entry.record["Input Mode"],
          mode,
          "Mixed input modes in " + id
        );

        check(
          entry.record["Expected Outcome"],
          outcome,
          "Mixed expected outcomes in " + id
        );

        check(
          entry.record[errorHeader],
          first[errorHeader],
          "Mixed error expectations in " + id
        );
      });

      const allowedModes = [
        "Rows",
        "Text score",
        "Empty array",
        "Not an array"
      ];

      if (!allowedModes.includes(mode)) {
        throw new Error(
          "Unknown Input Mode: " + mode
        );
      }

      if (!["Accept", "Reject"].includes(outcome)) {
        throw new Error(
          "Unknown Expected Outcome: " + outcome
        );
      }

      // Ensure the numeric-string test really receives text.
      if (
        mode === "Text score" &&
        entries.some(
          entry =>
            typeof entry.input.recommendationScore !== "string"
        )
      ) {
        throw new Error(
          "Setup error: format the Recommendation Score cell " +
          "as plain text and enter 77.5 again."
        );
      }

      // Build the argument described by Input Mode.
      let input;

      if (mode === "Empty array") {
        input = [];

      } else if (mode === "Not an array") {
        input = null;

      } else {
        input = entries.map(entry => entry.input);
      }

      // Start each case with known previous output.
      writeRecommendationOutput(baselineInput);

      const before = readOutput();
      let writerError = null;

      // Call the actual production function.
      try {
        writeRecommendationOutput(input);

      } catch (error) {
        writerError = error;
      }

      if (outcome === "Reject") {
        // A rejection case passes only with the expected error.
        if (!writerError) {
          throw new Error(
            "Writer accepted input that should be rejected."
          );
        }

        const expectedError = String(
          first[errorHeader] || ""
        );

        if (
          !expectedError ||
          !String(writerError.message).includes(expectedError)
        ) {
          throw new Error(
            "Wrong error: " + writerError.message
          );
        }

        // Invalid input must not erase or change previous output.
        check(
          readOutput(),
          before,
          "Rejected input changed previous output"
        );

        message =
          "Rejected: " +
          writerError.message +
          " Previous output unchanged.";

      } else {
        // An acceptance case must complete without an error.
        if (writerError) {
          throw writerError;
        }

        const expected =
          mode === "Empty array"
            ? []
            : entries
                .map(expectedRow)
                .sort((a, b) => a[0] - b[0]);

        // Check the spreadsheet's expected ranks are valid.
        expected.forEach((row, index) => {
          check(
            row[0],
            index + 1,
            "Expected ranks must be 1,2,3..."
          );
        });

        const actual = readOutput();

        check(
          actual[0],
          outputHeaders,
          "Output headers differ"
        );

        // Compare every output field, not just the score.
        check(
          actual.slice(1),
          expected,
          "Output rows differ"
        );

        const detail = actual.slice(1).map(row =>
          row[5] +
          "=" +
          row[8] +
          " (rank " +
          row[0] +
          ", " +
          row[9] +
          ")"
        ).join("; ");

        message =
          actual.length === 1
            ? "Accepted empty array; only headers remain."
            : "All output fields match. " + detail;
      }

      passed++;

    } catch (error) {
      status = "Fail";
      message = String(error.message);
      failed++;
    }

    // All rows in the same test group receive its result.
    entries.forEach(entry => {
      results[entry.sheetRow - 2] = [
        message,
        status
      ];
    });

    console.log(
      status.toUpperCase() +
      " " +
      id +
      ": " +
      message
    );
  });

  // Update only Actual Result and Status.
  // Inputs and expected results are left unchanged.
  sheet
    .getRange(2, actualIndex + 1, results.length, 2)
    .setValues(results);

  sheet
    .getRange(2, actualIndex + 1, results.length, 2)
    .setWrap(true);

  sheet.autoResizeRows(2, results.length);

  SpreadsheetApp.flush();

  // Leave the baseline recommendations visible after testing.
  writeRecommendationOutput(baselineInput);

  SpreadsheetApp.flush();

  console.log(
    passed +
    " passed; " +
    failed +
    " failed. Results are in Output Tests."
  );

  if (failed) {
    throw new Error(
      failed +
      " test group(s) failed. See Output Tests."
    );
  }
}
