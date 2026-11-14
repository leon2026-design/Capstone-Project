// MA-06: DJ contact enrichment.
// Research findings stay separate from MA-05 verified-profile storage until reviewed.

const DJ_ENRICHMENT_JOB_SHEET = "DJ_Enrichment_Jobs";
const DJ_ENRICHMENT_CANDIDATE_SHEET = "DJ_Enrichment_Candidates";
const DJ_ENRICHMENT_EVIDENCE_SHEET = "DJ_Enrichment_Evidence";
const DJ_ENRICHMENT_REVIEW_HISTORY_SHEET = "DJ_Enrichment_Review_History";
const DJ_ENRICHMENT_API_USAGE_SHEET = "DJ_Enrichment_API_Usage";

const DJ_ENRICHMENT_JOB_HEADERS = [
	"Job ID", "Contact ID", "Observation ID", "Research Target",
	"Research Provider", "Job Status", "Attempt Count", "Created At",
	"Updated At", "Error Details", "Search Query", "Identity JSON"
];

const DJ_ENRICHMENT_CANDIDATE_HEADERS = [
	"Enrichment ID", "Job ID", "Contact ID", "Observation ID",
	"Platform", "Candidate URL", "Candidate Value", "Source URL",
	"Contact Type", "Search Provider", "Search Query", "Confidence",
	"Review Status", "Created At", "Last Checked", "Candidate Data JSON"
];

const DJ_ENRICHMENT_EVIDENCE_HEADERS = [
	"Evidence ID", "Enrichment ID", "Evidence Type", "Evidence Value",
	"Source URL", "Observed At", "Evidence Status"
];

const DJ_ENRICHMENT_REVIEW_HISTORY_HEADERS = [
	"Decision ID", "Enrichment ID", "Previous Status", "Decision",
	"Reviewer", "Review Date", "Notes"
];

const DJ_ENRICHMENT_API_USAGE_HEADERS = [
	"Request ID", "Job ID", "Research Provider", "Platform",
	"API Name", "Started At", "Completed At", "Outcome"
];

const DJ_ENRICHMENT_PLATFORMS = [
	"INSTAGRAM", "TIKTOK", "FACEBOOK", "SOUNDCLOUD", "MIXCLOUD",
	"WEBSITE", "RADIO_DIRECTORY", "BUSINESS_EMAIL"
];

const DJ_ENRICHMENT_SOCIAL_PLATFORMS = [
	"INSTAGRAM", "TIKTOK", "FACEBOOK", "SOUNDCLOUD", "MIXCLOUD"
];

const DJ_ENRICHMENT_COMMON_SINGLE_NAMES = new Set([
	"alex", "andrew", "chris", "dan", "david", "james", "john",
	"josh", "mike", "nick", "sam", "steve", "tom"
]);

const DJ_ENRICHMENT_CONTACT_TYPES = [
	"PERSONAL_PROFESSIONAL", "BOOKING", "MANAGEMENT", "STATION",
	"ORGANIZATION", "UNKNOWN"
];

function djEnrichmentText(value) {
	return String(value == null ? "" : value).trim();
}

