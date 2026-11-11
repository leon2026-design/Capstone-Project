
	// MA-05: Follow-up queue for identity and social profile reviews.
	// Existing review sheets remain the source of truth for all decisions.

	const DJ_FOLLOWUP_SHEET = "DJ_FollowUp_Queue";

	const DJ_FOLLOWUP_HEADERS = [
		"Queue Key", "Follow-Up Type", "Observation ID", "Profile ID",
		"Source Report ID", "Reported Name", "Platform", "Profile URL",
		"Source URL", "Source Status", "Priority", "Queue Status",
		"Assigned To", "Follow-Up Notes", "First Seen", "Last Updated"
	];

	function djFollowUpText(value) {
		return String(value == null ? "" : value).trim();
	}

	// Store external text as a literal spreadsheet cell value.
	function djFollowUpSafe(value) {
		const text = djFollowUpText(value);
		return /^[=+\-@]/.test(text) ? "'" + text : text;
	}

	function djFollowUpStored(value) {
		const text = djFollowUpText(value);
		return /^'(?=[=+\-@])/.test(text) ? text.slice(1) : text;
	}

	// Validate the expected schema before reading or writing any records.
	function djFollowUpCheckHeaders(sheet, expected, name) {
		if (!sheet || sheet.getLastRow() < 1) {
			throw new Error(name + " is missing its header row.");
		}

		const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
			.getDisplayValues()[0];

		for (let i = 0; i < expected.length; i++) {
			if (headers[i] !== expected[i] ||
				headers.lastIndexOf(expected[i]) !== i) {
				throw new Error("Unexpected headers in " + name + ".");
			}
		}
	}

	// Read actual identity and social profile decisions without changing them.
	function djFollowUpReadSources(ss) {
		if (!ss || typeof ss.getSheetByName !== "function") {
			throw new Error("A spreadsheet is required.");
		}

		const specs = [
			{
				name: "DJ_Identity_Review",
				type: "IDENTITY",
				headers: [
					"Observation ID", "Reported Name", "Source Report ID", "Source Page",
					"Source Section", "Source URL", "Match Status", "Candidate Contact IDs",
					"Match Evidence", "Social Profiles", "Review Status", "Selected Contact ID",
					"Reviewer", "Review Date", "Review Notes"
				],
				statuses: ["PENDING", "NEEDS_RESEARCH", "APPROVED_LINK", "UNRESOLVED"]
			},
			{
				name: "DJ_Social_Profiles",
				type: "SOCIAL_PROFILE",
				headers: [
					"Profile ID", "Observation ID", "Platform", "Profile URL",
					"Evidence Source", "Source Report ID", "Source Page",
					"Source Section", "Source URL", "Contact ID",
					"Verification Status", "Reviewer", "Review Date", "Notes"
				],
				statuses: ["PENDING_REVIEW", "NEEDS_RESEARCH", "VERIFIED", "REJECTED"]
			}
		];

		const sources = new Map();
		const present = new Set();
		const reportedNames = new Map();

		for (const spec of specs) {
			const sheet = ss.getSheetByName(spec.name);

			if (!sheet) {
				continue;
			}

			present.add(spec.type);
			djFollowUpCheckHeaders(sheet, spec.headers, spec.name);

			if (sheet.getLastRow() < 2) {
				continue;
			}

			const data = sheet.getRange(
				2, 1, sheet.getLastRow() - 1, spec.headers.length
			).getDisplayValues();

			for (const row of data) {
				if (!row.some(djFollowUpText)) {
					continue;
				}

				const keyId = djFollowUpText(row[0]);
				const status = djFollowUpText(row[10]);

				if (!keyId || !spec.statuses.includes(status)) {
					throw new Error("Invalid source ID or status in " + spec.name + ".");
				}

				const observationId = spec.type === "IDENTITY" ? keyId : djFollowUpText(row[1]);
				const key = spec.type + "|" + keyId;

				if (!observationId || sources.has(key)) {
					throw new Error("Missing observation or duplicate follow-up source: " + key);
				}

				if (spec.type === "IDENTITY") {
					reportedNames.set(observationId, djFollowUpText(row[1]));
				}

				const active = spec.type === "IDENTITY"
					? status !== "APPROVED_LINK"
					: status === "PENDING_REVIEW" || status === "NEEDS_RESEARCH";

				sources.set(key, {
					key,
					type: spec.type,
					observationId,
					profileId: spec.type === "SOCIAL_PROFILE" ? keyId : "",
					reportId: djFollowUpText(row[spec.type === "IDENTITY" ? 2 : 5]),
					reportedName: spec.type === "IDENTITY" ? djFollowUpText(row[1]) : "",
					platform: spec.type === "SOCIAL_PROFILE" ? djFollowUpText(row[2]) : "",
					profileUrl: spec.type === "SOCIAL_PROFILE" ? djFollowUpText(row[3]) : "",
					sourceUrl: djFollowUpText(row[spec.type === "IDENTITY" ? 5 : 8]),
					status,
					priority: ["NEEDS_RESEARCH", "UNRESOLVED"].includes(status) ? "HIGH" : "NORMAL",
					active
				});
			}
		}

		// Use the original observation name as display context, not as identity proof.
		for (const source of sources.values()) {
			if (source.type === "SOCIAL_PROFILE") {
				source.reportedName = reportedNames.get(source.observationId) || "";
			}
		}

		return { sources, present };
	}

	// Create the queue only after source data has passed validation.
	function djFollowUpEnsureSheet(ss) {
		let sheet = ss.getSheetByName(DJ_FOLLOWUP_SHEET);

		if (!sheet) {
			sheet = ss.insertSheet(DJ_FOLLOWUP_SHEET);
		}

		if (sheet.getLastRow() === 0) {
			sheet.getRange(1, 1, 1, DJ_FOLLOWUP_HEADERS.length)
				.setValues([DJ_FOLLOWUP_HEADERS]);
			sheet.setFrozenRows(1);
		} else {
			djFollowUpCheckHeaders(sheet, DJ_FOLLOWUP_HEADERS, DJ_FOLLOWUP_SHEET);
		}

		return sheet;
	}

	// Read persisted assignments and reject duplicate or invalid queue records.
	function djFollowUpExisting(sheet) {
		const existing = new Map();

		if (sheet.getLastRow() < 2) {
			return existing;
		}

		const rows = sheet.getRange(
			2, 1, sheet.getLastRow() - 1, DJ_FOLLOWUP_HEADERS.length
		).getValues();

		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const key = djFollowUpText(row[0]);

			if (!key || existing.has(key) ||
				!["OPEN", "IN_PROGRESS", "RESOLVED"].includes(row[11]) ||
				!["IDENTITY", "SOCIAL_PROFILE"].includes(row[1]) ||
				!key.startsWith(row[1] + "|")) {
				throw new Error("Invalid or duplicate DJ follow-up queue record.");
			}

			existing.set(key, { rowNumber: i + 2, values: row });
		}

		return existing;
	}

	// Sync follow-ups without approving identity links or overwriting reviewer notes.
	function djFollowUpSync(ss) {
		const lock = LockService.getScriptLock();
		lock.waitLock(10000);

		try {
			const { sources, present } = djFollowUpReadSources(ss);
			const sheet = djFollowUpEnsureSheet(ss);
			const existing = djFollowUpExisting(sheet);
			const now = new Date();
			const updates = [];
			const additions = [];
			let unchanged = 0;

			// Never resolve a task simply because its source row disappeared.
			for (const [key, saved] of existing) {
				if (!sources.has(key)) {
					throw new Error("Follow-up source is missing: " + key);
				}

				if (!present.has(saved.values[1])) {
					throw new Error("Follow-up source sheet is missing: " + key);
				}
			}

			for (const source of sources.values()) {
				const prior = existing.get(source.key);

				if (!source.active && !prior) {
					continue;
				}

				const status = !source.active ? "RESOLVED" :
					prior && prior.values[11] === "IN_PROGRESS" ? "IN_PROGRESS" : "OPEN";

				const details = [
					source.key, source.type, source.observationId, source.profileId,
					source.reportId, source.reportedName, source.platform,
					source.profileUrl, source.sourceUrl, source.status,
					source.priority, status
				];

				if (!prior) {
					additions.push([
						...details.map(djFollowUpSafe), "", "", now, now
					]);
					continue;
				}

				const changed = details.some((value, index) =>
					djFollowUpStored(prior.values[index]) !== value
				);

				if (changed) {
					updates.push({ rowNumber: prior.rowNumber, details });
				} else {
					unchanged++;
				}
			}

			for (const update of updates) {
				sheet.getRange(update.rowNumber, 1, 1, 12)
					.setValues([update.details.map(djFollowUpSafe)]);
				sheet.getRange(update.rowNumber, 16).setValue(now);
			}

			if (additions.length) {
				const firstRow = sheet.getLastRow() + 1;
				const finalRow = firstRow + additions.length - 1;

				if (finalRow > sheet.getMaxRows()) {
					sheet.insertRowsAfter(sheet.getMaxRows(), finalRow - sheet.getMaxRows());
				}

				sheet.getRange(firstRow, 1, additions.length, DJ_FOLLOWUP_HEADERS.length)
					.setValues(additions);
			}

			SpreadsheetApp.flush();

			return {
				created: additions.length,
				updated: updates.length,
				unchanged
			};
		} finally {
			lock.releaseLock();
		}
	}

	// Track manual follow-up work without making identity or profile decisions.
	function djFollowUpSetProgress(ss, queueKey, status, assignedTo, notes) {
		const key = djFollowUpText(queueKey);
		const assignee = djFollowUpText(assignedTo);
		const details = djFollowUpText(notes);

		if (!key || !["OPEN", "IN_PROGRESS"].includes(status) ||
			(status === "IN_PROGRESS" && !assignee) ||
			assignee.length > 40000 || details.length > 40000) {
			throw new Error("Invalid follow-up progress details.");
		}

		const lock = LockService.getScriptLock();
		lock.waitLock(10000);

		try {
			const { sources } = djFollowUpReadSources(ss);
			const source = sources.get(key);

			if (!source || !source.active) {
				throw new Error("Follow-up source is missing or already finalized.");
			}

			const sheet = ss.getSheetByName(DJ_FOLLOWUP_SHEET);
			djFollowUpCheckHeaders(sheet, DJ_FOLLOWUP_HEADERS, DJ_FOLLOWUP_SHEET);
			const record = djFollowUpExisting(sheet).get(key);

			if (!record || record.values[11] === "RESOLVED") {
				throw new Error("Follow-up must be synchronized before editing.");
			}

			if (record.values[9] !== source.status) {
				throw new Error("Source status changed; synchronize the queue first.");
			}

			sheet.getRange(record.rowNumber, 12, 1, 3)
				.setValues([[status, djFollowUpSafe(assignee), djFollowUpSafe(details)]]);
			sheet.getRange(record.rowNumber, 16).setValue(new Date());
			SpreadsheetApp.flush();

			return { queueKey: key, status, assignedTo: assignee };
		} finally {
			lock.releaseLock();
		}
	}
