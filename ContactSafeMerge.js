
/**
 * TFB-135: Contact Safe Merge
 * Preview and prepare approved contact merges.
 */

const CONTACT_SAFE_MERGE_MULTI_FIELDS = [
	"Email",
	"Phone",
	"Station / Venue / Organization",
	"Social Accounts",
	"Sources"
];

const CONTACT_SAFE_MERGE_REVIEW_FIELDS = [
	"Email",
	"Phone",
	"Station / Venue / Organization"
];

const CONTACT_SAFE_MERGE_SYSTEM_FIELDS = [
	"Contact ID",
	"Review Status",
	"Review Notes",
	"Last Updated",
	"sheetRow"
];

//Convert a contact field into text.
function contactSafeMergeText(value) {
	return String(value == null ? "" : value).trim();
}

//Split a field containing multiple values.
function contactSafeMergeSplitValues(value) {
	return contactSafeMergeText(value)
		.split(/\r?\n/)
		.map(item => item.trim())
		.filter(Boolean);
}

//Combine values without adding duplicates.
function contactSafeMergeUniqueValues(first, second) {
	const values = [
		...contactSafeMergeSplitValues(first),
		...contactSafeMergeSplitValues(second)
	];

	const seen = new Set();
	const result = [];

	for (const value of values) {
		const key = value.toLowerCase();

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(value);
	}

	return result.join("\n");
}

//Compare two text values.
function contactSafeMergeSameValue(first, second) {
	return contactSafeMergeText(first).toLowerCase() ===
		contactSafeMergeText(second).toLowerCase();
}