function djEnrichmentSafe(value) {
	const text = djEnrichmentText(value);
	return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function djEnrichmentNow() {
	return new Date().toISOString();
}

function djEnrichmentEnsureSheet(ss, name, headers) {
	if (!ss || typeof ss.getSheetByName !== "function") {
		throw new Error("A spreadsheet is required.");
	}

	let sheet = ss.getSheetByName(name);

	if (!sheet) {
		sheet = ss.insertSheet(name);
	}

	const values = sheet.getDataRange().getDisplayValues();
	const current = values[0] || [];

	if (current.every(value => !djEnrichmentText(value))) {
		if (sheet.getLastRow() > 0) {
			throw new Error("Cannot initialize " + name + " over existing data.");
		}
		sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
		sheet.setFrozenRows(1);
		return sheet;
	}

	const lastColumn = sheet.getLastColumn
		? sheet.getLastColumn()
		: current.length;

	if (lastColumn !== headers.length ||
		!headers.every((header, index) => current[index] === header)) {
		throw new Error("Incorrect headers in " + name + ".");
	}

	return sheet;
}

function djEnrichmentReadTable(ss, name, headers) {
	const sheet = ss.getSheetByName(name);

	if (!sheet) {
		return { sheet: null, rows: [] };
	}

	const values = sheet.getDataRange().getDisplayValues();
	const actual = values[0] || [];

	if (actual.length !== headers.length ||
		!headers.every((header, index) => actual[index] === header)) {
		throw new Error("Incorrect headers in " + name + ".");
	}

	return { sheet: sheet, rows: values.slice(1) };
}

function djEnrichmentAppend(sheet, values) {
	if (values.some(value => djEnrichmentText(value).length > 40000)) {
		throw new Error("Enrichment record exceeds the safe cell length.");
	}

	sheet.appendRow(values.map(djEnrichmentSafe));
}

function djEnrichmentLock(callback) {
	const lock = LockService.getScriptLock();
	lock.waitLock(10000);

	try {
		return callback();
	} finally {
		lock.releaseLock();
	}
}

function djEnrichmentNormalizeText(value) {
	return djEnrichmentText(value).toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function djEnrichmentIdentity(target) {
	if (!target || typeof target !== "object" || Array.isArray(target)) {
		throw new Error("An enrichment target is required.");
	}

	const aliases = [];
	const rawAliases = Array.isArray(target.aliases)
		? target.aliases
		: [target.aliases];
	const name = djEnrichmentText(
		target.djAlias || target.djReportedName ||
		target.name || target["Name / DJ Alias"]
	);

	if (name) {
		aliases.push(name);
	}

	rawAliases.forEach(alias => {
		if (djEnrichmentText(alias)) {
			aliases.push(djEnrichmentText(alias));
		}
	});

	const uniqueAliases = [...new Set(aliases)];
	const knownWebsite = djEnrichmentText(
		target.website || target.officialWebsite || target.Website
	);
	const identity = {
		aliases: uniqueAliases,
		station: djEnrichmentText(
			target.station || target.radioStation ||
			target["Station / Venue / Organization"]
		),
		city: djEnrichmentText(target.city || target.City),
		region: djEnrichmentText(
			target.region || target.state || target["State / Region"]
		),
		country: djEnrichmentText(target.country || target.Country),
		website: knownWebsite ? djEnrichmentPublicUrl(knownWebsite) || "" : ""
	};
	// Only already-known public profile URLs are research hints; emails and phones never are.
	const publicLinks = [];
	String(target.socialAccounts || target["Social Accounts"] || "")
		.split(/[\r\n,]+/).forEach(value => {
			const profile = djEnrichmentText(value) && djIdentityProfile(value, "CONTACT_FIELD");
			if (profile && profile.profileUrl.length <= 500 &&
				!publicLinks.includes(profile.profileUrl) && publicLinks.length < 5) {
				publicLinks.push(profile.profileUrl);
			}
		});
	if (publicLinks.length) identity.publicLinks = publicLinks;
	if (uniqueAliases.length > 20 ||
		uniqueAliases.some(alias => alias.length > 500) ||
		[identity.station, identity.city, identity.region, identity.country,
			identity.website].some(value => value.length > 500)) {
		throw new Error("Identity data exceeds MA-06 size limits.");
	}

	const specificAlias = uniqueAliases.some(alias => {
		const normalized = djEnrichmentNormalizeText(alias);
		return normalized.length >= 4 &&
			!DJ_ENRICHMENT_COMMON_SINGLE_NAMES.has(normalized);
	});
	const disambiguator = identity.station || identity.city ||
		identity.region || identity.country || identity.website;

	return {
		identity: identity,
		usable: uniqueAliases.length > 0 && (specificAlias || !!disambiguator)
	};
}

function djEnrichmentBuildQuery(identity, platform) {
	if (!identity || !Array.isArray(identity.aliases) ||
		!DJ_ENRICHMENT_PLATFORMS.includes(platform)) {
		throw new Error("Identity and a supported platform are required.");
	}

	const aliasQuery = identity.aliases.length > 1
		? "(" + identity.aliases.slice(0, 3)
			.map(alias => '"' + alias + '"').join(" OR ") + ")"
		: identity.aliases[0];
	const parts = [aliasQuery, platform.toLowerCase()];
	if (identity.station) parts.push(identity.station);
	if (identity.city) parts.push(identity.city);
	if (identity.region) parts.push(identity.region);
	if (identity.country) parts.push(identity.country);

	if (identity.website) {
		const website = djEnrichmentPublicUrl(identity.website);
		const host = website && website.match(/^https:\/\/([^/]+)/i);
		if (host) {
			parts.push(host[1].toLowerCase());
		}
	}

	return [...new Set(parts.filter(Boolean))].join(" ");
}

function djEnrichmentParsePublicUrl(value, stripQuery) {
	const match = djEnrichmentText(value).match(
		/^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i
	);
	if (!match) return null;
	const authority = match[1].toLowerCase();
	if (authority.includes("@")) return null;
	const host = authority.endsWith(":443")
		? authority.slice(0, -4)
		: authority;
	const validDomain =
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
			.test(host);
	const privateHost =
		host === "localhost" || host.endsWith(".localhost") ||
		host.endsWith(".local") || host.endsWith(".internal") ||
		/^127\./.test(host) || /^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

	if (!validDomain || privateHost ||
		(authority !== host && authority !== host + ":443")) {
		return null;
	}

	const path = match[2] || "/";
	const query = stripQuery ? "" : match[3] || "";
	return "https://" + host + path + query;
}

function djEnrichmentPublicUrl(value) {
	return djEnrichmentParsePublicUrl(value, true);
}

function djEnrichmentNormalizeCandidateUrl(value, platform) {
	if (DJ_ENRICHMENT_SOCIAL_PLATFORMS.includes(platform)) {
		const profile = djIdentityProfile(value, "ENRICHMENT");
		if (!profile || profile.platform !== platform) {
			return null;
		}
		return profile.profileUrl;
	}

	return djEnrichmentPublicUrl(value);
}

function djEnrichmentHeaderMap(headers) {
	const map = {};
	headers.forEach((value, index) => {
		map[djEnrichmentText(value)] = index;
	});
	return map;
}

function djEnrichmentRequireHeaders(headers, required, name) {
	const map = djEnrichmentHeaderMap(headers);
	required.forEach(header => {
		if (map[header] == null ||
			headers.lastIndexOf(header) !== map[header]) {
			throw new Error(name + " is missing or duplicates " + header + ".");
		}
	});
	return map;
}

function djEnrichmentTruth(value) {
	return [
		"1", "true", "yes", "y", "opt out", "opted out",
		"do not contact", "do not research", "restricted", "excluded"
	]
		.includes(djEnrichmentText(value).toLowerCase());
}

function djEnrichmentIsExcluded(contact, headers) {
	const policyHeaderPattern =
		/^(do not contact|dnc|do not research|research opt out|privacy opt out|contact restriction)$/i;

	return headers.some((header, index) => {
		return policyHeaderPattern.test(djEnrichmentText(header)) &&
			djEnrichmentTruth(contact[index]);
	});
}

function djEnrichmentContactPriority(contact, columns, ss, contactId) {
	const observations = [];
	const statusColumn = columns["Campaign Status"];
	const ratingColumn = columns["Campaign Rating"];
	const feedbackColumn = columns["Campaign Feedback"];

	if (statusColumn != null) {
		observations.push({
			reportedStatus: contact[statusColumn],
			rating: ratingColumn == null ? "" : contact[ratingColumn],
			comments: feedbackColumn == null ? "" : contact[feedbackColumn]
		});
	}

	const historyColumn = columns["Campaign History Data"];
	if (historyColumn != null && typeof parseSavedCampaignHistory === "function") {
		observations.push(...parseSavedCampaignHistory(
			contact[historyColumn], contactId
		).map(item => ({
			reportedStatus: item.status,
			rating: item.rating,
			comments: item.comments
		})));
	} else if (ss.getSheetByName("DJ_Engagement_Links") &&
		typeof djEngagementReadContact === "function") {
		observations.push(...djEngagementReadContact(ss, contactId));
	}

	const statuses = observations.map(item =>
		djEnrichmentText(item.reportedStatus).toLowerCase()
	).join(" ");
	const ratings = observations.map(item =>
		djEnrichmentText(item.rating).toLowerCase()
	).join(" ");
	const comments = observations.map(item =>
		djEnrichmentText(item.comments).toLowerCase()
	).join(" ");

	if (/\bdownload(?:ed|er)?\b/.test(statuses) &&
		!/\bnot\s+downloaded\b/.test(statuses)) {
		return { priority: 4, category: "PROVIDER_REPORTED_DOWNLOAD" };
	}
	const negatedFeedback =
		/\b(?:not|never|don't|do not|won't|wouldn't|can't|cannot)\s+(?:be\s+able\s+to\s+)?(?:great|excellent|love|like|support|play|add)\b/;
	const positiveRating =
		/\b(positive|great|excellent|love|liked)\b/.test(ratings) ||
		/\b(4|5)\s*(?:\/\s*5|stars?)\b/.test(ratings);
	const positiveComment =
		/\b(great|excellent|love|loved|like|liked|support|supported)\b/.test(comments) &&
		!negatedFeedback.test(comments);
	if (positiveRating || positiveComment) {
		return { priority: 3, category: "EXPLICIT_POSITIVE_FEEDBACK" };
	}
	if (/\b(play|playing|support|add to (?:my )?rotation|airplay)\b/.test(comments) &&
		!negatedFeedback.test(comments)) {
		return { priority: 2, category: "STATED_INTEREST" };
	}

	return { priority: 1, category: "OTHER_ENGAGEMENT_REVIEW" };
}

function djEnrichmentObservationExists(ss, observationId) {
	const id = djEnrichmentText(observationId);
	if (!id) return false;

	const review = ss.getSheetByName("DJ_Identity_Review");
	if (review && review.getLastRow() > 1) {
		const rows = review.getDataRange().getDisplayValues();
		const columns = djEnrichmentHeaderMap(rows[0]);
		if (columns["Observation ID"] == null) {
			throw new Error("Invalid DJ_Identity_Review headers.");
		}
		if (rows.slice(1).some(row => row[columns["Observation ID"]] === id)) {
			return true;
		}
	}

	const log = ss.getSheetByName("Import_Log");
	if (!log || log.getLastRow() < 2) return false;
	const rows = log.getDataRange().getDisplayValues();
	const columns = djEnrichmentHeaderMap(rows[0]);
	if (columns["Observation Key"] == null) {
		throw new Error("Invalid Import_Log headers.");
	}
	return rows.slice(1).some(row => row[columns["Observation Key"]] === id);
}

function djEnrichmentObservationIdentity(ss, observationId) {
	const id = djEnrichmentText(observationId);
	const log = ss.getSheetByName("Import_Log");

	if (log && log.getLastRow() > 1) {
		const rows = log.getDataRange().getDisplayValues();
		const columns = djEnrichmentRequireHeaders(
			rows[0], ["Observation Key", "Details"], "Import_Log"
		);
		const matches = rows.slice(1).filter(row =>
			row[columns["Observation Key"]] === id
		);
		if (matches.length > 1) {
			throw new Error("Duplicate Observation Key in Import_Log: " + id);
		}
		if (matches.length === 1) {
			let details;
			try {
				details = JSON.parse(matches[0][columns.Details]);
			} catch (_) {
				throw new Error("Invalid imported identity details for " + id + ".");
			}
			if (!details || !details.candidate ||
				typeof details.candidate !== "object") {
				throw new Error("Imported identity candidate is missing for " + id + ".");
			}
			const candidate = details.candidate;
			return {
				djReportedName: candidate["Name / DJ Alias"],
				aliases: candidate.aliases,
				station: candidate["Station / Venue / Organization"],
				city: candidate.City,
				region: candidate["State / Region"],
				country: candidate.Country,
				website: candidate.Website
			};
		}
	}

	const review = ss.getSheetByName("DJ_Identity_Review");
	if (review && review.getLastRow() > 1) {
		const rows = review.getDataRange().getDisplayValues();
		const columns = djEnrichmentRequireHeaders(
			rows[0], ["Observation ID", "Reported Name"], "DJ_Identity_Review"
		);
		const matches = rows.slice(1).filter(row =>
			row[columns["Observation ID"]] === id
		);
		if (matches.length > 1) {
			throw new Error("Duplicate observation in DJ_Identity_Review: " + id);
		}
		if (matches.length === 1) {
			return { djReportedName: matches[0][columns["Reported Name"]] };
		}
	}

	throw new Error("Observation ID is not present in MA-05 identity records: " + id);
}

function djEnrichmentValidateTarget(ss, target) {
	const contactId = djEnrichmentText(target.contactId);
	const observationId = djEnrichmentText(target.observationId);

	if (!!contactId === !!observationId) {
		throw new Error("Provide exactly one Contact ID or Observation ID.");
	}

	let identitySource = target;
	if (contactId) {
		if (typeof djSocialProfileContactExists !== "function" ||
			!djSocialProfileContactExists(ss, contactId)) {
			throw new Error("Contact ID does not exist: " + contactId);
		}
		const master = ss.getSheetByName("Master_Contacts");
		const rows = master.getDataRange().getDisplayValues();
		const headers = rows[0];
		const columns = djEnrichmentRequireHeaders(
			headers, ["Contact ID", "Name / DJ Alias"], "Master_Contacts"
		);
		const matches = rows.slice(1).filter(row =>
			djEnrichmentText(row[columns["Contact ID"]]) === contactId
		);
		if (matches.length !== 1) {
			throw new Error("Contact ID must identify exactly one Master_Contacts row.");
		}
		if (djEnrichmentIsExcluded(matches[0], headers)) {
			return {
				eligible: false,
				status: "POLICY_EXCLUDED",
				contactId: contactId,
				observationId: observationId,
				identity: {}
			};
		}
		const row = matches[0];
		identitySource = {
			name: row[columns["Name / DJ Alias"]],
			station: columns["Station / Venue / Organization"] == null
				? ""
				: row[columns["Station / Venue / Organization"]],
			city: columns.City == null ? "" : row[columns.City],
			region: columns["State / Region"] == null
				? ""
				: row[columns["State / Region"]],
			country: columns.Country == null ? "" : row[columns.Country],
			website: columns.Website == null ? "" : row[columns.Website],
			socialAccounts: columns["Social Accounts"] == null
				? ""
				: row[columns["Social Accounts"]]
		};
	} else {
		if (!djEnrichmentObservationExists(ss, observationId)) {
			throw new Error("Observation ID is not present in MA-05 review or import records.");
		}
		identitySource = djEnrichmentObservationIdentity(ss, observationId);
	}

	const built = djEnrichmentIdentity(identitySource);
	if (!built.usable) {
		return {
			eligible: false,
			status: "INSUFFICIENT_IDENTITY_DATA",
			contactId: contactId,
			observationId: observationId,
			identity: built.identity
		};
	}

	return {
		eligible: true,
		contactId: contactId,
		observationId: observationId,
		identity: built.identity,
		priority: Number(target.priority) || 1,
		priorityCategory: djEnrichmentText(target.priorityCategory) ||
			"OTHER_ENGAGEMENT_REVIEW"
	};
}

function djEnrichmentVerifiedPlatforms(ss, contactId, observationId) {
	if (!contactId || typeof djSocialProfileGetVerified !== "function") {
		const profiles = [];
		const sheet = ss.getSheetByName(DJ_SOCIAL_PROFILE_SHEET);
		if (sheet && observationId && sheet.getLastRow() > 1) {
			const rows = sheet.getDataRange().getDisplayValues();
			const columns = djEnrichmentRequireHeaders(
				rows[0],
				["Observation ID", "Platform", "Verification Status"],
				DJ_SOCIAL_PROFILE_SHEET
			);
			rows.slice(1).forEach(row => {
				if (row[columns["Observation ID"]] === observationId &&
					row[columns["Verification Status"]] === "VERIFIED") {
					profiles.push(row[columns.Platform]);
				}
			});
		}
		return new Set(profiles.map(value => djEnrichmentText(value).toUpperCase()));
	}

	const profiles = djSocialProfileGetVerified(ss, contactId).map(profile =>
		djEnrichmentText(profile.platform).toUpperCase()
	);
	const sheet = ss.getSheetByName(DJ_SOCIAL_PROFILE_SHEET);
	if (sheet && observationId && sheet.getLastRow() > 1) {
		const rows = sheet.getDataRange().getDisplayValues();
		const columns = djEnrichmentRequireHeaders(
			rows[0],
			["Observation ID", "Platform", "Verification Status"],
			DJ_SOCIAL_PROFILE_SHEET
		);
		rows.slice(1).forEach(row => {
			if (row[columns["Observation ID"]] === observationId &&
				row[columns["Verification Status"]] === "VERIFIED") {
				profiles.push(row[columns.Platform]);
			}
		});
	}
	return new Set(profiles);
}

function djEnrichmentFindJob(ss, targetKey) {
	const table = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
	);
	const found = table.rows.filter(row =>
		[
			djEnrichmentText(row[1]),
			djEnrichmentText(row[2]),
			djEnrichmentText(row[3])
		].join("|") === targetKey
	);

	if (found.length > 1) {
		throw new Error("Duplicate enrichment jobs for " + targetKey + ".");
	}
	return found[0] || null;
}

function djEnrichmentCreateJob(ss, target, platform, providerId, query) {
	const targetKey = [
		target.contactId, target.observationId, platform
	].join("|");

	return djEnrichmentLock(() => {
		const sheet = djEnrichmentEnsureSheet(
			ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
		);
		const prior = djEnrichmentFindJob(ss, targetKey);
		if (prior) return prior[0];

		const now = djEnrichmentNow();
		const id = "DJEJ-" + Utilities.getUuid();
		djEnrichmentAppend(sheet, [
			id,
			target.contactId,
			target.observationId,
			platform,
			providerId,
			"QUEUED",
			0,
			now,
			now,
			"",
			query,
			JSON.stringify(target.identity)
		]);
		return id;
	});
}

function djEnrichmentRequeueJob(ss, record, providerId, query) {
	return djEnrichmentUpdateJob(ss, record[0], row => {
		row[4] = providerId;
		row[5] = "QUEUED";
		row[6] = 0;
		row[8] = djEnrichmentNow();
		row[9] = "";
		row[10] = query;
		return row;
	});
}

function djEnrichmentFindJobRecord(ss, jobId) {
	const table = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
	);
	const matches = table.rows.map((row, index) => ({ row: row, rowNumber: index + 2 }))
		.filter(item => djEnrichmentText(item.row[0]) === jobId);
	if (matches.length > 1) {
		throw new Error("Duplicate enrichment Job ID: " + jobId);
	}
	return matches[0] || null;
}

