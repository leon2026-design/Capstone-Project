// MA-05: DJ Identity Resolution
// Match DJ activity records with existing contacts.
// Reuse ContactMatcher.js without changing Master_Contacts.

const DJ_IDENTITY_PLATFORMS = {
	"instagram.com": "INSTAGRAM",
	"facebook.com": "FACEBOOK",
	"m.facebook.com": "FACEBOOK",
	"soundcloud.com": "SOUNDCLOUD",
	"mixcloud.com": "MIXCLOUD",
	"youtube.com": "YOUTUBE"
};

// Convert a value to text.
function djIdentityText(value) {
	return String(value == null ? "" : value).trim();
}

// Return the first non-empty value.
function djIdentityFirst(...values) {
	for (const value of values) {
		if (djIdentityText(value)) {
			return djIdentityText(value);
		}
	}
	return "";
}

// Identify the platform and normalize the profile URL.
function djIdentityProfile(raw, source) {
	const obj = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw
		: { profileUrl: raw };

	const original = djIdentityText(obj.profileUrl || obj.url);

	if (!original) {
		return null;
	}

	const match = original.match(
		/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+)(\/[^?#\s]+)(?:[?#][^\s]*)?$/i
	);

	if (!match) {
		return null;
	}

	const host = match[1].toLowerCase();
	const platform = DJ_IDENTITY_PLATFORMS[host];
	const accountPath = match[2].replace(/\/+$/, "");

	if (!platform || !accountPath || accountPath === "/") {
		return null;
	}

	return {
		platform: platform,
		profileUrl: "https://" + host + accountPath,
		verificationStatus: obj.verificationStatus === "VERIFIED"
			? "VERIFIED"
			: "PENDING_REVIEW",
		evidenceSource: djIdentityText(obj.evidenceSource || source) || "UNSPECIFIED"
	};
}

// Collect social media profiles from the DJ record.
// Keep Instagram, Facebook and SoundCloud separate.
function djIdentityExtractProfiles(identity) {
	const raw = [];

	function add(value, source) {
		if (Array.isArray(value)) {
			value.forEach(item => add(item, source));
		} else if (typeof value === "string") {
			value.split(/\r?\n/).forEach(item => {
				raw.push({ value: item, source: source });
			});
		} else if (value) {
			raw.push({ value: value, source: source });
		}
	}

	add(identity.socialProfiles, "SOCIAL_PROFILE_RECORD");
	add(identity.instagram, "INSTAGRAM_FIELD");
	add(identity.facebook, "FACEBOOK_FIELD");
	add(identity.soundcloud, "SOUNDCLOUD_FIELD");
	add(identity["Social Accounts"], "CONTACT_FIELD");
	add(identity["Social Media Account"], "REPORT_FIELD");

	const profiles = new Map();

	for (const item of raw) {
		const profile = djIdentityProfile(item.value, item.source);

		if (!profile) {
			continue;
		}

		const key = profile.platform + "|" + profile.profileUrl.toLowerCase();
		const existing = profiles.get(key);

		// Keep verified information when the same profile appears twice.
		if (!existing ||
			(existing.verificationStatus !== "VERIFIED" &&
			profile.verificationStatus === "VERIFIED")) {
			profiles.set(key, profile);
		}
	}

	return [...profiles.values()];
}

// Convert an MA-04 observation to the existing contact format.
function djIdentityBuildCandidate(observation) {
	if (!observation || typeof observation !== "object" ||
		Array.isArray(observation)) {
		throw new Error("DJ observation must be an object.");
	}

	const source = observation.reportedIdentity || observation;
	const profiles = djIdentityExtractProfiles(source);

	const fullName = [
		djIdentityText(source.firstName),
		djIdentityText(source.lastName)
	].filter(Boolean).join(" ");

	const candidate = {
		"Name / DJ Alias": djIdentityFirst(
			source.djReportedName,
			source.djAlias,
			source["Name / DJ Alias"],
			source.name,
			fullName
		),

		"Station / Venue / Organization": djIdentityFirst(
			source.station,
			source.radioStation,
			source.organization,
			source["Station / Venue / Organization"]
		),

		Email: djIdentityFirst(
			source.email,
			source.emailAddress,
			source["Email"],
			source["Email Address"]
		),

		Phone: djIdentityFirst(
			source.phone,
			source["Phone"]
		),

		City: djIdentityFirst(
			source.city,
			source["City"]
		),

		"State / Region": djIdentityFirst(
			source.state,
			source.region,
			source["State / Region"]
		),

		Country: djIdentityFirst(
			source.country,
			source["Country"]
		),

		"Social Accounts": profiles.map(profile => profile.profileUrl).join("\n")
	};

	return {
		candidate: candidate,
		profiles: profiles
	};
}

// Check whether both records have the same verified social profile.
function djIdentityVerifiedSocialOverlap(existing, incomingProfiles) {
	const stored = Array.isArray(existing.verifiedSocialProfiles)
		? existing.verifiedSocialProfiles
		: [];

	const verified = new Set();

	for (const item of stored) {
		const profile = djIdentityProfile(item, "MASTER_VERIFIED");

		if (profile && profile.verificationStatus === "VERIFIED") {
			const key = profile.platform + "|" + profile.profileUrl.toLowerCase();
			verified.add(key);
		}
	}

	for (const profile of incomingProfiles) {
		const key = profile.platform + "|" + profile.profileUrl.toLowerCase();

		if (profile.verificationStatus === "VERIFIED" && verified.has(key)) {
			return true;
		}
	}

	return false;
}

// Match one DJ observation against existing Master_Contacts.
// Return LINK, REVIEW or UNRESOLVED without changing any contact data.
function djResolveIdentity(observation, contacts) {
	if (!Array.isArray(contacts)) {
		throw new Error("Contacts must be an array.");
	}

	const observationId = djIdentityText(
		observation && observation.observationId
	);

	if (!observationId) {
		throw new Error("MA-04 observationId is required.");
	}

	const data = djIdentityBuildCandidate(observation);
	const candidate = data.candidate;
	const profiles = data.profiles;

	const matches = [];
	const seenIds = new Set();

	for (const existing of contacts) {
		if (!existing || typeof existing !== "object") {
			throw new Error("Invalid master contact.");
		}

		const contactId = djIdentityText(existing["Contact ID"]);

		if (!contactId || seenIds.has(contactId)) {
			throw new Error("Missing or duplicate Contact ID in Master_Contacts.");
		}

		seenIds.add(contactId);

		// Reuse the matching rules from ContactMatcher.js.
		const result = contactMatchClassify(existing, candidate);

		if (result.status === "NO_MATCH") {
			continue;
		}

		if (result.status !== "EXACT_MATCH" &&
			result.status !== "POSSIBLE_MATCH") {
			throw new Error("Unknown matcher status: " + result.status);
		}

		// Email and verified social profiles provide strong evidence.
		const emailMatch = result.matchingFields.includes("Email");
		const verifiedSocialMatch = djIdentityVerifiedSocialOverlap(
			existing,
			profiles
		);

		// Only allow automatic linking when there are no conflicts.
		const safeToLink =
			result.status === "EXACT_MATCH" &&
			result.conflictingFields.length === 0 &&
			(emailMatch || verifiedSocialMatch);

		const match = {
			contactId: contactId,
			status: result.status,
			matchScore: result.matchScore,
			matchingFields: [...result.matchingFields],
			conflictingFields: [...result.conflictingFields],
			safeToAutoLink: safeToLink,
			reason: result.status === "EXACT_MATCH" && !safeToLink
				? "SOCIAL_PROFILE_VERIFICATION_REQUIRED"
				: ""
		};

		matches.push(match);
	}

	// Sort possible contacts by match score.
	matches.sort((a, b) => {
		return b.matchScore - a.matchScore ||
			a.contactId.localeCompare(b.contactId);
	});

	const response = {
		observationId: observationId,
		reportedName: candidate["Name / DJ Alias"],
		socialProfiles: profiles,
		candidates: matches
	};

	// Automatically link only one safe, unique match.
	if (matches.length === 1 && matches[0].safeToAutoLink) {
		return {
			...response,
			status: "EXACT_MATCH",
			decision: "LINK",
			contactId: matches[0].contactId
		};
	}

	// Multiple matches or conflicting information require manual review.
	if (matches.length > 0) {
		return {
			...response,
			status: "POSSIBLE_MATCH",
			decision: "REVIEW",
			contactId: null
		};
	}

	// No reliable match was found.
	return {
		...response,
		status: "NO_MATCH",
		decision: "UNRESOLVED",
		contactId: null
	};
}
