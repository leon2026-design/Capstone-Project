// MA-05: DJ Merge Integration
// Preserve MA-04 campaign history before MA-02 Safe Merge & Undo.
// This module prepares and saves backups.
// Actual Merge and Undo integration is handled separately.

const DJ_MERGE_BACKUP_SHEET = "DJ_Merge_History";

const DJ_MERGE_BACKUP_HEADERS = [
	"Merge ID", "Primary Contact ID", "Duplicate Contact ID",
	"Primary Campaign Snapshot", "Duplicate Campaign Snapshot",
	"Merged Campaign Snapshot", "Status", "Created At"
];

const DJ_MERGE_CAMPAIGN_HEADERS = [
	"Latest Campaign", "Campaign Status", "Campaign Rating",
	"Favorite Track", "Campaign Feedback", "Activity Time",
	"Campaign History Data"
];

function djMergeText(value) {
	return String(value == null ? "" : value).trim();
}

// Find required column positions and reject missing or duplicate headers.
function djMergeHeaderPositions(headers, required) {
	const positions = {};

	for (const header of required) {
		const first = headers.indexOf(header);

		if (first < 0 || headers.lastIndexOf(header) !== first) {
			throw new Error(
				"Expected exactly one Master_Contacts column: " + header
			);
		}

		positions[header] = first;
	}

	return positions;
}

// Capture all seven MA-04 campaign fields and the display note.
// MA-02 separately backs up the original 14 contact columns.
function djMergeReadCampaignSnapshot(ss, contactId) {
	const id = djMergeText(contactId);
	const sheet = ss && ss.getSheetByName("Master_Contacts");

	if (!id || !sheet || sheet.getLastRow() < 2) {
		throw new Error("Master_Contacts or Contact ID is missing.");
	}

	const headers = sheet.getRange(
		1, 1, 1, sheet.getLastColumn()
	).getDisplayValues()[0];

	const positions = djMergeHeaderPositions(
		headers,
		["Contact ID", ...DJ_MERGE_CAMPAIGN_HEADERS]
	);

	const values = sheet.getRange(
		2, 1, sheet.getLastRow() - 1, headers.length
	).getValues();

	const matches = [];

	for (let index = 0; index < values.length; index++) {
		if (djMergeText(
			values[index][positions["Contact ID"]]
		) === id) {
			matches.push({
				rowNumber: index + 2,
				row: values[index]
			});
		}
	}

	if (matches.length !== 1) {
		throw new Error(
			"Expected exactly one campaign contact: " + id
		);
	}

	const found = matches[0];
	const fields = {};

	for (const header of DJ_MERGE_CAMPAIGN_HEADERS) {
		const value = found.row[positions[header]];

		if (typeof value !== "string" &&
			value !== null &&
			value !== undefined) {
			throw new Error(
				"Non-text campaign field: " + header
			);
		}

		fields[header] = value == null ? "" : value;

		const formulas = sheet.getRange(
			found.rowNumber,
			positions[header] + 1
		).getFormulas()[0];

		if (formulas.some(Boolean)) {
			throw new Error(
				"Campaign field contains a formula: " + header
			);
		}
	}

	// Reuse MA-04's strict history validation.
	// Never silently discard invalid campaign history.
	const history = parseSavedCampaignHistory(
		fields["Campaign History Data"],
		id
	);

	const note = sheet.getRange(
		found.rowNumber,
		positions["Latest Campaign"] + 1
	).getNote();

	return {
		contactId: id,
		fields: fields,
		note: note,
		history: history
	};
}

// Combine histories while rejecting contradictory entries.
function djMergeCombineCampaigns(primaryHistory, duplicateHistory) {
	const byReport = new Map();

	for (const entry of [
		...primaryHistory,
		...duplicateHistory
	]) {
		const existing = byReport.get(entry.reportId);

		if (existing &&
			JSON.stringify(existing) !== JSON.stringify(entry)) {
			throw new Error(
				"Conflicting campaign history for report: " +
				entry.reportId
			);
		}

		if (!existing) {
			byReport.set(entry.reportId, { ...entry });
		}
	}

	return [...byReport.values()];
}

// Prevent deleting a contact referenced by engagement audit records.
function djMergeCheckEngagementReferences(ss, duplicateId) {
	const sheet = ss.getSheetByName("DJ_Engagement_Links");

	if (!sheet || sheet.getLastRow() < 2) {
		return;
	}

	const values = sheet.getDataRange().getDisplayValues();
	const headers = values[0];

	const columns = djMergeHeaderPositions(
		headers,
		["Contact ID"]
	);

	if (values.slice(1).some(row =>
		djMergeText(row[columns["Contact ID"]]) === duplicateId)) {
		throw new Error(
			"Duplicate contact has engagement audit links; " +
			"relinking is required before merge."
		);
	}
}