function djEnrichmentUpdateJob(ss, jobId, updater) {
	return djEnrichmentLock(() => {
		const record = djEnrichmentFindJobRecord(ss, jobId);
		if (!record) throw new Error("Enrichment job not found: " + jobId);
		const next = updater([...record.row]);
		const sheet = ss.getSheetByName(DJ_ENRICHMENT_JOB_SHEET);
		sheet.getRange(record.rowNumber, 1, 1, DJ_ENRICHMENT_JOB_HEADERS.length)
			.setValues([next.map(djEnrichmentSafe)]);
		return next;
	});
}

function djEnrichmentProviderMap(providers) {
	if (providers == null) return new Map();
	if (!Array.isArray(providers)) throw new Error("Research providers must be an array.");

	const map = new Map();
	for (const provider of providers) {
		if (!provider || typeof provider !== "object" ||
			!djEnrichmentText(provider.providerId) ||
			typeof provider.authorized !== "boolean" ||
			!Array.isArray(provider.supportedPlatforms) ||
			!provider.capabilities || typeof provider.capabilities !== "object") {
			throw new Error("Invalid research provider configuration.");
		}
		if (map.has(provider.providerId)) {
			throw new Error("Duplicate research provider ID: " + provider.providerId);
		}
		[
			"searchPublicProfiles",
			"retrievePublicProfiles",
			"normalizeUserSuppliedUrls"
		].forEach(capability => {
			if (typeof provider.capabilities[capability] !== "boolean") {
				throw new Error("Research provider must explicitly declare " + capability + ".");
			}
		});
		if (provider.capabilities.searchPublicProfiles === true &&
			typeof provider.search !== "function") {
			throw new Error("Search-capable providers must implement search().");
		}
		if (provider.authorizedHosts != null &&
			(!Array.isArray(provider.authorizedHosts) ||
			provider.authorizedHosts.some(host =>
				! /^[a-z0-9.-]+$/i.test(djEnrichmentText(host))
			))) {
			throw new Error("Provider authorizedHosts must be a list of host names.");
		}
		if (provider.supportedPlatforms.some(platform =>
			!DJ_ENRICHMENT_PLATFORMS.includes(platform))) {
			throw new Error("Research provider declares an unsupported platform.");
		}
		if (!provider.supportedPlatforms.length ||
			new Set(provider.supportedPlatforms).size !==
			provider.supportedPlatforms.length) {
			throw new Error("Research provider platforms must be non-empty and unique.");
		}
		map.set(provider.providerId, provider);
	}
	return map;
}

function djEnrichmentTrackedFetch(ss, provider, job, apiName, url, options, budget) {
	const name = djEnrichmentText(apiName);
	const requestUrl = djEnrichmentParsePublicUrl(url, false);
	if (!name || name.length > 100 || !requestUrl) {
		throw new Error("Tracked provider requests require an API name and public HTTPS URL.");
	}
	const host = requestUrl.match(/^https:\/\/([^/]+)/i)[1].toLowerCase();
	const authorizedHosts = (provider.authorizedHosts || [])
		.map(value => djEnrichmentText(value).toLowerCase());
	if (!authorizedHosts.includes(host)) {
		throw new Error("Provider request host is not explicitly authorized: " + host);
	}
	if (typeof trackedFetch !== "function") {
		throw new Error("apiInventory.js trackedFetch is required for live provider requests.");
	}
	if (budget.used >= budget.max) {
		throw new Error("MA-06 API request budget was reached.");
	}

	const requestId = "DJEAR-" + Utilities.getUuid();
	const startedAt = djEnrichmentNow();
	let sheet;
	const rowNumber = djEnrichmentLock(() => {
		sheet = djEnrichmentEnsureSheet(
			ss, DJ_ENRICHMENT_API_USAGE_SHEET, DJ_ENRICHMENT_API_USAGE_HEADERS
		);
		djEnrichmentAppend(sheet, [
			requestId, job[0], provider.providerId, job[3],
			name, startedAt, "", "STARTED"
		]);
		return sheet.getLastRow();
	});
	budget.used++;

	try {
		const response = trackedFetch(
			"MA-06:" + provider.providerId + ":" + name,
			requestUrl,
			{ ...(options || {}), followRedirects: false }
		);
		let outcome = "SUCCESS";
		if (response && typeof response.getResponseCode === "function") {
			const responseCode = response.getResponseCode();
			if (responseCode < 200 || responseCode >= 300) {
				outcome = "HTTP_" + responseCode;
			}
		}
		djEnrichmentLock(() => {
			sheet.getRange(rowNumber, 7, 1, 2).setValues([[
				djEnrichmentNow(), outcome
			]]);
		});
		return response;
	} catch (error) {
		djEnrichmentLock(() => {
			sheet.getRange(rowNumber, 7, 1, 2).setValues([[
				djEnrichmentNow(),
				"ERROR: " + djEnrichmentText(error && error.message || error).slice(0, 500)
			]]);
		});
		throw error;
	}
}