/**
 * Build a merge preview for two contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergePreview(primary, duplicate) {
	//Validate the input records.
	if (!primary || typeof primary !== "object" || Array.isArray(primary)) {
		throw new Error("Primary contact is required.");
	}

	if (!duplicate || typeof duplicate !== "object" || Array.isArray(duplicate)) {
		throw new Error("Duplicate contact is required.");
	}

	const primaryId = contactSafeMergeText(primary["Contact ID"]);
	const duplicateId = contactSafeMergeText(duplicate["Contact ID"]);

	//Both records must have valid IDs.
	if (!primaryId || !duplicateId) {
		throw new Error("Both contacts must have a Contact ID.");
	}

	//Prevent merging a contact with itself.
	if (primaryId === duplicateId) {
		throw new Error("Cannot merge a contact with itself.");
	}

	//Preserve the primary contact ID.
	const mergedContact = { ...primary };
	const conflicts = [];
	const reviewFields = [];

	//Compare every field from both records.
	const allFields = new Set([
		...Object.keys(primary),
		...Object.keys(duplicate)
	]);

	for (const field of allFields) {
		//Keep system fields unchanged.
		if (CONTACT_SAFE_MERGE_SYSTEM_FIELDS.includes(field)) {
			continue;
		}

		const primaryValue = contactSafeMergeText(primary[field]);
		const duplicateValue = contactSafeMergeText(duplicate[field]);

		//Combine fields that can contain multiple values.
		if (CONTACT_SAFE_MERGE_MULTI_FIELDS.includes(field)) {
			const combinedValue = contactSafeMergeUniqueValues(
				primaryValue,
				duplicateValue
			);

			mergedContact[field] = combinedValue;

			//Flag contact details that require manual review.
			if (CONTACT_SAFE_MERGE_REVIEW_FIELDS.includes(field) &&
				!contactSafeMergeSameValue(primaryValue, combinedValue)) {
				reviewFields.push(field);
			}

			continue;
		}

		//Fill empty fields in the preview.
		if (!primaryValue && duplicateValue) {
			mergedContact[field] = duplicateValue;
			continue;
		}

		//Record conflicting information without overwriting it.
		if (primaryValue && duplicateValue &&
			!contactSafeMergeSameValue(primaryValue, duplicateValue)) {
			conflicts.push({
				field: field,
				primaryValue: primaryValue,
				duplicateValue: duplicateValue
			});
		}
	}

	return {
		survivingContactId: primaryId,
		duplicateContactId: duplicateId,
		mergedContact: mergedContact,
		conflicts: conflicts,
		reviewFields: reviewFields,
		hasUnresolvedConflicts: conflicts.length > 0,
		requiresManualReview: true
	};
}

/**
 * Validate approval before merging two contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeValidateApproval(primary, duplicate, reviewRecord) {
	//Validate both contact records.
	const preview = contactSafeMergePreview(primary, duplicate);

	//Require a manual review record.
	if (!reviewRecord ||
		typeof reviewRecord !== "object" ||
		Array.isArray(reviewRecord)) {
		throw new Error("Manual review record is required.");
	}

	const matchId = contactSafeMergeText(reviewRecord["Match ID"]);

	const existingId = contactSafeMergeText(
		reviewRecord["Existing Contact ID"]
	);

	const incomingId = contactSafeMergeText(
		reviewRecord["Incoming Record ID"]
	);

	const decision = contactSafeMergeText(
		reviewRecord["Review Status"]
	);

	const reviewer = contactSafeMergeText(
		reviewRecord["Reviewer"]
	);

	const reviewDate = reviewRecord["Review Date"];

	//Require a valid review record ID.
	if (!matchId) {
		throw new Error("Match ID is required.");
	}

	//Approval must belong to these exact contacts.
	if (existingId !== preview.survivingContactId ||
		incomingId !== preview.duplicateContactId) {
		throw new Error("Approval does not match contact IDs.");
	}

	//Only confirmed duplicates can be merged.
	if (decision !== "Confirm Duplicate") {
		throw new Error("Duplicate merge has not been approved.");
	}

	//Require an identified human reviewer.
	if (!reviewer) {
		throw new Error("Reviewer is required.");
	}

	//Require a valid review date.
	if (!reviewDate ||
		!Number.isFinite(new Date(reviewDate).getTime())) {
		throw new Error("Valid review date is required.");
	}

	//Return approval details without changing any records.
	return {
		matchId: matchId,
		primaryContactId: preview.survivingContactId,
		duplicateContactId: preview.duplicateContactId,
		reviewer: reviewer,
		reviewDate: new Date(reviewDate).toISOString(),
		approved: true
	};
}

/**
 * Create a backup snapshot before merging contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeCreateSnapshot(primary, duplicate, reviewRecord) {
	//Validate the proposed merge approval.
	const approval = contactSafeMergeValidateApproval(
		primary,
		duplicate,
		reviewRecord
	);

	//Copy flat contact fields without sharing mutable values.
	function copyContact(record) {
		const copy = {};

		for (const [field, value] of Object.entries(record)) {
			if (value instanceof Date) {
				copy[field] = new Date(value.getTime());
			} else if (
				value === null ||
				["string", "number", "boolean", "undefined"].includes(typeof value)
			) {
				copy[field] = value;
			} else {
				throw new Error("Unsupported contact field value: " + field);
			}
		}

		return copy;
	}

	//Keep independent copies of both original contacts.
	const primaryBefore = copyContact(primary);
	const duplicateBefore = copyContact(duplicate);

	return {
		primaryContactId: approval.primaryContactId,
		duplicateContactId: approval.duplicateContactId,
		matchId: approval.matchId,
		reviewer: approval.reviewer,
		reviewDate: approval.reviewDate,
		createdAt: new Date(),
		primaryBefore: primaryBefore,
		duplicateBefore: duplicateBefore,
		persisted: false
	};
}

/**
 * Verify that contact data has not changed since backup.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeVerifyCurrentData(backup, currentPrimary, currentDuplicate) {
	//Require a verified saved backup.
	if (!backup ||
		backup.status !== "BACKUP_SAVED" ||
		backup.backupVerified !== true) {
		throw new Error("A verified saved backup is required.");
	}

	//Validate the current contacts.
	if (!currentPrimary || !currentDuplicate ||
		typeof currentPrimary !== "object" ||
		typeof currentDuplicate !== "object" ||
		Array.isArray(currentPrimary) ||
		Array.isArray(currentDuplicate)) {
		throw new Error("Both current contacts are required.");
	}

	const primaryId = contactSafeMergeText(currentPrimary["Contact ID"]);
	const duplicateId = contactSafeMergeText(currentDuplicate["Contact ID"]);

	//Confirm both contact IDs.
	if (!primaryId || !duplicateId ||
		primaryId === duplicateId ||
		primaryId !== backup.primaryContactId ||
		duplicateId !== backup.duplicateContactId) {
		throw new Error("Current contact IDs do not match the backup.");
	}

	//Compare contact values without losing date information.
	function comparableValue(value) {
		if (Object.prototype.toString.call(value) === "[object Date]") {
			if (!Number.isFinite(value.getTime())) {
				throw new Error("Invalid contact date.");
			}

			return value.toISOString();
		}

		if (value !== null &&
			typeof value === "object") {
			throw new Error("Unsupported contact field value.");
		}

		return value;
	}

	//Compare every saved field with the current record.
	function verifyContact(original, current, contactId) {
		if (!original || typeof original !== "object" ||
			Array.isArray(original)) {
			throw new Error("Invalid original contact backup.");
		}

		const fields = new Set([
			...Object.keys(original),
			...Object.keys(current)
		]);

		for (const field of fields) {
			//Sheet row positions can change independently.
			if (field === "sheetRow") {
				continue;
			}

			//Require the same field structure.
			if (!Object.prototype.hasOwnProperty.call(original, field) ||
				!Object.prototype.hasOwnProperty.call(current, field)) {
				throw new Error(
					"Contact fields changed since backup: " + contactId
				);
			}

			const before = comparableValue(original[field]);
			const now = comparableValue(current[field]);

			//Stop if any contact value has changed.
			if (before !== now) {
				throw new Error(
					"Contact changed since backup: " +
					contactId + " / " + field
				);
			}
		}
	}

	//Verify both records independently.
	verifyContact(
		backup.primaryBefore,
		currentPrimary,
		primaryId
	);

	verifyContact(
		backup.duplicateBefore,
		currentDuplicate,
		duplicateId
	);

	return {
		primaryContactId: primaryId,
		duplicateContactId: duplicateId,
		unchanged: true
	};
}

/**
 * Prepare a safe merge plan.
 * This function does not modify Google Sheets.
 */
