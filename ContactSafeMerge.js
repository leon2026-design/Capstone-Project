/**
 * TFB-135: Contact Safe Merge
 * Preview a contact merge without changing the database.
 */

const CONTACT_SAFE_MERGE_MULTI_FIELDS = [
	"Email",
	"Phone",
	"Station / Venue / Organization",
	"Social Accounts",
	"Sources"
];

const CONTACT_SAFE_MERGE_REVIEW_FIELDS = [
	"Email",
	"Phone",
	"Station / Venue / Organization"
];

const CONTACT_SAFE_MERGE_SYSTEM_FIELDS = [
	"Contact ID",
	"Review Status",
	"Review Notes",
	"Last Updated",
	"sheetRow"
];

//Convert a contact field into text.
function contactSafeMergeText(value) {
	return String(value == null ? "" : value).trim();
}

//Split a field containing multiple values.
function contactSafeMergeSplitValues(value) {
	return contactSafeMergeText(value)
		.split(/\r?\n/)
		.map(item => item.trim())
		.filter(Boolean);
}

//Combine values without adding duplicates.
function contactSafeMergeUniqueValues(first, second) {
	const values = [
		...contactSafeMergeSplitValues(first),
		...contactSafeMergeSplitValues(second)
	];

	const seen = new Set();
	const result = [];

	for (const value of values) {
		const key = value.toLowerCase();

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(value);
	}

	return result.join("\n");
}

//Compare two text values.
function contactSafeMergeSameValue(first, second) {
	return contactSafeMergeText(first).toLowerCase() ===
		contactSafeMergeText(second).toLowerCase();
}

/**
 * Build a merge preview for two contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergePreview(primary, duplicate) {
	//Validate the input records.
	if (!primary || typeof primary !== "object" ||
		Array.isArray(primary)) {
		throw new Error("Primary contact is required.");
	}

	if (!duplicate || typeof duplicate !== "object" ||
		Array.isArray(duplicate)) {
		throw new Error("Duplicate contact is required.");
	}

	const primaryId = contactSafeMergeText(primary["Contact ID"]);
	const duplicateId = contactSafeMergeText(duplicate["Contact ID"]);

	//Both records must have valid IDs.
	if (!primaryId || !duplicateId) {
		throw new Error("Both contacts must have a Contact ID.");
	}

	//Prevent merging a contact with itself.
	if (primaryId === duplicateId) {
		throw new Error("Cannot merge a contact with itself.");
	}

	//Preserve the primary contact ID.
	const mergedContact = { ...primary };
	const conflicts = [];
	const reviewFields = [];

	//Compare every field from both records.
	const allFields = new Set([
		...Object.keys(primary),
		...Object.keys(duplicate)
	]);

	for (const field of allFields) {
		//Keep system fields unchanged.
		if (CONTACT_SAFE_MERGE_SYSTEM_FIELDS.includes(field)) {
			continue;
		}

		const primaryValue = contactSafeMergeText(primary[field]);
		const duplicateValue = contactSafeMergeText(duplicate[field]);

		//Combine fields that can contain multiple values.
		if (CONTACT_SAFE_MERGE_MULTI_FIELDS.includes(field)) {
			const combinedValue = contactSafeMergeUniqueValues(
				primaryValue,
				duplicateValue
			);

			mergedContact[field] = combinedValue;

			//Flag contact details that require manual review.
			if (CONTACT_SAFE_MERGE_REVIEW_FIELDS.includes(field) &&
				!contactSafeMergeSameValue(primaryValue, combinedValue)) {
				reviewFields.push(field);
			}

			continue;
		}

		//Fill empty fields in the preview.
		if (!primaryValue && duplicateValue) {
			mergedContact[field] = duplicateValue;
			continue;
		}

		//Record conflicting information without overwriting it.
		if (primaryValue && duplicateValue &&
			!contactSafeMergeSameValue(primaryValue, duplicateValue)) {
			conflicts.push({
				field: field,
				primaryValue: primaryValue,
				duplicateValue: duplicateValue
			});
		}
	}

	return {
		survivingContactId: primaryId,
		duplicateContactId: duplicateId,
		mergedContact: mergedContact,
		conflicts: conflicts,
		reviewFields: reviewFields,
		hasUnresolvedConflicts: conflicts.length > 0,
		requiresManualReview: true
	};
}


/**
 * TFB-135: Manual Merge Approval
 * Validate approval before merging two contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeValidateApproval(primary, duplicate, reviewRecord) {
	//Validate both contact records.
	const preview = contactSafeMergePreview(primary, duplicate);

	//Require a manual review record.
	if (!reviewRecord ||
		typeof reviewRecord !== "object" ||
		Array.isArray(reviewRecord)) {
		throw new Error("Manual review record is required.");
	}

	const matchId = contactSafeMergeText(reviewRecord["Match ID"]);

	const existingId = contactSafeMergeText(
		reviewRecord["Existing Contact ID"]
	);

	const incomingId = contactSafeMergeText(
		reviewRecord["Incoming Record ID"]
	);

	const decision = contactSafeMergeText(
		reviewRecord["Review Status"]
	);

	const reviewer = contactSafeMergeText(
		reviewRecord["Reviewer"]
	);

	const reviewDate = reviewRecord["Review Date"];

	//Require a valid review record ID.
	if (!matchId) {
		throw new Error("Match ID is required.");
	}

	//Approval must belong to these exact contacts.
	if (existingId !== preview.survivingContactId ||
		incomingId !== preview.duplicateContactId) {
		throw new Error("Approval does not match contact IDs.");
	}

	//Only confirmed duplicates can be merged.
	if (decision !== "Confirm Duplicate") {
		throw new Error("Duplicate merge has not been approved.");
	}

	//Require an identified human reviewer.
	if (!reviewer) {
		throw new Error("Reviewer is required.");
	}

	//Require a valid review date.
	if (!reviewDate ||
		!Number.isFinite(new Date(reviewDate).getTime())) {
		throw new Error("Valid review date is required.");
	}

	//Return approval details without changing any records.
	return {
		matchId: matchId,
		primaryContactId: preview.survivingContactId,
		duplicateContactId: preview.duplicateContactId,
		reviewer: reviewer,
		reviewDate: new Date(reviewDate).toISOString(),
		approved: true
	};
}


/**
 * Create a backup snapshot before merging contacts.
 * This function does not modify Google Sheets.
 */
function contactSafeMergeCreateSnapshot(primary, duplicate, reviewRecord) {
	//Validate the proposed merge approval.
	const approval = contactSafeMergeValidateApproval(
		primary,
		duplicate,
		reviewRecord
	);

	//Copy flat contact fields without sharing mutable values.
	function copyContact(record) {
		const copy = {};

		for (const [field, value] of Object.entries(record)) {
			if (value instanceof Date) {
				copy[field] = new Date(value.getTime());
			} else if (
				value === null ||
				["string", "number", "boolean", "undefined"].includes(typeof value)
			) {
				copy[field] = value;
			} else {
				throw new Error("Unsupported contact field value: " + field);
			}
		}

		return copy;
	}

	//Keep independent copies of both original contacts.
	const primaryBefore = copyContact(primary);
	const duplicateBefore = copyContact(duplicate);

	return {
		primaryContactId: approval.primaryContactId,
		duplicateContactId: approval.duplicateContactId,
		matchId: approval.matchId,
		reviewer: approval.reviewer,
		reviewDate: approval.reviewDate,
		createdAt: new Date(),
		primaryBefore: primaryBefore,
		duplicateBefore: duplicateBefore,
		persisted: false
	};
}