function djEnrichmentFindProvider(providers, platform) {
	for (const provider of providers.values()) {
		if (provider.supportedPlatforms.includes(platform)) return provider;
	}
	return null;
}

function djEnrichmentEvidenceType(type) {
	const allowed = [
		"OFFICIAL_CROSS_LINK", "UNIQUE_ACCOUNT_ID_MATCH",
		"DJ_ALIAS_MATCH", "STATION_AFFILIATION", "LOCATION_MATCH",
		"PROFESSIONAL_ACTIVITY", "NAME_MATCH", "PROFILE_DESCRIPTION",
		"CONFLICTING_IDENTITY"
	];
	const normalized = djEnrichmentText(type).toUpperCase();
	if (!allowed.includes(normalized)) {
		throw new Error("Unsupported enrichment evidence type: " + normalized);
	}
	return normalized;
}

function djEnrichmentEvidenceStatus(type) {
	if (type === "OFFICIAL_CROSS_LINK" ||
		type === "UNIQUE_ACCOUNT_ID_MATCH") return "STRONG";
	if (type === "CONFLICTING_IDENTITY") return "CONFLICTING";
	if (type === "NAME_MATCH" || type === "PROFILE_DESCRIPTION") return "INSUFFICIENT";
	return "SUPPORTING";
}

function djEnrichmentAnalyzeCandidate(identity, candidate, candidateUrl, sourceUrl) {
	const entries = [];
	const now = djEnrichmentNow();
	const add = (type, value, evidenceSource) => {
		const normalizedType = djEnrichmentEvidenceType(type);
		const normalizedSource = djEnrichmentPublicUrl(evidenceSource || sourceUrl);
		if (!normalizedSource) {
			throw new Error("Evidence must have a valid public HTTPS source URL.");
		}
		const text = djEnrichmentText(value);
		if (!text || text.length > 1000) {
			throw new Error("Evidence value is empty or too long.");
		}
		entries.push({
			type: normalizedType,
			value: text,
			sourceUrl: normalizedSource,
			observedAt: now,
			status: djEnrichmentEvidenceStatus(normalizedType)
		});
	};

	const aliases = identity.aliases.map(djEnrichmentNormalizeText);
	const candidateNames = [
		candidate.displayName, candidate.profileName
	].concat(Array.isArray(candidate.aliases) ? candidate.aliases : [])
		.map(djEnrichmentNormalizeText).filter(Boolean);

	if (candidateNames.some(value => aliases.includes(value))) {
		add("DJ_ALIAS_MATCH", candidateNames.find(value => aliases.includes(value)), sourceUrl);
	}

	const candidateStation = djEnrichmentNormalizeText(candidate.station);
	if (candidateStation && identity.station &&
		candidateStation === djEnrichmentNormalizeText(identity.station)) {
		add("STATION_AFFILIATION", candidate.station, sourceUrl);
	}

	const candidateLocation = [
		candidate.city, candidate.region, candidate.country
	].map(djEnrichmentNormalizeText).filter(Boolean);
	const knownLocation = [
		identity.city, identity.region, identity.country
	].map(djEnrichmentNormalizeText).filter(Boolean);
	const sharedLocation = candidateLocation.find(value => knownLocation.includes(value));
	if (sharedLocation) add("LOCATION_MATCH", sharedLocation, sourceUrl);

	if (candidate.professionalActivity) {
		add("PROFESSIONAL_ACTIVITY", candidate.professionalActivity, sourceUrl);
	}

	if (!Array.isArray(candidate.evidence) &&
		candidate.evidence != null) {
		throw new Error("Candidate evidence must be an array.");
	}
	if ((candidate.evidence || []).length > 20) {
		throw new Error("Candidate contains too many evidence entries.");
	}
	(candidate.evidence || []).forEach(item => {
		if (!item || typeof item !== "object") {
			throw new Error("Invalid provider evidence.");
		}
		if (typeof item.type !== "string" ||
			typeof item.value !== "string") {
			throw new Error("Provider evidence type and value must be text.");
		}
		const type = djEnrichmentEvidenceType(item.type);
		const value = djEnrichmentText(item.value);
		if (type === "OFFICIAL_CROSS_LINK" &&
			djEnrichmentNormalizeCandidateUrl(value, candidate.platform) !== candidateUrl) {
			throw new Error("Official cross-link evidence must identify the candidate URL.");
		}
		add(type, value, item.sourceUrl || sourceUrl);
	});

	const unique = new Map();
	entries.forEach(entry => {
		const key = [entry.type, entry.value, entry.sourceUrl].join("|");
		if (!unique.has(key)) unique.set(key, entry);
	});
	const evidence = [...unique.values()];
	const strong = evidence.some(item => item.status === "STRONG");
	const conflicting = evidence.some(item => item.status === "CONFLICTING");
	const supporting = evidence.filter(item => item.status === "SUPPORTING").length;
	const reviewStatus = conflicting
		? "CONFLICTING"
		: strong || supporting >= 2
			? "PENDING_REVIEW"
			: "NEEDS_RESEARCH";
	const confidence = Math.min(1,
		(strong ? 0.75 : 0) +
		Math.min(supporting, 3) * 0.1 +
		(evidence.some(item => item.type === "NAME_MATCH") ? 0.05 : 0)
	);

	return {
		evidence: evidence,
		reviewStatus: reviewStatus,
		confidence: confidence
	};
}

function djEnrichmentCandidateData(candidate) {
	const data = {};
	[
		"displayName", "profileName", "aliases", "station", "city",
		"region", "country", "professionalActivity", "contactType"
	].forEach(key => {
		if (candidate[key] != null) data[key] = candidate[key];
	});
	return data;
}

function djEnrichmentSummarizeEvidence(rows) {
	const strong = rows.some(row => row[6] === "STRONG");
	const conflicting = rows.some(row => row[6] === "CONFLICTING");
	const supporting = rows.filter(row => row[6] === "SUPPORTING").length;
	const status = conflicting
		? "CONFLICTING"
		: strong || supporting >= 2
			? "PENDING_REVIEW"
			: "NEEDS_RESEARCH";
	const confidence = Math.min(1,
		(strong ? 0.75 : 0) +
		Math.min(supporting, 3) * 0.1 +
		(rows.some(row => row[2] === "NAME_MATCH") ? 0.05 : 0)
	);
	return { status: status, confidence: confidence };
}

function djEnrichmentPrepareCandidate(job, candidate) {
	if (!candidate || typeof candidate !== "object" ||
		!DJ_ENRICHMENT_PLATFORMS.includes(candidate.platform) ||
		candidate.platform !== job[3]) {
		throw new Error("Research candidate has an unsupported platform.");
	}

	const platform = candidate.platform;
	const candidateUrl = candidate.candidateUrl
		? djEnrichmentNormalizeCandidateUrl(candidate.candidateUrl, platform) || ""
		: "";
	const candidateValue = djEnrichmentText(candidate.candidateValue);
	const sourceUrl = djEnrichmentPublicUrl(candidate.sourceUrl);
	const contactType = djEnrichmentText(candidate.contactType || "UNKNOWN").toUpperCase();
	if (candidate.aliases != null &&
		(!Array.isArray(candidate.aliases) || candidate.aliases.length > 20 ||
		candidate.aliases.some(alias =>
			typeof alias !== "string" || alias.length > 500
		))) {
		throw new Error("Candidate aliases must be an array of at most 20 values.");
	}

	if (!sourceUrl) {
		throw new Error("Candidate sourceUrl must be a public HTTPS URL.");
	}
	if (candidateUrl.length > 2000 || candidateValue.length > 254 ||
		[sourceUrl, candidate.displayName, candidate.profileName,
			candidate.station, candidate.city, candidate.region,
			candidate.country, candidate.professionalActivity]
			.some(value => djEnrichmentText(value).length > 1000)) {
		throw new Error("Research candidate exceeds MA-06 size limits.");
	}
	if (!DJ_ENRICHMENT_CONTACT_TYPES.includes(contactType)) {
		throw new Error("Unsupported professional contact type.");
	}
	if (platform === "BUSINESS_EMAIL") {
		if (!candidateValue ||
			candidateValue.length > 254 ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateValue)) {
			throw new Error("A valid publicly listed business email is required.");
		}
	} else if (!candidateUrl) {
		throw new Error("Candidate URL is invalid or does not match its platform.");
	}

	const rawIdentity = JSON.parse(job[11]);
	const candidateForAnalysis = { ...candidate, platform };
	const analysis = djEnrichmentAnalyzeCandidate(
		rawIdentity,
		candidateForAnalysis,
		candidateUrl,
		sourceUrl
	);
	const candidateKey = [
		job[0], platform, candidateUrl.toLowerCase(), candidateValue.toLowerCase()
	].join("|");
	return {
		platform: platform,
		candidateUrl: candidateUrl,
		candidateValue: candidateValue,
		sourceUrl: sourceUrl,
		contactType: contactType,
		analysis: analysis,
		candidateKey: candidateKey,
		candidateData: djEnrichmentCandidateData(candidate)
	};
}

