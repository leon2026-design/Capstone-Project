
	// MA-05: Follow-up queue integration tests using in-memory Google Sheets.
	// No external API calls, master contact edits or real spreadsheet writes.

	const test = require("node:test");
	const assert = require("node:assert/strict");
	const fs = require("node:fs");
	const path = require("node:path");
	const vm = require("node:vm");

	const IDENTITY_HEADERS = [
		"Observation ID", "Reported Name", "Source Report ID", "Source Page",
		"Source Section", "Source URL", "Match Status", "Candidate Contact IDs",
		"Match Evidence", "Social Profiles", "Review Status", "Selected Contact ID",
		"Reviewer", "Review Date", "Review Notes"
	];

	const SOCIAL_HEADERS = [
		"Profile ID", "Observation ID", "Platform", "Profile URL",
		"Evidence Source", "Source Report ID", "Source Page", "Source Section",
		"Source URL", "Contact ID", "Verification Status", "Reviewer", "Review Date", "Notes"
	];

	function makeSheet(initial = []) {
		const sheet = {
			rows: initial.map(row => [...row]),
			writes: 0,

			getLastRow() {
				return this.rows.length;
			},

			getLastColumn() {
				return Math.max(1, ...this.rows.map(row => row.length));
			},

			getMaxRows() {
				return 100;
			},

			insertRowsAfter() {},
			setFrozenRows() {},

			getRange(r, c, height = 1, width = 1) {
				const read = () => Array.from({ length: height }, (_, i) =>
					Array.from({ length: width }, (_, j) =>
						sheet.rows[r + i - 1]?.[c + j - 1] ?? ""
					)
				);

				const write = values => {
					assert.equal(values.length, height);

					values.forEach((row, i) => {
						assert.equal(row.length, width);
						sheet.rows[r + i - 1] ??= [];

						row.forEach((value, j) => {
							sheet.rows[r + i - 1][c + j - 1] = value;
						});
					});

					sheet.writes++;
				};

				return {
					getValues: read,

					getDisplayValues: () => read().map(row => row.map(value =>
						value instanceof Date ? value.toISOString() :
							String(value).replace(/^'(?=[=+\-@])/, "")
					)),

					getValue: () => read()[0][0],
					setValues: write,
					setValue: value => write([[value]])
				};
			}
		};

		return sheet;
	}

	function fixture() {
		const identity = makeSheet([
			IDENTITY_HEADERS,
			["OBS-1", "Alex DJ", "REPORT-A", "2", "DJ", "https://example.test/A", "POSSIBLE_MATCH", "CT-1", "[]", "[]", "PENDING", "", "", "", ""],
			["OBS-2", "DJ Two", "REPORT-B", "3", "DJ", "https://example.test/B", "NO_MATCH", "", "[]", "[]", "NEEDS_RESEARCH", "", "", "", ""]
		]);

		const social = makeSheet([
			SOCIAL_HEADERS,
			["P-1", "OBS-1", "INSTAGRAM", "https://instagram.com/alex", "REPORT", "REPORT-A", "2", "DJ", "https://example.test/A", "", "PENDING_REVIEW", "", "", ""],
			["P-2", "OBS-1", "SOUNDCLOUD", "https://soundcloud.com/alex", "REPORT", "REPORT-A", "2", "DJ", "https://example.test/A", "CT-1", "VERIFIED", "Brad", "2026-11-10", "Reviewed"]
		]);

		const master = makeSheet([["Contact ID"], ["CT-1"]]);

		const sheets = {
			DJ_Identity_Review: identity,
			DJ_Social_Profiles: social,
			Master_Contacts: master
		};

		const book = {
			getSheetByName: name => sheets[name] || null,

			insertSheet(name) {
				sheets[name] = makeSheet([]);
				return sheets[name];
			}
		};

		const lock = {
			locked: false,

			waitLock() {
				assert.equal(this.locked, false, "Nested lock attempt");
				this.locked = true;
			},

			releaseLock() {
				assert.equal(this.locked, true);
				this.locked = false;
			}
		};

		const context = vm.createContext({
			Date,
			LockService: {
				getScriptLock: () => lock
			},
			SpreadsheetApp: {
				flush() {}
			}
		});

		vm.runInContext(
			fs.readFileSync(
				path.join(__dirname, "..", "DJFollowUpQueue.js"),
				"utf8"
			),
			context,
			{ filename: "DJFollowUpQueue.js" }
		);

		const fn = name => vm.runInContext(name, context);
		const getQueue = () => sheets.DJ_FollowUp_Queue;
		const queueRow = key => getQueue().rows.find(row => row[0] === key);

		return {
			identity, social, master, sheets, book,
			lock, fn, getQueue, queueRow
		};
	}

	test("Creates follow-ups from pending identity and social reviews", () => {
		const x = fixture();

		assert.equal(x.fn("djFollowUpSync")(x.book).created, 3);
		assert.equal(x.getQueue().rows.length, 4);
		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
		assert.equal(x.queueRow("IDENTITY|OBS-2")[10], "HIGH");
		assert.equal(x.queueRow("SOCIAL_PROFILE|P-1")[6], "INSTAGRAM");
		assert.equal(x.queueRow("SOCIAL_PROFILE|P-1")[5], "Alex DJ");
		assert.equal(x.queueRow("SOCIAL_PROFILE|P-2"), undefined);
		assert.equal(x.master.writes, 0);
		assert.equal(x.lock.locked, false);
	});

	test("Repeated sync makes no new rows or changes", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		const writes = x.getQueue().writes;
		const result = x.fn("djFollowUpSync")(x.book);

		assert.equal(result.created, 0);
		assert.equal(result.updated, 0);
		assert.equal(result.unchanged, 3);
		assert.equal(x.getQueue().writes, writes);
	});

	test("Preserves assignment and reviewer notes across sync", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.fn("djFollowUpSetProgress")(
			x.book, "IDENTITY|OBS-1", "IN_PROGRESS", "Wenhe", "Check source"
		);

		x.fn("djFollowUpSync")(x.book);

		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "IN_PROGRESS");
		assert.equal(x.queueRow("IDENTITY|OBS-1")[12], "Wenhe");
		assert.equal(x.queueRow("IDENTITY|OBS-1")[13], "Check source");
	});

	test("Finalized identity review resolves the queue task", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.identity.rows[1][10] = "APPROVED_LINK";
		const updated = x.fn("djFollowUpSync")(x.book);

		assert.equal(updated.updated, 1);
		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "RESOLVED");
	});

	test("Verified social profile resolves only its own queue task", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.social.rows[1][10] = "VERIFIED";
		x.fn("djFollowUpSync")(x.book);

		assert.equal(x.queueRow("SOCIAL_PROFILE|P-1")[11], "RESOLVED");
		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
	});

	test("Reopened review returns an old resolved task to OPEN", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.identity.rows[1][10] = "APPROVED_LINK";
		x.fn("djFollowUpSync")(x.book);

		x.identity.rows[1][10] = "PENDING";
		x.fn("djFollowUpSync")(x.book);

		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
	});

	test("UNRESOLVED remains visible for manual follow-up", () => {
		const x = fixture();
		x.identity.rows[1][10] = "UNRESOLVED";

		x.fn("djFollowUpSync")(x.book);

		assert.equal(x.queueRow("IDENTITY|OBS-1")[10], "HIGH");
		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
	});

	test("Rejects manual RESOLVED without a source decision", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		assert.throws(() => x.fn("djFollowUpSetProgress")(
			x.book, "IDENTITY|OBS-1", "RESOLVED", "Wenhe", "Done"
		), /Invalid follow-up progress/);

		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
	});

	test("Rejects progress when source status changed since sync", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.identity.rows[1][10] = "NEEDS_RESEARCH";

		assert.throws(() => x.fn("djFollowUpSetProgress")(
			x.book, "IDENTITY|OBS-1", "IN_PROGRESS", "Wenhe", "Investigate"
		), /synchronize the queue first/);
	});

	test("Rejects missing source rows without silently resolving old tasks", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.identity.rows.splice(1, 1);

		assert.throws(() => x.fn("djFollowUpSync")(x.book), /source is missing/);
		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
		assert.equal(x.lock.locked, false);
	});

	test("Rejects duplicate source IDs before creating queue", () => {
		const x = fixture();
		x.identity.rows.push([...x.identity.rows[1]]);

		assert.throws(() => x.fn("djFollowUpSync")(x.book), /duplicate follow-up source/);
		assert.equal(x.getQueue(), undefined);
		assert.equal(x.lock.locked, false);
	});

	test("Rejects malformed source headers", () => {
		const x = fixture();
		x.identity.rows[0][10] = "Wrong Header";

		assert.throws(() => x.fn("djFollowUpSync")(x.book), /Unexpected headers/);
		assert.equal(x.getQueue(), undefined);
	});

	test("Rejects unknown review status instead of guessing", () => {
		const x = fixture();
		x.social.rows[1][10] = "SOME_UNKNOWN_STATUS";

		assert.throws(() => x.fn("djFollowUpSync")(x.book), /Invalid source ID or status/);
		assert.equal(x.getQueue(), undefined);
	});

	test("Protects formula-like source text and reviewer notes", () => {
		const x = fixture();
		x.identity.rows[1][1] = '=IMPORTDATA("https://example.test")';

		x.fn("djFollowUpSync")(x.book);

		assert.match(x.queueRow("IDENTITY|OBS-1")[5], /^'/);

		x.fn("djFollowUpSetProgress")(
			x.book, "IDENTITY|OBS-1", "IN_PROGRESS", "Wenhe", '=HYPERLINK("evil")'
		);

		assert.match(x.queueRow("IDENTITY|OBS-1")[13], /^'/);

		const result = x.fn("djFollowUpSync")(x.book);
		assert.equal(result.updated, 0);
	});

	test("Rejects duplicate existing queue keys", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.getQueue().rows.push([...x.queueRow("IDENTITY|OBS-1")]);

		assert.throws(() => x.fn("djFollowUpSync")(x.book), /duplicate DJ follow-up queue/);
		assert.equal(x.lock.locked, false);
	});

	test("Rejects concurrent follow-up progress operations", () => {
		const x = fixture();
		x.fn("djFollowUpSync")(x.book);

		x.lock.locked = true;

		assert.throws(() => x.fn("djFollowUpSetProgress")(
			x.book, "IDENTITY|OBS-1", "IN_PROGRESS", "Wenhe", "Check"
		), /Nested lock attempt/);

		assert.equal(x.queueRow("IDENTITY|OBS-1")[11], "OPEN");
	});