// Prepare a DJ campaign merge using the existing verified MA-02 backup.
function djMergePrepare(ss, mergeId) {
	const id = djMergeText(mergeId);

	if (!ss || !id) {
		throw new Error(
			"Spreadsheet and Merge ID are required."
		);
	}

	const backup = contactMergeHistoryReadBackup(ss, id);

	if (!backup ||
		backup.status !== "BACKUP_SAVED" ||
		backup.backupVerified !== true) {
		throw new Error(
			"Verified MA-02 backup is required."
		);
	}

	const primaryId = djMergeText(backup.primaryContactId);
	const duplicateId = djMergeText(backup.duplicateContactId);

	if (!primaryId || !duplicateId ||
		primaryId === duplicateId) {
		throw new Error("Invalid merge Contact IDs.");
	}

	// Verify that original MA-02 contact fields have not changed.
	const primaryContact = contactSafeMergeReadMasterContact(
		ss,
		primaryId
	);

	const duplicateContact = contactSafeMergeReadMasterContact(
		ss,
		duplicateId
	);

	const basePlan = contactSafeMergePreparePlan(
		backup,
		primaryContact,
		duplicateContact
	);

	if (basePlan.hasBlockers) {
		throw new Error(
			"MA-02 merge has unresolved contact field blockers."
		);
	}

	djMergeCheckEngagementReferences(ss, duplicateId);

	const primary = djMergeReadCampaignSnapshot(
		ss,
		primaryId
	);

	const duplicate = djMergeReadCampaignSnapshot(
		ss,
		duplicateId
	);

	const combined = djMergeCombineCampaigns(
		primary.history,
		duplicate.history
	);

	// Use MA-04's presentation function to rebuild display fields.
	const view = campaignHistoryPresentation(combined);

	const merged = {
		contactId: primaryId,
		fields: {},
		note: view.note,
		history: combined
	};

	for (
		let i = 0;
		i < DJ_MERGE_CAMPAIGN_HEADERS.length - 1;
		i++
	) {
		merged.fields[DJ_MERGE_CAMPAIGN_HEADERS[i]] =
			view.values[i];
	}

	merged.fields["Campaign History Data"] =
		JSON.stringify(combined);

	// Respect MA-04's maximum safe cell length.
	for (const value of [
		...Object.values(merged.fields),
		merged.note
	]) {
		if (value.length > 40000) {
			throw new Error(
				"Merged campaign history exceeds the MA-04 size limit."
			);
		}
	}

	return {
		mergeId: id,
		primaryId: primaryId,
		duplicateId: duplicateId,
		primary: primary,
		duplicate: duplicate,
		merged: merged
	};
}

// Create or validate the campaign merge backup sheet.
function djMergeEnsureBackupSheet(ss) {
	let sheet = ss.getSheetByName(DJ_MERGE_BACKUP_SHEET);

	if (!sheet) {
		sheet = ss.insertSheet(DJ_MERGE_BACKUP_SHEET);
	}

	if (sheet.getLastRow() === 0) {
		sheet.getRange(
			1, 1, 1, DJ_MERGE_BACKUP_HEADERS.length
		).setValues([DJ_MERGE_BACKUP_HEADERS]);

		sheet.setFrozenRows(1);
	} else {
		const headers = sheet.getRange(
			1, 1, 1, DJ_MERGE_BACKUP_HEADERS.length
		).getDisplayValues()[0];

		if (!DJ_MERGE_BACKUP_HEADERS.every(
			(header, index) => headers[index] === header
		)) {
			throw new Error(
				"Unexpected DJ_Merge_History headers."
			);
		}
	}

	return sheet;
}

