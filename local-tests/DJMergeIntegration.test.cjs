
// MA-05: DJ Merge Integration Tests
// Test campaign merge preparation, backups, and Undo safety.
// Run from project root: node --test local-tests/DJMergeIntegration.test.cjs

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

const CONTACT_HEADERS = [
	"Contact ID", "Name / DJ Alias", "Role",
	"Station / Venue / Organization", "City", "State / Region",
	"Country", "Email", "Phone", "Social Accounts",
	"Sources", "Review Status", "Review Notes", "Last Updated"
];

const CAMPAIGN_HEADERS = [
	"Latest Campaign", "Campaign Status", "Campaign Rating",
	"Favorite Track", "Campaign Feedback", "Activity Time",
	"Campaign History Data"
];

const ALL_HEADERS = [...CONTACT_HEADERS, ...CAMPAIGN_HEADERS];

// Mock Google Sheets without accessing production data.
class MockSheet {
	constructor(name, rows = []) {
		this.name = name;
		this.rows = rows.map(row => [...row]);
		this.maxRows = 100;
		this.maxCols = 50;
		this.notes = new Map();
		this.formulas = new Set();
		this.writes = 0;
	}

	getLastRow() {
		let count = this.rows.length;

		while (count > 0 &&
			!this.rows[count - 1].some(value =>
				value !== "" && value != null
			)) {
			count--;
		}

		return count;
	}

	getLastColumn() {
		return Math.max(0, ...this.rows.map(row => {
			let count = row.length;

			while (count > 0 &&
				(row[count - 1] === "" || row[count - 1] == null)) {
				count--;
			}

			return count;
		}));
	}

	getMaxRows() {
		return this.maxRows;
	}

	getMaxColumns() {
		return this.maxCols;
	}

	insertRowsAfter(row, count) {
		this.maxRows += count;
	}

	insertColumnsAfter(column, count) {
		this.maxCols += count;
	}

	setFrozenRows() {}

	getDataRange() {
		return this.getRange(
			1,
			1,
			Math.max(1, this.getLastRow()),
			Math.max(1, this.getLastColumn())
		);
	}

	getRange(startRow, startCol, height = 1, width = 1) {
		assert.ok(startRow > 0 && startCol > 0);
		assert.ok(height > 0 && width > 0);

		assert.ok(
			startRow + height - 1 <= this.maxRows &&
			startCol + width - 1 <= this.maxCols
		);

		const sheet = this;

		return {
			getValues() {
				return Array.from({ length: height }, (_, i) =>
					Array.from({ length: width }, (_, j) =>
						sheet.rows[startRow + i - 1]?.[startCol + j - 1] ?? ""
					)
				);
			},

			getDisplayValues() {
				return this.getValues().map(row =>
					row.map(value => {
						if (Object.prototype.toString.call(value) === "[object Date]") {
							return value.toISOString();
						}

						return String(value).replace(/^'(?=[=+\-@])/, "");
					})
				);
			},

			getValue() {
				return this.getValues()[0][0];
			},

			getNote() {
				return sheet.notes.get(startRow + ":" + startCol) || "";
			},

			setNote(note) {
				sheet.notes.set(startRow + ":" + startCol, note);
				sheet.writes++;
				return this;
			},

			getFormulas() {
				return Array.from({ length: height }, (_, i) =>
					Array.from({ length: width }, (_, j) =>
						sheet.formulas.has(
							(startRow + i) + ":" + (startCol + j)
						) ? "=FORMULA()" : ""
					)
				);
			},

			setValues(values) {
				assert.equal(values.length, height);

				values.forEach((row, i) => {
					assert.equal(row.length, width);

					const index = startRow + i - 1;
					sheet.rows[index] ??= [];

					row.forEach((value, j) => {
						sheet.rows[index][startCol + j - 1] = value;
					});
				});

				sheet.writes++;
				return this;
			},

			setValue(value) {
				return this.setValues([[value]]);
			}
		};
	}
}

class MockSpreadsheet {
	constructor(sheets = []) {
		this.sheets = sheets;
	}

