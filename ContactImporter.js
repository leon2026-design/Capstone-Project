const MASTER_CONTACT_HEADERS = [
  "Contact ID", "Name / DJ Alias", "Role", "Station / Venue / Organization",
  "City", "State / Region", "Country", "Email", "Phone", "Social Accounts",
  "Sources", "Review Status", "Review Notes", "Last Updated"
];
const CONTACT_IMPORT_LOG_HEADERS = [
  "Timestamp", "Run ID", "Source Tab", "Source URL", "Source Row",
  "Observation Key", "Outcome", "Contact IDs", "Details"
];

function trimCellText(v) { return String(v == null ? "" : v).trim(); }
function normalizeContactText(v) { return trimCellText(v).toLowerCase().replace(/\s+/g, " "); }
function joinUniqueLines(values) {
  return [...new Set(values.flatMap(v => trimCellText(v).split(/\r?\n/))
    .map(trimCellText).filter(Boolean))].join("\n");
}
// Write report text literally even if it starts with an equals sign.
function asLiteralCellValue(v) { return typeof v === "string" && v.startsWith("=") ? "'" + v : v; }

function indexRequiredHeaders(headers, required, name) {
  const cols = {};
  required.forEach(h => {
    const i = headers.indexOf(h);
    if (i < 0 || headers.lastIndexOf(h) !== i)
      throw Error(name + ': expected exactly one header named "' + h + '".');
    cols[h] = i;
  });
  return cols;
}

// Reuse the project's known aliases; otherwise use the report header itself.
function identifyContactFields(headers) {
  const aliases = buildHeaderAliasLookup();
  const combinedNames = new Set(COMBINED_NAME_ALIASES.map(normalizeKey));

  return headers.map(header => {
    const key = normalizeKey(header);
    if (combinedNames.has(key)) return normalizeKey("Name / DJ Alias");
    return normalizeKey(aliases.get(key) || header);
  });
}

function readContactFromRow(fields, row) {
  const get = (...headers) => {
    const keys = headers.map(normalizeKey);
    return joinUniqueLines(row.filter((value, i) => keys.includes(fields[i])));
  };
  let name = get("Name / DJ Alias") || [get("First Name"), get("Last Name")].filter(Boolean).join(" ");
  let email = get("Email Address");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    email = joinUniqueLines([email, name]); name = "";
  }
  const organizations = get("Radio Station", "Venue", "Organization");
  const socials = get("Social Media Account");
  return {
    "Name / DJ Alias": name, "Role": get("Role"),
    "Station / Venue / Organization": organizations, "City": get("City"),
    "State / Region": get("State/Region", "State", "Region"), "Country": get("Country"),
    "Email": email, "Phone": get("Phone Number"), "Social Accounts": socials
  };
}

function findContactMatch(contacts, candidate) {
  const exactMatches = [];
  const possibleMatches = [];

  for (const person of contacts) {
    const result = contactMatchClassify(person, candidate);

    if (result.status === "EXACT_MATCH") {
      exactMatches.push(person);
    } else if (result.status === "POSSIBLE_MATCH") {
      possibleMatches.push(person);
    } else if (result.status === "NO_MATCH") {
      // Keep the old review rule for a name alone or two unnamed station records.
      const sameName = contactMatchHasSharedValue(
        person["Name / DJ Alias"],
        candidate["Name / DJ Alias"]
      );

      const sameUnnamedStation =
        !person["Name / DJ Alias"] &&
        !candidate["Name / DJ Alias"] &&
        contactMatchHasSharedValue(
          person["Station / Venue / Organization"],
          candidate["Station / Venue / Organization"]
        );

      if (sameName || sameUnnamedStation) {
        possibleMatches.push(person);
      }
    } else {
      throw new Error("Unexpected match status: " + result.status);
    }
  }

  // Only link automatically when exactly one person fits and nobody else might.
  if (exactMatches.length === 1 && possibleMatches.length === 0) {
    return { person: exactMatches[0] };
  }

  const review = exactMatches.concat(possibleMatches);
  return review.length > 0 ? { review } : {};
}