function contactSafeMergePreparePlan(backup, currentPrimary, currentDuplicate) {
	//Verify the saved data matches current records.
	const validation = contactSafeMergeVerifyCurrentData(
		backup,
		currentPrimary,
		currentDuplicate
	);

	//Build the proposed merge result.
	const preview = contactSafeMergePreview(
		currentPrimary,
		currentDuplicate
	);

	const blockers = [];

	//Require review of conflicting fields.
	for (const conflict of preview.conflicts) {
		blockers.push({
			field: conflict.field,
			reason: "UNRESOLVED_CONFLICT",
			primaryValue: conflict.primaryValue,
			duplicateValue: conflict.duplicateValue
		});
	}

	//Require approval for new contact information.
	for (const field of preview.reviewFields) {
		blockers.push({
			field: field,
			reason: "FIELD_APPROVAL_REQUIRED"
		});
	}

	//Return a plan without applying any changes.
	return {
		mergeId: contactSafeMergeText(backup.mergeId),
		primaryContactId: validation.primaryContactId,
		duplicateContactId: validation.duplicateContactId,
		mergedContact: preview.mergedContact,
		blockers: blockers,
		hasBlockers: blockers.length > 0,
		requiresManualMergeApproval: true,
		readyForDataWrite: false
	};
}

