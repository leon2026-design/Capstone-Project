/**
 * TFB-135: Intelligent Contact Matching
 *
 * Normalize contact information before comparing records.
 * These helpers do not modify spreadsheet data.
 */

//Convert a value to lowercase and remove extra whitespace.
function contactMatchNormalizeText(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

//Normalize a contact email address.
function contactMatchNormalizeEmail(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase();
}

//Normalize a phone number by removing formatting characters.
function contactMatchNormalizePhone(value) {
	const digits = String(value ?? "").replace(/\D/g, "");

	//Remove the US country code when present.
	if (digits.length === 11 && digits.startsWith("1")) {
		return digits.slice(1);
	}

	return digits;
}

//Normalize a social account URL before comparing.
function contactMatchNormalizeSocial(value) {
	return contactMatchNormalizeText(value)
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/+$/, "");
}

//Convert multiple values into a normalized list.
//ContactImporter stores multiple emails and social accounts separated by newlines.
function contactMatchSplitValues(value) {
	return [
		...new Set(
			String(value ?? "")
				.split(/\r?\n/)
				.map(contactMatchNormalizeText)
				.filter(Boolean)
		)
	];
}

//Check whether two fields share at least one value.
function contactMatchHasSharedValue(existingValue, incomingValue) {
	const existingValues = new Set(
		contactMatchSplitValues(existingValue)
	);

	const incomingValues = contactMatchSplitValues(incomingValue);

	return incomingValues.some(value => existingValues.has(value));
}

//Check whether two contacts share a normalized phone number.
function contactMatchHasSharedPhone(existingValue, incomingValue) {
	const existingPhones = new Set(
		contactMatchSplitValues(existingValue)
			.map(contactMatchNormalizePhone)
			.filter(Boolean)
	);

	const incomingPhones = contactMatchSplitValues(incomingValue)
		.map(contactMatchNormalizePhone)
		.filter(Boolean);

	return incomingPhones.some(phone => existingPhones.has(phone));
}

//Check whether two contacts share a normalized social account.
function contactMatchHasSharedSocial(existingValue, incomingValue) {
	const existingAccounts = new Set(
		contactMatchSplitValues(existingValue)
			.map(contactMatchNormalizeSocial)
			.filter(Boolean)
	);

	const incomingAccounts = contactMatchSplitValues(incomingValue)
		.map(contactMatchNormalizeSocial)
		.filter(Boolean);

	return incomingAccounts.some(account => existingAccounts.has(account));
}

//Check whether two contacts share a common office email.
function contactMatchHasSharedOfficeEmail(existingEmail, incomingEmail) {
	const officeNames = [
		"info", "contact", "office", "admin",
		"support", "team", "hello", "general",
		"reception", "booking", "bookings"
	];

	const existingEmails = new Set(
		contactMatchSplitValues(existingEmail)
	);

	return contactMatchSplitValues(incomingEmail).some(email => {
		const emailName = email.split("@")[0];

		return existingEmails.has(email) &&
			officeNames.includes(emailName);
	});
}

//Identify strong matching evidence between two contacts.
//Matching an email or social profile provides strong evidence, but does not automatically merge contacts.
function contactMatchGetStrongEvidence(existing, incoming) {
	const matchingFields = [];

	if (contactMatchHasSharedValue(existing.Email, incoming.Email)) {
		matchingFields.push("Email");
	}

	if (
		contactMatchHasSharedSocial(
			existing["Social Accounts"],
			incoming["Social Accounts"]
		)
	) {
		matchingFields.push("Social Accounts");
	}

	return matchingFields;
}

//Check whether two names are identical or use known nicknames.
//Similar names are only supporting evidence, not exact identity.
function contactMatchNamesSimilar(existingName, incomingName) {
	if (contactMatchHasSharedValue(existingName, incomingName)) {
		return true;
	}

	const name1 = contactMatchNormalizeText(existingName).split(" ");
	const name2 = contactMatchNormalizeText(incomingName).split(" ");

	//Only compare simple first-name and last-name pairs.
	if (name1.length !== 2 || name2.length !== 2) {
		return false;
	}

	//Different last names are not matched by this rule.
	if (name1[1] !== name2[1]) {
		return false;
	}

	//Known nickname pairs.
	const nicknameGroups = [
		["michael", "mike"],
		["william", "bill"],
		["robert", "bob"],
		["james", "jim"]
	];

	return nicknameGroups.some(group =>
		group.includes(name1[0]) && group.includes(name2[0])
	);
}