// Run this from Apps Script to import the configured campaign report tabs.
function importReportContacts(reportTabIds) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let log, runId, logReady = false, events = [];
  const stats = {read:0, created:0, matched:0, review:0, skipped:0};
  function flushLog() {
    if (log && events.length) {
      const start = log.getLastRow()+1;
      ensureSheetRowCapacity(log,start+events.length-1);
      log.getRange(start,1,events.length,CONTACT_IMPORT_LOG_HEADERS.length)
        .setValues(events.map(row => row.map(asLiteralCellValue)));
      events = [];
    }
  }
  try {
    runId = Utilities.getUuid();
    const props = PropertiesService.getScriptProperties();
    const dbId = trimCellText(props.getProperty("CONTACT_DATABASE_SPREADSHEET_ID"));
    // Automatically supplied IDs take priority over manual configuration.
    if (
      reportTabIds !== undefined &&
      (
        !Array.isArray(reportTabIds) ||
        !reportTabIds.length ||
        reportTabIds.some(id => !/^\d+$/.test(String(id)))
      )
    ) {
      throw new Error(
        "Pass a nonempty array of report tab IDs, " +
        "or run without arguments for manual selection."
      );
    }
    const raw = reportTabIds === undefined
      ? trimCellText(props.getProperty("CONTACT_REPORT_TAB_IDS"))
      : reportTabIds.map(String).join(",");
    if (!dbId || !SPREADSHEET_DATA_EXTRACTION || dbId === SPREADSHEET_DATA_EXTRACTION)
      throw Error("Set distinct extraction and contact spreadsheet IDs.");
    if (!/^\d+(\s*,\s*\d+)*$/.test(raw))
      throw Error("CONTACT_REPORT_TAB_IDS must contain campaign tab gid numbers separated by commas.");
    const src = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
    const db = SpreadsheetApp.openById(dbId);
    const master = db.getSheetByName("Master_Contacts");
    if (!master) throw Error("Create the Master_Contacts tab and paste its headers in A1.");
    const campaignHistory = createCampaignHistoryStore(master);
    const grid = master.getDataRange().getDisplayValues();
    const col = indexRequiredHeaders(grid[0], MASTER_CONTACT_HEADERS, "Master_Contacts");
    const contacts = [], ids = new Set();
    grid.slice(1).forEach((r,i) => {
      if (!r.some(trimCellText)) return;
      const person = {sheetRow:i+2};
      MASTER_CONTACT_HEADERS.forEach(h => person[h] = trimCellText(r[col[h]]));
      const id = person["Contact ID"];
      if (!id || ids.has(id)) throw Error("Missing or duplicate Contact ID at master row " + (i+2));
      contacts.push(person); ids.add(id);
    });

    const sheets = src.getSheets();
    const inputs = [...new Set(raw.split(",").map(x => x.trim()))].map(id => {
      const tab = sheets.find(s => String(s.getSheetId()) === id);
      if (!tab) throw Error("No extraction tab with gid " + id);
      if ([...FIELDS_TO_MAKE_SHEETS_OF,"ISRC_Metadata","BMI_MLC_EXPORT","Station_Recommendations",
           "Master_Contacts","Import_Log"].includes(tab.getName())) throw Error("Output tab selected: "+tab.getName());
      return tab;
    });
    log = db.getSheetByName("Import_Log");
    if (log && log.getLastRow()) {
      const actual = log.getRange(1,1,1,CONTACT_IMPORT_LOG_HEADERS.length).getDisplayValues()[0];
      if (!CONTACT_IMPORT_LOG_HEADERS.every((h,i)=>actual[i]===h)) throw Error("Unexpected Import_Log headers.");
    } else {
      log = log || db.insertSheet("Import_Log");
      log.getRange(1,1,1,CONTACT_IMPORT_LOG_HEADERS.length).setValues([CONTACT_IMPORT_LOG_HEADERS]);
      log.setFrozenRows(1);
    }
    // Keep previous confirmed links so old contact-only imports can gain history.
    const seen = new Set();
    const previousLinks = new Map();
    if (log.getLastRow() > 1) {
      const oldEvents = log.getRange(2, 1, log.getLastRow() - 1, CONTACT_IMPORT_LOG_HEADERS.length).getDisplayValues();
      oldEvents.forEach(event => {
        const observationKey = event[5];
        if (!observationKey) return;
        seen.add(observationKey);
        previousLinks.set(observationKey, ["Created", "Matched"].includes(event[6]) ? event[7] : "");
      });
    }
    logReady = true;
    let nextRow = master.getLastRow()+1;
    for (const tab of inputs) {
      const tabUrl = src.getUrl().split("#")[0] + "#gid=" + tab.getSheetId();
      const data = tab.getDataRange().getDisplayValues();
      const fields = identifyContactFields(data[0]);
      const identityFields = ["First Name", "Last Name", "Name / DJ Alias", "Radio Station",
        "Organization", "Venue", "Email Address", "Social Media Account"].map(normalizeKey);
      if (!fields.some(field => identityFields.includes(field)))
        throw Error("No recognized identity columns in " + tab.getName() + ". Check the report headers.");
      for (let i=1;i<data.length;i++) {
        if (!data[i].some(trimCellText)) continue;
        stats.read++;
        const candidate = readContactFromRow(fields,data[i]);
        const rawInfo = joinUniqueLines(data[i].filter((_,j)=>fields[j] === normalizeKey("Additional Info / Stations")));
        const pdf = joinUniqueLines(data[i].filter((_,j)=>fields[j] === normalizeKey("Report Source URL")));
        const source = joinUniqueLines([tabUrl,pdf]);
        const observation = JSON.stringify({candidate,rawInfo,pdf});
        const key = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
          JSON.stringify([src.getId(),tab.getSheetId(),observation]),Utilities.Charset.UTF_8));
        const response = readCampaignResponse(fields, data[i], src.getId(), tab.getSheetId(), tab.getName(), tabUrl);
        if (seen.has(key)) {
          const priorId = previousLinks.get(key) || "";
          // A stale/merged ID is not guessed or reassigned by MA-04.
          campaignHistory.queue(ids.has(priorId) ? priorId : "", response);
          stats.skipped++;
          continue;
        }
        let outcome, related="", detail=observation;
        const identity = candidate["Name / DJ Alias"] || candidate.Email ||
          candidate["Social Accounts"] || candidate["Station / Venue / Organization"];
        const match = identity ? findContactMatch(contacts,candidate) : {review:[]};
        if (match.review) {
          outcome = "Review identity"; stats.review++;
          related = match.review.map(p=>p["Contact ID"]).join(", ");
        } else {
          const existing = match.person;
          const person = existing || {sheetRow:nextRow++, "Contact ID":"CT-"+Utilities.getUuid()};
          const patch = {}, notes = [];
          for (const [field,val] of Object.entries(candidate)) {
            if (!val) continue;
            if (!person[field]) patch[field]=val;
            else if (normalizeContactText(person[field])!==normalizeContactText(val))
              notes.push(field + ": report says " + val);
          }
          if (rawInfo) notes.push("Unparsed affiliation/location: "+rawInfo);
          if (notes.length) {
            patch["Review Notes"]=joinUniqueLines([person["Review Notes"],...notes.map(x=>x+" — "+tabUrl)]);
            patch["Review Status"]="Needs Review"; stats.review++;
          } else if (!existing || (Object.keys(patch).length && person["Review Status"]==="Reviewed")) {
            patch["Review Status"]="Not Reviewed";
          }
          patch.Sources=joinUniqueLines([person.Sources,source]);
          Object.keys(patch).forEach(h=>{if(patch[h]===person[h]) delete patch[h];});
          if (!existing || Object.keys(patch).length) patch["Last Updated"]=new Date();
          Object.assign(person,patch);
          if (!existing) {
            const out=grid[0].map(()=> "");
            MASTER_CONTACT_HEADERS.forEach(h=>out[col[h]]=asLiteralCellValue(person[h] || ""));
            ensureSheetRowCapacity(master,person.sheetRow);
            master.getRange(person.sheetRow,1,1,out.length).setValues([out]);
          } else {
            for (const h of Object.keys(patch))
              master.getRange(person.sheetRow,col[h]+1).setValue(asLiteralCellValue(patch[h]));
          }
          if (existing) stats.matched++; else {stats.created++; contacts.push(person); ids.add(person["Contact ID"]);}
          related=person["Contact ID"];
          outcome=existing ? "Matched" : "Created";
        }
        const confirmedId = ["Created", "Matched"].includes(outcome) ? related : "";
        campaignHistory.queue(confirmedId, response);
        previousLinks.set(key, confirmedId);
        seen.add(key);
        events.push([new Date(),runId,tab.getName(),tabUrl,i+1,key,outcome,related,detail]);
        if (events.length>=25) flushLog();
      }
      flushLog();
    }
    stats.campaignHistory = campaignHistory.commit();
    events.push([new Date(),runId,"","","","","Completed","",JSON.stringify(stats)]);
    flushLog();
    console.log("Import: "+JSON.stringify(stats));
    return stats;
  } catch (e) {
    if (logReady) {
      events.push([new Date(),runId,"","","","","Error","",String(e.message)]);
      flushLog();
    }
    throw e;
  } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
}
function ensureSheetRowCapacity(sheet,rows) {
  const max = sheet.getMaxRows();
  if (rows>max) sheet.insertRowsAfter(max,rows-max);
}

