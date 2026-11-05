
/**
 * TFB-135: Contact Merge History
 * Store backup records for safe merge and undo.
 */

const CONTACT_MERGE_HISTORY_SHEET = "Merge_History";

const CONTACT_MERGE_HISTORY_HEADERS = [
	"Merge ID",
	"Primary Contact ID",
	"Duplicate Contact ID",
	"Match ID",
	"Reviewer",
	"Review Date",
	"Backup Created At",
	"Primary Snapshot",
	"Duplicate Snapshot",
	"Merged Snapshot",
	"Merge Status",
	"Merge Applied At",
	"Undo At"
];

/**
 * Create or validate the Merge_History sheet.
 * This function does not modify Master_Contacts.
 */
function contactMergeHistoryEnsureSheet(ss) {
	//Require a valid spreadsheet.
	if (!ss) {
		throw new Error("Spreadsheet is required.");
	}

	let sheet = ss.getSheetByName(CONTACT_MERGE_HISTORY_SHEET);

	//Create the history sheet if it does not exist.
	if (!sheet) {
		sheet = ss.insertSheet(CONTACT_MERGE_HISTORY_SHEET);
	}

	//Add headers to an empty sheet.
	if (sheet.getLastRow() === 0) {
		sheet.getRange(
			1,
			1,
			1,
			CONTACT_MERGE_HISTORY_HEADERS.length
		).setValues([CONTACT_MERGE_HISTORY_HEADERS]);

		sheet.setFrozenRows(1);

		return sheet;
	}

	//Read the existing headers.
	const actualHeaders = sheet.getRange(
		1,
		1,
		1,
		CONTACT_MERGE_HISTORY_HEADERS.length
	).getDisplayValues()[0];

	//Prevent writing to a sheet with incorrect headers.
	const validHeaders = CONTACT_MERGE_HISTORY_HEADERS.every(
		(header, index) => actualHeaders[index] === header
	);

	if (!validHeaders) {
		throw new Error("Unexpected Merge_History headers.");
	}

	return sheet;
}

/**
 * Convert text into a safe spreadsheet cell value.
 */
function contactMergeHistorySafeCell(value) {
	const text = String(value == null ? "" : value).trim();

	//Prevent spreadsheet formula injection.
	if (/^[=+\-@]/.test(text)) {
		return "'" + text;
	}

	return text;
}

/**
 * Serialize a contact record for backup.
 */
function contactMergeHistorySerializeContact(contact) {
	if (!contact ||
		typeof contact !== "object" ||
		Array.isArray(contact)) {
		throw new Error("Invalid contact backup.");
	}

	//Validate every contact field before saving.
	for (const [field, value] of Object.entries(contact)) {
		if (value instanceof Date) {
			if (!Number.isFinite(value.getTime())) {
				throw new Error("Invalid contact date: " + field);
			}
		} else if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			throw new Error("Unsupported contact field: " + field);
		}

		if (typeof value === "number" &&
			!Number.isFinite(value)) {
			throw new Error("Invalid contact number: " + field);
		}
	}

	return JSON.stringify(contact);
}

/**
 * Save both original contacts before a merge.
 * This function does not update Master_Contacts.
 */