// Read a previously saved campaign merge backup.
function djMergeReadSavedBackup(ss, mergeId) {
	const sheet = ss.getSheetByName(DJ_MERGE_BACKUP_SHEET);

	if (!sheet || sheet.getLastRow() < 2) {
		return null;
	}

	const headers = sheet.getRange(
		1, 1, 1, DJ_MERGE_BACKUP_HEADERS.length
	).getDisplayValues()[0];

	if (!DJ_MERGE_BACKUP_HEADERS.every(
		(header, index) => headers[index] === header
	)) {
		throw new Error(
			"Unexpected DJ_Merge_History headers."
		);
	}

	const rows = sheet.getRange(
		2, 1,
		sheet.getLastRow() - 1,
		DJ_MERGE_BACKUP_HEADERS.length
	).getValues();

	const matches = rows.filter(row =>
		djMergeText(row[0]) === djMergeText(mergeId)
	);

	if (matches.length > 1) {
		throw new Error("Duplicate DJ merge backups.");
	}

	if (!matches.length) {
		return null;
	}

	const row = matches[0];

	if (row[6] !== "PREPARED") {
		throw new Error(
			"DJ merge backup is not in PREPARED status."
		);
	}

	let primary;
	let duplicate;
	let merged;

	try {
		primary = JSON.parse(row[3]);
		duplicate = JSON.parse(row[4]);
		merged = JSON.parse(row[5]);
	} catch (_) {
		throw new Error("Corrupt DJ merge backup JSON.");
	}

	if (!primary || !duplicate || !merged ||
		primary.contactId !== row[1] ||
		duplicate.contactId !== row[2] ||
		merged.contactId !== row[1]) {
		throw new Error(
			"DJ merge backup has mismatched Contact IDs."
		);
	}

	return {
		mergeId: djMergeText(row[0]),
		primaryId: row[1],
		duplicateId: row[2],
		primary: primary,
		duplicate: duplicate,
		merged: merged,
		status: row[6]
	};
}

// Save all campaign snapshots before the actual merge.
// The optional flag prevents acquiring MA-02's existing lock twice.
function djMergeSaveBackup(ss, mergeId, lockAlreadyHeld = false) {
	// When called inside MA-02, its script lock is already held.
	// Only a caller that already owns the lock may set this flag to true.
	const lock = lockAlreadyHeld
		? null
		: LockService.getScriptLock();

	if (lock) {
		lock.waitLock(10000);
	}

	try {
		const plan = djMergePrepare(ss, mergeId);

		const prior = djMergeReadSavedBackup(
			ss,
			plan.mergeId
		);

		const serialized = [
			plan.primary,
			plan.duplicate,
			plan.merged
		].map(snapshot => JSON.stringify(snapshot));

		if (serialized.some(value => value.length > 40000)) {
			throw new Error(
				"DJ merge backup exceeds the safe cell size."
			);
		}

		// Repeated backup calls must be idempotent.
		if (prior) {
			const existing = [
				prior.primary,
				prior.duplicate,
				prior.merged
			].map(snapshot => JSON.stringify(snapshot));

			if (prior.primaryId !== plan.primaryId ||
				prior.duplicateId !== plan.duplicateId ||
				existing.some(
					(value, index) => value !== serialized[index]
				)) {
				throw new Error(
					"Saved DJ merge backup differs from current contact data."
				);
			}

			return {
				mergeId: plan.mergeId,
				status: "PREPARED",
				alreadySaved: true
			};
		}

		const sheet = djMergeEnsureBackupSheet(ss);
		const nextRow = sheet.getLastRow() + 1;

		if (nextRow > sheet.getMaxRows()) {
			sheet.insertRowsAfter(
				sheet.getMaxRows(),
				nextRow - sheet.getMaxRows()
			);
		}

		sheet.getRange(
			nextRow,
			1,
			1,
			DJ_MERGE_BACKUP_HEADERS.length
		).setValues([[
			plan.mergeId,
			plan.primaryId,
			plan.duplicateId,
			...serialized,
			"PREPARED",
			new Date()
		]]);

		// Verify that all snapshots were persisted.
		const checked = djMergeReadSavedBackup(
			ss,
			plan.mergeId
		);

		if (!checked ||
			JSON.stringify(checked.merged) !== serialized[2]) {
			throw new Error(
				"DJ merge backup verification failed."
			);
		}

		return {
			mergeId: plan.mergeId,
			status: "PREPARED",
			alreadySaved: false
		};
	} finally {
		// Never release a lock owned by the calling MA-02 function.
		if (lock) {
			lock.releaseLock();
		}
	}
}