// MA-04: these columns are appended to Master_Contacts, not a new tab.
const CAMPAIGN_HISTORY_HEADERS = [
"Latest Campaign", "Campaign Status", "Campaign Rating", "Favorite Track",
"Campaign Feedback", "Activity Time", "Campaign History Data"
];

// Pull existing feedback and the new metadata from a processed report row.
function readCampaignResponse(fields, row, sourceId, tabId, tabName, tabUrl) {
const get = (...names) => {
  const keys = names.map(normalizeKey);
  return joinUniqueLines(row.filter((_, i) => keys.includes(fields[i])));
};
const status = get("Campaign Status", "Status");
const rating = get("Rating");
const favoriteTrack = get("Favorite Track", "Favourite Track", "Fave");
const comments = get("Comments");
if (![status, rating, favoriteTrack, comments].some(Boolean)) return null;
const sourceUrl = get("Report Source URL");
const fileId = get("Report Source ID");
const urlId = sourceUrl.match(/\/d\/([A-Za-z0-9_-]+)/);
const reportId = fileId ? "file:" + fileId : urlId ? "file:" + urlId[1] :
  sourceUrl ? "url:" + sourceUrl : "sheet:" + sourceId + ":" + tabId;
return {
  reportId,
  campaign: get("Campaign / Release", "Campaign Name") || tabName,
  reportGeneratedAt: get("Report Generated At"),
  status, rating, favoriteTrack, comments,
  activityTime: get("Activity Time") || (/^listened\b.*\bago\b/i.test(status) ? status : ""),
  sourceUrl: sourceUrl || tabUrl,
  sourceTabUrl: tabUrl,
  extractedAt: get("Report Extracted At")
};
}