	getSheetByName(name) {
		return this.sheets.find(sheet => sheet.name === name) || null;
	}

	insertSheet(name) {
		const sheet = new MockSheet(name);
		this.sheets.push(sheet);
		return sheet;
	}
}

// Build a valid MA-04 campaign history entry.
function createReport(reportId, changes = {}) {
	return {
		reportId: reportId,
		campaign: "Release " + reportId,
		reportGeneratedAt: "2026-11-02",
		status: "Downloaded No Feedback",
		rating: "",
		favoriteTrack: "",
		comments: "",
		activityTime: "",
		sourceUrl: "https://example.test/report/" + reportId,
		sourceTabUrl: "https://example.test/tab/111",
		extractedAt: "2026-11-04T10:00:00.000Z",
		firstSavedAt: "2026-11-04T12:00:00.000Z",
		...changes
	};
}

// Load the actual modules using a mock spreadsheet.
function setup(
	primaryHistory = [createReport("R1")],
	duplicateHistory = [createReport("R2")]
) {
	const master = new MockSheet(
		"Master_Contacts",
		[[...ALL_HEADERS]]
	);

	const db = new MockSpreadsheet([master]);

	let locked = false;

	const context = vm.createContext({
		console: {
			log() {},
			warn() {}
		},

		LockService: {
			getScriptLock() {
				return {
					waitLock() {
						assert.equal(locked, false);
						locked = true;
					},

					releaseLock() {
						assert.equal(locked, true);
						locked = false;
					},

					tryLock() {
						if (locked) {
							return false;
						}

						locked = true;
						return true;
					}
				};
			}
		},

		Utilities: {
			getUuid() {
				return "LOCAL-TEST-ID";
			}
		},

		SpreadsheetApp: {
			flush() {}
		}
	});

	// Load the production implementations, not rewritten test versions.
	const files = [
		"ContactImporter.js",
		"ContactMergeHistory.js",
		"ContactSafeMerge.js",
		"DJMergeIntegration.js"
	];

	for (const filename of files) {
		vm.runInContext(
			fs.readFileSync(path.join(ROOT, filename), "utf8"),
			context,
			{ filename }
		);
	}

	// Create a contact with valid MA-04 campaign history.
	function addContact(contactId, history) {
		const fields = {
			"Contact ID": contactId,
			"Name / DJ Alias": "Example DJ",
			"Role": "DJ",
			"Station / Venue / Organization": "Radio ABC",
			"City": "Columbus",
			"State / Region": "OH",
			"Country": "USA",
			"Email": "dj@example.test",
			"Phone": "",
			"Social Accounts": "",
			"Sources": "https://example.test/source",
			"Review Status": "Reviewed",
			"Review Notes": "",
			"Last Updated": ""
		};

		const view = context.campaignHistoryPresentation(history);

		CAMPAIGN_HEADERS.slice(0, 6).forEach((header, i) => {
			fields[header] = view.values[i];
		});

		fields["Campaign History Data"] = history.length
			? JSON.stringify(history)
			: "";

		const rowNumber = master.rows.length + 1;

		master.getRange(
			rowNumber, 1, 1, ALL_HEADERS.length
		).setValues([ALL_HEADERS.map(header => fields[header] ?? "")]);

		if (view.note) {
			master.getRange(rowNumber, 15).setNote(view.note);
		}
	}

	addContact("CT-A", primaryHistory);
	addContact("CT-B", duplicateHistory);

	// Create a real MA-02 approved snapshot and persisted backup.
	const primary = context.contactSafeMergeReadMasterContact(
		db, "CT-A"
	);

	const duplicate = context.contactSafeMergeReadMasterContact(
		db, "CT-B"
	);

	const review = {
		"Match ID": "MATCH-1",
		"Existing Contact ID": "CT-A",
		"Incoming Record ID": "CT-B",
		"Review Status": "Confirm Duplicate",
		"Reviewer": "Human Reviewer",
		"Review Date": "2026-11-05T10:00:00.000Z"
	};

	const snapshot = context.contactSafeMergeCreateSnapshot(
		primary,
		duplicate,
		review
	);

	const saved = context.contactMergeHistorySaveBackup(
		db,
		snapshot
	);

	const mergeId = saved.mergeId;

	function changeField(contactId, header, value) {
		const column = ALL_HEADERS.indexOf(header);
		assert.ok(column >= 0);

		const row = master.rows.find(item => item[0] === contactId);
		assert.ok(row);

		row[column] = value;
	}

	function audit() {
		const sheet = db.getSheetByName("DJ_Merge_History");

		return sheet ? sheet.rows.slice(1) : [];
	}

	// Simulate the result of a completed merge.
	// This is not a production merge or deletion function.
	function simulateCompletedMerge() {
		const plan = context.djMergePrepare(db, mergeId);

		context.djMergeSaveBackup(db, mergeId);

		const primaryRow = master.rows.find(row => row[0] === "CT-A");

		for (const [header, value] of Object.entries(plan.merged.fields)) {
			primaryRow[ALL_HEADERS.indexOf(header)] = value;
		}

		master.notes.set("2:15", plan.merged.note);

		const duplicateIndex = master.rows.findIndex(
			row => row[0] === "CT-B"
		);

		master.rows.splice(duplicateIndex, 1);

		const mergeSheet = db.getSheetByName("Merge_History");

		const statusColumn = mergeSheet.rows[0].indexOf("Merge Status");

		mergeSheet.rows[1][statusColumn] = "MERGED";

		return plan;
	}

	return {
		context,
		db,
		master,
		mergeId,
		changeField,
		audit,
		simulateCompletedMerge,
		isLocked: () => locked
	};
}

// Test 1
test("Read all seven MA-04 fields and preserve source note", () => {
	const t = setup();

	const snapshot = t.context.djMergeReadCampaignSnapshot(
		t.db, "CT-A"
	);

	assert.equal(snapshot.history.length, 1);

	assert.equal(
		snapshot.fields["Campaign History Data"],
		JSON.stringify([createReport("R1")])
	);

	assert.match(snapshot.note, /Release R1/);
});

// Test 2
test("Build read-only merge preview without changing contacts", () => {
	const t = setup();

	const before = JSON.stringify(t.master.rows);
	const plan = t.context.djMergePrepare(t.db, t.mergeId);

	assert.equal(plan.primaryId, "CT-A");
	assert.equal(plan.duplicateId, "CT-B");
	assert.equal(plan.merged.history.length, 2);
	assert.equal(JSON.stringify(t.master.rows), before);
	assert.equal(t.audit().length, 0);
});

// Test 3
test("Combine distinct reports and preserve activity data", () => {
	const t = setup();

	const plan = t.context.djMergePrepare(t.db, t.mergeId);

	const ids = [...plan.merged.history.map(
		entry => entry.reportId
	)].sort();

	assert.deepEqual(ids, ["R1", "R2"]);

	assert.ok(plan.merged.history.every(
		entry => entry.status === "Downloaded No Feedback"
	));

	assert.ok(plan.merged.history.every(
		entry => entry.activityTime === ""
	));
});

// Test 4
test("Deduplicate identical report entries", () => {
	const t = setup(
		[createReport("R1")],
		[createReport("R1")]
	);

	const plan = t.context.djMergePrepare(t.db, t.mergeId);

	assert.equal(plan.merged.history.length, 1);
});

// Test 5
test("Reject conflicting reports with the same Report ID", () => {
	const t = setup(
		[createReport("R1")],
		[createReport("R1", { comments: "Different feedback" })]
	);

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /Conflicting campaign history/);
});

