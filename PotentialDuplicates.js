
/**
 * TFB-135: Potential Duplicate Contact Review
 */

//Potential duplicate contact review.
const POTENTIAL_DUPLICATES_SHEET = "Potential_Duplicates";

const POTENTIAL_DUPLICATES_HEADERS = [
	"Match ID",
	"Existing Contact ID",
	"Incoming Record ID",
	"Existing Name",
	"Incoming Name",
	"Matching Fields",
	"Conflicting Fields",
	"Match Score",
	"Review Status",
	"Reviewer",
	"Review Date"
];

//Create the review sheet if it does not exist.
function contactMatchEnsureReviewSheet(ss) {
	let sheet = ss.getSheetByName(POTENTIAL_DUPLICATES_SHEET);

	if (!sheet) {
		sheet = ss.insertSheet(POTENTIAL_DUPLICATES_SHEET);
	}

	const headerRange = sheet.getRange(
		1, 1, 1, POTENTIAL_DUPLICATES_HEADERS.length
	);

	const currentHeaders = headerRange.getValues()[0];

	//Add headers only when the header row is empty.
	if (currentHeaders.every(value => value === "")) {
		headerRange.setValues([POTENTIAL_DUPLICATES_HEADERS]);
		sheet.setFrozenRows(1);
	} else if (
		!POTENTIAL_DUPLICATES_HEADERS.every(
			(header, index) => currentHeaders[index] === header
		)
	) {
		throw new Error("Potential_Duplicates headers do not match.");
	}

	return sheet;
}

//Save a possible duplicate for manual review.
function contactMatchSavePotentialDuplicate(ss, existing, incoming, incomingRecordId, matchResult) {
	//Only save possible matches.
	if (matchResult.status !== "POSSIBLE_MATCH") {
		return null;
	}

	const sheet = contactMatchEnsureReviewSheet(ss);
	const existingContactId = String(existing["Contact ID"] ?? "").trim();
	const recordId = String(incomingRecordId ?? "").trim();

	//Both IDs are required to identify a review record.
	if (!existingContactId || !recordId) {
		throw new Error("Missing contact ID or incoming record ID.");
	}

	//Check whether this pair was already reviewed or added.
	const lastRow = sheet.getLastRow();

	if (lastRow > 1) {
		const records = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

		for (const row of records) {
			if (
				String(row[1]) === existingContactId &&
				String(row[2]) === recordId
			) {
				return row[0];
			}
		}
	}

	//Create a unique match ID.
	const matchId = "MATCH-" + Utilities.getUuid();

	//Prevent spreadsheet formulas in imported text.
	const safeText = value => {
		const text = String(value ?? "");

		return /^[=+\-@]/.test(text.trimStart()) ? "'" + text : text;
	};

	//Add a new review record.
	sheet.appendRow([
		matchId,
		existingContactId,
		recordId,
		safeText(existing["Name / DJ Alias"]),
		safeText(incoming["Name / DJ Alias"]),
		safeText(matchResult.matchingFields.join("\n")),
		safeText(matchResult.conflictingFields.join("\n")),
		matchResult.matchScore,
		"Pending",
		"",
		""
	]);

	return matchId;
}

//Save a manual review decision for a potential duplicate.
function contactMatchReviewDuplicate(ss, matchId, decision, reviewer) {
	const allowedDecisions = [
		"Confirm Duplicate",
		"Different Individuals",
		"Needs Further Research"
	];

	//Check the review decision.
	if (!allowedDecisions.includes(decision)) {
		throw new Error("Invalid review decision.");
	}

	const reviewerName = String(reviewer ?? "").trim();
	const targetMatchId = String(matchId ?? "").trim();

	if (!targetMatchId || !reviewerName) {
		throw new Error("Match ID and reviewer are required.");
	}

	const sheet = contactMatchEnsureReviewSheet(ss);
	const lastRow = sheet.getLastRow();

	if (lastRow < 2) {
		throw new Error("Match ID not found.");
	}

	//Find the matching review record.
	const records = sheet.getRange(2, 1, lastRow - 1, 9).getValues();

	for (let i = 0; i < records.length; i++) {
		if (String(records[i][0]) !== targetMatchId) {
			continue;
		}

		//Allow another decision after further research.
		//Do not overwrite final review decisions.
		const currentStatus = records[i][8];

		if (
			currentStatus !== "Pending" &&
			currentStatus !== "Needs Further Research"
		) {
			throw new Error("This match has already been reviewed.");
		}

		//Save the decision, reviewer, and review date.
		sheet.getRange(i + 2, 9, 1, 3).setValues([
			[decision, reviewerName, new Date()]
		]);

		return true;
	}

	throw new Error("Match ID not found.");
}
