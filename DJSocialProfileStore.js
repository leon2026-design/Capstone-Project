
// MA-05: DJ Social Profile Store
// Store DJ social accounts separately and track verification decisions.
// Reuse DJIdentityResolver.js without modifying Master_Contacts.

const DJ_SOCIAL_PROFILE_SHEET = "DJ_Social_Profiles";
const DJ_SOCIAL_PROFILE_HISTORY_SHEET = "DJ_Social_Profile_History";

const DJ_SOCIAL_PROFILE_HEADERS = [
	"Profile ID", "Observation ID", "Platform", "Profile URL",
	"Evidence Source", "Source Report ID", "Source Page",
	"Source Section", "Source URL", "Contact ID",
	"Verification Status", "Reviewer", "Review Date", "Notes"
];

const DJ_SOCIAL_PROFILE_HISTORY_HEADERS = [
	"Decision ID", "Profile ID", "Observation ID", "Previous Status",
	"Decision", "Previous Contact ID", "Selected Contact ID",
	"Reviewer", "Review Date", "Notes"
];

// Convert a value to text.
function djSocialProfileText(value) {
	return String(value == null ? "" : value).trim();
}

// Prevent imported text from being treated as a spreadsheet formula.
function djSocialProfileSafeText(value) {
	const text = djSocialProfileText(value);

	return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// Create a sheet or check its existing headers.
function djSocialProfileEnsureSheet(ss, name, headers) {
	let sheet = ss.getSheetByName(name);

	if (!sheet) {
		sheet = ss.insertSheet(name);
	}

	const current = sheet.getRange(1, 1, 1, headers.length)
		.getDisplayValues()[0];

	if (current.every(value => !djSocialProfileText(value))) {
		sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
		sheet.setFrozenRows(1);
	} else if (!headers.every((header, index) => current[index] === header)) {
		throw new Error("Incorrect headers in " + name);
	}

	return sheet;
}

// Normalize a social profile using the existing identity resolver.
function djSocialProfileNormalize(value) {
	const profile = djIdentityProfile(value, "REPORT");

	if (!profile) {
		throw new Error("Invalid or unsupported social profile.");
	}

	return {
		platform: profile.platform,
		profileUrl: profile.profileUrl,
		evidenceSource: profile.evidenceSource || "REPORT"
	};
}

// Create a unique key for each observation and social profile.
function djSocialProfileKey(observationId, platform, url) {
	return [
		djSocialProfileText(observationId),
		djSocialProfileText(platform).toLowerCase(),
		djSocialProfileText(url).toLowerCase()
	].join("|");
}

// Find an existing profile by its ID.
function djSocialProfileFindRow(sheet, profileId) {
	const lastRow = sheet.getLastRow();

	if (lastRow < 2) {
		return null;
	}

	const data = sheet.getRange(
		2, 1, lastRow - 1, DJ_SOCIAL_PROFILE_HEADERS.length
	).getDisplayValues();

	let found = null;

	for (let i = 0; i < data.length; i++) {
		if (djSocialProfileText(data[i][0]) === profileId) {
			if (found) {
				throw new Error("Duplicate social profile ID.");
			}

			found = {
				rowNumber: i + 2,
				values: data[i]
			};
		}
	}

	return found;
}

// Save the social profiles found in a DJ observation.
// New profiles always require review before being linked to contacts.
function djSocialProfileSave(ss, observation, result) {
	if (!observation || !result ||
		typeof observation !== "object" ||
		typeof result !== "object") {
		throw new Error("Observation and identity result are required.");
	}

	const observationId = djSocialProfileText(result.observationId);

	if (!observationId ||
		djSocialProfileText(observation.observationId) !== observationId) {
		throw new Error("Invalid observation ID.");
	}

	if (!Array.isArray(result.socialProfiles)) {
		throw new Error("Social profiles must be an array.");
	}

	const profiles = result.socialProfiles.map(djSocialProfileNormalize);

	if (!profiles.length) {
		return [];
	}

	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const sheet = djSocialProfileEnsureSheet(
			ss, DJ_SOCIAL_PROFILE_SHEET, DJ_SOCIAL_PROFILE_HEADERS
		);

		const existing = new Map();
		const lastRow = sheet.getLastRow();

		if (lastRow > 1) {
			const data = sheet.getRange(
				2, 1, lastRow - 1, DJ_SOCIAL_PROFILE_HEADERS.length
			).getDisplayValues();

			for (const row of data) {
				const key = djSocialProfileKey(row[1], row[2], row[3]);

				if (existing.has(key)) {
					throw new Error("Duplicate social profile record.");
				}

				existing.set(key, {
					profileId: row[0],
					reportId: row[5]
				});
			}
		}

		const reportId = djSocialProfileText(
			observation.sourceReportId || observation.reportId
		);

		const profileIds = [];

		for (const profile of profiles) {
			const key = djSocialProfileKey(
				observationId, profile.platform, profile.profileUrl
			);

			const previous = existing.get(key);

			// Reuse existing records instead of creating duplicates.
			if (previous) {
				if (reportId && previous.reportId &&
					reportId !== previous.reportId) {
					throw new Error("Conflicting source report for social profile.");
				}

				profileIds.push(previous.profileId);
				continue;
			}

			const profileId = "DJSP-" + Utilities.getUuid();

			const row = [
				profileId,
				observationId,
				profile.platform,
				profile.profileUrl,
				profile.evidenceSource,
				reportId,
				observation.sourcePage,
				observation.sourceSection,
				observation.sourceUrl || observation.sourceReportUrl,
				"",
				"PENDING_REVIEW",
				"",
				"",
				""
			].map(djSocialProfileSafeText);

			if (row.some(value => value.length > 40000)) {
				throw new Error("Social profile record exceeds the safe cell length.");
			}

			sheet.appendRow(row);

			existing.set(key, {
				profileId: profileId,
				reportId: reportId
			});

			profileIds.push(profileId);
		}

		return profileIds;
	} finally {
		lock.releaseLock();
	}
}