function djEnrichmentPersistPreparedCandidate(ss, job, providerId, query, prepared) {
	return djEnrichmentLock(() => {
		const candidateSheet = djEnrichmentEnsureSheet(
			ss, DJ_ENRICHMENT_CANDIDATE_SHEET, DJ_ENRICHMENT_CANDIDATE_HEADERS
		);
		const evidenceSheet = djEnrichmentEnsureSheet(
			ss, DJ_ENRICHMENT_EVIDENCE_SHEET, DJ_ENRICHMENT_EVIDENCE_HEADERS
		);
		const existingTable = djEnrichmentReadTable(
			ss, DJ_ENRICHMENT_CANDIDATE_SHEET, DJ_ENRICHMENT_CANDIDATE_HEADERS
		);
		const existing = existingTable.rows.find(row =>
			[
				djEnrichmentText(row[1]), djEnrichmentText(row[4]),
				djEnrichmentText(row[5]).toLowerCase(),
				djEnrichmentText(row[6]).toLowerCase()
			].join("|") === prepared.candidateKey
		);
		const duplicateCandidates = existingTable.rows.filter(row =>
			[
				djEnrichmentText(row[1]), djEnrichmentText(row[4]),
				djEnrichmentText(row[5]).toLowerCase(),
				djEnrichmentText(row[6]).toLowerCase()
			].join("|") === prepared.candidateKey
		);
		if (duplicateCandidates.length > 1) {
			throw new Error("Duplicate enrichment candidate record.");
		}
		const id = existing ? existing[0] : "DJEN-" + Utilities.getUuid();
		const evidenceTable = djEnrichmentReadTable(
			ss, DJ_ENRICHMENT_EVIDENCE_SHEET, DJ_ENRICHMENT_EVIDENCE_HEADERS
		);
		const existingEvidence = new Set(evidenceTable.rows
			.filter(row => row[1] === id)
			.map(row => [row[2], row[3], row[4]].join("|")));
		const evidenceKeys = evidenceTable.rows
			.filter(row => row[1] === id)
			.map(row => [row[2], row[3], row[4]].join("|"));
		if (new Set(evidenceKeys).size !== evidenceKeys.length) {
			throw new Error("Duplicate enrichment evidence record.");
		}
		const saveMissingEvidence = () => {
			prepared.analysis.evidence.forEach(item => {
				const key = [item.type, item.value, item.sourceUrl].join("|");
				if (existingEvidence.has(key)) return;
				djEnrichmentAppend(evidenceSheet, [
					"DJEE-" + Utilities.getUuid(), id, item.type, item.value,
					item.sourceUrl, item.observedAt, item.status
				]);
				existingEvidence.add(key);
			});
		};
		if (existing) {
			saveMissingEvidence();
			if (existing[12] === "NEEDS_RESEARCH") {
				const savedEvidence = djEnrichmentReadTable(
					ss, DJ_ENRICHMENT_EVIDENCE_SHEET,
					DJ_ENRICHMENT_EVIDENCE_HEADERS
				).rows.filter(row => row[1] === id);
				const summary = djEnrichmentSummarizeEvidence(savedEvidence);
				const rowNumber = existingTable.rows.indexOf(existing) + 2;
				candidateSheet.getRange(rowNumber, 12, 1, 2).setValues([[
					summary.confidence,
					summary.status
				]]);
				candidateSheet.getRange(rowNumber, 15, 1, 1)
					.setValue(djEnrichmentNow());
			}
			return id;
		}

		const now = djEnrichmentNow();
		djEnrichmentAppend(candidateSheet, [
			id, job[0], job[1], job[2], prepared.platform, prepared.candidateUrl,
			prepared.candidateValue, prepared.sourceUrl, prepared.contactType,
			providerId, query, prepared.analysis.confidence,
			prepared.analysis.reviewStatus, now, now,
			JSON.stringify(prepared.candidateData)
		]);
		saveMissingEvidence();

		const latest = djEnrichmentFindJobRecord(ss, job[0]);
		if (!latest) throw new Error("Enrichment job disappeared during candidate save.");
		const nextStatus = prepared.analysis.reviewStatus === "PENDING_REVIEW"
			? "PENDING_REVIEW"
			: prepared.analysis.reviewStatus;
		ss.getSheetByName(DJ_ENRICHMENT_JOB_SHEET)
			.getRange(latest.rowNumber, 6, 1, 4)
			.setValues([[
				nextStatus,
				latest.row[6],
				latest.row[7],
				djEnrichmentNow()
			]]);
		return id;
	});
}

function djEnrichmentStoreCandidate(ss, job, providerId, query, candidate) {
	const prepared = djEnrichmentPrepareCandidate(job, candidate);
	return djEnrichmentPersistPreparedCandidate(
		ss, job, providerId, query, prepared
	);
}

function djEnrichmentClaimJob(ss, jobId, maxAttempts) {
	return djEnrichmentUpdateJob(ss, jobId, row => {
		const status = djEnrichmentText(row[5]);
		if (status !== "QUEUED") {
			throw new Error("Enrichment job is not queued: " + jobId);
		}
		const attempts = Number(row[6]) || 0;
		if (attempts >= maxAttempts) {
			throw new Error("Enrichment job exceeded its retry limit: " + jobId);
		}
		row[5] = "PROCESSING";
		row[6] = attempts + 1;
		row[8] = djEnrichmentNow();
		row[9] = "";
		return row;
	});
}

function djEnrichmentFinishJob(ss, jobId, status, error) {
	return djEnrichmentUpdateJob(ss, jobId, row => {
		row[5] = status;
		row[8] = djEnrichmentNow();
		row[9] = error ? djEnrichmentText(error).slice(0, 1000) : "";
		return row;
	});
}

