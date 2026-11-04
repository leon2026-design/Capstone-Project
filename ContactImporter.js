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
      // Use MA-02 to compare this master contact with the incoming report row.
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
        throw new Error("Unexpected MA-02 match status: " + result.status);
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
  function importReportContacts() {
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
      const raw = trimCellText(props.getProperty("CONTACT_REPORT_TAB_IDS"));
      if (!dbId || !SPREADSHEET_DATA_EXTRACTION || dbId === SPREADSHEET_DATA_EXTRACTION)
        throw Error("Set distinct extraction and contact spreadsheet IDs.");
      if (!/^\d+(\s*,\s*\d+)*$/.test(raw))
        throw Error("CONTACT_REPORT_TAB_IDS must contain campaign tab gid numbers separated by commas.");
      const src = SpreadsheetApp.openById(SPREADSHEET_DATA_EXTRACTION);
      const db = SpreadsheetApp.openById(dbId);
      const master = db.getSheetByName("Master_Contacts");
      if (!master) throw Error("Create the Master_Contacts tab and paste its headers in A1.");
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
      const seen = new Set(log && log.getLastRow()>1
        ? log.getRange(2,6,log.getLastRow()-1,1).getDisplayValues().flat().filter(Boolean) : []);
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
          if (seen.has(key)) { stats.skipped++; continue; }
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
            if (existing) stats.matched++; else {stats.created++; contacts.push(person);}
            related=person["Contact ID"];
            outcome=existing ? "Matched" : "Created";
          }
          seen.add(key);
          events.push([new Date(),runId,tab.getName(),tabUrl,i+1,key,outcome,related,detail]);
          if (events.length>=25) flushLog();
        }
        flushLog();
      }
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
  
  
  