// Check whether a contact exists in Master_Contacts.
function djSocialProfileContactExists(ss, contactId) {
	const master = ss.getSheetByName("Master_Contacts");

	if (!master || master.getLastRow() < 2) {
		return false;
	}

	const data = master.getDataRange().getDisplayValues();
	const idColumn = data[0].indexOf("Contact ID");

	if (idColumn < 0) {
		throw new Error("Master_Contacts is missing Contact ID.");
	}

	const matches = data.slice(1).filter(row =>
		djSocialProfileText(row[idColumn]) === contactId
	);

	if (matches.length > 1) {
		throw new Error("Duplicate Contact ID in Master_Contacts.");
	}

	return matches.length === 1;
}

// Check whether an existing identity review conflicts with the selected contact.
function djSocialProfileCheckIdentityReview(ss, observationId, contactId) {
	const sheet = ss.getSheetByName("DJ_Identity_Review");

	if (!sheet || sheet.getLastRow() < 2) {
		return;
	}

	const data = sheet.getDataRange().getDisplayValues();
	const headers = data[0];

	const observationCol = headers.indexOf("Observation ID");
	const statusCol = headers.indexOf("Review Status");
	const contactCol = headers.indexOf("Selected Contact ID");

	if (observationCol < 0 || statusCol < 0 || contactCol < 0) {
		throw new Error("Invalid DJ identity review headers.");
	}

	const matches = data.slice(1).filter(row =>
		djSocialProfileText(row[observationCol]) === observationId
	);

	if (matches.length > 1) {
		throw new Error("Duplicate observation in identity review.");
	}

	if (matches.length === 1) {
		const status = djSocialProfileText(matches[0][statusCol]);
		const selected = djSocialProfileText(matches[0][contactCol]);

		if (status !== "APPROVED_LINK" || selected !== contactId) {
			throw new Error("Social profile conflicts with identity review.");
		}
	}
}