function djEnrichmentProcessQueued(ss, providers, options) {
	const providerMap = djEnrichmentProviderMap(providers);
	const opts = options || {};
	const requestedProviderLimit = Number(opts.maxProviderRequests);
	const maxRequests = Number.isFinite(requestedProviderLimit)
		? Math.max(0, Math.min(100, requestedProviderLimit))
		: 10;
	const maxAttempts = Math.max(1, Math.min(5,
		Number(opts.maxAttempts) || 2
	));
	const requestedDelay = Number(opts.requestDelayMs);
	const requestDelayMs = Number.isFinite(requestedDelay)
		? Math.max(0, Math.min(5000, requestedDelay))
		: 0;
	const requestedApiLimit = Number(opts.maxApiCallsPerRun);
	const apiBudget = {
		max: Number.isFinite(requestedApiLimit)
			? Math.max(0, Math.min(100, requestedApiLimit))
			: 20,
		used: 0
	};
	const jobs = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
	).rows.filter(row => row[5] === "QUEUED");
	const results = [];
	let requests = 0;

	for (const queued of jobs) {
		if (requests >= maxRequests) break;
		const jobId = queued[0];
		const platform = queued[3];
		const provider = providerMap.get(queued[4]);

		if (!provider || provider.authorized !== true ||
			!provider.supportedPlatforms.includes(platform) ||
			provider.capabilities.searchPublicProfiles !== true) {
			djEnrichmentFinishJob(
				ss, jobId, "NEEDS_RESEARCH",
				"An authorized live search provider is not configured for this platform."
			);
			results.push({ jobId: jobId, status: "NEEDS_RESEARCH" });
			continue;
		}

		if (Number(queued[6]) >= maxAttempts) {
			djEnrichmentFinishJob(
				ss, jobId, "SOURCE_UNAVAILABLE",
				"Provider retry limit reached."
			);
			results.push({ jobId: jobId, status: "SOURCE_UNAVAILABLE" });
			continue;
		}

		if (requests > 0 && requestDelayMs > 0) {
			if (typeof Utilities.sleep !== "function") {
				throw new Error("Utilities.sleep is required for configured request delays.");
			}
			Utilities.sleep(requestDelayMs);
		}
		const claimed = djEnrichmentClaimJob(ss, jobId, maxAttempts);
		requests++;
		let response;
		try {
			const identity = JSON.parse(claimed[11]);
			response = provider.search(claimed[10], {
				platform: platform,
				identity: identity,
				jobId: jobId,
				maxResults: Math.max(1, Math.min(20,
					Number(opts.maxResultsPerProvider) || 10
				)),
				fetch: (apiName, url, fetchOptions) =>
					djEnrichmentTrackedFetch(
						ss, provider, claimed, apiName, url, fetchOptions, apiBudget
					)
			});
		} catch (error) {
			const retryable = !!(error && error.retryable);
			const current = djEnrichmentFindJobRecord(ss, jobId);
			const attempts = current ? Number(current.row[6]) || 0 : maxAttempts;
			const retry = retryable && attempts < maxAttempts;
			djEnrichmentFinishJob(
				ss,
				jobId,
				retry ? "QUEUED" : "SOURCE_UNAVAILABLE",
				error && error.message ? error.message : String(error)
			);
			results.push({
				jobId: jobId,
				status: retry ? "QUEUED" : "SOURCE_UNAVAILABLE",
				error: error && error.message ? error.message : String(error)
			});
			continue;
		}

		if (!response || typeof response !== "object" ||
			!Array.isArray(response.candidates) ||
			response.candidates.length > 20) {
			const error = "Provider returned an invalid response.";
			djEnrichmentFinishJob(ss, jobId, "SOURCE_UNAVAILABLE", error);
			results.push({
				jobId: jobId,
				status: "SOURCE_UNAVAILABLE",
				error: error
			});
			continue;
		}
		if (!response.candidates.length) {
			djEnrichmentFinishJob(ss, jobId, "NOT_FOUND", "");
			results.push({ jobId: jobId, status: "NOT_FOUND" });
			continue;
		}

		const prepared = [];
		const rejectedCandidates = [];
		response.candidates.forEach(candidate => {
			try {
				prepared.push(djEnrichmentPrepareCandidate(claimed, candidate));
			} catch (error) {
				rejectedCandidates.push(
					error && error.message ? error.message : String(error)
				);
			}
		});
		if (!prepared.length) {
			const error = rejectedCandidates.join("; ") ||
				"Provider returned no usable candidates.";
			djEnrichmentFinishJob(ss, jobId, "SOURCE_UNAVAILABLE", error);
			results.push({
				jobId: jobId,
				status: "SOURCE_UNAVAILABLE",
				error: error,
				rejectedCandidates: rejectedCandidates
			});
			continue;
		}
		const ids = prepared.map(candidate =>
			djEnrichmentPersistPreparedCandidate(
				ss, claimed, provider.providerId, claimed[10], candidate
			)
		);
		const stored = ids.map(id => djEnrichmentFindCandidate(ss, id))
			.filter(Boolean);
		const status = stored.some(item => item.row[12] === "PENDING_REVIEW")
			? "PENDING_REVIEW"
			: stored.some(item => item.row[12] === "CONFLICTING")
				? "CONFLICTING"
				: "NEEDS_RESEARCH";
		djEnrichmentFinishJob(ss, jobId, status, "");
		results.push({
			jobId: jobId,
			status: status,
			enrichmentIds: [...new Set(ids)],
			rejectedCandidates: rejectedCandidates
		});
	}

	return {
		requests: requests,
		apiCalls: apiBudget.used,
		results: results
	};
}

function djEnrichmentQueueTargets(ss, targets, providers, options) {
	if (!Array.isArray(targets)) throw new Error("Enrichment targets must be an array.");
	const opts = options || {};
	const requestedTargetLimit = Number(opts.maxCandidatesPerRun);
	const maxTargets = Number.isFinite(requestedTargetLimit)
		? Math.max(0, Math.min(100, requestedTargetLimit))
		: 20;
	if (opts.platforms != null && !Array.isArray(opts.platforms)) {
		throw new Error("Enrichment platforms must be an array.");
	}
	const platforms = Array.isArray(opts.platforms) && opts.platforms.length
		? opts.platforms
		: DJ_ENRICHMENT_SOCIAL_PLATFORMS;
	if (platforms.some(platform => !DJ_ENRICHMENT_PLATFORMS.includes(platform))) {
		throw new Error("Unsupported enrichment platform.");
	}
	if (new Set(platforms).size !== platforms.length) {
		throw new Error("Enrichment platforms must be unique.");
	}
	const providerMap = djEnrichmentProviderMap(providers);
	const providerConfigured = providerMap.size > 0;
	const queued = [];
	const excluded = [];
	const seenTargets = new Set();
	const sorted = [...targets].sort((a, b) =>
		(Number(b.priority) || 1) - (Number(a.priority) || 1)
	);

	for (const rawTarget of sorted) {
		if (queued.length >= maxTargets) break;
		const target = djEnrichmentValidateTarget(ss, rawTarget);
		const targetKey = [target.contactId, target.observationId].join("|");
		if (seenTargets.has(targetKey)) {
			excluded.push({
				contactId: target.contactId || null,
				observationId: target.observationId || null,
				status: "DUPLICATE_TARGET"
			});
			continue;
		}
		seenTargets.add(targetKey);
		if (!target.eligible) {
			excluded.push({
				contactId: target.contactId || null,
				observationId: target.observationId || null,
				status: target.status
			});
			continue;
		}

		const verified = djEnrichmentVerifiedPlatforms(
			ss, target.contactId, target.observationId
		);
		const candidateTable = djEnrichmentReadTable(
			ss, DJ_ENRICHMENT_CANDIDATE_SHEET, DJ_ENRICHMENT_CANDIDATE_HEADERS
		);

		for (const platform of platforms) {
			if (queued.length >= maxTargets) break;
			if (verified.has(platform)) {
				excluded.push({
					contactId: target.contactId || null,
					observationId: target.observationId || null,
					platform: platform,
					status: "ALREADY_VERIFIED"
				});
				continue;
			}
			const prior = candidateTable.rows.find(row =>
				djEnrichmentText(row[2]) === target.contactId &&
				djEnrichmentText(row[3]) === target.observationId &&
				djEnrichmentText(row[4]) === platform &&
				["PENDING_REVIEW", "APPROVED_FOR_MA05", "CONFLICTING"]
					.includes(djEnrichmentText(row[12]))
			);
			if (prior) {
				excluded.push({
					contactId: target.contactId || null,
					observationId: target.observationId || null,
					platform: platform,
					status: "EXISTING_CANDIDATE"
				});
				continue;
			}

			const provider = djEnrichmentFindProvider(providerMap, platform);
			const canSearch = provider &&
				provider.authorized === true &&
				provider.capabilities.searchPublicProfiles === true;
			const providerId = canSearch
				? provider.providerId
				: providerConfigured
					? "NO_AUTHORIZED_PROVIDER"
					: "OFFLINE_RESEARCH_MODE";
			const query = djEnrichmentBuildQuery(target.identity, platform);
			const jobTargetKey = [
				target.contactId, target.observationId, platform
			].join("|");
			const existingJob = djEnrichmentFindJob(ss, jobTargetKey);
			const offlineJobCanUseProvider =
				existingJob &&
				existingJob[5] === "NEEDS_RESEARCH" &&
				["OFFLINE_RESEARCH_MODE", "NO_AUTHORIZED_PROVIDER"]
					.includes(existingJob[4]) &&
				canSearch;
			if (offlineJobCanUseProvider) {
				djEnrichmentRequeueJob(
					ss, existingJob, providerId, query
				);
			} else if (existingJob && existingJob[5] !== "QUEUED") {
				const refreshDays = Number(opts.refreshAfterDays) || 0;
				const age = Date.now() - Date.parse(existingJob[8]);
				const shouldRefresh = existingJob[5] === "NOT_FOUND" &&
					refreshDays > 0 &&
					Number.isFinite(age) &&
					age >= refreshDays * 86400000;
				if (shouldRefresh) {
					djEnrichmentRequeueJob(
						ss, existingJob, providerId, query
					);
				} else {
					excluded.push({
						contactId: target.contactId || null,
						observationId: target.observationId || null,
						platform: platform,
						status: "EXISTING_JOB"
					});
					continue;
				}
			}
			const jobId = djEnrichmentCreateJob(
				ss, target, platform, providerId, query
			);

			if (!canSearch) {
				djEnrichmentFinishJob(
					ss, jobId, "NEEDS_RESEARCH",
					"No live discovery was performed; researcher input is required."
				);
			}
			queued.push({
				jobId: jobId,
				contactId: target.contactId || null,
				observationId: target.observationId || null,
				platform: platform,
				providerId: providerId,
				query: query,
				priority: target.priority,
				priorityCategory: target.priorityCategory
			});
		}
	}

	return { jobs: queued, excluded: excluded };
}