// Check whether the original campaign history can safely be restored.
// This function does not change either contact.
function djMergePrepareUndo(ss, mergeId) {
	const id = djMergeText(mergeId);

	if (!ss || !id) {
		throw new Error(
			"Spreadsheet and Merge ID are required."
		);
	}

	const ma02 = contactMergeHistoryReadBackup(
		ss,
		id
	);

	if (!ma02 ||
		ma02.status !== "MERGED" ||
		ma02.backupVerified !== true) {
		throw new Error(
			"Completed MA-02 merge is required for undo."
		);
	}

	const saved = djMergeReadSavedBackup(
		ss,
		id
	);

	if (!saved ||
		saved.primaryId !== ma02.primaryContactId ||
		saved.duplicateId !== ma02.duplicateContactId) {
		throw new Error(
			"Verified MA-04 campaign backup is required for undo."
		);
	}

	// Reject Undo if campaign activity was added or changed after Merge.
	const current = djMergeReadCampaignSnapshot(
		ss,
		saved.primaryId
	);

	if (!djMergeCampaignSnapshotsEqual(current, saved.merged) ||
		JSON.stringify(current.history) !==
		JSON.stringify(saved.merged.history)) {
		throw new Error(
			"Campaign history changed after merge; unsafe to undo."
		);
	}

	const sheet = ss.getSheetByName("Master_Contacts");

	const headers = sheet.getRange(
		1, 1, 1, sheet.getLastColumn()
	).getDisplayValues()[0];

	const idCol = djMergeHeaderPositions(
		headers,
		["Contact ID"]
	)["Contact ID"];

	const ids = sheet.getRange(
		2,
		idCol + 1,
		sheet.getLastRow() - 1,
		1
	).getDisplayValues().map(row => djMergeText(row[0]));

	if (ids.includes(saved.duplicateId)) {
		throw new Error(
			"Duplicate contact already exists; unsafe to undo."
		);
	}

	return {
		mergeId: id,
		primaryId: saved.primaryId,
		duplicateId: saved.duplicateId,
		primaryRestore: saved.primary,
		duplicateRestore: saved.duplicate,
		status: "UNDO_READY"
	};
}



// MA-05: Verify campaign data while MA-02 already owns the script lock.
// Never delete MA-04 data without a verified campaign backup.

function djMergeCampaignComparable(value) {
	const text = String(value == null ? "" : value);
	return /^'(?=[=+\-@])/.test(text) ? text.slice(1) : text;
}

function djMergeCampaignSnapshotsEqual(actual, expected) {
	if (!actual || !expected || actual.contactId !== expected.contactId ||
		actual.note !== expected.note || !actual.fields || !expected.fields) {
		return false;
	}

	for (const header of DJ_MERGE_CAMPAIGN_HEADERS) {
		if (!Object.prototype.hasOwnProperty.call(expected.fields, header) ||
			djMergeCampaignComparable(actual.fields[header]) !==
			djMergeCampaignComparable(expected.fields[header])) {
			return false;
		}
	}

	return true;
}

// Detect MA-04 data that would be lost by an unprotected legacy merge.
function djMergeHasUnprotectedCampaignData(ss, contactIds) {
	const sheet = ss.getSheetByName("Master_Contacts");

	if (!sheet || sheet.getLastRow() < 2) {
		return false;
	}

	const grid = sheet.getDataRange().getDisplayValues();
	const headers = grid[0];

	const present = DJ_MERGE_CAMPAIGN_HEADERS.filter(
		header => headers.includes(header)
	);

	if (!present.length) {
		return false;
	}

	if (present.length !== DJ_MERGE_CAMPAIGN_HEADERS.length) {
		throw new Error("Incomplete MA-04 campaign columns in Master_Contacts.");
	}

	const columns = djMergeHeaderPositions(
		headers, ["Contact ID", ...DJ_MERGE_CAMPAIGN_HEADERS]
	);

	const targets = new Set(contactIds);

	for (let i = 1; i < grid.length; i++) {
		if (!targets.has(djMergeText(grid[i][columns["Contact ID"]]))) {
			continue;
		}

		if (DJ_MERGE_CAMPAIGN_HEADERS.some(
			header => djMergeText(grid[i][columns[header]])
		)) {
			return true;
		}

		if (sheet.getRange(
			i + 1, columns["Latest Campaign"] + 1
		).getNote()) {
			return true;
		}
	}

	return false;
}