// Record a manual verification decision.
// Verification does not merge contacts or change the original observation.
function djSocialProfileReview(ss, profileId, decision, contactId, reviewer, notes) {
	const id = djSocialProfileText(profileId);
	const selectedId = djSocialProfileText(contactId);
	const reviewerName = djSocialProfileText(reviewer);
	const details = djSocialProfileText(notes);

	const allowed = ["VERIFY", "REJECT", "NEEDS_RESEARCH"];

	if (!id || !reviewerName || !allowed.includes(decision)) {
		throw new Error("Profile ID, reviewer and valid decision are required.");
	}

	if ((decision === "VERIFY" && !selectedId) ||
		(decision !== "VERIFY" && selectedId)) {
		throw new Error("Invalid Contact ID for verification decision.");
	}

	if (!details) {
		throw new Error("Review notes are required.");
	}

	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		const sheet = djSocialProfileEnsureSheet(
			ss, DJ_SOCIAL_PROFILE_SHEET, DJ_SOCIAL_PROFILE_HEADERS
		);

		const record = djSocialProfileFindRow(sheet, id);

		if (!record) {
			throw new Error("Social profile not found.");
		}

		const currentStatus = record.values[10];

		if (!["PENDING_REVIEW", "NEEDS_RESEARCH"].includes(currentStatus)) {
			throw new Error("This social profile has already been reviewed.");
		}

		if (decision === "VERIFY") {
			if (!djSocialProfileContactExists(ss, selectedId)) {
				throw new Error("Selected contact does not exist.");
			}

			djSocialProfileCheckIdentityReview(
				ss, record.values[1], selectedId
			);
		}

		const status = decision === "VERIFY" ? "VERIFIED" :
			decision === "REJECT" ? "REJECTED" : "NEEDS_RESEARCH";

		const reviewedAt = new Date();

		const history = djSocialProfileEnsureSheet(
			ss,
			DJ_SOCIAL_PROFILE_HISTORY_SHEET,
			DJ_SOCIAL_PROFILE_HISTORY_HEADERS
		);

		// Save the decision history before updating the profile.
		history.appendRow([
			"DJSPREV-" + Utilities.getUuid(),
			id,
			record.values[1],
			currentStatus,
			decision,
			record.values[9],
			selectedId,
			djSocialProfileSafeText(reviewerName),
			reviewedAt,
			djSocialProfileSafeText(details)
		]);

		sheet.getRange(record.rowNumber, 10, 1, 5).setValues([[
			selectedId,
			status,
			djSocialProfileSafeText(reviewerName),
			reviewedAt,
			djSocialProfileSafeText(details)
		]]);

		return {
			profileId: id,
			status: status,
			contactId: selectedId || null
		};
	} finally {
		lock.releaseLock();
	}
}

// Get verified social profiles for an existing contact.
// These can be passed to DJIdentityResolver for future matching.
function djSocialProfileGetVerified(ss, contactId) {
	const id = djSocialProfileText(contactId);
	const sheet = ss.getSheetByName(DJ_SOCIAL_PROFILE_SHEET);

	if (!id || !sheet || sheet.getLastRow() < 2) {
		return [];
	}

	const data = sheet.getRange(
		2, 1, sheet.getLastRow() - 1, DJ_SOCIAL_PROFILE_HEADERS.length
	).getDisplayValues();

	const profiles = [];
	const seen = new Set();

	for (const row of data) {
		if (row[9] !== id || row[10] !== "VERIFIED") {
			continue;
		}

		const key = djSocialProfileKey(id, row[2], row[3]);

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);

		profiles.push({
			platform: row[2],
			profileUrl: row[3],
			verificationStatus: "VERIFIED",
			evidenceSource: row[4]
		});
	}

	return profiles;
}