function djEnrichmentReadTargets(ss) {
	const master = ss.getSheetByName("Master_Contacts");
	if (!master || master.getLastRow() < 1) {
		throw new Error("Master_Contacts sheet is missing or empty.");
	}

	const rows = master.getDataRange().getDisplayValues();
	const headers = rows[0];
	const columns = djEnrichmentRequireHeaders(
		headers, ["Contact ID", "Name / DJ Alias"], "Master_Contacts"
	);

	const targets = [];
	const contactIds = new Set();
	for (const row of rows.slice(1)) {
		const contactId = djEnrichmentText(row[columns["Contact ID"]]);
		if (!contactId) continue;
		if (contactIds.has(contactId)) {
			throw new Error("Duplicate Contact ID in Master_Contacts: " + contactId);
		}
		contactIds.add(contactId);
		if (djEnrichmentIsExcluded(row, headers)) continue;

		const target = {
			contactId: contactId,
			name: row[columns["Name / DJ Alias"]],
			station: columns["Station / Venue / Organization"] == null
				? ""
				: row[columns["Station / Venue / Organization"]],
			city: columns.City == null ? "" : row[columns.City],
			region: columns["State / Region"] == null
				? ""
				: row[columns["State / Region"]],
			country: columns.Country == null ? "" : row[columns.Country],
			website: columns.Website == null ? "" : row[columns.Website]
		};
		const priority = djEnrichmentContactPriority(
			row, columns, ss, contactId
		);
		target.priority = priority.priority;
		target.priorityCategory = priority.category;
		targets.push(target);
	}

	if (typeof djEngagementPendingReviews === "function") {
		djEngagementPendingReviews(ss).forEach(observation => {
			const priority = {
				priority: 1,
				category: "OTHER_ENGAGEMENT_REVIEW"
			};
			targets.push({
				observationId: observation.observationId,
				djReportedName: observation.djReportedName,
				station: observation.station,
				city: observation.city,
				region: observation.state,
				country: observation.country,
				priority: priority.priority,
				priorityCategory: priority.category
			});
		});
	}

	return targets;
}

function djEnrichmentSelectCandidates(ss, options) {
	const opts = options || {};
	return djEnrichmentQueueTargets(
		ss, djEnrichmentReadTargets(ss), opts.providers || [], opts
	);
}

function djEnrichmentRun(ss, targets, providers, options) {
	const selection = djEnrichmentQueueTargets(
		ss, targets, providers, options
	);
	const runOptions = options || {};

	if (!providers || !providers.length) {
		return {
			mode: "OFFLINE_RESEARCH_MODE",
			jobs: selection.jobs,
			excluded: selection.excluded,
			processed: []
		};
	}

	const processed = djEnrichmentProcessQueued(ss, providers, runOptions);
	const providerMap = djEnrichmentProviderMap(providers);
	const hasAuthorizedProvider = selection.jobs.some(job => {
		const provider = providerMap.get(job.providerId);
		return provider && provider.authorized === true &&
			provider.capabilities.searchPublicProfiles === true;
	});
	return {
		mode: hasAuthorizedProvider
			? "AUTHORIZED_PROVIDER_CONFIGURED"
			: "OFFLINE_RESEARCH_MODE",
		jobs: selection.jobs,
		excluded: selection.excluded,
		processed: processed.results,
		providerRequests: processed.requests,
		apiCalls: processed.apiCalls
	};
}

function djEnrichmentRunSelected(ss, providers, options) {
	return djEnrichmentRun(
		ss, djEnrichmentReadTargets(ss), providers || [], options || {}
	);
}

function djEnrichmentResume(ss, providers, options) {
	djEnrichmentLock(() => {
		const table = djEnrichmentReadTable(
			ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
		);
		const sheet = table.sheet;
		table.rows.forEach((row, index) => {
			if (row[5] === "PROCESSING") {
				sheet.getRange(index + 2, 6, 1, 4).setValues([[
					"QUEUED",
					row[6],
					row[7],
					djEnrichmentNow()
				]]);
			}
		});
	});
	return djEnrichmentProcessQueued(ss, providers || [], options || {});
}

function djEnrichmentAddManualCandidate(ss, jobId, candidate, researcher, notes) {
	const id = djEnrichmentText(jobId);
	const researcherName = djEnrichmentText(researcher);
	const details = djEnrichmentText(notes);
	if (!id || !researcherName || !details) {
		throw new Error("Job ID, researcher, and submission notes are required.");
	}
	const jobRecord = djEnrichmentFindJobRecord(ss, id);
	if (!jobRecord) throw new Error("Enrichment job not found: " + id);
	if (!["NEEDS_RESEARCH", "QUEUED"].includes(jobRecord.row[5])) {
		throw new Error("This enrichment job is not accepting manual research.");
	}
	const candidateId = djEnrichmentStoreCandidate(
		ss,
		jobRecord.row,
		"MANUAL_RESEARCH",
		jobRecord.row[10],
		candidate
	);
	const history = djEnrichmentEnsureSheet(
		ss,
		DJ_ENRICHMENT_REVIEW_HISTORY_SHEET,
		DJ_ENRICHMENT_REVIEW_HISTORY_HEADERS
	);
	djEnrichmentAppend(history, [
		"DJER-" + Utilities.getUuid(),
		candidateId,
		jobRecord.row[5],
		"SUBMIT_MANUAL_CANDIDATE",
		researcherName,
		djEnrichmentNow(),
		details
	]);
	const current = djEnrichmentFindJobRecord(ss, id);
	const storedCandidate = djEnrichmentFindCandidate(ss, candidateId);
	if (current && storedCandidate &&
		current.row[5] !== storedCandidate.row[12]) {
		djEnrichmentFinishJob(ss, id, storedCandidate.row[12], "");
	}
	return {
		enrichmentId: candidateId,
		researcher: researcherName,
		notes: details
	};
}

function djEnrichmentFindCandidate(ss, enrichmentId) {
	const table = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_CANDIDATE_SHEET,
		DJ_ENRICHMENT_CANDIDATE_HEADERS
	);
	const matches = table.rows.map((row, index) => ({
		row: row,
		rowNumber: index + 2
	})).filter(item => item.row[0] === enrichmentId);
	if (matches.length > 1) {
		throw new Error("Duplicate Enrichment ID: " + enrichmentId);
	}
	return matches[0] || null;
}

function djEnrichmentReview(ss, enrichmentId, decision, reviewer, notes) {
	const id = djEnrichmentText(enrichmentId);
	const action = djEnrichmentText(decision).toUpperCase();
	const reviewerName = djEnrichmentText(reviewer);
	const details = djEnrichmentText(notes);
	const decisions = ["APPROVE", "REJECT", "NEEDS_RESEARCH"];
	if (!id || !reviewerName || !details || !decisions.includes(action)) {
		throw new Error("Candidate, reviewer, valid decision, and notes are required.");
	}

	return djEnrichmentLock(() => {
		const record = djEnrichmentFindCandidate(ss, id);
		if (!record) throw new Error("Enrichment candidate not found.");
		const previous = djEnrichmentText(record.row[12]);
		if (!["PENDING_REVIEW", "CONFLICTING"].includes(previous)) {
			throw new Error("Candidate is not awaiting review.");
		}
		if (previous === "CONFLICTING" && action === "APPROVE") {
			throw new Error("Conflicting candidates cannot be approved for MA-05.");
		}
		const nextStatus = action === "APPROVE"
			? "APPROVED_FOR_MA05"
			: action === "REJECT" ? "REJECTED" : "NEEDS_RESEARCH";
		const history = djEnrichmentEnsureSheet(
			ss,
			DJ_ENRICHMENT_REVIEW_HISTORY_SHEET,
			DJ_ENRICHMENT_REVIEW_HISTORY_HEADERS
		);
		djEnrichmentAppend(history, [
			"DJER-" + Utilities.getUuid(), id, previous, action,
			reviewerName, djEnrichmentNow(), details
		]);

		ss.getSheetByName(DJ_ENRICHMENT_CANDIDATE_SHEET)
			.getRange(record.rowNumber, 13, 1, 1)
			.setValue(djEnrichmentSafe(nextStatus));
		ss.getSheetByName(DJ_ENRICHMENT_CANDIDATE_SHEET)
			.getRange(record.rowNumber, 15, 1, 1)
			.setValue(djEnrichmentNow());
		const candidates = djEnrichmentReadTable(
			ss,
			DJ_ENRICHMENT_CANDIDATE_SHEET,
			DJ_ENRICHMENT_CANDIDATE_HEADERS
		).rows.filter(row => row[1] === record.row[1]);
		const jobStatus = candidates.some(row => row[12] === "PENDING_REVIEW")
			? "PENDING_REVIEW"
			: candidates.some(row => row[12] === "CONFLICTING")
				? "CONFLICTING"
				: candidates.some(row => row[12] === "NEEDS_RESEARCH")
					? "NEEDS_RESEARCH"
					: candidates.some(row => row[12] === "APPROVED_FOR_MA05")
						? "APPROVED_FOR_MA05"
						: "REJECTED";
		const job = djEnrichmentFindJobRecord(ss, record.row[1]);
		if (!job) throw new Error("Enrichment job not found for reviewed candidate.");
		ss.getSheetByName(DJ_ENRICHMENT_JOB_SHEET)
			.getRange(job.rowNumber, 6, 1, 1)
			.setValue(djEnrichmentSafe(jobStatus));
		ss.getSheetByName(DJ_ENRICHMENT_JOB_SHEET)
			.getRange(job.rowNumber, 9, 1, 1)
			.setValue(djEnrichmentNow());
		return { enrichmentId: id, status: nextStatus };
	});
}