/**
 * Apply proposed field decisions to a merge plan.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeResolvePlan(backup, currentPrimary, currentDuplicate, decisions) {
	//Rebuild and validate the merge plan.
	const plan = contactSafeMergePreparePlan(
		backup,
		currentPrimary,
		currentDuplicate
	);

	//Require a valid decisions object.
	if (!decisions || typeof decisions !== "object" ||
		Array.isArray(decisions)) {
		throw new Error("Field review decisions are required.");
	}

	const mergedContact = { ...plan.mergedContact };
	const resolvedFields = [];
	const requiredFields = new Set(
		plan.blockers.map(blocker => blocker.field)
	);

	//Reject decisions for fields without blockers.
	for (const field of Object.keys(decisions)) {
		if (!requiredFields.has(field)) {
			throw new Error("Unexpected field decision: " + field);
		}
	}

	//Process each field requiring review.
	for (const blocker of plan.blockers) {
		const field = blocker.field;

		//Require an explicit decision for every blocker.
		if (!Object.prototype.hasOwnProperty.call(decisions, field)) {
			throw new Error("Missing field decision: " + field);
		}

		const decision = decisions[field];

		if (blocker.reason === "FIELD_APPROVAL_REQUIRED") {
			//Approve the combined value or keep the original.
			if (decision === "APPROVE") {
				//Keep the proposed combined value.
			} else if (decision === "KEEP_PRIMARY") {
				mergedContact[field] = currentPrimary[field] || "";
			} else {
				throw new Error("Invalid field approval decision: " + field);
			}
		} else if (blocker.reason === "UNRESOLVED_CONFLICT") {
			//Choose one value for a conflicting field.
			if (decision === "KEEP_PRIMARY") {
				mergedContact[field] = currentPrimary[field];
			} else if (decision === "USE_DUPLICATE") {
				mergedContact[field] = currentDuplicate[field];
			} else {
				throw new Error("Invalid conflict resolution: " + field);
			}
		} else {
			throw new Error("Unknown merge blocker.");
		}

		resolvedFields.push({
			field: field,
			decision: decision
		});
	}

	//Return the resolved preview without authorizing a write.
	return {
		mergeId: plan.mergeId,
		primaryContactId: plan.primaryContactId,
		duplicateContactId: plan.duplicateContactId,
		mergedContact: mergedContact,
		resolvedFields: resolvedFields,
		allFieldDecisionsProvided: true,
		requiresTrustedApprovalVerification: true,
		readyForDataWrite: false
	};
}

/**
 * Read one existing contact from Master_Contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeReadMasterContact(ss, contactId) {
	//Validate the spreadsheet and contact ID.
	if (!ss) {
		throw new Error("Spreadsheet is required.");
	}

	const id = contactSafeMergeText(contactId);

	if (!id) {
		throw new Error("Contact ID is required.");
	}

	const sheet = ss.getSheetByName("Master_Contacts");

	if (!sheet) {
		throw new Error("Master_Contacts sheet not found.");
	}

	const headers = [
		"Contact ID",
		"Name / DJ Alias",
		"Role",
		"Station / Venue / Organization",
		"City",
		"State / Region",
		"Country",
		"Email",
		"Phone",
		"Social Accounts",
		"Sources",
		"Review Status",
		"Review Notes",
		"Last Updated"
	];

	if (sheet.getLastRow() < 1) {
		throw new Error("Master_Contacts has no headers.");
	}

	//Validate the expected database structure.
	const actualHeaders = sheet.getRange(
		1,
		1,
		1,
		headers.length
	).getDisplayValues()[0];

	if (!headers.every((header, index) =>
		actualHeaders[index] === header)) {
		throw new Error("Unexpected Master_Contacts headers.");
	}

	if (sheet.getLastRow() < 2) {
		throw new Error("Contact not found.");
	}

	//Read existing contacts without changing them.
	const rows = sheet.getRange(
		2,
		1,
		sheet.getLastRow() - 1,
		headers.length
	).getValues();

	const matches = [];

	for (let index = 0; index < rows.length; index++) {
		if (rows[index][0] === id) {
			matches.push({
				rowNumber: index + 2,
				values: rows[index]
			});
		}
	}

	//Prevent missing or duplicated Contact IDs.
	if (matches.length !== 1) {
		throw new Error("Expected exactly one matching Contact ID.");
	}

	const contact = {
		sheetRow: matches[0].rowNumber
	};

	//Build the contact record using verified headers.
	for (let index = 0; index < headers.length; index++) {
		contact[headers[index]] = matches[0].values[index];
	}

	return contact;
}

/**
 * TFB-135: Apply Approved Contact Merge
 * Requires ContactMergeHistory.js in the same project.
 * Do not run on production data before Undo and integration tests.
 */
