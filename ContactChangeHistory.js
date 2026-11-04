/**
 * TFB-135: Contact Change History
 * Record proposed contact changes for manual review.
 */

const CONTACT_CHANGE_HISTORY_SHEET = "Change_History";

const CONTACT_CHANGE_HISTORY_HEADERS = [
	"Contact ID",
	"Field Changed",
	"Previous Value",
	"Proposed Value",
	"Source",
	"Date Detected",
	"Review Status",
	"Date Approved"
];

//Convert a value into text.
function contactHistoryToText(value) {
	return String(value == null ? "" : value).trim();
}

//Prevent imported text from being treated as a spreadsheet formula.
function contactHistorySafeValue(value) {
	const text = contactHistoryToText(value);

	if (/^[\s]*[=+\-@]/.test(text)) {
		return "'" + text;
	}

	return text;
}

//Create or validate the Change_History sheet.
function contactHistoryEnsureSheet(ss) {
	if (!ss) {
		throw new Error("Spreadsheet is required.");
	}

	let sheet = ss.getSheetByName(CONTACT_CHANGE_HISTORY_SHEET);

	//Create the sheet if it does not exist.
	if (!sheet) {
		sheet = ss.insertSheet(CONTACT_CHANGE_HISTORY_SHEET);
	}

	//Add headers to a new or empty sheet.
	if (sheet.getLastRow() === 0) {
		sheet.getRange(
			1,
			1,
			1,
			CONTACT_CHANGE_HISTORY_HEADERS.length
		).setValues([CONTACT_CHANGE_HISTORY_HEADERS]);

		sheet.setFrozenRows(1);
		return sheet;
	}

	//Check the existing headers before writing.
	const actualHeaders = sheet.getRange(
		1,
		1,
		1,
		CONTACT_CHANGE_HISTORY_HEADERS.length
	).getDisplayValues()[0];

	const validHeaders = CONTACT_CHANGE_HISTORY_HEADERS.every(
		(header, index) => actualHeaders[index] === header
	);

	if (!validHeaders) {
		throw new Error("Unexpected Change_History headers.");
	}

	return sheet;
}

//Build a key to detect repeated pending changes.
function contactHistoryChangeKey(values) {
	return JSON.stringify(values.map(contactHistoryToText));
}

//Save detected changes for manual review.
function contactHistoryRecordChanges(ss, contactId, changes, source) {
	const id = contactHistoryToText(contactId);
	const sourceText = contactHistoryToText(source);

	//Validate input before making any changes.
	if (!id) {
		throw new Error("Contact ID is required.");
	}

	if (!sourceText) {
		throw new Error("Change source is required.");
	}

	if (!Array.isArray(changes)) {
		throw new Error("Changes must be an array.");
	}

	const sheet = contactHistoryEnsureSheet(ss);
	const existingKeys = new Set();

	//Read existing pending changes.
	if (sheet.getLastRow() > 1) {
		const existingRows = sheet.getRange(
			2,
			1,
			sheet.getLastRow() - 1,
			CONTACT_CHANGE_HISTORY_HEADERS.length
		).getDisplayValues();

		for (const row of existingRows) {
			if (row[6] !== "Pending") {
				continue;
			}

			existingKeys.add(contactHistoryChangeKey(row.slice(0, 5)));
		}
	}

	const newRows = [];
	const detectedAt = new Date();

	for (const change of changes) {
		if (!change || !contactHistoryToText(change.field)) {
			throw new Error("Each change must have a field.");
		}

		//Unchanged fields do not need review.
		if (change.changeType === "UNCHANGED") {
			continue;
		}

		const previousValue = contactHistoryToText(change.previousValue);
		const proposedValue = contactHistoryToText(change.proposedValue);

		if (!proposedValue) {
			continue;
		}

		const key = contactHistoryChangeKey([
			id,
			change.field,
			previousValue,
			proposedValue,
			sourceText
		]);

		//Do not add the same pending change twice.
		if (existingKeys.has(key)) {
			continue;
		}

		existingKeys.add(key);

		newRows.push([
			contactHistorySafeValue(id),
			contactHistorySafeValue(change.field),
			contactHistorySafeValue(previousValue),
			contactHistorySafeValue(proposedValue),
			contactHistorySafeValue(sourceText),
			detectedAt,
			"Pending",
			""
		]);
	}

	//Write all new changes together.
	if (newRows.length > 0) {
		const startRow = sheet.getLastRow() + 1;
		const requiredLastRow = startRow + newRows.length - 1;

		if (requiredLastRow > sheet.getMaxRows()) {
			sheet.insertRowsAfter(
				sheet.getMaxRows(),
				requiredLastRow - sheet.getMaxRows()
			);
		}

		sheet.getRange(
			startRow,
			1,
			newRows.length,
			CONTACT_CHANGE_HISTORY_HEADERS.length
		).setValues(newRows);
	}

	return newRows.length;
}


/**
 * Record a manual review decision for a proposed change.
 * This function does not update Master_Contacts.
 */
function contactHistoryReviewChange(ss, rowNumber, decision) {
	const allowedDecisions = [
		"Approved",
		"Rejected",
		"Needs Further Research"
	];

	//Validate the review decision.
	if (!allowedDecisions.includes(decision)) {
		throw new Error("Invalid review decision.");
	}

	const sheet = contactHistoryEnsureSheet(ss);

	//Check that the row exists and is not the header.
	if (!Number.isInteger(rowNumber) ||
		rowNumber < 2 ||
		rowNumber > sheet.getLastRow()) {
		throw new Error("Invalid history row number.");
	}

	//Read the current review status.
	const statusCell = sheet.getRange(rowNumber, 7);
	const currentStatus = statusCell.getDisplayValues()[0][0];

	//Only pending or research records can be reviewed.
	if (currentStatus !== "Pending" &&
		currentStatus !== "Needs Further Research") {
		throw new Error("This change cannot be reviewed again.");
	}

	//Save the manual review decision.
	statusCell.setValue(decision);

	//Record the approval date only for approved changes.
	if (decision === "Approved") {
		sheet.getRange(rowNumber, 8).setValue(new Date());
	}

	return decision;
}
