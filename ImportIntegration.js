    //Connect imported campaign records to identity review and engagement linking.
    //Run these functions only after ContactImporter releases its Script Lock.

    function importIntegrationText(value) {
        return String(value == null ? "" : value).trim();
    }

    function importIntegrationContacts(database) {
        const master = database.getSheetByName("Master_Contacts");
        if (!master || master.getLastRow() < 1) {
            throw new Error("Master_Contacts is missing.");
        }

        const data = master.getDataRange().getDisplayValues();
        const columns = indexRequiredHeaders(data[0], MASTER_CONTACT_HEADERS, "Master_Contacts");
        const contacts = [];
        const ids = new Set();

        for (const row of data.slice(1)) {
            if (!row.some(importIntegrationText)) continue;

            const contact = {};
            for (const header of MASTER_CONTACT_HEADERS) {
                contact[header] = importIntegrationText(row[columns[header]]);
            }

            const id = contact["Contact ID"];
            if (!id || ids.has(id)) {
                throw new Error("Missing or duplicate Contact ID in Master_Contacts.");
            }

            ids.add(id);
            contacts.push(contact);
        }

        const social = database.getSheetByName("DJ_Social_Profiles");
        const verified = new Map();

        if (social && social.getLastRow() > 1) {
            const rows = social.getDataRange().getDisplayValues();
            const positions = indexRequiredHeaders(rows[0], [
                "Contact ID", "Platform", "Profile URL", "Verification Status"
            ], "DJ_Social_Profiles");

            for (const row of rows.slice(1)) {
                if (importIntegrationText(row[positions["Verification Status"]]) !== "VERIFIED") {
                    continue;
                }

                const id = importIntegrationText(row[positions["Contact ID"]]);
                const url = importIntegrationText(row[positions["Profile URL"]]);
                if (!id || !url) {
                    throw new Error("Invalid verified social profile record.");
                }

                if (!verified.has(id)) verified.set(id, []);
                verified.get(id).push({
                    platform: importIntegrationText(row[positions["Platform"]]),
                    profileUrl: url,
                    verificationStatus: "VERIFIED"
                });
            }
        }

        return contacts.map(contact => ({
            ...contact,
            verifiedSocialProfiles: verified.get(contact["Contact ID"]) || []
        }));
    }

    function importIntegrationObservation(record) {
        const id = importIntegrationText(record.observationId);
        if (!id) throw new Error("Missing Import_Log observation key.");

        return {
            observationId: id,
            djReportedName: importIntegrationText(record.djReportedName),
            email: importIntegrationText(record.email),
            station: importIntegrationText(record.station),
            phone: importIntegrationText(record.phone),
            city: importIntegrationText(record.city),
            state: importIntegrationText(record.state),
            country: importIntegrationText(record.country),
            "Social Accounts": importIntegrationText(record["Social Accounts"]),
            sourceUrl: importIntegrationText(record.sourceUrl),
            sourceReportId: "",
            sourcePage: "",
            sourceSection: ""
        };
    }

    //Queue uncertain import identities without automatically approving any link.
    function importIntegrationSyncReviews(database) {
        const pending = djEngagementPendingReviews(database);
        const contacts = importIntegrationContacts(database);
        const byId = new Map(contacts.map(person => [person["Contact ID"], person]));
        const summary = { observations: pending.length, queued: 0, socialProfiles: 0 };

        for (const record of pending) {
            const observation = importIntegrationObservation(record);
            const resolved = djResolveIdentity(observation, contacts);
            const candidates = [...resolved.candidates];
            const candidateIds = new Set(candidates.map(person => person.contactId));

            //Keep candidates that the existing importer already flagged for review.
            const previousIds = importIntegrationText(record.candidateContactIds)
                .split(",")
                .map(importIntegrationText)
                .filter(Boolean);

            for (const id of previousIds) {
                if (!byId.has(id) || candidateIds.has(id)) continue;
                candidates.push({
                    contactId: id,
                    status: "POSSIBLE_MATCH",
                    matchScore: 0,
                    matchingFields: [],
                    conflictingFields: [],
                    safeToAutoLink: false,
                    reason: "PREVIOUS_IMPORT_REVIEW_CANDIDATE"
                });
                candidateIds.add(id);
            }

            const needsReview = candidates.length > 0;
            const result = {
                ...resolved,
                candidates,
                decision: needsReview ? "REVIEW" : "UNRESOLVED",
                status: needsReview ? "POSSIBLE_MATCH" : "NO_MATCH",
                contactId: null
            };

            //Each writer manages its own lock; never call under ContactImporter lock.
            djIdentitySaveReview(database, observation, result);
            summary.queued++;
            summary.socialProfiles += djSocialProfileSave(database, observation, result).length;
        }

        summary.followUps = djFollowUpSync(database);
        return summary;
    }

    //Apply only human-approved engagement links, preserving the original MA-04 data.
    function importIntegrationApplyApproved(database, extraction) {
        const review = database.getSheetByName("DJ_Identity_Review");
        const summary = { approved: 0, linked: 0, alreadyLinked: 0 };
        if (!review || review.getLastRow() < 2) return summary;

        const data = review.getDataRange().getDisplayValues();
        const columns = indexRequiredHeaders(data[0], [
            "Observation ID", "Review Status", "Selected Contact ID"
        ], "DJ_Identity_Review");
        const ids = new Set();
        const approved = [];

        for (const row of data.slice(1)) {
            if (!row.some(importIntegrationText)) continue;
            const id = importIntegrationText(row[columns["Observation ID"]]);
            if (!id || ids.has(id)) {
                throw new Error("Missing or duplicate identity review observation ID.");
            }
            ids.add(id);

            if (row[columns["Review Status"]] !== "APPROVED_LINK") continue;
            if (!importIntegrationText(row[columns["Selected Contact ID"]])) {
                throw new Error("Approved review has no Contact ID: " + id);
            }
            approved.push(id);
        }

        summary.approved = approved.length;
        for (const id of approved) {
            const result = djEngagementLinkApproved(database, extraction, id);
            if (result.status === "LINKED") summary.linked++;
            else if (result.status === "ALREADY_LINKED") summary.alreadyLinked++;
            else throw new Error("Unexpected engagement status: " + result.status);
        }

        return summary;
    }

    //Manual Apps Script entry point for importing pending identity reviews.
    function importIntegrationSync() {
        const properties = PropertiesService.getScriptProperties();
        const databaseId = importIntegrationText(
            properties.getProperty("CONTACT_DATABASE_SPREADSHEET_ID")
        );
        if (!databaseId || !SPREADSHEET_DATA_EXTRACTION ||
            databaseId === SPREADSHEET_DATA_EXTRACTION) {
            throw new Error("Set distinct contact and extraction spreadsheet IDs.");
        }
        const database = SpreadsheetApp.openById(databaseId);
        return importIntegrationSyncReviews(database);
    }

    //Manual Apps Script entry point for approved engagement links.
    function importIntegrationLinkApproved() {
        const properties = PropertiesService.getScriptProperties();
        const databaseId = importIntegrationText(
            properties.getProperty("CONTACT_DATABASE_SPREADSHEET_ID")
        );
        if (!databaseId || !SPREADSHEET_DATA_EXTRACTION ||
            databaseId === SPREADSHEET_DATA_EXTRACTION) {
            throw new Error("Set distinct contact and extraction spreadsheet IDs.");
        }
        return importIntegrationApplyApproved(
            SpreadsheetApp.openById(databaseId),
            SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION)
        );
    }
