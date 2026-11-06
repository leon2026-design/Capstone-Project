/**
 * TFB-135: Contact Change Tracking
 *
 * Detect changes in contact information.
 * Do not overwrite existing contact data.
 */

//Fields to check for contact changes.
const CONTACT_CHANGE_FIELDS = [
	"Name / DJ Alias",
	"Email",
	"Phone",
	"Station / Venue / Organization",
	"City",
	"State / Region",
	"Country",
	"Social Accounts"
];

//Normalize field values before comparing.
function contactChangeNormalizeValue(field, value) {
	const text = String(value ?? "").trim();

	//Ignore email capitalization.
	if (field === "Email") {
		return text.toLowerCase();
	}

	//Normalize US phone number formatting.
	if (field === "Phone") {
		const digits = text.replace(/\D/g, "");

		if (digits.length === 11 && digits.startsWith("1")) {
			return digits.slice(1);
		}

		if (digits.length === 10) {
			return digits;
		}
	}

	//Normalize social account URLs.
	if (field === "Social Accounts") {
		return text.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/^www\./, "")
			.replace(/\/+$/, "");
	}

	return text;
}

//Compare an existing value with an incoming value.
function contactChangeCompareValue(existingValue, incomingValue, field) {
	const oldValue = String(existingValue ?? "").trim();
	const newValue = String(incomingValue ?? "").trim();

	//No new information.
	if (!newValue) {
		return "UNCHANGED";
	}

	//New information for an empty field.
	if (!oldValue) {
		return "NEWLY_POPULATED";
	}

	//Compare multiple emails, social accounts, or phone numbers.
	if (field === "Email" || field === "Social Accounts" || field === "Phone") {
		const existingValues = new Set(
			oldValue.split(/\r?\n/)
				.map(value => contactChangeNormalizeValue(field, value))
				.filter(Boolean)
		);

		const incomingValues = newValue.split(/\r?\n/)
			.map(value => contactChangeNormalizeValue(field, value))
			.filter(Boolean);

		//No change if all incoming values already exist.
		if (incomingValues.every(value => existingValues.has(value))) {
			return "UNCHANGED";
		}

		//New values need review before updating.
		return "CONFLICTING";
	}

	//Compare normalized values.
	const normalizedOld = contactChangeNormalizeValue(field, oldValue);
	const normalizedNew = contactChangeNormalizeValue(field, newValue);

	if (normalizedOld === normalizedNew) {
		return "UNCHANGED";
	}

	//A different station may indicate an outdated affiliation.
	//Keep the previous station for manual review.
	if (field === "Station / Venue / Organization") {
		return "POTENTIALLY_OUTDATED";
	}

	//Both values exist but are different.
	return "CONFLICTING";
}

//Detect changes between an existing contact and an incoming contact.
function contactChangeDetectChanges(existing, incoming) {
	const changes = [];

	//Check each contact field.
	for (const field of CONTACT_CHANGE_FIELDS) {
		const oldValue = String(existing[field] ?? "").trim();
		const newValue = String(incoming[field] ?? "").trim();

		const changeType = contactChangeCompareValue(
			oldValue,
			newValue,
			field
		);

		//Skip fields without changes.
		if (changeType === "UNCHANGED") {
			continue;
		}

		//Record the change without modifying contact data.
		changes.push({
			field,
			previousValue: oldValue,
			proposedValue: newValue,
			changeType
		});
	}

	return changes;
}
