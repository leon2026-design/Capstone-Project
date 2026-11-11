    // MA-05: Recover interrupted DJ merges without overwriting new information.
	// Recovery is limited to verified checkpoints and never skips manual approval.

	const DJ_MERGE_RECOVERY_CONTACT_HEADERS = [
		"Contact ID", "Name / DJ Alias", "Role", "Station / Venue / Organization",
		"City", "State / Region", "Country", "Email", "Phone",
		"Social Accounts", "Sources", "Review Status", "Review Notes", "Last Updated"
	];

	function djMergeRecoveryText(value) {
		return String(value == null ? "" : value).trim();
	}

	// Read interrupted states directly because MA-02's normal reader rejects them.
	function djMergeRecoveryReadHistory(ss, mergeId) {
		const sheet = ss.getSheetByName("Merge_History");

		if (!sheet || sheet.getLastRow() < 2) {
			throw new Error("Merge_History backup is missing.");
		}

		const headers = sheet.getRange(1, 1, 1, 13).getDisplayValues()[0];

		if (!CONTACT_MERGE_HISTORY_HEADERS.every(
			(header, index) => headers[index] === header
		)) {
			throw new Error("Unexpected Merge_History headers.");
		}

		const rows = sheet.getRange(
			2, 1, sheet.getLastRow() - 1, 13
		).getValues();

		const matches = [];

		for (let index = 0; index < rows.length; index++) {
			if (djMergeRecoveryText(rows[index][0]) === mergeId) {
				matches.push({
					rowNumber: index + 2,
					values: rows[index]
				});
			}
		}

		if (matches.length !== 1) {
			throw new Error("Expected exactly one interrupted merge record.");
		}

		const record = matches[0];
		const row = record.values;

		if (!["APPLYING", "UNDOING"].includes(row[10])) {
			throw new Error(
				"Only APPLYING and UNDOING merges can be recovered."
			);
		}

		if (!djMergeRecoveryText(row[1]) ||
			!djMergeRecoveryText(row[2]) ||
			row[1] === row[2] ||
			!djMergeRecoveryText(row[3]) ||
			!djMergeRecoveryText(row[4]) ||
			!Number.isFinite(new Date(row[5]).getTime())) {
			throw new Error("Interrupted merge metadata is invalid.");
		}

		let primaryBefore;
		let duplicateBefore;
		let merged;

		try {
			primaryBefore = JSON.parse(row[7]);
			duplicateBefore = JSON.parse(row[8]);
			merged = JSON.parse(row[9]);
		} catch (_) {
			throw new Error("Interrupted merge backup JSON is invalid.");
		}

		for (const [recordName, contact, expectedId] of [
			["primary", primaryBefore, row[1]],
			["duplicate", duplicateBefore, row[2]],
			["merged", merged, row[1]]
		]) {
			if (!contact ||
				Array.isArray(contact) ||
				typeof contact !== "object" ||
				contact["Contact ID"] !== expectedId) {
				throw new Error(
					"Invalid " + recordName + " contact backup."
				);
			}

			for (const header of DJ_MERGE_RECOVERY_CONTACT_HEADERS) {
				if (!Object.prototype.hasOwnProperty.call(contact, header)) {
					throw new Error(
						"Incomplete " + recordName +
						" contact backup: " + header
					);
				}
			}

			contactMergeHistorySerializeContact(contact);
		}

		return {
			sheet,
			rowNumber: record.rowNumber,
			status: row[10],
			mergeId,
			primaryId: row[1],
			duplicateId: row[2],
			matchId: row[3],
			reviewer: row[4],
			reviewDate: new Date(row[5]).getTime(),
			primaryBefore,
			duplicateBefore,
			merged
		};
	}

	// Confirm that the original human approval is still valid.
	function djMergeRecoveryApprovalValid(ss, record) {
		const sheet = ss.getSheetByName("Potential_Duplicates");

		if (!sheet || sheet.getLastRow() < 2) {
			return false;
		}

		const headers = sheet.getRange(
			1, 1, 1, 11
		).getDisplayValues()[0];

		const required = [
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

		if (!required.every(
			(header, index) => headers[index] === header
		)) {
			return false;
		}

		const rows = sheet.getRange(
			2, 1, sheet.getLastRow() - 1, 11
		).getValues();

		const matches = rows.filter(row =>
			djMergeRecoveryText(row[0]) === record.matchId
		);

		return matches.length === 1 &&
			djMergeRecoveryText(matches[0][1]) === record.primaryId &&
			djMergeRecoveryText(matches[0][2]) === record.duplicateId &&
			djMergeRecoveryText(matches[0][8]) === "Confirm Duplicate" &&
			djMergeRecoveryText(matches[0][9]) === record.reviewer &&
			new Date(matches[0][10]).getTime() === record.reviewDate;
	}

	// Read a contact without assuming that it still exists after interruption.
	function djMergeRecoveryReadContact(ss, contactId) {
		const sheet = ss.getSheetByName("Master_Contacts");

		if (!sheet || sheet.getLastRow() < 2) {
			throw new Error("Master_Contacts is missing.");
		}

		const headers = sheet.getRange(
			1, 1, 1, 14
		).getDisplayValues()[0];

		if (!DJ_MERGE_RECOVERY_CONTACT_HEADERS.every(
			(header, index) => headers[index] === header
		)) {
			throw new Error("Unexpected Master_Contacts headers.");
		}

		const values = sheet.getRange(
			2, 1, sheet.getLastRow() - 1, 14
		).getValues();

		const matches = [];

		for (let index = 0; index < values.length; index++) {
			if (djMergeRecoveryText(values[index][0]) === contactId) {
				matches.push({
					rowNumber: index + 2,
					values: values[index]
				});
			}
		}

		if (matches.length > 1) {
			throw new Error(
				"Duplicate Contact ID found during recovery: " + contactId
			);
		}

		if (!matches.length) {
			return null;
		}

		const match = matches[0];

		const formulas = sheet.getRange(
			match.rowNumber, 1, 1, 14
		).getFormulas()[0];

		if (formulas.some(Boolean)) {
			throw new Error(
				"Contact contains formulas; recovery requires manual review."
			);
		}

		const fields = {};

		for (let index = 0; index < headers.length; index++) {
			fields[headers[index]] = match.values[index];
		}

		return {
			rowNumber: match.rowNumber,
			fields
		};
	}

	// Compare all original contact fields, including dates and identifiers.
	function djMergeRecoveryContactEqual(actual, expected) {
		if (!actual || !expected) {
			return false;
		}

		for (const header of DJ_MERGE_RECOVERY_CONTACT_HEADERS) {
			const value = actual.fields[header] instanceof Date
				? actual.fields[header].toISOString()
				: actual.fields[header];

			const saved = expected[header] instanceof Date
				? expected[header].toISOString()
				: expected[header];

			if (value !== saved) {
				return false;
			}
		}

		return true;
	}

	// Compare all campaign fields, raw history records and the cell note.
	function djMergeRecoveryCampaignEqual(ss, contactId, expected) {
		try {
			const actual = djMergeReadCampaignSnapshot(ss, contactId);

			return djMergeCampaignSnapshotsEqual(actual, expected) &&
				JSON.stringify(actual.history) ===
				JSON.stringify(expected.history);
		} catch (_) {
			return false;
		}
	}

	// Inspect the interrupted operation without changing any spreadsheet data.
	function djMergeInspectRecovery(ss, mergeId) {
		const id = djMergeRecoveryText(mergeId);

		if (!ss || !id) {
			throw new Error("Spreadsheet and Merge ID are required.");
		}

		const record = djMergeRecoveryReadHistory(ss, id);

		const result = {
			mergeId: id,
			status: record.status,
			action: "MANUAL_REVIEW",
			reason: "Current contact data does not match a safe recovery checkpoint."
		};

		if (!djMergeRecoveryApprovalValid(ss, record)) {
			result.reason =
				"Original human approval is missing or has changed.";
			return result;
		}

		const saved = djMergeReadSavedBackup(ss, id);

		if (!saved ||
			saved.primaryId !== record.primaryId ||
			saved.duplicateId !== record.duplicateId) {
			result.reason = "Matching MA-05 campaign backup is missing.";
			return result;
		}

		const primary = djMergeRecoveryReadContact(
			ss, record.primaryId
		);

		const duplicate = djMergeRecoveryReadContact(
			ss, record.duplicateId
		);

		if (record.status === "APPLYING") {
			// The surviving contact must match the intended merged values.
			if (!djMergeRecoveryContactEqual(primary, record.merged) ||
				!djMergeRecoveryCampaignEqual(
					ss, record.primaryId, saved.merged
				)) {
				return result;
			}

			// Deletion already completed; only the final audit status is missing.
			if (!duplicate) {
				result.action = "FINALIZE_MERGE";
				result.reason =
					"Merged contact verified and duplicate already removed.";
				return result;
			}

			// Deletion is allowed only if the duplicate is completely unchanged.
			if (djMergeRecoveryContactEqual(
				duplicate, record.duplicateBefore
			) && djMergeRecoveryCampaignEqual(
				ss, record.duplicateId, saved.duplicate
			)) {
				djMergeCheckEngagementReferences(
					ss, record.duplicateId
				);

				result.action = "DELETE_DUPLICATE_AND_FINALIZE";
				result.reason =
					"Primary merged and duplicate still matches its original backup.";
			}

			return result;
		}

		// Undo can finish only when both original contact records are restored.
		if (primary &&
			duplicate &&
			djMergeRecoveryContactEqual(
				primary, record.primaryBefore
			) &&
			djMergeRecoveryContactEqual(
				duplicate, record.duplicateBefore
			) &&
			djMergeRecoveryCampaignEqual(
				ss, record.primaryId, saved.primary
			) &&
			djMergeRecoveryCampaignEqual(
				ss, record.duplicateId, saved.duplicate
			)) {
			result.action = "FINALIZE_UNDO";
			result.reason =
				"Both original contacts and campaign notes are fully restored.";
		}

		return result;
	}

	// Recover only a verified checkpoint under the MA-02 script lock.
	// The caller must explicitly confirm deletion of the duplicate contact.
	function djMergeRecoverInterrupted(
		ss,
		mergeId,
		confirmDelete = false
	) {
		const lock = LockService.getScriptLock();

		if (!lock.tryLock(30000)) {
			throw new Error("Could not acquire recovery lock.");
		}

		try {
			const plan = djMergeInspectRecovery(ss, mergeId);

			if (plan.action === "MANUAL_REVIEW") {
				return {
					...plan,
					recovered: false
				};
			}

			if (plan.action === "DELETE_DUPLICATE_AND_FINALIZE" &&
				confirmDelete !== true) {
				return {
					...plan,
					recovered: false,
					requiresConfirmation: true
				};
			}

			const record = djMergeRecoveryReadHistory(
				ss, plan.mergeId
			);

			if (plan.action === "DELETE_DUPLICATE_AND_FINALIZE") {
				// Recheck all data while holding the lock.
				const approved = djMergeInspectRecovery(
					ss, mergeId
				);

				if (approved.action !== plan.action) {
					throw new Error(
						"Recovery state changed before deletion."
					);
				}

				const duplicate = djMergeRecoveryReadContact(
					ss, record.duplicateId
				);

				const sheet = ss.getSheetByName(
					"Master_Contacts"
				);

				sheet.deleteRow(duplicate.rowNumber);
				SpreadsheetApp.flush();

				// Never report success unless the surviving record is correct.
				if (djMergeInspectRecovery(
					ss, mergeId
				).action !== "FINALIZE_MERGE") {
					throw new Error(
						"Deleted duplicate but merge verification failed."
					);
				}
			}

			// Write the audit timestamp before the terminal status.
			if (plan.action === "FINALIZE_UNDO") {
				record.sheet.getRange(
					record.rowNumber, 13
				).setValue(new Date());

				record.sheet.getRange(
					record.rowNumber, 11
				).setValue("UNDONE");
			} else {
				record.sheet.getRange(
					record.rowNumber, 12
				).setValue(new Date());

				record.sheet.getRange(
					record.rowNumber, 11
				).setValue("MERGED");
			}

			SpreadsheetApp.flush();

			const finalStatus = record.sheet.getRange(
				record.rowNumber, 11
			).getValue();

			const expected = plan.action === "FINALIZE_UNDO"
				? "UNDONE"
				: "MERGED";

			if (finalStatus !== expected) {
				throw new Error(
					"Recovery status verification failed."
				);
			}

			return {
				mergeId: plan.mergeId,
				status: expected,
				recovered: true
			};
		} finally {
			lock.releaseLock();
		}
	}
