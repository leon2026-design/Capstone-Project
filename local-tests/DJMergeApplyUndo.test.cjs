    // MA-05: Campaign history Merge and Undo integration tests.
	// Uses the real MA-02 and MA-05 functions with in-memory Google Sheets only.

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
		"Latest Campaign", "Campaign Status", "Campaign Rating",
		"Favorite Track", "Campaign Feedback", "Activity Time", "Campaign History Data"
	];

	const REVIEW_HEADERS = [
		"Match ID", "Existing Contact ID", "Incoming Record ID",
		"Existing Name", "Incoming Name", "Matching Fields", "Conflicting Fields",
		"Match Score", "Review Status", "Reviewer", "Review Date"
	];

	const HISTORY_HEADERS = [
		"Merge ID", "Primary Contact ID", "Duplicate Contact ID", "Match ID",
		"Reviewer", "Review Date", "Backup Created At", "Primary Snapshot",
		"Duplicate Snapshot", "Merged Snapshot", "Merge Status", "Merge Applied At", "Undo At"
	];

	// Match the Google Sheets methods used by the actual merge functions.
	function makeSheet(initialRows) {
		const rows = initialRows.map(row => [...row]);
		const notes = new Map();

		const sheet = {
			rows,
			notes,
			deleteCount: 0,
			throwOnDelete: false,
			formulaRows: new Set(),
			maxRows: 100,

			getLastRow() {
				return rows.length;
			},

			getLastColumn() {
				return Math.max(1, ...rows.map(row => row.length));
			},

			getMaxRows() {
				return this.maxRows;
			},

			insertRowsAfter(row, amount) {
				this.maxRows += amount;
			},

			setFrozenRows() {},

			getDataRange() {
				return this.getRange(1, 1, Math.max(1, this.getLastRow()), this.getLastColumn());
			},

			getRange(startRow, startCol, height = 1, width = 1) {
				function read() {
					return Array.from({ length: height }, (_, i) =>
						Array.from({ length: width }, (_, j) =>
							rows[startRow + i - 1]?.[startCol + j - 1] ?? ""
						)
					);
				}

				function write(values) {
					assert.equal(values.length, height);

					values.forEach((rowValues, i) => {
						assert.equal(rowValues.length, width);
						const rowIndex = startRow + i - 1;
						rows[rowIndex] ??= [];

						rowValues.forEach((value, j) => {
							rows[rowIndex][startCol + j - 1] = value;
						});
					});
				}

				return {
					getValues: read,

					getDisplayValues() {
						return read().map(row => row.map(value => {
							if (value instanceof Date) {
								return value.toISOString();
							}

							return String(value).replace(/^'(?=[=+\-@])/, "");
						}));
					},

					getValue() {
						return read()[0][0];
					},

					setValue(value) {
						write([[value]]);
						return this;
					},

					setValues(values) {
						write(values);
						return this;
					},

					getNote() {
						return notes.get(startRow + ":" + startCol) || "";
					},

					setNote(value) {
						notes.set(startRow + ":" + startCol, value);
						return this;
					},

					getFormulas() {
						return read().map((row, i) => row.map(() =>
							sheet.formulaRows.has(startRow + i) ? "=SUM(A1)" : ""
						));
					}
				};
			},

			deleteRow(rowNumber) {
				if (this.throwOnDelete) {
					throw new Error("Simulated delete failure");
				}

				rows.splice(rowNumber - 1, 1);
				this.deleteCount++;

				// Google Sheets shifts cell notes upward when a row is deleted.
				const moved = new Map();
				for (const [key, note] of notes) {
					const [row, column] = key.split(":").map(Number);
					if (row < rowNumber) {
						moved.set(key, note);
					} else if (row > rowNumber) {
						moved.set((row - 1) + ":" + column, note);
					}
				}

				notes.clear();
				for (const [key, note] of moved) {
					notes.set(key, note);
				}
			}
		};

		return sheet;
	}

	// Create a complete MA-04 report entry with valid source provenance.
	function campaignEntry(reportId, date, campaign) {
		return {
			reportId,
			campaign,
			reportGeneratedAt: date,
			status: "Downloaded No Feedback",
			rating: "",
			favoriteTrack: "",
			comments: "",
			activityTime: "",
			sourceUrl: "https://example.com/" + reportId,
			sourceTabUrl: "https://example.com/tab/" + reportId,
			extractedAt: "2026-11-08T10:00:00.000Z",
			firstSavedAt: "2026-11-08T11:00:00.000Z"
		};
	}

	function contactRow(id, sources, history, note) {
		const contact = {
			"Contact ID": id,
			"Name / DJ Alias": "Alex Smith",
			"Role": "DJ",
			"Station / Venue / Organization": "WXYZ",
			"City": "Columbus",
			"State / Region": "Ohio",
			"Country": "US",
			"Email": "alex@example.com",
			"Phone": "6145551000",
			"Social Accounts": "@alex",
			"Sources": sources,
			"Review Status": "Reviewed",
			"Review Notes": "",
			"Last Updated": "2026-11-04"
		};

		const latest = history[0];
		const campaign = {
			"Latest Campaign": latest.campaign,
			"Campaign Status": latest.status,
			"Campaign Rating": latest.rating,
			"Favorite Track": latest.favoriteTrack,
			"Campaign Feedback": latest.comments,
			"Activity Time": latest.activityTime,
			"Campaign History Data": JSON.stringify(history)
		};

		return [...CONTACT_HEADERS.map(header => contact[header]),
			...CAMPAIGN_HEADERS.map(header => campaign[header])];
	}

	// Build MA-02 approval, verified backup, and MA-04 history in one fixture.
	function fixture(options = {}) {
		const first = campaignEntry("file:REPORT_A", "2026-11-01", "Release A");
		const second = campaignEntry("file:REPORT_B", "2026-11-05", "Release B");
		const date = new Date("2026-11-04T18:00:00.000Z");

		const master = makeSheet([
			[...CONTACT_HEADERS, ...CAMPAIGN_HEADERS],
			contactRow("CT-001", "Report A", [first], "Original note A"),
			contactRow("CT-002", "Report B", [second], "Original note B")
		]);

		master.getRange(2, 15).setNote("Original note A");
		master.getRange(3, 15).setNote("Original note B");

		const review = makeSheet([
			REVIEW_HEADERS,
			["MT-001", "CT-001", "CT-002", "Alex Smith", "Alex Smith",
				"Name", "", 100, "Confirm Duplicate", "Brad", date]
		]);

		const history = makeSheet([HISTORY_HEADERS]);
		const sheets = {
			Master_Contacts: master,
			Potential_Duplicates: review,
			Merge_History: history
		};

		const ss = {
			getSheetByName(name) {
				return sheets[name] || null;
			},

			insertSheet(name) {
				sheets[name] = makeSheet([]);
				return sheets[name];
			}
		};

		const lock = {
			locked: false,

			tryLock() {
				assert.equal(this.locked, false, "Nested script lock detected");
				this.locked = true;
				return true;
			},

			waitLock() {
				assert.equal(this.locked, false, "Nested script lock detected");
				this.locked = true;
			},

			releaseLock() {
				assert.equal(this.locked, true, "Released an unlocked script lock");
				this.locked = false;
			}
		};

		const context = vm.createContext({
			Date,
			console,
			LockService: {
				getScriptLock: () => lock
			},
			SpreadsheetApp: {
				flush() {}
			},
			Utilities: {
				getUuid: () => "00000000-0000-4000-8000-000000000001"
			}
		});

		// Load actual project functions, not replacement implementations.
		for (const filename of [
			"ContactMergeHistory.js",
			"ContactSafeMerge.js",
			"ContactImporter.js",
			"DJMergeIntegration.js"
		]) {
			vm.runInContext(
				fs.readFileSync(path.join(ROOT, filename), "utf8"),
				context,
				{ filename }
			);
		}

		const fn = name => vm.runInContext(name, context);
		const primary = fn("contactSafeMergeReadMasterContact")(ss, "CT-001");
		const duplicate = fn("contactSafeMergeReadMasterContact")(ss, "CT-002");

		const reviewRecord = {
			"Match ID": "MT-001",
			"Existing Contact ID": "CT-001",
			"Incoming Record ID": "CT-002",
			"Review Status": "Confirm Duplicate",
			Reviewer: "Brad",
			"Review Date": date
		};

		const snapshot = fn("contactSafeMergeCreateSnapshot")(
			primary, duplicate, reviewRecord
		);

		const saved = fn("contactMergeHistorySaveBackup")(
			ss, snapshot
		);

		if (options.saveDJBackup !== false) {
			fn("djMergeSaveBackup")(ss, saved.mergeId);
		}

		return {
			ss,
			master,
			review,
			history,
			sheets,
			lock,
			id: saved.mergeId,
			fn,
			first,
			second
		};
	}

	function readCampaign(x, id) {
		return x.fn("djMergeReadCampaignSnapshot")(x.ss, id);
	}

	// Verify complete Merge and Undo through the public MA-02 entry points.
	test("Merge retains both reports and Undo restores both original notes", () => {
		const x = fixture();
		const originalPrimary = readCampaign(x, "CT-001");
		const originalDuplicate = readCampaign(x, "CT-002");

		const merged = x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);
		assert.equal(merged.status, "MERGED");
		assert.equal(x.history.rows[1][10], "MERGED");
		assert.equal(x.master.getLastRow(), 2);
		assert.equal(x.master.deleteCount, 1);

		const result = readCampaign(x, "CT-001");
		assert.deepEqual(Array.from(result.history, item => item.reportId).sort(),
			["file:REPORT_A", "file:REPORT_B"]);
		assert.match(result.note, /Release A/);
		assert.match(result.note, /Release B/);
		assert.equal(result.fields["Latest Campaign"], "Release B");

		const undone = x.fn("contactSafeMergeUndo")(x.ss, x.id);
		assert.equal(undone.status, "UNDONE");
		assert.equal(x.history.rows[1][10], "UNDONE");
		assert.equal(x.master.getLastRow(), 3);
		assert.deepEqual(readCampaign(x, "CT-001").fields, originalPrimary.fields);
		assert.deepEqual(readCampaign(x, "CT-002").fields, originalDuplicate.fields);
		assert.equal(readCampaign(x, "CT-001").note, originalPrimary.note);
		assert.equal(readCampaign(x, "CT-002").note, originalDuplicate.note);
		assert.equal(x.lock.locked, false);
	});

	// Never allow the original 14-column merge to delete unprotected MA-04 data.
	test("Merge with campaign history is blocked without a DJ backup", () => {
		const x = fixture({ saveDJBackup: false });

		assert.throws(
			() => x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
			/campaign history|MA-05|backup/i
		);
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.history.rows[1][10], "BACKUP_SAVED");
		assert.equal(x.lock.locked, false);
	});

	// Changes to a saved report invalidate the merge preview.
	test("Changed report after DJ backup prevents merge", () => {
		const x = fixture();
		const index = CONTACT_HEADERS.length + CAMPAIGN_HEADERS.indexOf("Campaign History Data");
		const changed = JSON.parse(x.master.rows[2][index]);
		changed[0].comments = "Changed after backup";
		x.master.rows[2][index] = JSON.stringify(changed);

		assert.throws(
			() => x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
			/changed|differs/i
		);
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.history.rows[1][10], "BACKUP_SAVED");
		assert.equal(x.lock.locked, false);
	});

	// Do not split a post-merge campaign update across the original contacts.
	test("Undo rejects campaign updates added after merge", () => {
		const x = fixture();
		x.fn("contactSafeMergeApplyApproved")(x.ss, x.id);
		const index = CONTACT_HEADERS.length + CAMPAIGN_HEADERS.indexOf("Campaign History Data");
		const current = JSON.parse(x.master.rows[1][index]);
		current.push(campaignEntry("file:REPORT_C", "2026-11-08", "Release C"));
		x.master.rows[1][index] = JSON.stringify(current);

		assert.throws(
			() => x.fn("contactSafeMergeUndo")(x.ss, x.id),
			/changed after merge|unsafe to undo/i
		);
		assert.equal(x.master.getLastRow(), 2);
		assert.equal(x.history.rows[1][10], "MERGED");
		assert.equal(x.lock.locked, false);
	});

	// A failed deletion must not mark the merge as completed.
	test("Interrupted merge remains APPLYING and preserves source rows", () => {
		const x = fixture();
		x.master.throwOnDelete = true;

		assert.throws(
			() => x.fn("contactSafeMergeApplyApproved")(x.ss, x.id),
			/Simulated delete failure/
		);
		assert.equal(x.history.rows[1][10], "APPLYING");
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.lock.locked, false);
	});

	// Engagement links must be relinked before their contact can be deleted.
	test("Engagement audit references prevent saving DJ merge backup", () => {
		const x = fixture({ saveDJBackup: false });
		x.sheets.DJ_Engagement_Links = makeSheet([
			["Contact ID", "Observation Key"],
			["CT-002", "OBS-001"]
		]);

		assert.throws(
			() => x.fn("djMergeSaveBackup")(x.ss, x.id),
			/engagement audit links|relinking/i
		);
		assert.equal(x.master.getLastRow(), 3);
		assert.equal(x.lock.locked, false);
	});