// Compare calendar dates only. This never manufactures an activity timestamp.
function campaignReportDay(value) {
const text = trimCellText(value);
let year, month, day;
let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
if (match) [year, month, day] = match.slice(1).map(Number);
else {
  match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:$|\s)/);
  if (match) [day, month, year] = match.slice(1).map(Number);
  else {
    match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})(?:$|\s)/i);
    if (!match) return 0;
    month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
    day = Number(match[2]); year = Number(match[3]);
  }
}
const date = new Date(Date.UTC(year, month - 1, day));
return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
  date.getUTCDate() === day ? year * 10000 + month * 100 + day : 0;
}

function campaignExtractionTime(value) {
return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) ? value : "";
}

function campaignResponseContent(entry) {
return JSON.stringify([entry.campaign, entry.reportGeneratedAt, entry.status,
  entry.rating, entry.favoriteTrack, entry.comments, entry.activityTime]);
}

// One response summary per report inside each already-confirmed contact's history.
function upsertCampaignResponse(history, incoming, now) {
const result = history.map(entry => ({ ...entry }));
const index = result.findIndex(entry => entry.reportId === incoming.reportId);
const previous = index < 0 ? null : result[index];
if (previous) {
  const oldTime = campaignExtractionTime(previous.extractedAt);
  const newTime = campaignExtractionTime(incoming.extractedAt);
  if (oldTime && (!newTime || newTime < oldTime)) return { entries: result, changed: false };
  if (campaignResponseContent(previous) === campaignResponseContent(incoming) && oldTime === newTime)
    return { entries: result, changed: false };
}
const entry = { ...incoming, firstSavedAt: previous ? previous.firstSavedAt : now };
if (index < 0) result.push(entry); else result[index] = entry;
return { entries: result, changed: true };
}