function contactSafeMergeApplyApproved(ss, mergeId) {
	//Validate the request.
	const id = contactSafeMergeText(mergeId);

	if (!ss || !id) {
		throw new Error("Spreadsheet and Merge ID are required.");
	}

	//Prevent overlapping merge operations.
	const lock = LockService.getScriptLock();

	if (!lock.tryLock(30000)) {
		throw new Error("Could not acquire merge lock.");
	}

	try {
		//Read the persisted backup.
		const backup = contactMergeHistoryReadBackup(ss, id);

		if (!backup ||
			backup.status !== "BACKUP_SAVED" ||
			backup.backupVerified !== true) {
			throw new Error("Verified backup is required.");
		}

		const primaryId = contactSafeMergeText(
			backup.primaryContactId
		);

		const duplicateId = contactSafeMergeText(
			backup.duplicateContactId
		);

		if (!primaryId || !duplicateId ||
			primaryId === duplicateId) {
			throw new Error("Invalid merge contact IDs.");
		}

		//MA-04 history is outside the original 14-column merge/undo backup.
		contactSafeMergeCheckCampaignHistory(ss, [primaryId, duplicateId]);

		//Read the current database records.
		const primary = contactSafeMergeReadMasterContact(
			ss,
			primaryId
		);

		const duplicate = contactSafeMergeReadMasterContact(
			ss,
			duplicateId
		);

		//Reject stale contact information.
		const plan = contactSafeMergePreparePlan(
			backup,
			primary,
			duplicate
		);

		//Only conflict-free merges are supported here.
		if (plan.hasBlockers) {
			throw new Error(
				"Merge contains fields requiring manual resolution."
			);
		}

		//Read the real manual review sheet.
		const reviewSheet = ss.getSheetByName("Potential_Duplicates");

		if (!reviewSheet || reviewSheet.getLastRow() < 2) {
			throw new Error("Manual review record not found.");
		}

		const reviewHeaders = [
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

		const actualReviewHeaders = reviewSheet.getRange(
			1, 1, 1, reviewHeaders.length
		).getDisplayValues()[0];

		if (!reviewHeaders.every((header, index) =>
			actualReviewHeaders[index] === header)) {
			throw new Error("Unexpected review sheet headers.");
		}

		const reviewRows = reviewSheet.getRange(
			2,
			1,
			reviewSheet.getLastRow() - 1,
			reviewHeaders.length
		).getValues();

		const matches = reviewRows.filter(
			row => contactSafeMergeText(row[0]) === backup.matchId
		);

		if (matches.length !== 1) {
			throw new Error("Expected one matching review record.");
		}

		const review = matches[0];

		//Both IDs must identify existing Master_Contacts rows.
		if (contactSafeMergeText(review[1]) !== primaryId ||
			contactSafeMergeText(review[2]) !== duplicateId) {
			throw new Error("Review does not identify both contacts.");
		}

		if (contactSafeMergeText(review[8]) !== "Confirm Duplicate") {
			throw new Error("Merge has not been manually approved.");
		}

		const reviewer = contactSafeMergeText(review[9]);
		const reviewDate = new Date(review[10]);

		if (!reviewer ||
			!Number.isFinite(reviewDate.getTime()) ||
			reviewer !== backup.reviewer) {
			throw new Error("Review metadata does not match backup.");
		}

		//Locate the saved Merge_History entry.
		const historySheet = ss.getSheetByName("Merge_History");

		if (!historySheet || historySheet.getLastRow() < 2) {
			throw new Error("Merge history is missing.");
		}

		const historyRows = historySheet.getRange(
			2, 1, historySheet.getLastRow() - 1, 13
		).getValues();

		const historyMatches = [];

		for (let index = 0; index < historyRows.length; index++) {
			if (contactSafeMergeText(historyRows[index][0]) === id) {
				historyMatches.push({
					row: index + 2,
					values: historyRows[index]
				});
			}
		}

		if (historyMatches.length !== 1) {
			throw new Error("Expected one merge history entry.");
		}

		const historyEntry = historyMatches[0];

		//Compare approval dates against saved history.
		const storedReviewDate = new Date(historyEntry.values[5]);

		if (!Number.isFinite(storedReviewDate.getTime()) ||
			storedReviewDate.getTime() !== reviewDate.getTime()) {
			throw new Error("Review date does not match saved backup.");
		}

		if (historyEntry.values[10] !== "BACKUP_SAVED" ||
			contactSafeMergeText(historyEntry.values[9])) {
			throw new Error("Merge history is not ready.");
		}

		//Prepare the database row.
		const master = ss.getSheetByName("Master_Contacts");

		const masterHeaders = [
			"Contact ID",
			"Name / DJ Alias",
			"Role",
			"Station / Venue / Organization",
			"City",
			"State / Region",
			"Country",
			"Email",
			"Phone",
			"Social Accounts",
			"Sources",
			"Review Status",
			"Review Notes",
			"Last Updated"
		];

		//Do not overwrite spreadsheet formulas.
		for (const rowNumber of [
			primary.sheetRow,
			duplicate.sheetRow
		]) {
			const formulas = master.getRange(
				rowNumber,
				1,
				1,
				masterHeaders.length
			).getFormulas()[0];

			if (formulas.some(Boolean)) {
				throw new Error("Contact contains spreadsheet formulas.");
			}
		}

		const merged = { ...plan.mergedContact };

		const values = masterHeaders.map(header => {
			const value = merged[header];

			if (value === null || value === undefined) {
				return "";
			}

			//Reject formula-like text.
			if (typeof value === "string" && /^[\s]*[=+\-]/.test(value)) {
				throw new Error("Unsafe formula-like contact value.");
			}

			if (value instanceof Date && !Number.isFinite(value.getTime())) {
				throw new Error("Invalid contact date.");
			}

			return value;
		});

		//Save the exact values intended for the database row.
		const mergedForHistory = { ...merged };

		for (let index = 0; index < masterHeaders.length; index++) {
			mergedForHistory[masterHeaders[index]] = values[index];
		}

		const mergedSnapshot = contactMergeHistorySerializeContact(
			mergedForHistory
		);

		const historyRow = historyEntry.row;

		historySheet.getRange(
			historyRow,
			10
		).setValue(mergedSnapshot);

		if (historySheet.getRange(
			historyRow,
			10
		).getValue() !== mergedSnapshot) {
			throw new Error("Merged snapshot verification failed.");
		}

		//Mark the operation as in progress.
		historySheet.getRange(
			historyRow,
			11
		).setValue("APPLYING");

		SpreadsheetApp.flush();

		//Update the surviving contact.
		master.getRange(
			primary.sheetRow,
			1,
			1,
			masterHeaders.length
		).setValues([values]);

		SpreadsheetApp.flush();

		//Verify the written values.
		const written = master.getRange(
			primary.sheetRow,
			1,
			1,
			masterHeaders.length
		).getValues()[0];

		for (let index = 0; index < values.length; index++) {
			const expected = values[index] instanceof Date
				? values[index].getTime()
				: values[index];

			const actual = written[index] instanceof Date
				? written[index].getTime()
				: written[index];

			if (actual !== expected) {
				throw new Error("Merged contact write verification failed.");
			}
		}

		//Delete the duplicate after verifying the primary.
		master.deleteRow(duplicate.sheetRow);

		SpreadsheetApp.flush();

		//Verify the surviving contact.
		const surviving = contactSafeMergeReadMasterContact(
			ss,
			primaryId
		);

		const remainingIds = master.getRange(
			2,
			1,
			master.getLastRow() - 1,
			1
		).getValues().flat();

		if (remainingIds.includes(duplicateId)) {
			throw new Error("Duplicate contact still exists.");
		}

		//Mark the merge as completed.
		historySheet.getRange(
			historyRow,
			11
		).setValue("MERGED");

		historySheet.getRange(
			historyRow,
			12
		).setValue(new Date());

		SpreadsheetApp.flush();

		return {
			mergeId: id,
			primaryContactId: surviving["Contact ID"],
			duplicateContactId: duplicateId,
			status: "MERGED",
			undoAvailable: false
		};
	} finally {
		lock.releaseLock();
	}
}

/**
 * TFB-135: Undo a completed contact merge.
 * Restore both original contacts from a saved backup.
 * Do not run on production until integration tests are complete.
 */
function contactSafeMergeUndo(ss, mergeId) {
	//Validate the request.
	const id = contactSafeMergeText(mergeId);

	if (!ss || !id) {
		throw new Error("Spreadsheet and Merge ID are required.");
	}

	//Prevent overlapping script operations.
	const lock = LockService.getScriptLock();

	if (!lock.tryLock(30000)) {
		throw new Error("Could not acquire undo lock.");
	}

	try {
		//Read the two original contacts from Merge_History.
		const backup = contactMergeHistoryReadBackup(ss, id);

		if (!backup ||
			backup.status !== "MERGED" ||
			backup.backupVerified !== true) {
			throw new Error("A completed merge with verified backup is required.");
		}

		const primaryId = contactSafeMergeText(backup.primaryContactId);
		const duplicateId = contactSafeMergeText(backup.duplicateContactId);

		if (!primaryId || !duplicateId || primaryId === duplicateId) {
			throw new Error("Invalid contact IDs in backup.");
		}

		//Do not restore a 14-column backup over contacts with campaign history.
		contactSafeMergeCheckCampaignHistory(ss, [primaryId, duplicateId]);

		const history = contactMergeHistoryEnsureSheet(ss);
		const historyRow = history.getRange(
			backup.rowNumber,
			1,
			1,
			13
		).getValues()[0];

		//Require the exact completed merge and no earlier undo.
		if (contactSafeMergeText(historyRow[0]) !== id ||
			contactSafeMergeText(historyRow[1]) !== primaryId ||
			contactSafeMergeText(historyRow[2]) !== duplicateId ||
			historyRow[10] !== "MERGED" ||
			contactSafeMergeText(historyRow[12])) {
			throw new Error("Merge history is not ready for undo.");
		}

		let mergedSnapshot;

		try {
			mergedSnapshot = JSON.parse(historyRow[9]);
		} catch (error) {
			throw new Error("Invalid merged snapshot.");
		}

		if (!mergedSnapshot ||
			typeof mergedSnapshot !== "object" ||
			Array.isArray(mergedSnapshot) ||
			mergedSnapshot["Contact ID"] !== primaryId) {
			throw new Error("Merged snapshot does not match primary contact.");
		}

		//Validate saved snapshot values before editing the database.
		contactMergeHistorySerializeContact(mergedSnapshot);

		const currentPrimary = contactSafeMergeReadMasterContact(
			ss,
			primaryId
		);

		const master = ss.getSheetByName("Master_Contacts");
		const headers = [
			"Contact ID",
			"Name / DJ Alias",
			"Role",
			"Station / Venue / Organization",
			"City",
			"State / Region",
			"Country",
			"Email",
			"Phone",
			"Social Accounts",
			"Sources",
			"Review Status",
			"Review Notes",
			"Last Updated"
		];

		//Never overwrite a contact already using the duplicate ID.
		const ids = master.getRange(
			2,
			1,
			master.getLastRow() - 1,
			1
		).getValues().flat();

		if (ids.includes(duplicateId)) {
			throw new Error("Duplicate contact already exists.");
		}

		//Compare dates in either Date or serialized ISO form.
		function comparableValue(value) {
			if (Object.prototype.toString.call(value) === "[object Date]") {
				if (!Number.isFinite(value.getTime())) {
					throw new Error("Invalid contact date.");
				}

				return value.toISOString();
			}

			return value;
		}

		//Stop if the surviving contact was changed after the merge.
		for (const header of headers) {
			if (!Object.prototype.hasOwnProperty.call(mergedSnapshot, header)) {
				throw new Error("Incomplete merged snapshot: " + header);
			}

			if (comparableValue(currentPrimary[header]) !==
				comparableValue(mergedSnapshot[header])) {
				throw new Error("Contact changed after merge: " + header);
			}
		}

		//Do not replace formulas in the surviving contact.
		const formulas = master.getRange(
			currentPrimary.sheetRow,
			1,
			1,
			headers.length
		).getFormulas()[0];

		if (formulas.some(Boolean)) {
			throw new Error("Cannot undo contact containing formulas.");
		}

		//Validate and prepare both original rows before changing anything.
		function restoreValues(record, expectedId) {
			if (!record ||
				typeof record !== "object" ||
				Array.isArray(record) ||
				record["Contact ID"] !== expectedId) {
				throw new Error("Invalid original contact backup.");
			}

			return headers.map(header => {
				if (!Object.prototype.hasOwnProperty.call(record, header)) {
					throw new Error("Missing original field: " + header);
				}

				let value = record[header];

				if (value === null) {
					return "";
				}

				if (!["string", "number", "boolean"].includes(typeof value)) {
					throw new Error("Unsupported original field: " + header);
				}

				if (typeof value === "number" && !Number.isFinite(value)) {
					throw new Error("Invalid original number: " + header);
				}

				//Prevent spreadsheet formula injection.
				if (typeof value === "string" && /^\s*[=+\-]/.test(value)) {
					throw new Error("Unsafe original field: " + header);
				}

				//Restore date types when the current column is a Date.
				if (header === "Last Updated" &&
					typeof value === "string" &&
					/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
					Object.prototype.toString.call(currentPrimary[header]) === "[object Date]") {
					value = new Date(value);

					if (!Number.isFinite(value.getTime())) {
						throw new Error("Invalid original date.");
					}
				}

				return value;
			});
		}

		const primaryValues = restoreValues(backup.primaryBefore, primaryId);
		const duplicateValues = restoreValues(backup.duplicateBefore, duplicateId);
		const duplicateRow = master.getLastRow() + 1;

		if (duplicateRow > master.getMaxRows()) {
			master.insertRowsAfter(
				master.getMaxRows(),
				duplicateRow - master.getMaxRows()
			);
		}

		//Mark progress before modifying Master_Contacts.
		history.getRange(backup.rowNumber, 11).setValue("UNDOING");
		SpreadsheetApp.flush();

		//Restore the deleted record first.
		master.getRange(
			duplicateRow,
			1,
			1,
			headers.length
		).setValues([duplicateValues]);
		SpreadsheetApp.flush();

		const restoredDuplicate = contactSafeMergeReadMasterContact(
			ss,
			duplicateId
		);

		for (let index = 0; index < headers.length; index++) {
			if (comparableValue(restoredDuplicate[headers[index]]) !==
				comparableValue(duplicateValues[index])) {
				throw new Error(
					"Duplicate restore verification failed: " + headers[index]
				);
			}
		}

		//Restore the primary record to its original values.
		master.getRange(
			currentPrimary.sheetRow,
			1,
			1,
			headers.length
		).setValues([primaryValues]);
		SpreadsheetApp.flush();

		const restoredPrimary = contactSafeMergeReadMasterContact(
			ss,
			primaryId
		);

		for (let index = 0; index < headers.length; index++) {
			if (comparableValue(restoredPrimary[headers[index]]) !==
				comparableValue(primaryValues[index])) {
				throw new Error(
					"Primary restore verification failed: " + headers[index]
				);
			}
		}

		//Finish the audit trail only after both records are verified.
		history.getRange(backup.rowNumber, 13).setValue(new Date());
		history.getRange(backup.rowNumber, 11).setValue("UNDONE");
		SpreadsheetApp.flush();

		return {
			mergeId: id,
			primaryContactId: primaryId,
			duplicateContactId: duplicateId,
			status: "UNDONE",
			contactsRestored: 2
		};
	} finally {
		lock.releaseLock();
	}
}

// Temporary MA-04 compatibility guard, not a new matching or merge policy.
// MA-05 must include campaign history and notes in merge/undo before removing it.
function contactSafeMergeCheckCampaignHistory(ss, contactIds) {
  const sheet = ss.getSheetByName("Master_Contacts");
  if (!sheet || sheet.getLastRow() < 2) return;
  const values = sheet.getDataRange().getDisplayValues();
  const idCol = values[0].indexOf("Contact ID");
  const historyCol = values[0].indexOf("Campaign History Data");
  if (historyCol < 0) return;
  if (idCol < 0) throw Error("Contact ID column missing.");
  const targetIds = new Set(contactIds);
  for (const row of values.slice(1)) {
    const history = String(row[historyCol] || "").trim();
    if (targetIds.has(String(row[idCol]).trim()) && history && history !== "[]") {
      throw Error("MA-05 must support campaign history in merge/undo before merging or undoing this contact.");
    }
  }
}
