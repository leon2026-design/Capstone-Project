
// MA-05: DJ Identity Review
// Keep uncertain DJ matches for manual review without editing Master_Contacts.

const DJ_IDENTITY_REVIEW_SHEET = "DJ_Identity_Review";
const DJ_IDENTITY_REVIEW_HISTORY_SHEET = "DJ_Identity_Review_History";

const DJ_IDENTITY_REVIEW_HEADERS = [
	"Observation ID", "Reported Name", "Source Report ID", "Source Page",
	"Source Section", "Source URL", "Match Status", "Candidate Contact IDs",
	"Match Evidence", "Social Profiles", "Review Status", "Selected Contact ID",
	"Reviewer", "Review Date", "Review Notes"
];

const DJ_IDENTITY_REVIEW_HISTORY_HEADERS = [
	"Decision ID", "Observation ID", "Previous Status", "Decision",
	"Previous Contact ID", "Selected Contact ID", "Reviewer", "Review Date", "Notes"
];

function djIdentityReviewText(value) {
	return String(value == null ? "" : value).trim();
}

// Keep source text from becoming a Google Sheets formula.
function djIdentityReviewSafe(value) {
	const text = djIdentityReviewText(value);
	return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// Create a review sheet or verify that existing columns have not changed.
function djIdentityEnsureReviewSheet(ss, name, headers) {
	if (!ss || typeof ss.getSheetByName !== "function") {
		throw new Error("A spreadsheet is required.");
	}

	let sheet = ss.getSheetByName(name);

	if (!sheet) {
		sheet = ss.insertSheet(name);
	}

	const current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];

	if (current.every(value => !djIdentityReviewText(value))) {
		sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
		sheet.setFrozenRows(1);
	} else if (!headers.every((header, index) => current[index] === header)) {
		throw new Error("Incorrect headers in " + name);
	}

	return sheet;
}

// Reject repeated observation IDs so a review can never refer to two rows.
function djIdentityFindReviewRow(sheet, observationId) {
	const lastRow = sheet.getLastRow();

	if (lastRow < 2) {
		return null;
	}

	const values = sheet.getRange(
		2, 1, lastRow - 1, DJ_IDENTITY_REVIEW_HEADERS.length
	).getDisplayValues();

	let match = null;

	for (let i = 0; i < values.length; i++) {
		if (djIdentityReviewText(values[i][0]) !== observationId) {
			continue;
		}

		if (match) {
			throw new Error("Duplicate observation ID in identity review.");
		}

		match = {
			rowNumber: i + 2,
			values: values[i]
		};
	}

	return match;
}

// Queue uncertain identity results. Reimporting the same report is idempotent.
function djIdentitySaveReview(ss, observation, result) {
	if (!observation || !result ||
		typeof observation !== "object" ||
		typeof result !== "object") {
		throw new Error("Observation and identity result are required.");
	}

	const observationId = djIdentityReviewText(result.observationId);

	if (!observationId ||
		djIdentityReviewText(observation.observationId) !== observationId) {
		throw new Error("Invalid observation ID.");
	}

	if (result.decision === "LINK") {
		return null;
	}

	if (!["REVIEW", "UNRESOLVED"].includes(result.decision)) {
		throw new Error("Invalid identity resolution decision.");
	}

	if (!Array.isArray(result.candidates) ||
		!Array.isArray(result.socialProfiles)) {
		throw new Error("Identity candidates and social profiles must be arrays.");
	}

	const reportId = djIdentityReviewText(
		observation.sourceReportId || observation.reportId
	);

	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const sheet = djIdentityEnsureReviewSheet(
			ss,
			DJ_IDENTITY_REVIEW_SHEET,
			DJ_IDENTITY_REVIEW_HEADERS
		);

		const prior = djIdentityFindReviewRow(sheet, observationId);

		if (prior) {
			if (reportId && prior.values[2] && reportId !== prior.values[2]) {
				throw new Error("Observation ID belongs to a different source report.");
			}

			return prior.rowNumber;
		}

		const candidateIds = result.candidates.map(candidate =>
			djIdentityReviewText(candidate.contactId)
		).filter(Boolean);

		const row = [
			observationId,
			result.reportedName || observation.djReportedName || "",
			reportId,
			observation.sourcePage || "",
			observation.sourceSection || "",
			observation.sourceUrl || observation.sourceReportUrl || "",
			result.status || "",
			[...new Set(candidateIds)].join(", "),
			JSON.stringify(result.candidates),
			JSON.stringify(result.socialProfiles),
			"PENDING",
			"",
			"",
			"",
			""
		].map(djIdentityReviewSafe);

		if (row.some(value => value.length > 40000)) {
			throw new Error("Identity review record exceeds safe cell length.");
		}

		sheet.appendRow(row);

		return sheet.getLastRow();
	} finally {
		lock.releaseLock();
	}
}

