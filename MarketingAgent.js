const DJ_ACTIONABLE_HEADERS = [
  "Contact ID", "DJ Name", "Campaign / Release", "Engagement Status",
  "Rating", "Comments", "Favorite Remix", "Email", "Social Accounts",
  "Contact Status", "Suggested Follow-Up", "Source Report", "Last Updated"
];
const MARKETING_ERROR_HEADERS = ["Timestamp", "Stage", "Source ID", "Error"];

// UrlFetchApp timeout/network errors include the request URL, which can carry an API key;
// provider error bodies can echo keys or Authorization headers.
function marketingRedact_(text) {
  return String(text)
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_*-]{8,}/g, "sk-[redacted]");
}

function logMarketingFailure_(stage, sourceId, error) {
  error = {message: marketingRedact_(error && error.message || error)};
  console.error("Marketing Agent " + stage + " [" + sourceId + "]: " + error.message);
  const props = PropertiesService.getScriptProperties();
  const db = SpreadsheetApp.openById(props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID"));
  const lock = LockService.getScriptLock();
  // The console entry above remains when the sheet log is busy.
  if (!lock.tryLock(10000)) return;
  try {
    const sheet = djIdentityEnsureReviewSheet(db, "Marketing_Run_Log", MARKETING_ERROR_HEADERS);
    ensureSheetRowCapacity(sheet, sheet.getLastRow() + 1);
    sheet.appendRow([new Date(), stage, sourceId, String(error.message)].map(asLiteralCellValue));
  } finally { lock.releaseLock(); }
}

const MARKETING_RUN_LEASE = "MA_RUN_LEASE";
// Longer than the Apps Script execution limit, so a killed run never blocks later timers.
const MARKETING_RUN_LEASE_MS = 7 * 60 * 1000;

function marketingReadLease_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(MARKETING_RUN_LEASE) || "null");
  } catch (error) {
    return null;
  }
}

// The lock is held only to read/write the lease, never during Gemini or Drive work.
function marketingClaimRun_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return null;
  try {
    const lease = marketingReadLease_();
    if (lease && lease.expiresAt > Date.now()) return null;
    const run = {owner: Utilities.getUuid(), startedAt: Date.now()};
    PropertiesService.getScriptProperties().setProperty(MARKETING_RUN_LEASE,
      JSON.stringify({owner: run.owner, expiresAt: run.startedAt + MARKETING_RUN_LEASE_MS}));
    return run;
  } finally { lock.releaseLock(); }
}

// Caller holds the script lock. Rejects work from a run whose lease was reclaimed
// by a later timer, and renews the lease of the current owner.
function marketingAssertOwner_(run) {
  const lease = marketingReadLease_();
  if (!lease || lease.owner !== run.owner) {
    const error = new Error("Marketing Agent run lease was taken over; this run stopped without saving.");
    error.leaseLost = true;
    throw error;
  }
  PropertiesService.getScriptProperties().setProperty(MARKETING_RUN_LEASE,
    JSON.stringify({owner: run.owner, expiresAt: Date.now() + MARKETING_RUN_LEASE_MS}));
}

function marketingReleaseRun_(run) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const lease = marketingReadLease_();
    if (lease && lease.owner === run.owner)
      PropertiesService.getScriptProperties().deleteProperty(MARKETING_RUN_LEASE);
  } finally { lock.releaseLock(); }
}

// Run manually after correcting a permanent extraction error (for example the API key).
// Saved sections are kept; only failed sections are requested again on the next timer.
function marketingRetryFailedReports() {
  return marketingWithLock_(() => {
    const lease = marketingReadLease_();
    if (lease && lease.expiresAt > Date.now())
      throw new Error("A Marketing Agent run is active; retry after it finishes.");
    const props = PropertiesService.getScriptProperties();
    let reset = 0;
    props.getKeys().filter(key => key.indexOf("MA_JOB_") === 0).forEach(key => {
      const job = marketingLoadJob_(key.slice("MA_JOB_".length));
      if (!job) return;
      job.sections.forEach(section => {
        if (!section.failed) return;
        Object.assign(section, {failed: false, attempts: 0, nextAt: 0});
        reset++;
      });
      marketingSaveJob_(job);
    });
    return reset;
  });
}

