
// MA-05: DJ Merge Integration (safe preparation phase)
// Preserve MA-04 campaign history before using MA-02 Safe Merge & Undo.
// This module prepares and saves backups. It NEVER merges or deletes contacts.

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

// Capture all seven MA-04 values, plus the human-readable note.
// The first 14 contact columns are still covered by MA-02's existing backup.
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

	// Reuse MA-04's validator; never replace corrupt JSON with [].
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

// Do not silently choose between contradictory reports with the same ID.
function djMergeCombineCampaigns(primaryHistory, duplicateHistory) {
	const byReport = new Map();

	for (const entry of [...primaryHistory, ...duplicateHistory]) {
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

// Do not leave engagement audit records pointing to a deleted contact.
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

// Validate the existing MA-02 backup before preparing a DJ history merge.
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

	// Verify the original MA-02 contact fields have not changed.
	const primaryContact = contactSafeMergeReadMasterContact(
		ss, primaryId
	);

	const duplicateContact = contactSafeMergeReadMasterContact(
		ss, duplicateId
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

	// Reject merges that would strand existing engagement audit links.
	djMergeCheckEngagementReferences(ss, duplicateId);

	const primary = djMergeReadCampaignSnapshot(
		ss, primaryId
	);

	const duplicate = djMergeReadCampaignSnapshot(
		ss, duplicateId
	);

	const combined = djMergeCombineCampaigns(
		primary.history,
		duplicate.history
	);

	// Reuse MA-04 to construct the display fields.
	const view = campaignHistoryPresentation(combined);

	const merged = {
		contactId: primaryId,
		fields: {},
		note: view.note,
		history: combined
	};

	for (let i = 0; i < DJ_MERGE_CAMPAIGN_HEADERS.length - 1; i++) {
		merged.fields[DJ_MERGE_CAMPAIGN_HEADERS[i]] =
			view.values[i];
	}

	merged.fields["Campaign History Data"] =
		JSON.stringify(combined);

	// Check MA-04's safe cell-size limit before writing anything.
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

// Create or validate the dedicated campaign backup sheet.
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
			(header, i) => headers[i] === header
		)) {
			throw new Error(
				"Unexpected DJ_Merge_History headers."
			);
		}
	}

	return sheet;
}

// Read a previously saved MA-04 merge backup.
function djMergeReadSavedBackup(ss, mergeId) {
	const sheet = ss.getSheetByName(DJ_MERGE_BACKUP_SHEET);

	if (!sheet || sheet.getLastRow() < 2) {
		return null;
	}

	const headers = sheet.getRange(
		1, 1, 1, DJ_MERGE_BACKUP_HEADERS.length
	).getDisplayValues()[0];

	if (!DJ_MERGE_BACKUP_HEADERS.every(
		(header, i) => headers[i] === header
	)) {
		throw new Error(
			"Unexpected DJ_Merge_History headers."
		);
	}

	const rows = sheet.getRange(
		2, 1, sheet.getLastRow() - 1,
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

// Save the original histories and the planned merged history.
// This function DOES NOT apply a merge.
function djMergeSaveBackup(ss, mergeId) {
	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const plan = djMergePrepare(ss, mergeId);

		const prior = djMergeReadSavedBackup(
			ss, plan.mergeId
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

		// A repeated call must not create another backup.
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
			nextRow, 1, 1, DJ_MERGE_BACKUP_HEADERS.length
		).setValues([[
			plan.mergeId,
			plan.primaryId,
			plan.duplicateId,
			...serialized,
			"PREPARED",
			new Date()
		]]);

		// Read back the persisted backup.
		const checked = djMergeReadSavedBackup(
			ss, plan.mergeId
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
		lock.releaseLock();
	}
}

// Prepare an MA-04 Undo without modifying either contact.
// Actual MA-02 Undo remains guarded until integration is tested.
function djMergePrepareUndo(ss, mergeId) {
	const id = djMergeText(mergeId);

	if (!ss || !id) {
		throw new Error(
			"Spreadsheet and Merge ID are required."
		);
	}

	const ma02 = contactMergeHistoryReadBackup(ss, id);

	if (!ma02 ||
		ma02.status !== "MERGED" ||
		ma02.backupVerified !== true) {
		throw new Error(
			"Completed MA-02 merge is required for undo."
		);
	}

	const saved = djMergeReadSavedBackup(ss, id);

	if (!saved ||
		saved.primaryId !== ma02.primaryContactId ||
		saved.duplicateId !== ma02.duplicateContactId) {
		throw new Error(
			"Verified MA-04 campaign backup is required for undo."
		);
	}

	// Reject Undo if new campaign activity was added after the merge.
	const current = djMergeReadCampaignSnapshot(
		ss, saved.primaryId
	);

	if (JSON.stringify(current.fields) !==
		JSON.stringify(saved.merged.fields) ||
		current.note !== saved.merged.note) {
		throw new Error(
			"Campaign history changed after merge; unsafe to undo."
		);
	}

	const sheet = ss.getSheetByName("Master_Contacts");

	const headers = sheet.getRange(
		1, 1, 1, sheet.getLastColumn()
	).getDisplayValues()[0];

	const idCol = djMergeHeaderPositions(
		headers, ["Contact ID"]
	)["Contact ID"];

	const ids = sheet.getRange(
		2, idCol + 1, sheet.getLastRow() - 1, 1
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