// Test 6
test("Reject invalid Campaign History JSON", () => {
	const t = setup();

	t.changeField("CT-B", "Campaign History Data", "{broken-json");

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /Invalid Campaign History Data/);

	assert.equal(t.audit().length, 0);
});

// Test 7
test("Reject unsupported campaign field types", () => {
	const t = setup();

	t.changeField("CT-B", "Campaign Status", 123);

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /Non-text campaign field/);
});

// Test 8
test("Reject formulas inside campaign fields", () => {
	const t = setup();

	t.master.formulas.add("3:21");

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /contains a formula/);
});

// Test 9
test("Reject duplicate Contact IDs", () => {
	const t = setup();

	t.master.rows.push([...t.master.rows[1]]);

	assert.throws(() => {
		t.context.djMergeReadCampaignSnapshot(t.db, "CT-A");
	}, /exactly one campaign contact/);
});

// Test 10
test("Reject missing or duplicate campaign headers", () => {
	const t = setup();

	const index = ALL_HEADERS.indexOf("Campaign History Data");

	t.master.rows[0][index] = "Unknown Header";

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /Expected exactly one/i);

	t.master.rows[0][index] = "Campaign History Data";
	t.master.rows[0].push("Campaign History Data");

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /Expected exactly one/);
});

// Test 11
test("Require an existing verified MA-02 backup", () => {
	const t = setup();

	assert.throws(() => {
		t.context.djMergePrepare(t.db, "MG-NOT-FOUND");
	}, /exactly one merge backup/i);
});