function djEnrichmentImportLinks(ss) {
	const log = ss.getSheetByName("Import_Log");
	if (!log || log.getLastRow() < 2) return [];
	const rows = log.getDataRange().getDisplayValues();
	const columns = djEnrichmentRequireHeaders(
		rows[0], ["Observation Key", "Outcome", "Contact IDs"], "Import_Log"
	);
	return rows.slice(1).map(row => ({
		observationId: djEnrichmentText(row[columns["Observation Key"]]),
		outcome: djEnrichmentText(row[columns.Outcome]),
		contactIds: djEnrichmentText(row[columns["Contact IDs"]])
	})).filter(item => item.observationId);
}

/**
 * Contact ID that the importer linked this observation to under its established rules
 * ("Created" or "Matched" to exactly one contact), or "" when no such single link exists.
 */
function djEnrichmentImportLinkedContact(ss, observationId) {
	const id = djEnrichmentText(observationId);
	const rows = djEnrichmentImportLinks(ss).filter(item => item.observationId === id);
	if (rows.length !== 1 || !["Created", "Matched"].includes(rows[0].outcome) ||
		!/^[^,\s]+$/.test(rows[0].contactIds)) {
		return "";
	}
	return rows[0].contactIds;
}

// Real logged import observations safely linked to a contact and never sent to identity review.
function djEnrichmentImportObservationsForContact(ss, contactId) {
	const id = djEnrichmentText(contactId);
	const reviewSheet = ss.getSheetByName("DJ_Identity_Review");
	const reviewed = new Set();
	if (reviewSheet && reviewSheet.getLastRow() > 1) {
		const rows = reviewSheet.getDataRange().getDisplayValues();
		const column = rows[0].indexOf("Observation ID");
		if (column < 0) throw new Error("Invalid DJ_Identity_Review headers.");
		rows.slice(1).forEach(row => reviewed.add(row[column]));
	}
	const links = djEnrichmentImportLinks(ss);
	const counts = new Map();
	links.forEach(item => counts.set(item.observationId, (counts.get(item.observationId) || 0) + 1));
	return links
		.filter(item => !reviewed.has(item.observationId) &&
			counts.get(item.observationId) === 1 &&
			["Created", "Matched"].includes(item.outcome) &&
			item.contactIds === id)
		.map(item => item.observationId);
}

function djEnrichmentTransferApproved(ss, enrichmentId, observationId) {
	const id = djEnrichmentText(enrichmentId);
	const requestedObservationId = djEnrichmentText(observationId);
	if (!id || !requestedObservationId) {
		throw new Error("Approved candidate and existing observation ID are required.");
	}
	const record = djEnrichmentFindCandidate(ss, id);
	if (!record) throw new Error("Enrichment candidate not found.");
	if (record.row[12] !== "APPROVED_FOR_MA05") {
		throw new Error("Enrichment candidate must be approved before transfer.");
	}
	if (!DJ_ENRICHMENT_SOCIAL_PLATFORMS.includes(record.row[4])) {
		throw new Error("Only social-profile candidates can be transferred to MA-05.");
	}

	const reviewSheet = ss.getSheetByName("DJ_Identity_Review");
	const reviewRows = reviewSheet && reviewSheet.getLastRow() > 1
		? reviewSheet.getDataRange().getDisplayValues()
		: [];
	const reviewColumns = reviewRows.length ? djEnrichmentHeaderMap(reviewRows[0]) : {};
	if (reviewRows.length) {
		[
			"Observation ID", "Review Status", "Selected Contact ID"
		].forEach(header => {
			if (reviewColumns[header] == null) {
				throw new Error("Invalid DJ_Identity_Review headers.");
			}
		});
	}
	const reviewed = reviewRows.slice(1).filter(row =>
		row[reviewColumns["Observation ID"]] === requestedObservationId
	);
	const matches = reviewed.filter(row =>
		row[reviewColumns["Review Status"]] === "APPROVED_LINK"
	);
	let contactId;
	if (reviewed.length) {
		if (matches.length !== 1) {
			throw new Error("Observation must have exactly one approved MA-05 identity review.");
		}
		contactId = djEnrichmentText(
			matches[0][reviewColumns["Selected Contact ID"]]
		);
	} else {
		// Observations never sent to identity review were linked by the importer's safe rules.
		contactId = djEnrichmentImportLinkedContact(ss, requestedObservationId);
		if (!contactId) {
			throw new Error("Observation must have exactly one approved MA-05 identity review or one safe import link.");
		}
	}
	if (!contactId ||
		(record.row[2] && record.row[2] !== contactId) ||
		(record.row[3] && record.row[3] !== requestedObservationId)) {
		throw new Error("Approved identity review does not match this enrichment candidate.");
	}
	if (typeof djSocialProfileSave !== "function" ||
		!djSocialProfileContactExists(ss, contactId)) {
		throw new Error("MA-05 social-profile storage is unavailable or contact is invalid.");
	}

	const sourceTag = "ENRICHMENT:" + record.row[9] + ":" + id;
	const profileSheet = ss.getSheetByName(DJ_SOCIAL_PROFILE_SHEET);
	if (profileSheet && profileSheet.getLastRow() > 1) {
		const profileRows = profileSheet.getDataRange().getDisplayValues();
		const profileColumns = djEnrichmentRequireHeaders(
			profileRows[0],
			[
				"Profile ID", "Observation ID", "Platform", "Profile URL",
				"Evidence Source", "Contact ID", "Verification Status"
			],
			DJ_SOCIAL_PROFILE_SHEET
		);
		const priorProfiles = profileRows.slice(1).filter(row =>
			row[profileColumns.Platform] === record.row[4] &&
			row[profileColumns["Profile URL"]].toLowerCase() ===
				record.row[5].toLowerCase()
		);
		if (priorProfiles.length > 1) {
			throw new Error("Multiple MA-05 records already contain this profile.");
		}
		if (priorProfiles.length === 1) {
			const prior = priorProfiles[0];
			const priorContactId = djEnrichmentText(
				prior[profileColumns["Contact ID"]]
			);
			const priorObservationId = djEnrichmentText(
				prior[profileColumns["Observation ID"]]
			);
			if (priorContactId && priorContactId !== contactId) {
				throw new Error("Profile is already associated with a different contact.");
			}
			if (priorObservationId !== requestedObservationId) {
				throw new Error("Profile already has an MA-05 review record; review it instead of duplicating it.");
			}
			if (prior[profileColumns["Verification Status"]] === "REJECTED") {
				throw new Error("MA-05 previously rejected this profile; it cannot be reapproved through enrichment.");
			}
			return {
				profileIds: [prior[profileColumns["Profile ID"]]],
				contactId: contactId,
				observationId: priorObservationId,
				verificationStatus: prior[profileColumns["Verification Status"]],
				existing: true
			};
		}
	}

	const evidence = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_EVIDENCE_SHEET, DJ_ENRICHMENT_EVIDENCE_HEADERS
	).rows.filter(row => row[1] === id);
	const sourceUrl = evidence.length
		? evidence[0][4]
		: record.row[7];
	const observation = {
		observationId: requestedObservationId,
		sourceReportId: "",
		sourcePage: "",
		sourceSection: "",
		sourceUrl: sourceUrl
	};
	const profileIds = djSocialProfileSave(ss, observation, {
		observationId: requestedObservationId,
		socialProfiles: [{
			profileUrl: record.row[5],
			evidenceSource: sourceTag
		}]
	});

	return {
		profileIds: profileIds,
		contactId: contactId,
		observationId: requestedObservationId,
		verificationStatus: "PENDING_REVIEW",
		existing: false
	};
}

function djEnrichmentGetUsage(ss) {
	const table = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_JOB_SHEET, DJ_ENRICHMENT_JOB_HEADERS
	);
	const byProvider = {};
	let totalRequests = 0;
	table.rows.forEach(row => {
		const count = Number(row[6]) || 0;
		const provider = djEnrichmentText(row[4]) || "UNKNOWN";
		byProvider[provider] = (byProvider[provider] || 0) + count;
		totalRequests += count;
	});
	const apiUsage = djEnrichmentReadTable(
		ss, DJ_ENRICHMENT_API_USAGE_SHEET, DJ_ENRICHMENT_API_USAGE_HEADERS
	);
	const apiByProvider = {};
	apiUsage.rows.forEach(row => {
		const provider = djEnrichmentText(row[2]) || "UNKNOWN";
		apiByProvider[provider] = (apiByProvider[provider] || 0) + 1;
	});
	return {
		totalRequests: totalRequests,
		byProvider: byProvider,
		apiCalls: apiUsage.rows.length,
		apiCallsByProvider: apiByProvider
	};
}

function djEnrichmentCreateFixtureProvider(fixtures) {
	const data = fixtures || {};
	return {
		providerId: "SYNTHETIC_FIXTURE",
		authorized: true,
		supportedPlatforms: [...DJ_ENRICHMENT_PLATFORMS],
		capabilities: {
			searchPublicProfiles: true,
			retrievePublicProfiles: false,
			normalizeUserSuppliedUrls: false
		},
		search: function(query, context) {
			const key = context.identity.aliases[0] + "|" + context.platform;
			return { candidates: data[key] || [] };
		}
	};
}