// Require a matching prepared backup before an MA-04 campaign merge.
function djMergeReadyForApply(ss, mergeId, primaryId, duplicateId) {
	const saved = djMergeReadSavedBackup(ss, mergeId);

	if (!saved) {
		// Legacy merges without campaign data follow the original MA-02 flow.
		contactSafeMergeCheckCampaignHistory(ss, [primaryId, duplicateId]);

		if (djMergeHasUnprotectedCampaignData(
			ss, [primaryId, duplicateId]
		)) {
			throw new Error("MA-05 campaign backup is required before merge.");
		}

		return null;
	}

	if (saved.primaryId !== primaryId ||
		saved.duplicateId !== duplicateId) {
		throw new Error("Campaign backup Contact IDs do not match MA-02.");
	}

	// Recheck both saved contacts and their complete campaign history.
	const plan = djMergePrepare(ss, mergeId);

	for (const field of ["primary", "duplicate", "merged"]) {
		if (!djMergeCampaignSnapshotsEqual(
			plan[field], saved[field]
		) || JSON.stringify(plan[field].history) !==
			JSON.stringify(saved[field].history)) {
			throw new Error(
				"Campaign data changed since DJ merge backup: " + field
			);
		}
	}

	return saved;
}

// Reject unsafe Undo before MA-02 changes either contact.
function djMergeReadyForUndo(ss, mergeId, primaryId, duplicateId) {
	const saved = djMergeReadSavedBackup(ss, mergeId);

	if (!saved) {
		contactSafeMergeCheckCampaignHistory(ss, [primaryId, duplicateId]);

		if (djMergeHasUnprotectedCampaignData(
			ss, [primaryId, duplicateId]
		)) {
			throw new Error("MA-05 campaign backup is required before undo.");
		}

		return null;
	}

	if (saved.primaryId !== primaryId ||
		saved.duplicateId !== duplicateId) {
		throw new Error("DJ Undo Contact IDs do not match MA-02.");
	}

	return djMergePrepareUndo(ss, mergeId);
}

// Write all seven MA-04 fields and their original note.
function djMergeWriteCampaignSnapshot(ss, rowNumber, snapshot) {
	if (!snapshot || !snapshot.contactId || !snapshot.fields ||
		!Array.isArray(snapshot.history)) {
		throw new Error("Complete DJ campaign snapshot is required.");
	}

	const sheet = ss.getSheetByName("Master_Contacts");

	const headers = sheet.getRange(
		1, 1, 1, sheet.getLastColumn()
	).getDisplayValues()[0];

	const columns = djMergeHeaderPositions(
		headers, ["Contact ID", ...DJ_MERGE_CAMPAIGN_HEADERS]
	);

	const actualId = djMergeText(sheet.getRange(
		rowNumber, columns["Contact ID"] + 1
	).getValue());

	if (actualId !== snapshot.contactId) {
		throw new Error("Campaign write target Contact ID changed.");
	}

	// Validate saved JSON before modifying any cells.
	const parsed = parseSavedCampaignHistory(
		snapshot.fields["Campaign History Data"],
		snapshot.contactId
	);

	if (JSON.stringify(parsed) !== JSON.stringify(snapshot.history)) {
		throw new Error("Campaign snapshot JSON does not match its history.");
	}

	// Reject invalid values and spreadsheet formulas.
	for (const header of DJ_MERGE_CAMPAIGN_HEADERS) {
		const value = snapshot.fields[header];

		if (typeof value !== "string" || value.length > 40000) {
			throw new Error("Invalid campaign field: " + header);
		}

		const formulas = sheet.getRange(
			rowNumber, columns[header] + 1
		).getFormulas()[0];

		if (formulas.some(Boolean)) {
			throw new Error("Campaign target contains a formula: " + header);
		}
	}

	if (typeof snapshot.note !== "string" ||
		snapshot.note.length > 40000) {
		throw new Error("Invalid campaign note.");
	}

	// Write source-of-truth history before the display fields.
	const order = [
		"Campaign History Data",
		...DJ_MERGE_CAMPAIGN_HEADERS.slice(0, 6)
	];

	for (const header of order) {
		const value = snapshot.fields[header];

		sheet.getRange(
			rowNumber, columns[header] + 1
		).setValue(
			/^[=+\-@]/.test(value) ? "'" + value : value
		);
	}

	sheet.getRange(
		rowNumber, columns["Latest Campaign"] + 1
	).setNote(snapshot.note);

	SpreadsheetApp.flush();

	// Leave APPLYING or UNDOING active if verification fails.
	djMergeVerifyCampaignSnapshot(
		ss, snapshot.contactId, snapshot
	);
}

// Verify the entire campaign snapshot after writing or restoring.
function djMergeVerifyCampaignSnapshot(ss, contactId, snapshot) {
	const current = djMergeReadCampaignSnapshot(ss, contactId);

	if (!djMergeCampaignSnapshotsEqual(current, snapshot) ||
		JSON.stringify(current.history) !==
		JSON.stringify(snapshot.history)) {
		throw new Error(
			"DJ campaign write verification failed: " + contactId
		);
	}

	return true;
}