// The timer and both legacy entry points use this same workflow.
function runMarketingAgent() {
  const run = marketingClaimRun_();
  if (!run) {
    console.log("Marketing Agent: previous run still active; this timer run was skipped.");
    return {skipped: true};
  }
  resetApiInventory();
  marketingResetExtractionUsage_();
  try {
    marketingInitialize_();
    const stats = processNewPDFs(run);
    stats.extraction = MARKETING_EXTRACTION_USAGE;
    marketingWithLock_(() => marketingAssertOwner_(run));
    const props = PropertiesService.getScriptProperties();
    const db = SpreadsheetApp.openById(props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID"));
    const source = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
    stats.identity = marketingSyncIdentityReviews_(db, source);
    djFollowUpSync(db);
    stats.actionable = marketingRefreshActionable_(db, source);
    console.log("Marketing Agent: " + JSON.stringify(stats));
    if (stats.failed || stats.identity.failed)
      throw new Error(stats.failed + " report(s) failed; " + stats.identity.failed +
        " identity operation(s) failed; see Marketing_Run_Log. Other reports and the actionable list were processed.");
    return stats;
  } catch (error) {
    if (error && typeof error.message === "string") error.message = marketingRedact_(error.message);
    logMarketingFailure_("RUN", "", error);
    throw error;
  } finally {
    marketingReleaseRun_(run);
    printApiInventory();
  }
}

function marketingInitialize_() {
  const props = PropertiesService.getScriptProperties();
  const required = ["PARSER_INPUT_FOLDER", "PARSER_OUTPUT_FOLDER",
    "SPREADSHEET_DATA_EXTRACTION", "CONTACT_DATABASE_SPREADSHEET_ID", marketingExtractionProvider_().keyProperty];
  required.forEach(key => {
    if (!trimCellText(props.getProperty(key))) throw new Error("Missing Script Property: " + key);
  });
  if (props.getProperty("PARSER_INPUT_FOLDER") === props.getProperty("PARSER_OUTPUT_FOLDER") ||
      props.getProperty("SPREADSHEET_DATA_EXTRACTION") === props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID"))
    throw new Error("Use distinct input/output folders and extraction/contact spreadsheets.");
  const db = SpreadsheetApp.openById(props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID"));
  const master = db.getSheetByName("Master_Contacts");
  if (!master) throw new Error("Create Master_Contacts with MASTER_CONTACT_HEADERS before installing.");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { createCampaignHistoryStore(master); } finally { lock.releaseLock(); }
}

// Install once, as the account that owns the input folders and spreadsheets.
function installMarketingAgentTrigger() {
  marketingInitialize_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const handlers = ["runMarketingAgent", "runAutomatedFunctions", "runScripts"];
    const existing = ScriptApp.getProjectTriggers().filter(trigger => handlers.includes(trigger.getHandlerFunction()));
    // Create first: a creation failure must not remove the working timer.
    ScriptApp.newTrigger("runMarketingAgent").timeBased().everyMinutes(5).create();
    existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  } finally { lock.releaseLock(); }
}

function marketingSyncIdentityReviews_(db, source) {
  const stats = {queued: 0, linked: 0, failed: 0};
  const contacts = djEngagementReadSheet(db.getSheetByName("Master_Contacts"), MASTER_CONTACT_HEADERS, "Master_Contacts");
  const people = contacts.rows.filter(row => row.some(trimCellText)).map(row =>
    Object.fromEntries(MASTER_CONTACT_HEADERS.map(header => [header, row[contacts.columns[header]]])));
  for (const pending of djEngagementPendingReviews(db)) {
    try {
      let reviewSheet = db.getSheetByName(DJ_IDENTITY_REVIEW_SHEET);
      let review = reviewSheet ? djIdentityFindReviewRow(reviewSheet, pending.observationId) : null;
      if (!review) {
        const observation = {...pending, sourceReportId: pending.sourceReportId || pending.sourceTab,
          sourceUrl: pending.sourceReportUrl || pending.sourceUrl};
        const result = djResolveIdentity(observation, people);
        for (const id of pending.candidateContactIds.split(",").map(trimCellText).filter(Boolean)) {
          if (result.candidates.some(candidate => candidate.contactId === id)) continue;
          const person = people.find(candidate => candidate["Contact ID"] === id);
          const evidence = person ? contactMatchClassify(person, djIdentityBuildCandidate(observation).candidate) :
            {status: "CONTACT_NOT_FOUND", matchScore: 0, matchingFields: [], conflictingFields: []};
          result.candidates.push({...evidence, contactId: id, safeToAutoLink: false,
            reason: "IMPORT_LOG_IDENTITY_REVIEW"});
        }
        // Import_Log remains authoritative until the existing review/link operation completes.
        result.decision = "REVIEW";
        result.status = "REVIEW_REQUIRED";
        djIdentitySaveReview(db, observation, result);
        reviewSheet = db.getSheetByName(DJ_IDENTITY_REVIEW_SHEET);
        review = djIdentityFindReviewRow(reviewSheet, pending.observationId);
      }
      if (review.values[10] === "APPROVED_LINK") {
        djEngagementLinkApproved(db, source, pending.observationId);
        stats.linked++;
      } else stats.queued++;
    } catch (error) {
      stats.failed++;
      logMarketingFailure_("IDENTITY", pending.observationId, error);
    }
  }
  return stats;
}

function marketingExplicitCount_(value) {
  const text = trimCellText(value);
  return /^(?:yes|true|downloaded|listened)$/i.test(text) ||
    (/^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0);
}

function marketingEngagement_(entry) {
  const fields = entry.reportedFields || {};
  const status = entry.status;
  // Match affirmative platform statuses, not "not downloaded", "0 downloads", or favorites.
  const affirmative = verb => new RegExp("^" + verb + "\\b", "i").test(status) &&
    !new RegExp("^" + verb + "\\s*[:=-]?\\s*(?:no\\b(?!\\s+feedback)|false\\b|0\\b|not\\b)", "i").test(status);
  const downloaded = affirmative("downloaded") || /^download\s*:\s*(?:yes|true|[1-9]\d*)\b/i.test(status) ||
    marketingExplicitCount_(fields.downloaded) || marketingExplicitCount_(fields.downloads);
  const listened = affirmative("listened") ||
    marketingExplicitCount_(fields.listened) || marketingExplicitCount_(fields.listens);
  const section = trimCellText(fields.reportsection);
  return {
    status: joinUniqueLines([section && section.toLowerCase() !== String(status).trim().toLowerCase() ?
      "Report section: " + section : "", status, downloaded ? "Confirmed download" : "",
      listened ? "Confirmed listen" : "", trimCellText(entry.comments) ? "Written feedback" : ""]) ||
      "No explicit engagement reported",
    followUp: downloaded ? "THANK_YOU_DOWNLOAD" : trimCellText(entry.comments) ?
      "RESPOND_TO_FEEDBACK" : listened ? "FOLLOW_UP_LISTEN" : "NO_CONFIRMED_ENGAGEMENT"
  };
}

function marketingRefreshActionable_(db, source) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const master = djEngagementReadSheet(db.getSheetByName("Master_Contacts"),
      [...MASTER_CONTACT_HEADERS, "Campaign History Data"], "Master_Contacts");
    const rows = [];
    for (const row of master.rows) {
      if (!row.some(trimCellText)) continue;
      const get = header => trimCellText(row[master.columns[header]]);
      const id = get("Contact ID");
      const verified = djSocialProfileGetVerified(db, id);
      const contactStatus = verified.length || /^(?:verified|reviewed)$/i.test(get("Review Status")) ?
        "VERIFIED" : "UNVERIFIED";
      for (const entry of parseSavedCampaignHistory(get("Campaign History Data"), id)) {
        const engagement = marketingEngagement_(entry);
        rows.push([id, get("Name / DJ Alias"), entry.campaign, engagement.status,
          entry.rating, entry.comments, entry.favoriteTrack, get("Email"),
          joinUniqueLines([get("Social Accounts"), ...verified.map(profile => profile.profileUrl)]),
          contactStatus, engagement.followUp, entry.sourceUrl,
          [entry.extractedAt, entry.firstSavedAt].filter(campaignExtractionTime).sort().pop()]);
      }
    }
    const logSheet = db.getSheetByName("Import_Log");
    if (logSheet) {
      const log = djEngagementReadSheet(logSheet, CONTACT_IMPORT_LOG_HEADERS, "Import_Log");
      for (const pending of djEngagementPendingReviews(db)) {
        try {
          const logRow = djEngagementFindUnique(log.rows, log.columns["Observation Key"], pending.observationId, "observation");
          const entry = djEngagementReadSource(source, logRow, log.columns, pending.observationId);
          rows.push(["", pending.djReportedName, entry.campaign, marketingEngagement_(entry).status,
            entry.rating, entry.comments, entry.favoriteTrack, pending.email, pending["Social Accounts"],
            "UNRESOLVED_IDENTITY", "IDENTITY_REVIEW", entry.sourceUrl, entry.extractedAt]);
        } catch (error) {
          // Do not publish a success-shaped list that silently omits a pending recipient.
          console.error("Actionable identity " + pending.observationId + ": " + error.message);
          rows.push(["", pending.djReportedName, pending.sourceTab, "", "", "", "", pending.email,
            pending["Social Accounts"], "UNRESOLVED_IDENTITY", "IDENTITY_REVIEW",
            pending.sourceUrl, ""]);
        }
      }
    }
    rows.sort((a, b) => a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
    const sheet = djIdentityEnsureReviewSheet(db, "DJ_Actionable_Contacts", DJ_ACTIONABLE_HEADERS);
    const oldRows = sheet.getLastRow();
    const matrix = [DJ_ACTIONABLE_HEADERS, ...rows];
    ensureSheetRowCapacity(sheet, matrix.length);
    sheet.getRange(1, 1, matrix.length, DJ_ACTIONABLE_HEADERS.length)
      .setValues(matrix.map(row => row.map(asLiteralCellValue)));
    if (oldRows > matrix.length)
      sheet.getRange(matrix.length + 1, 1, oldRows - matrix.length, DJ_ACTIONABLE_HEADERS.length).clearContent();
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    return {rows: rows.length, url: db.getUrl().split("#")[0] + "#gid=" + sheet.getSheetId()};
  } finally { lock.releaseLock(); }
}