// Test 12
test("Reject changed MA-02 contact data", () => {
	const t = setup();

	t.changeField("CT-A", "Name / DJ Alias", "Changed DJ");

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /changed since backup/);
});

// Test 13
test("Require manual review of new contact information", () => {
	const t = setup();

	const mergeSheet = t.db.getSheetByName("Merge_History");

	const snapshotColumn = mergeSheet.rows[0].indexOf(
		"Duplicate Snapshot"
	);

	const snapshot = JSON.parse(
		mergeSheet.rows[1][snapshotColumn]
	);

	t.changeField(
		"CT-B",
		"Email",
		"another@example.test"
	);

	// Keep the saved backup current so the field-review blocker is reached.
	snapshot.Email = "another@example.test";

	mergeSheet.rows[1][snapshotColumn] = JSON.stringify(snapshot);

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /unresolved contact field blockers/);
});

// Test 14
test("Reject audit references to duplicate Contact ID", () => {
	const t = setup();

	const sheet = t.db.insertSheet("DJ_Engagement_Links");

	sheet.rows = [
		["Observation Key", "Contact ID"],
		["OBS-1", "CT-B"]
	];

	assert.throws(() => {
		t.context.djMergePrepare(t.db, t.mergeId);
	}, /engagement audit links/);
});

// Test 15
test("Allow audit references to surviving Contact ID", () => {
	const t = setup();

	const sheet = t.db.insertSheet("DJ_Engagement_Links");

	sheet.rows = [
		["Observation Key", "Contact ID"],
		["OBS-1", "CT-A"]
	];

	const plan = t.context.djMergePrepare(t.db, t.mergeId);

	assert.equal(plan.merged.history.length, 2);
});

// Test 16
test("Save both original histories and proposed merged history", () => {
	const t = setup();

	const result = t.context.djMergeSaveBackup(t.db, t.mergeId);

	assert.equal(result.status, "PREPARED");
	assert.equal(result.alreadySaved, false);
	assert.equal(t.audit().length, 1);

	const saved = t.context.djMergeReadSavedBackup(
		t.db,
		t.mergeId
	);

	assert.equal(saved.primary.history[0].reportId, "R1");
	assert.equal(saved.duplicate.history[0].reportId, "R2");
	assert.equal(saved.merged.history.length, 2);
	assert.equal(t.isLocked(), false);
});

// Test 17
test("Repeated backup saving is idempotent", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	const again = t.context.djMergeSaveBackup(
		t.db,
		t.mergeId
	);

	assert.equal(again.alreadySaved, true);
	assert.equal(t.audit().length, 1);
});

// Test 18
test("Reject source changes after saving DJ backup", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	t.changeField(
		"CT-B",
		"Campaign History Data",
		JSON.stringify([createReport("R3")])
	);

	assert.throws(() => {
		t.context.djMergeSaveBackup(t.db, t.mergeId);
	}, /differs from current contact data/);

	assert.equal(t.audit().length, 1);
	assert.equal(t.isLocked(), false);
});

