
// MA-05: DJ Engagement Linker
// Link approved report activity to Master_Contacts using the actual MA-04 history format.
// Do not guess identities, activity timestamps, or missing engagement data.

const DJ_ENGAGEMENT_LINK_SHEET = "DJ_Engagement_Links";
const DJ_ENGAGEMENT_LINK_HEADERS = [
	"Observation Key", "Contact ID", "Report ID", "Campaign",
	"Source URL", "Reviewer", "Review Date", "Linked At"
];

function djEngagementText(value) {
	return String(value == null ? "" : value).trim();
}

function djEngagementSafe(value) {
	const text = djEngagementText(value);
	return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// Read a sheet using its actual column headings, not assumed column numbers.
function djEngagementReadSheet(sheet, headers, name) {
	if (!sheet || sheet.getLastRow() < 1) {
		throw new Error(name + " sheet is missing or empty.");
	}

	const data = sheet.getDataRange().getDisplayValues();
	const columns = indexRequiredHeaders(data[0], headers, name);

	return {
		columns: columns,
		rows: data.slice(1)
	};
}

function djEngagementFindUnique(rows, column, value, label) {
	const found = rows.filter(row =>
		djEngagementText(row[column]) === value
	);

	if (found.length > 1) {
		throw new Error("Duplicate " + label + ": " + value);
	}

	return found[0] || null;
}

function djEngagementReadLinks(ss) {
	const sheet = ss.getSheetByName(DJ_ENGAGEMENT_LINK_SHEET);

	if (!sheet) {
		return [];
	}

	return djEngagementReadSheet(
		sheet,
		DJ_ENGAGEMENT_LINK_HEADERS,
		DJ_ENGAGEMENT_LINK_SHEET
	).rows;
}

function djEngagementEnsureLinks(ss) {
	let sheet = ss.getSheetByName(DJ_ENGAGEMENT_LINK_SHEET);

	if (!sheet) {
		sheet = ss.insertSheet(DJ_ENGAGEMENT_LINK_SHEET);
	}

	if (sheet.getLastRow() === 0) {
		sheet.getRange(
			1, 1, 1, DJ_ENGAGEMENT_LINK_HEADERS.length
		).setValues([DJ_ENGAGEMENT_LINK_HEADERS]);

		sheet.setFrozenRows(1);
	} else {
		djEngagementReadSheet(
			sheet,
			DJ_ENGAGEMENT_LINK_HEADERS,
			DJ_ENGAGEMENT_LINK_SHEET
		);
	}

	return sheet;
}

// Read campaign activity already linked by MA-04.
// Preserve the original status and activity time.
function djEngagementReadContact(ss, contactId) {
	const id = djEngagementText(contactId);

	if (!id) {
		throw new Error("Contact ID is required.");
	}

	const master = ss.getSheetByName("Master_Contacts");

	const data = djEngagementReadSheet(
		master,
		["Contact ID", "Campaign History Data"],
		"Master_Contacts"
	);

	const row = djEngagementFindUnique(
		data.rows,
		data.columns["Contact ID"],
		id,
		"Contact ID"
	);

	if (!row) {
		throw new Error("Contact ID not found: " + id);
	}

	const entries = parseSavedCampaignHistory(
		row[data.columns["Campaign History Data"]],
		id
	);

	return entries.map(entry => ({
		contactId: id,
		reportId: entry.reportId,
		campaign: entry.campaign,
		reportedStatus: entry.status,
		rating: entry.rating,
		favoriteTrack: entry.favoriteTrack,
		comments: entry.comments,
		reportGeneratedAt: entry.reportGeneratedAt,
		activityTime: entry.activityTime,
		sourceUrl: entry.sourceUrl,
		sourceTabUrl: entry.sourceTabUrl,
		extractedAt: entry.extractedAt,
		firstSavedAt: entry.firstSavedAt
	}));
}

// Find unresolved MA-04 identities in Import_Log.
// Use Observation Key as the MA-05 observationId.
function djEngagementPendingReviews(ss) {
	const log = ss.getSheetByName("Import_Log");

	if (!log) {
		return [];
	}

	const fields = djEngagementReadSheet(
		log,
		[
			"Observation Key",
			"Outcome",
			"Contact IDs",
			"Details",
			"Source Tab",
			"Source URL",
			"Source Row"
		],
		"Import_Log"
	);

	const links = djEngagementReadLinks(ss);

	const alreadyLinked = new Set(
		links.map(row => djEngagementText(row[0]))
	);

	const seen = new Set();
	const pending = [];

	for (const row of fields.rows) {
		if (row[fields.columns["Outcome"]] !== "Review identity") {
			continue;
		}

		const key = djEngagementText(
			row[fields.columns["Observation Key"]]
		);

		if (!key) {
			throw new Error("Review identity row is missing Observation Key.");
		}

		if (seen.has(key)) {
			throw new Error("Duplicate pending Observation Key: " + key);
		}

		seen.add(key);

		if (alreadyLinked.has(key)) {
			continue;
		}

		let details;

		try {
			details = JSON.parse(row[fields.columns["Details"]]);
		} catch (_) {
			throw new Error("Invalid identity details for " + key);
		}

		if (!details || !details.candidate ||
			typeof details.candidate !== "object") {
			throw new Error("Missing identity candidate for " + key);
		}

		const candidate = details.candidate;
		const reportUrl = djEngagementText(details.pdf);
		const reportFile = reportUrl.match(/\/d\/([A-Za-z0-9_-]+)/);

		pending.push({
			observationId: key,
			sourceReportId: reportFile ? "file:" + reportFile[1] : "",
			sourceReportUrl: reportUrl,
			djReportedName: djEngagementText(
				candidate["Name / DJ Alias"]
			),
			email: djEngagementText(candidate.Email),
			station: djEngagementText(
				candidate["Station / Venue / Organization"]
			),
			"Social Accounts": djEngagementText(
				candidate["Social Accounts"]
			),
			phone: djEngagementText(candidate.Phone),
			city: djEngagementText(candidate.City),
			state: djEngagementText(candidate["State / Region"]),
			country: djEngagementText(candidate.Country),
			candidateContactIds: djEngagementText(
				row[fields.columns["Contact IDs"]]
			),
			sourceTab: djEngagementText(
				row[fields.columns["Source Tab"]]
			),
			sourceUrl: djEngagementText(
				row[fields.columns["Source URL"]]
			),
			sourceRow: djEngagementText(
				row[fields.columns["Source Row"]]
			)
		});
	}

	return pending;
}

// Read the original source report again.
// Verify the Observation Key rather than trusting an old row number.
function djEngagementReadSource(sourceSpreadsheet, logRow, columns, observationKey) {
	if (!sourceSpreadsheet ||
		typeof sourceSpreadsheet.getSheets !== "function") {
		throw new Error("Source report spreadsheet is required.");
	}

	const tabUrl = djEngagementText(
		logRow[columns["Source URL"]]
	);

	const match = tabUrl.match(/#gid=(\d+)(?:&|$)/);

	if (!match) {
		throw new Error("Missing source report tab ID.");
	}

	const tab = sourceSpreadsheet.getSheets().find(sheet =>
		String(sheet.getSheetId()) === match[1]
	);

	if (!tab || tab.getName() !== logRow[columns["Source Tab"]]) {
		throw new Error("Original source report tab was not found.");
	}

	const data = tab.getDataRange().getDisplayValues();
	const fields = identifyContactFields(data[0]);
	const observations = [];

	for (let i = 1; i < data.length; i++) {
		if (!data[i].some(trimCellText)) {
			continue;
		}

		const candidate = readContactFromRow(fields, data[i]);

		const rawInfo = joinUniqueLines(
			data[i].filter((_, j) =>
				fields[j] === normalizeKey("Additional Info / Stations")
			)
		);

		const pdf = joinUniqueLines(
			data[i].filter((_, j) =>
				fields[j] === normalizeKey("Report Source URL")
			)
		);

		const observation = JSON.stringify({
			candidate: candidate,
			rawInfo: rawInfo,
			pdf: pdf
		});

		const key = Utilities.base64EncodeWebSafe(
			Utilities.computeDigest(
				Utilities.DigestAlgorithm.SHA_256,
				JSON.stringify([
					sourceSpreadsheet.getId(),
					tab.getSheetId(),
					observation
				]),
				Utilities.Charset.UTF_8
			)
		);

		if (key === observationKey) {
			observations.push({
				fields: fields,
				row: data[i],
				tab: tab
			});
		}
	}

	// Identical source rows are one observation, not an ambiguous identity.
	const responses = observations.map(found => readCampaignResponse(
		found.fields, found.row, sourceSpreadsheet.getId(),
		found.tab.getSheetId(), found.tab.getName(), tabUrl
	));
	if (observations.length < 1 || responses.some(response =>
		campaignResponseContent(response || {}) !== campaignResponseContent(responses[0] || {})
	)) {
		throw new Error(
			"Expected exactly one unchanged source observation: " +
			observationKey
		);
	}

	const found = observations[0];

	const response = readCampaignResponse(
		found.fields,
		found.row,
		sourceSpreadsheet.getId(),
		found.tab.getSheetId(),
		found.tab.getName(),
		tabUrl
	);

	if (!response) {
		throw new Error(
			"Source observation has no reported campaign activity."
		);
	}

	return response;
}

// Link a manually approved observation to an existing contact.
// Reuse MA-04 history storage and preserve an audit record.
function djEngagementLinkApproved(ss, sourceSpreadsheet, observationId) {
	const key = djEngagementText(observationId);

	if (!key) {
		throw new Error("Observation Key is required.");
	}

	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const log = djEngagementReadSheet(
			ss.getSheetByName("Import_Log"),
			[
				"Observation Key",
				"Outcome",
				"Source Tab",
				"Source URL"
			],
			"Import_Log"
		);

		const imported = djEngagementFindUnique(
			log.rows,
			log.columns["Observation Key"],
			key,
			"Import_Log Observation Key"
		);

		if (!imported ||
			imported[log.columns["Outcome"]] !== "Review identity") {
			throw new Error(
				"Observation is not waiting for identity review."
			);
		}

		const review = djEngagementReadSheet(
			ss.getSheetByName("DJ_Identity_Review"),
			[
				"Observation ID",
				"Review Status",
				"Selected Contact ID",
				"Reviewer",
				"Review Date"
			],
			"DJ_Identity_Review"
		);

		const approved = djEngagementFindUnique(
			review.rows,
			review.columns["Observation ID"],
			key,
			"DJ identity review"
		);

		if (!approved ||
			approved[review.columns["Review Status"]] !== "APPROVED_LINK") {
			throw new Error("Manual identity approval is required.");
		}

		const contactId = djEngagementText(
			approved[review.columns["Selected Contact ID"]]
		);

		const reviewer = djEngagementText(
			approved[review.columns["Reviewer"]]
		);

		const reviewDate = djEngagementText(
			approved[review.columns["Review Date"]]
		);

		if (!contactId || !reviewer || !reviewDate) {
			throw new Error("Identity approval is incomplete.");
		}

		const master = ss.getSheetByName("Master_Contacts");

		const contacts = djEngagementReadSheet(
			master,
			["Contact ID", "Campaign History Data"],
			"Master_Contacts"
		);

		const person = djEngagementFindUnique(
			contacts.rows,
			contacts.columns["Contact ID"],
			contactId,
			"Contact ID"
		);

		if (!person) {
			throw new Error(
				"Approved Contact ID no longer exists."
			);
		}

		const response = djEngagementReadSource(
			sourceSpreadsheet,
			imported,
			log.columns,
			key
		);

		const links = djEngagementReadLinks(ss);

		const prior = djEngagementFindUnique(
			links,
			0,
			key,
			"engagement link"
		);

		if (prior) {
			if (prior[1] !== contactId ||
				prior[2] !== response.reportId) {
				throw new Error(
					"Observation was linked to a different contact or report."
				);
			}

			const history = parseSavedCampaignHistory(
				person[contacts.columns["Campaign History Data"]],
				contactId
			);

			if (!history.some(entry =>
				entry.reportId === response.reportId
			)) {
				throw new Error(
					"Engagement audit exists but campaign history is missing."
				);
			}

			return {
				observationId: key,
				contactId: contactId,
				reportId: response.reportId,
				status: "ALREADY_LINKED"
			};
		}

		const existing = parseSavedCampaignHistory(
			person[contacts.columns["Campaign History Data"]],
			contactId
		);

		const sameReport = existing.find(entry =>
			entry.reportId === response.reportId
		);

		if (sameReport &&
			campaignResponseContent(sameReport) !==
			campaignResponseContent(response)) {
			throw new Error(
				"Campaign report already has different activity for this contact."
			);
		}

		// Validate the audit sheet before writing history.
		const linkSheet = djEngagementEnsureLinks(ss);

		// Reuse MA-04 storage and its duplicate-handling rules.
		const store = createCampaignHistoryStore(master);

		store.queue(contactId, response);
		store.commit();

		linkSheet.appendRow([
			key,
			contactId,
			response.reportId,
			djEngagementSafe(response.campaign),
			djEngagementSafe(response.sourceUrl),
			djEngagementSafe(reviewer),
			reviewDate,
			new Date()
		]);

		return {
			observationId: key,
			contactId: contactId,
			reportId: response.reportId,
			status: "LINKED"
		};
	} finally {
		lock.releaseLock();
	}
}