function contactMergeHistorySaveBackup(ss, snapshot) {
	//Require a snapshot that has not been persisted.
	if (!snapshot ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot) ||
		snapshot.persisted !== false) {
		throw new Error("Valid unpersisted snapshot is required.");
	}

	const primaryId = String(snapshot.primaryContactId || "").trim();
	const duplicateId = String(snapshot.duplicateContactId || "").trim();
	const matchId = String(snapshot.matchId || "").trim();
	const reviewer = String(snapshot.reviewer || "").trim();

	//Validate identifiers and review details.
	if (!primaryId || !duplicateId || primaryId === duplicateId) {
		throw new Error("Invalid contact IDs.");
	}

	if (!matchId || !reviewer) {
		throw new Error("Manual approval details are required.");
	}

	if (!snapshot.reviewDate ||
		!Number.isFinite(new Date(snapshot.reviewDate).getTime())) {
		throw new Error("Invalid review date.");
	}

	if (!(snapshot.createdAt instanceof Date) ||
		!Number.isFinite(snapshot.createdAt.getTime())) {
		throw new Error("Invalid backup creation date.");
	}

	//Validate both original records.
	if (!snapshot.primaryBefore ||
		snapshot.primaryBefore["Contact ID"] !== primaryId) {
		throw new Error("Primary backup ID does not match.");
	}

	if (!snapshot.duplicateBefore ||
		snapshot.duplicateBefore["Contact ID"] !== duplicateId) {
		throw new Error("Duplicate backup ID does not match.");
	}

	const primaryJSON = contactMergeHistorySerializeContact(
		snapshot.primaryBefore
	);

	const duplicateJSON = contactMergeHistorySerializeContact(
		snapshot.duplicateBefore
	);

	//Reject oversized backups before writing.
	if (primaryJSON.length > 45000 ||
		duplicateJSON.length > 45000) {
		throw new Error("Contact backup exceeds safe cell size.");
	}

	const sheet = contactMergeHistoryEnsureSheet(ss);

	//Prevent saving the same approved match twice.
	if (sheet.getLastRow() > 1) {
		const existingMatchIds = sheet.getRange(
			2,
			4,
			sheet.getLastRow() - 1,
			1
		).getDisplayValues();

		for (const row of existingMatchIds) {
			if (row[0] === matchId) {
				throw new Error("Backup already exists for this Match ID.");
			}
		}
	}

	//Create a unique merge identifier.
	const mergeId = "MG-" + Utilities.getUuid();

	const newRow = [
		mergeId,
		contactMergeHistorySafeCell(primaryId),
		contactMergeHistorySafeCell(duplicateId),
		contactMergeHistorySafeCell(matchId),
		contactMergeHistorySafeCell(reviewer),
		new Date(snapshot.reviewDate),
		new Date(snapshot.createdAt.getTime()),
		primaryJSON,
		duplicateJSON,
		"",
		"BACKUP_SAVED",
		"",
		""
	];

	//Expand the sheet if necessary.
	const rowNumber = sheet.getLastRow() + 1;

	if (rowNumber > sheet.getMaxRows()) {
		sheet.insertRowsAfter(
			sheet.getMaxRows(),
			rowNumber - sheet.getMaxRows()
		);
	}

	//Write the backup to Merge_History.
	sheet.getRange(
		rowNumber,
		1,
		1,
		CONTACT_MERGE_HISTORY_HEADERS.length
	).setValues([newRow]);

	//Read the saved data back for verification.
	const savedRow = sheet.getRange(
		rowNumber,
		1,
		1,
		CONTACT_MERGE_HISTORY_HEADERS.length
	).getDisplayValues()[0];

	if (savedRow[0] !== mergeId ||
		savedRow[7] !== primaryJSON ||
		savedRow[8] !== duplicateJSON ||
		savedRow[10] !== "BACKUP_SAVED") {
		throw new Error("Merge backup verification failed.");
	}

	//Return the saved backup reference.
	return {
		mergeId: mergeId,
		rowNumber: rowNumber,
		status: "BACKUP_SAVED",
		backupVerified: true
	};
}


/**
 * Read and validate a saved merge backup.
 * This function does not modify Google Sheets.
 */
function contactMergeHistoryReadBackup(ss, mergeId) {
	//Validate the merge identifier.
	const id = String(mergeId == null ? "" : mergeId).trim();

	if (!id) {
		throw new Error("Merge ID is required.");
	}

	const sheet = contactMergeHistoryEnsureSheet(ss);

	//Require at least one saved backup.
	if (sheet.getLastRow() < 2) {
		throw new Error("No merge backups found.");
	}

	//Read all saved merge records.
	const rows = sheet.getRange(
		2,
		1,
		sheet.getLastRow() - 1,
		CONTACT_MERGE_HISTORY_HEADERS.length
	).getDisplayValues();

	const matches = [];

	//Find the record matching this Merge ID.
	for (let index = 0; index < rows.length; index++) {
		if (rows[index][0] === id) {
			matches.push({
				rowNumber: index + 2,
				values: rows[index]
			});
		}
	}

	//Reject missing or duplicated Merge IDs.
	if (matches.length !== 1) {
		throw new Error("Expected exactly one merge backup.");
	}

	const record = matches[0];
	const row = record.values;

	const primaryId = row[1];
	const duplicateId = row[2];
	const matchId = row[3];
	const reviewer = row[4];
	const status = row[10];

	//Validate the stored identifiers.
	if (!primaryId || !duplicateId ||
		primaryId === duplicateId || !matchId || !reviewer) {
		throw new Error("Invalid merge backup metadata.");
	}

	//Only recognize expected merge states.
	const validStatuses = [
		"BACKUP_SAVED",
		"MERGED",
		"UNDONE"
	];

	if (!validStatuses.includes(status)) {
		throw new Error("Invalid merge backup status.");
	}

	//Require both original snapshots.
	if (!row[7] || !row[8]) {
		throw new Error("Missing original contact snapshots.");
	}

	let primaryBefore;
	let duplicateBefore;

	//Parse the saved JSON records.
	try {
		primaryBefore = JSON.parse(row[7]);
		duplicateBefore = JSON.parse(row[8]);
	} catch (error) {
		throw new Error("Invalid merge backup JSON.");
	}

	//Validate the structure of both backups.
	contactMergeHistorySerializeContact(primaryBefore);
	contactMergeHistorySerializeContact(duplicateBefore);

	//Confirm the saved IDs match the original records.
	if (primaryBefore["Contact ID"] !== primaryId ||
		duplicateBefore["Contact ID"] !== duplicateId) {
		throw new Error("Contact IDs do not match saved backups.");
	}

	//Return both original records without modifying the sheet.
	return {
		mergeId: id,
		rowNumber: record.rowNumber,
		primaryContactId: primaryId,
		duplicateContactId: duplicateId,
		matchId: matchId,
		reviewer: reviewer,
		status: status,
		primaryBefore: primaryBefore,
		duplicateBefore: duplicateBefore,
		backupVerified: true
	};
}
