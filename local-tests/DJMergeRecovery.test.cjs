    // MA-05: Interrupted Merge and Undo recovery tests.
	// Uses the real MA-05 recovery and campaign reader with in-memory sheets only.

	const test = require("node:test");
	const assert = require("node:assert/strict");
	const fs = require("node:fs");
	const path = require("node:path");
	const vm = require("node:vm");

	const ROOT = path.join(__dirname, "..");

	const CONTACT_HEADERS = [
		"Contact ID", "Name / DJ Alias", "Role", "Station / Venue / Organization",
		"City", "State / Region", "Country", "Email", "Phone",
		"Social Accounts", "Sources", "Review Status", "Review Notes", "Last Updated"
	];

	const CAMPAIGN_HEADERS = [
		"Latest Campaign", "Campaign Status", "Campaign Rating", "Favorite Track",
		"Campaign Feedback", "Activity Time", "Campaign History Data"
	];

	const HISTORY_HEADERS = [
		"Merge ID", "Primary Contact ID", "Duplicate Contact ID",
		"Match ID", "Reviewer", "Review Date", "Backup Created At",
		"Primary Snapshot", "Duplicate Snapshot", "Merged Snapshot",
		"Merge Status", "Merge Applied At", "Undo At"
	];

	const DJ_HEADERS = [
		"Merge ID", "Primary Contact ID", "Duplicate Contact ID",
		"Primary Campaign Snapshot", "Duplicate Campaign Snapshot",
		"Merged Campaign Snapshot", "Status", "Created At"
	];

	const REVIEW_HEADERS = [
		"Match ID", "Existing Contact ID", "Incoming Record ID",
		"Existing Name", "Incoming Name", "Matching Fields",
		"Conflicting Fields", "Match Score", "Review Status",
		"Reviewer", "Review Date"
	];

	// Create an in-memory Google Sheet for recovery testing.
	function makeSheet(rows) {
		const notes = new Map();

		const sheet = {
			rows: rows.map(row => [...row]),
			notes,
			failDelete: false,

			getLastRow() {
				return this.rows.length;
			},

			getLastColumn() {
				return Math.max(
					1,
					...this.rows.map(row => row.length)
				);
			},

			getDataRange() {
				return this.getRange(
					1, 1, this.getLastRow(), this.getLastColumn()
				);
			},

			getRange(r, c, height = 1, width = 1) {
				const read = () => Array.from(
					{ length: height },
					(_, i) => Array.from(
						{ length: width },
						(_, j) => this.rows[r + i - 1]?.[c + j - 1] ?? ""
					)
				);

				return {
					getValues: read,

					getDisplayValues() {
						return read().map(row => row.map(value =>
							value instanceof Date
								? value.toISOString()
								: String(value)
						));
					},

					getValue: () => read()[0][0],

					setValue(value) {
						sheet.rows[r - 1] ??= [];
						sheet.rows[r - 1][c - 1] = value;
					},

					getNote: () =>
						notes.get(r + ":" + c) || "",

					setNote: value =>
						notes.set(r + ":" + c, value),

					getFormulas: () =>
						read().map(row => row.map(() => ""))
				};
			},

			deleteRow(row) {
				if (this.failDelete) {
					throw new Error("Simulated delete failure");
				}

				this.rows.splice(row - 1, 1);

				const moved = new Map();

				for (const [key, note] of notes) {
					const [oldRow, column] =
						key.split(":").map(Number);

					if (oldRow !== row) {
						const nextRow = oldRow > row
							? oldRow - 1
							: oldRow;

						moved.set(
							nextRow + ":" + column,
							note
						);
					}
				}

				notes.clear();

				for (const [key, value] of moved) {
					notes.set(key, value);
				}
			}
		};

		return sheet;
	}

	// Create a contact in the original MA-02 column order.
	function contact(id, source) {
		return {
			"Contact ID": id,
			"Name / DJ Alias": "Alex Smith",
			Role: "DJ",
			"Station / Venue / Organization": "WXYZ",
			City: "Columbus",
			"State / Region": "Ohio",
			Country: "US",
			Email: "alex@example.com",
			Phone: "6145551000",
			"Social Accounts": "@alex",
			Sources: source,
			"Review Status": "Reviewed",
			"Review Notes": "",
			"Last Updated": "2026-11-04"
		};
	}

	// Store all MA-04 fields, raw reports and the latest campaign note.
	function campaign(id, reports, latest, note) {
		return {
			contactId: id,
			fields: {
				"Latest Campaign": latest,
				"Campaign Status": "",
				"Campaign Rating": "",
				"Favorite Track": "",
				"Campaign Feedback": "",
				"Activity Time": "",
				"Campaign History Data": JSON.stringify(reports)
			},
			history: reports,
			note
		};
	}

	// Prepare interrupted Merge or Undo records using saved snapshots.
	function fixture(
		state = "APPLYING",
		stage = "READY_TO_DELETE"
	) {
		const date = new Date("2026-11-04T18:00:00.000Z");

		const beforeA = contact("CT-001", "Report A");
		const beforeB = contact("CT-002", "Report B");
		const merged = contact(
			"CT-001",
			"Report A\nReport B"
		);

		const entryA = {
			reportId: "file:A",
			campaign: "Release A",
			firstSavedAt: "2026-11-08T11:00:00.000Z"
		};

		const entryB = {
			reportId: "file:B",
			campaign: "Release B",
			firstSavedAt: "2026-11-08T11:00:00.000Z"
		};

		const campA = campaign(
			"CT-001", [entryA], "Release A", "Note A"
		);

		const campB = campaign(
			"CT-002", [entryB], "Release B", "Note B"
		);

		const campMerged = campaign(
			"CT-001", [entryA, entryB], "Release B", "Merged note"
		);

		function fullRow(record, snapshot) {
			return [
				...CONTACT_HEADERS.map(h => record[h]),
				...CAMPAIGN_HEADERS.map(h => snapshot.fields[h])
			];
		}

		const primaryRecord = stage === "UNDO_COMPLETE"
			? beforeA
			: merged;

		const primaryCampaign = stage === "UNDO_COMPLETE"
			? campA
			: campMerged;

		const masterRows = [
			[...CONTACT_HEADERS, ...CAMPAIGN_HEADERS],
			fullRow(primaryRecord, primaryCampaign)
		];

		if (stage !== "MERGE_COMPLETE") {
			masterRows.push(fullRow(beforeB, campB));
		}

		const master = makeSheet(masterRows);

		master.getRange(2, 15).setNote(primaryCampaign.note);

		if (stage !== "MERGE_COMPLETE") {
			master.getRange(3, 15).setNote(campB.note);
		}

		const history = makeSheet([
			HISTORY_HEADERS,
			[
				"MG-001", "CT-001", "CT-002", "MT-001",
				"Brad", date, date,
				JSON.stringify(beforeA),
				JSON.stringify(beforeB),
				JSON.stringify(merged),
				state, "", ""
			]
		]);

		const dj = makeSheet([
			DJ_HEADERS,
			[
				"MG-001", "CT-001", "CT-002",
				JSON.stringify(campA),
				JSON.stringify(campB),
				JSON.stringify(campMerged),
				"PREPARED", date
			]
		]);

		const review = makeSheet([
			REVIEW_HEADERS,
			[
				"MT-001", "CT-001", "CT-002",
				"Alex Smith", "Alex Smith", "Name", "",
				100, "Confirm Duplicate", "Brad", date
			]
		]);

		const sheets = {
			Master_Contacts: master,
			Merge_History: history,
			DJ_Merge_History: dj,
			Potential_Duplicates: review
		};

		const ss = {
			getSheetByName: name => sheets[name] || null
		};

		const lock = {
			locked: false,

			tryLock() {
				if (this.locked) {
					return false;
				}

				this.locked = true;
				return true;
			},

			releaseLock() {
				assert.equal(this.locked, true);
				this.locked = false;
			}
		};

		const ctx = vm.createContext({
			Date,
			console,
			CONTACT_MERGE_HISTORY_HEADERS: HISTORY_HEADERS,

			LockService: {
				getScriptLock: () => lock
			},

			SpreadsheetApp: {
				flush() {}
			},

			// Simulate MA-02 serialization without accessing real Sheets.
			contactMergeHistorySerializeContact(record) {
				return JSON.stringify(record);
			},

			// The recovery reader uses the saved MA-04 JSON.
			parseSavedCampaignHistory(raw) {
				return JSON.parse(raw || "[]");
			}
		});

		// Load the real local campaign and recovery implementations.
		for (const name of [
			"DJMergeIntegration.js",
			"DJMergeRecovery.js"
		]) {
			vm.runInContext(
				fs.readFileSync(
					path.join(ROOT, name),
					"utf8"
				),
				ctx,
				{ filename: name }
			);
		}

		const run = (name, ...args) =>
			vm.runInContext(name, ctx)(
				ss, "MG-001", ...args
			);

		return {
			master,
			history,
			dj,
			review,
			ss,
			lock,
			sheets,
			run
		};
	}

	test("Recovery inspection identifies safe pending deletion without writing", () => {
		const x = fixture();

		const rows = x.master.getLastRow();

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"DELETE_DUPLICATE_AND_FINALIZE"
		);

		assert.equal(x.master.getLastRow(), rows);
		assert.equal(x.history.rows[1][10], "APPLYING");
	});

	test("Recovery refuses deletion without explicit confirmation", () => {
		const x = fixture();

		const result = x.run("djMergeRecoverInterrupted");

		assert.equal(result.recovered, false);
		assert.equal(result.requiresConfirmation, true);
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.lock.locked, false);
	});

	test("Recovery finishes a verified interrupted merge exactly once", () => {
		const x = fixture();

		const result = x.run(
			"djMergeRecoverInterrupted",
			true
		);

		assert.equal(result.status, "MERGED");
		assert.equal(x.master.getLastRow(), 2);
		assert.equal(x.history.rows[1][10], "MERGED");
		assert.ok(x.history.rows[1][11] instanceof Date);
		assert.equal(x.lock.locked, false);

		assert.throws(
			() => x.run("djMergeRecoverInterrupted"),
			/Only APPLYING and UNDOING/
		);
	});

	test("Recovery finalizes a physically completed merge without deleting again", () => {
		const x = fixture("APPLYING", "MERGE_COMPLETE");

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"FINALIZE_MERGE"
		);

		assert.equal(
			x.run("djMergeRecoverInterrupted").status,
			"MERGED"
		);

		assert.equal(x.master.getLastRow(), 2);
	});

	test("Recovery requires manual review if campaign data changed", () => {
		const x = fixture();

		x.master.rows[1][20] = JSON.stringify([
			{ reportId: "file:OTHER" }
		]);

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"MANUAL_REVIEW"
		);

		assert.equal(
			x.run("djMergeRecoverInterrupted", true).recovered,
			false
		);

		assert.equal(x.history.rows[1][10], "APPLYING");
		assert.equal(x.master.getLastRow(), 3);
	});

	test("Recovery finalizes Undo only after both originals are restored", () => {
		const x = fixture("UNDOING", "UNDO_COMPLETE");

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"FINALIZE_UNDO"
		);

		const result = x.run("djMergeRecoverInterrupted");

		assert.equal(result.status, "UNDONE");
		assert.ok(x.history.rows[1][12] instanceof Date);
		assert.equal(x.lock.locked, false);
	});

	test("Recovery does not complete a partial Undo", () => {
		const x = fixture(
			"UNDOING",
			"READY_TO_DELETE"
		);

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"MANUAL_REVIEW"
		);

		assert.equal(
			x.run("djMergeRecoverInterrupted").recovered,
			false
		);

		assert.equal(x.history.rows[1][10], "UNDOING");
	});

	test("Recovery stops if manual approval was revoked", () => {
		const x = fixture();

		x.review.rows[1][8] = "Different Individuals";

		assert.equal(
			x.run("djMergeInspectRecovery").action,
			"MANUAL_REVIEW"
		);

		assert.equal(
			x.run("djMergeRecoverInterrupted", true).recovered,
			false
		);

		assert.equal(x.master.getLastRow(), 3);
	});

	test("Recovery rejects deletion while an engagement audit references the duplicate", () => {
		const x = fixture();

		x.sheets.DJ_Engagement_Links = makeSheet([
			["Contact ID", "Observation Key"],
			["CT-002", "OBS-01"]
		]);

		assert.throws(
			() => x.run("djMergeInspectRecovery"),
			/engagement audit links/i
		);

		assert.equal(x.master.getLastRow(), 3);
	});

	test("Recovery preserves APPLYING if duplicate deletion fails", () => {
		const x = fixture();

		x.master.failDelete = true;

		assert.throws(
			() => x.run("djMergeRecoverInterrupted", true),
			/Simulated delete failure/
		);

		assert.equal(x.history.rows[1][10], "APPLYING");
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.lock.locked, false);
	});

	test("Recovery rejects concurrent execution", () => {
		const x = fixture();

		x.lock.locked = true;

		assert.throws(
			() => x.run("djMergeRecoverInterrupted", true),
			/Could not acquire recovery lock/
		);

		assert.equal(x.history.rows[1][10], "APPLYING");
	});