//Identify supporting evidence between two contacts.
//Supporting evidence can indicate a possible duplicate, but must not trigger an automatic merge.
function contactMatchGetSupportingEvidence(existing, incoming) {
	const matchingFields = [];

	//Name / DJ Alias
	const sameName = contactMatchNamesSimilar(
		existing["Name / DJ Alias"],
		incoming["Name / DJ Alias"]
	);

	//Radio Station / Organization
	const sameOrganization = contactMatchHasSharedValue(
		existing["Station / Venue / Organization"],
		incoming["Station / Venue / Organization"]
	);

	//Name + Station / Organization
	if (sameName && sameOrganization) {
		matchingFields.push("Name + Organization");
	}

	//Geographic information
	const sameCity = contactMatchHasSharedValue(
		existing.City,
		incoming.City
	);

	const sameState = contactMatchHasSharedValue(
		existing["State / Region"],
		incoming["State / Region"]
	);

	const sameCountry = contactMatchHasSharedValue(
		existing.Country,
		incoming.Country
	);

	//Name + sufficiently specific location
	if (sameName && sameCity && (sameState || sameCountry)) {
		matchingFields.push("Name + Location");
	}

	//Phone number is supporting evidence only.
	if (contactMatchHasSharedPhone(existing.Phone, incoming.Phone)) {
		matchingFields.push("Phone");
	}

	return matchingFields;
}

//Calculate a match score based on matching evidence.
//The maximum score is 100.
function contactMatchCalculateScore(strongEvidence, supportingEvidence) {
	let score = 0;

	//Strong matching evidence.
	if (strongEvidence.includes("Email")) {
		score += 50;
	}

	if (strongEvidence.includes("Social Accounts")) {
		score += 50;
	}

	//Supporting matching evidence.
	if (supportingEvidence.includes("Name + Organization")) {
		score += 30;
	}

	if (supportingEvidence.includes("Name + Location")) {
		score += 20;
	}

	if (supportingEvidence.includes("Phone")) {
		score += 10;
	}

	return Math.min(score, 100);
}

//Classify two contacts based on strong and supporting evidence.
//Do not automatically merge contacts when identity information conflicts.
function contactMatchClassify(existing, incoming) {
	const strongEvidence = contactMatchGetStrongEvidence(
		existing, incoming
	);

	const supportingEvidence = contactMatchGetSupportingEvidence(
		existing, incoming
	);

	//Calculate the match score.
	const matchScore = contactMatchCalculateScore(
		strongEvidence,
		supportingEvidence
	);

	const conflictingFields = [];

	//Check whether both contacts have different names.
	const existingName = contactMatchNormalizeText(
		existing["Name / DJ Alias"]
	);

	const incomingName = contactMatchNormalizeText(
		incoming["Name / DJ Alias"]
	);

	if (existingName && incomingName && existingName !== incomingName) {
		conflictingFields.push("Name / DJ Alias");
	}

	//Check whether both contacts have different phone numbers.
	const existingPhones = contactMatchSplitValues(existing.Phone);
	const incomingPhones = contactMatchSplitValues(incoming.Phone);

	if (
		existingPhones.length > 0 &&
		incomingPhones.length > 0 &&
		!contactMatchHasSharedPhone(existing.Phone, incoming.Phone)
	) {
		conflictingFields.push("Phone");
	}

	//Check whether the matching email is a shared office email.
	const sharedOfficeEmail = contactMatchHasSharedOfficeEmail(
		existing.Email,
		incoming.Email
	);

	//Strong evidence without conflicts can be an exact match.
	//A shared office email needs review unless a social profile also matches.
	if (
		strongEvidence.length > 0 &&
		conflictingFields.length === 0 &&
		(!sharedOfficeEmail || strongEvidence.includes("Social Accounts"))
	) {
		return {
			status: "EXACT_MATCH",
			matchScore,
			matchingFields: [...strongEvidence, ...supportingEvidence],
			conflictingFields
		};
	}

	//Strong evidence with a conflict needs human review.
	//Name + organization or location also indicates a possible match.
	const hasPotentialIdentityEvidence = supportingEvidence.some(
		field =>
			field === "Name + Organization" ||
			field === "Name + Location"
	);

	if (strongEvidence.length > 0 || hasPotentialIdentityEvidence) {
		return {
			status: "POSSIBLE_MATCH",
			matchScore,
			matchingFields: [...strongEvidence, ...supportingEvidence],
			conflictingFields
		};
	}

	//Phone alone is not enough to establish identity.
	return {
		status: "NO_MATCH",
		matchScore,
		matchingFields: supportingEvidence,
		conflictingFields
	};
}