// A readable view of the saved records. Notes are regenerated, not used as storage.
function campaignHistoryPresentation(entries) {
const sorted = [...entries].sort((a, b) =>
  campaignReportDay(b.reportGeneratedAt) - campaignReportDay(a.reportGeneratedAt) ||
  b.firstSavedAt.localeCompare(a.firstSavedAt) || a.reportId.localeCompare(b.reportId));
if (!sorted.length) return { values: ["", "", "", "", "", ""], note: "" };
const latest = sorted[0];
const note = sorted.map(entry => {
  const lines = ["Campaign: " + entry.campaign,
    "Report generated: " + (entry.reportGeneratedAt || "Not provided")];
  if (entry.status) lines.push("Status: " + entry.status);
  if (entry.rating) lines.push("Rating: " + entry.rating);
  if (entry.favoriteTrack) lines.push("Favorite track: " + entry.favoriteTrack);
  if (entry.comments) lines.push("Comments: " + entry.comments);
  lines.push("Activity time: " + (entry.activityTime || "Not provided"));
  lines.push("Source: " + entry.sourceUrl);
  return lines.join("\n");
}).join("\n\n--------------------\n\n");
return {
  values: [latest.campaign, latest.status, latest.rating, latest.favoriteTrack,
    latest.comments, latest.activityTime],
  note: "Dated reports appear newest first; undated reports follow. If all reports are undated, the latest imported is shown.\n\n" + note
};
}

function parseSavedCampaignHistory(raw, contactId) {
if (!trimCellText(raw)) return [];
let entries;
try { entries = JSON.parse(raw); } catch (_) { throw Error("Invalid Campaign History Data for " + contactId); }
const fields = ["reportId", "campaign", "reportGeneratedAt", "status", "rating", "favoriteTrack",
  "comments", "activityTime", "sourceUrl", "sourceTabUrl", "extractedAt", "firstSavedAt"];
const seen = new Set();
if (!Array.isArray(entries)) throw Error("Campaign history must be an array for " + contactId);
entries.forEach(entry => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      !fields.every(field => typeof entry[field] === "string") ||
      !entry.reportId || !campaignExtractionTime(entry.firstSavedAt) || seen.has(entry.reportId))
    throw Error("Invalid or duplicate campaign history entry for " + contactId);
  seen.add(entry.reportId);
});
return entries;
}