// Test 19
test("Reject incorrect DJ_Merge_History headers", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	const sheet = t.db.getSheetByName("DJ_Merge_History");
	sheet.rows[0][0] = "Invalid";

	assert.throws(() => {
		t.context.djMergeReadSavedBackup(t.db, t.mergeId);
	}, /Unexpected DJ_Merge_History headers/);
});

// Test 20
test("Reject duplicate DJ merge backups", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	const sheet = t.db.getSheetByName("DJ_Merge_History");

	sheet.rows.push([...sheet.rows[1]]);

	assert.throws(() => {
		t.context.djMergeReadSavedBackup(t.db, t.mergeId);
	}, /Duplicate DJ merge backups/);
});

// Test 21
test("Reject corrupt saved DJ merge JSON", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	const sheet = t.db.getSheetByName("DJ_Merge_History");
	sheet.rows[1][3] = "{broken";

	assert.throws(() => {
		t.context.djMergeReadSavedBackup(t.db, t.mergeId);
	}, /Corrupt DJ merge backup JSON/);
});

// Test 22
test("Reject backup with mismatched Contact IDs", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	const sheet = t.db.getSheetByName("DJ_Merge_History");

	sheet.rows[1][1] = "CT-OTHER";

	assert.throws(() => {
		t.context.djMergeReadSavedBackup(t.db, t.mergeId);
	}, /mismatched Contact IDs/);
});

// Test 23
test("Release script lock after failed backup validation", () => {
	const t = setup();

	t.changeField(
		"CT-B",
		"Campaign History Data",
		"{broken"
	);

	assert.throws(() => {
		t.context.djMergeSaveBackup(t.db, t.mergeId);
	}, /Invalid Campaign History Data/);

	assert.equal(t.isLocked(), false);
});

// Test 24
test("Undo requires completed MA-02 merge", () => {
	const t = setup();

	t.context.djMergeSaveBackup(t.db, t.mergeId);

	assert.throws(() => {
		t.context.djMergePrepareUndo(t.db, t.mergeId);
	}, /Completed MA-02 merge is required/);
});

// Test 25
test("Undo requires existing DJ campaign backup", () => {
	const t = setup();

	const sheet = t.db.getSheetByName("Merge_History");
	const column = sheet.rows[0].indexOf("Merge Status");

	sheet.rows[1][column] = "MERGED";

	assert.throws(() => {
		t.context.djMergePrepareUndo(t.db, t.mergeId);
	}, /Verified MA-04 campaign backup is required/);
});

// Test 26
test("Undo preparation preserves both original histories", () => {
	const t = setup();

	t.simulateCompletedMerge();

	const writesBefore = t.master.writes;

	const result = t.context.djMergePrepareUndo(
		t.db,
		t.mergeId
	);

	assert.equal(result.status, "UNDO_READY");
	assert.equal(result.primaryRestore.history[0].reportId, "R1");
	assert.equal(result.duplicateRestore.history[0].reportId, "R2");

	// Preparation must not modify the actual contact records.
	assert.equal(t.master.writes, writesBefore);
});

// Test 27
test("Undo refuses history modified after merge", () => {
	const t = setup();

	t.simulateCompletedMerge();

	t.changeField(
		"CT-A",
		"Campaign History Data",
		JSON.stringify([createReport("R3")])
	);

	assert.throws(() => {
		t.context.djMergePrepareUndo(t.db, t.mergeId);
	}, /Campaign history changed after merge/);
});

// Test 28
test("Undo refuses restoration of an existing duplicate ID", () => {
	const t = setup();

	t.simulateCompletedMerge();

	const restoredRow = [...t.master.rows[1]];
	restoredRow[0] = "CT-B";

	t.master.rows.push(restoredRow);

	assert.throws(() => {
		t.context.djMergePrepareUndo(t.db, t.mergeId);
	}, /Duplicate contact already exists/);
});

// Test 29
test("Existing MA-04 merge guard remains active", () => {
	const t = setup();

	assert.throws(() => {
		t.context.contactSafeMergeCheckCampaignHistory(
			t.db,
			["CT-A", "CT-B"]
		);
	}, /MA-05 must support/);
});