// Verify a selected Contact ID is unique in Master_Contacts.
function djIdentityReviewContactExists(ss, contactId) {
	const sheet = ss.getSheetByName("Master_Contacts");

	if (!sheet || sheet.getLastRow() < 2) {
		return false;
	}

	const data = sheet.getDataRange().getDisplayValues();
	const idColumn = data[0].indexOf("Contact ID");

	if (idColumn < 0) {
		throw new Error("Master_Contacts is missing Contact ID.");
	}

	let count = 0;

	for (const row of data.slice(1)) {
		if (djIdentityReviewText(row[idColumn]) === contactId) {
			count++;
		}
	}

	if (count > 1) {
		throw new Error("Duplicate Contact ID in Master_Contacts.");
	}

	return count === 1;
}

// Record a human decision. The observation-to-contact link is applied later.
function djIdentityReviewDecision(ss, observationId, decision, contactId, reviewer, notes) {
	const id = djIdentityReviewText(observationId);
	const selectedId = djIdentityReviewText(contactId);
	const reviewerName = djIdentityReviewText(reviewer);
	const details = djIdentityReviewText(notes);

	if (!id || !reviewerName ||
		!["CONFIRM_LINK", "NO_LINK", "NEEDS_RESEARCH"].includes(decision)) {
		throw new Error("Observation ID, reviewer and valid decision are required.");
	}

	if ((decision === "CONFIRM_LINK" && !selectedId) ||
		(decision !== "CONFIRM_LINK" && selectedId)) {
		throw new Error("Selected Contact ID is invalid for this decision.");
	}

	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const sheet = djIdentityEnsureReviewSheet(
			ss,
			DJ_IDENTITY_REVIEW_SHEET,
			DJ_IDENTITY_REVIEW_HEADERS
		);

		const record = djIdentityFindReviewRow(sheet, id);

		if (!record) {
			throw new Error("Observation not found in identity review.");
		}

		const previousStatus = record.values[10];

		if (!["PENDING", "NEEDS_RESEARCH"].includes(previousStatus)) {
			throw new Error("Identity review has already finalized.");
		}

		if (decision === "CONFIRM_LINK") {
			if (!djIdentityReviewContactExists(ss, selectedId)) {
				throw new Error("Selected contact does not exist.");
			}

			const suggested = record.values[7].split(",")
				.map(value => value.trim())
				.filter(Boolean);

			if (!suggested.includes(selectedId) && !details) {
				throw new Error("Notes are required when selecting an alternative contact.");
			}
		}

		const status = decision === "CONFIRM_LINK" ? "APPROVED_LINK" :
			decision === "NO_LINK" ? "UNRESOLVED" : "NEEDS_RESEARCH";

		const reviewedAt = new Date();

		const history = djIdentityEnsureReviewSheet(
			ss,
			DJ_IDENTITY_REVIEW_HISTORY_SHEET,
			DJ_IDENTITY_REVIEW_HISTORY_HEADERS
		);

		// Write the audit entry before updating the review status.
		history.appendRow([
			"DJIDREV-" + Utilities.getUuid(),
			id,
			previousStatus,
			decision,
			record.values[11],
			selectedId,
			djIdentityReviewSafe(reviewerName),
			reviewedAt,
			djIdentityReviewSafe(details)
		]);

		sheet.getRange(record.rowNumber, 11, 1, 5).setValues([[
			status,
			selectedId,
			djIdentityReviewSafe(reviewerName),
			reviewedAt,
			djIdentityReviewSafe(details)
		]]);

		return {
			observationId: id,
			status: status,
			contactId: selectedId || null
		};
	} finally {
		lock.releaseLock();
	}
}