// Called under the contact importer's existing lock.
function createCampaignHistoryStore(master) {
let headers = master.getRange(1, 1, 1, master.getLastColumn()).getDisplayValues()[0];
indexRequiredHeaders(headers, MASTER_CONTACT_HEADERS, "Master_Contacts");
for (const header of CAMPAIGN_HISTORY_HEADERS) {
  if (headers.includes(header) && headers.lastIndexOf(header) !== headers.indexOf(header))
    throw Error("Duplicate master header: " + header);
}
const missing = CAMPAIGN_HISTORY_HEADERS.filter(header => !headers.includes(header));
if (missing.length) {
  if (headers.length + missing.length > master.getMaxColumns())
    master.insertColumnsAfter(master.getMaxColumns(), headers.length + missing.length - master.getMaxColumns());
  master.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight("bold");
  headers = headers.concat(missing);
}
const cols = indexRequiredHeaders(headers, ["Contact ID", ...CAMPAIGN_HISTORY_HEADERS], "Master_Contacts");
master.hideColumns(cols["Campaign History Data"] + 1);
const data = master.getDataRange().getDisplayValues();
const saved = new Map();
data.slice(1).forEach(row => {
  const id = trimCellText(row[cols["Contact ID"]]);
  if (id) saved.set(id, parseSavedCampaignHistory(row[cols["Campaign History Data"]], id));
});
const pending = new Map();
const stats = { savedContacts: 0, unchangedContacts: 0, pendingIdentity: 0 };

return {
  stats,
  queue(contactId, entry) {
    if (!entry) return;
    if (!contactId) { stats.pendingIdentity++; return; }
    if (!pending.has(contactId)) pending.set(contactId, new Map());
    const responses = pending.get(contactId);
    const earlier = responses.get(entry.reportId);
    if (earlier) {
      const oldTime = campaignExtractionTime(earlier.extractedAt);
      const newTime = campaignExtractionTime(entry.extractedAt);
      if (campaignResponseContent(earlier) !== campaignResponseContent(entry) && oldTime === newTime)
        throw Error("Conflicting rows for contact " + contactId + " in report " + entry.reportId + ". Review the source rows.");
      if (oldTime && (!newTime || newTime < oldTime)) return;
    }
    responses.set(entry.reportId, entry);
  },
  commit() {
    // Validate every planned write before modifying any saved histories.
    const current = master.getDataRange().getDisplayValues();
    const rowById = new Map();
    current.slice(1).forEach((row, i) => {
      const id = trimCellText(row[cols["Contact ID"]]);
      if (id && rowById.has(id)) throw Error("Duplicate Contact ID: " + id);
      if (id) rowById.set(id, i + 2);
    });
    const now = new Date().toISOString();
    const plans = [];
    for (const [contactId, responses] of pending) {
      if (!rowById.has(contactId)) throw Error("Unknown Contact ID for history: " + contactId);
      let entries = saved.get(contactId) || [];
      for (const response of responses.values()) entries = upsertCampaignResponse(entries, response, now).entries;
      const json = JSON.stringify(entries);
      const view = campaignHistoryPresentation(entries);
      if (json.length > 40000 || view.note.length > 40000)
        throw Error("History for " + contactId + " exceeds this version's 40,000-character safety limit. Existing history was retained.");
      const rowNumber = rowById.get(contactId);
      const row = current[rowNumber - 1];
      const values = [...view.values, json];
      const changed = CAMPAIGN_HISTORY_HEADERS.some((header, i) => trimCellText(row[cols[header]]) !== values[i]) ||
        master.getRange(rowNumber, cols["Latest Campaign"] + 1).getNote() !== view.note;
      if (!changed) { stats.unchangedContacts++; continue; }
      plans.push({ rowNumber, values, note: view.note });
    }
    for (const plan of plans) {
      // Save the complete history before rebuilding its disposable display.
      master.getRange(plan.rowNumber, cols["Campaign History Data"] + 1).setValue(plan.values[6]);
      for (let i = 0; i < 6; i++)
        master.getRange(plan.rowNumber, cols[CAMPAIGN_HISTORY_HEADERS[i]] + 1).setValue(asLiteralCellValue(plan.values[i]));
      master.getRange(plan.rowNumber, cols["Latest Campaign"] + 1).setNote(plan.note);
      stats.savedContacts++;
    }
    return stats;
  }
};
}

  
  
  