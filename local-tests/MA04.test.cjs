// Run from the project root: node --test local-tests/MA04.test.cjs
// Built-in Node modules only. No Google login, Gemini calls, or real Sheet writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

class Sheet {
  constructor(name, id, rows = []) {
    this.name = name; this.id = id; this.rows = rows;
    this.maxRows = Math.max(2, rows.length); this.maxCols = 26;
    this.notes = new Map(); this.hidden = new Set(); this.writes = 0;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getLastRow() {
    let n = this.rows.length;
    while (n && !this.rows[n - 1].some(value => value !== '' && value != null)) n--;
    return n;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map(row => {
      let n = row.length; while (n && (row[n - 1] === '' || row[n - 1] == null)) n--; return n;
    }));
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, count) { this.maxRows += count; }
  insertColumnsAfter(_, count) { this.maxCols += count; }
  setFrozenRows() {}
  hideColumns(column) { this.hidden.add(column); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(r, c, nr = 1, nc = 1) {
    assert.ok(r > 0 && c > 0 && nr > 0 && nc > 0, 'valid range');
    assert.ok(r + nr - 1 <= this.maxRows && c + nc - 1 <= this.maxCols, 'range within allocated grid');
    const s = this;
    return {
      getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => s.rows[r + i - 1]?.[c + j - 1] ?? '')); },
      getDisplayValues() { return this.getValues().map(row => row.map(v =>
        Object.prototype.toString.call(v) === '[object Date]' ? v.toISOString() : String(v).replace(/^'(?==)/, ''))); },
      getValue() { return this.getValues()[0][0]; },
      getNote() { return s.notes.get(`${r},${c}`) || ''; },
      setNote(text) { s.notes.set(`${r},${c}`, text); s.writes++; return this; },
      setValues(values) {
        assert.equal(values.length, nr); values.forEach(row => assert.equal(row.length, nc));
        values.forEach((row, i) => { s.rows[r + i - 1] ??= []; row.forEach((v, j) => s.rows[r + i - 1][c + j - 1] = v); });
        s.writes++; return this;
      },
      setValue(value) { return this.setValues([[value]]); },
      setFontWeight() { return this; }, setWrapStrategy() { return this; },
      getFormulas() { return this.getValues().map(row => row.map(() => '')); }
    };
  }
}
class Book {
  constructor(id, sheets = []) { this.id = id; this.sheets = sheets; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name); }
  insertSheet(name) { const sheet = new Sheet(name, this.sheets.length + 100); this.sheets.push(sheet); return sheet; }
}
const BASE_HEADERS = ['Contact ID', 'Name / DJ Alias', 'Role', 'Station / Venue / Organization', 'City',
  'State / Region', 'Country', 'Email', 'Phone', 'Social Accounts', 'Sources', 'Review Status', 'Review Notes', 'Last Updated'];
const REPORT_HEADERS = ['Name / DJ Alias', 'First Name', 'Last Name', 'Radio Station', 'Email Address',
  'Social Media Account', 'Rating', 'Favorite Track', 'Comments', 'Campaign Status', 'Campaign / Release',
  'Report Generated At', 'Activity Time', 'Report Source ID', 'Report Source URL', 'Report Extracted At'];
const sourceRecord = (changes = {}) => ({
  'Name / DJ Alias': 'Test DJ', 'Email Address': 'dj@example.test', 'Rating': '5',
  'Favorite Track': 'Radio Remix', 'Comments': 'Nice track', 'Campaign / Release': 'Release A',
  'Report Generated At': 'October 29th, 2026 15:07', 'Report Source ID': 'REPORT_A',
  'Report Source URL': 'https://drive.google.com/file/d/REPORT_A/view',
  'Report Extracted At': '2026-11-07T10:00:00.000Z', ...changes
});

function setup() {
  const master = new Sheet('Master_Contacts', 1, [[...BASE_HEADERS]]);
  const books = { SOURCE: new Book('SOURCE'), DATABASE: new Book('DATABASE', [master]) };
  const properties = { SPREADSHEET_DATA_EXTRACTION: 'SOURCE', CONTACT_DATABASE_SPREADSHEET_ID: 'DATABASE',
    CONTACT_REPORT_TAB_IDS: '', GEMINI_API_KEY: 'LOCAL_ONLY' };
  const clock = { now: Date.parse('2026-11-07T12:00:00.000Z') };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  let locked = false;
  const context = {
    console: { log() {}, warn() {}, error() {} }, Date: ClockDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null }) },
    SpreadsheetApp: { openById: id => { assert.ok(books[id], 'known spreadsheet ID'); return books[id]; }, flush() {}, WrapStrategy: { WRAP: 'WRAP' } },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      tryLock() { if (locked) return false; locked = true; return true; }, releaseLock() { locked = false; }
    }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, text, enc) => crypto.createHash(alg).update(text, enc).digest(),
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'), base64Encode: value => Buffer.from(value).toString('base64') },
    trackedFetch() { throw Error('Unexpected external API call in local test'); }
  };
  vm.createContext(context);
  for (const name of ['Constants.js', 'DataExtractor.js', 'ContactMatcher.js', 'Parser.js', 'ContactImporter.js', 'ContactSafeMerge.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, name), 'utf8'), context, { filename: name });
  function addReport(records, headers = REPORT_HEADERS, id = 111) {
    const sheet = new Sheet('campaign_report_' + id, id, [[...headers], ...records.map(record => headers.map(h => record[h] ?? ''))]);
    books.SOURCE.sheets.push(sheet);
    properties.CONTACT_REPORT_TAB_IDS = books.SOURCE.sheets.map(s => s.getSheetId()).join(',');
    return sheet;
  }
  function contact(index = 1) { return Object.fromEntries(master.rows[0].map((h, i) => [h, master.rows[index]?.[i] ?? ''])); }
  function history(index = 1) { return JSON.parse(contact(index)['Campaign History Data'] || '[]'); }
  function note(index = 1) { return master.getRange(index + 1, master.rows[0].indexOf('Latest Campaign') + 1).getNote(); }
  return { context, master, books, properties, clock, addReport, contact, history, note, isLocked: () => locked };
}

test('adds columns to the same master tab and hides only stored JSON', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  assert.equal(t.master.getLastRow(), 2);
  assert.deepEqual(t.master.rows[0].slice(0, 14), BASE_HEADERS);
  assert.equal(t.master.rows[0].length, 21);
  assert.ok(t.master.hidden.has(21));
  assert.deepEqual(t.books.DATABASE.sheets.map(s => s.name), ['Master_Contacts', 'Import_Log']);
});
test('saves full feedback and creates a note without inventing activity/status', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  assert.equal(t.contact()['Campaign Rating'], '5'); assert.equal(t.contact()['Campaign Status'], '');
  assert.equal(t.contact()['Activity Time'], ''); assert.equal(t.history()[0].favoriteTrack, 'Radio Remix');
  assert.match(t.note(), /Comments: Nice track/); assert.match(t.note(), /REPORT_A/);
});
test('second report for a confirmed contact retains both responses and uses newer report date', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  t.clock.now += 1000;
  t.addReport([sourceRecord({ 'Report Source ID': 'REPORT_B', 'Report Source URL': 'https://drive.google.com/file/d/REPORT_B/view',
    'Campaign / Release': 'Release B', 'Report Generated At': 'November 5, 2026', 'Rating': '3' })], REPORT_HEADERS, 112);
  t.context.importReportContacts();
  assert.equal(t.master.getLastRow(), 2); assert.equal(t.history().length, 2);
  assert.equal(t.contact()['Latest Campaign'], 'Release B'); assert.equal(t.contact()['Campaign Rating'], '3');
  assert.ok(t.note().indexOf('Release B') < t.note().indexOf('Release A'));
});
test('identical rerun adds nothing and does not rewrite the master history', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  const writes = t.master.writes, raw = t.contact()['Campaign History Data'];
  const stats = t.context.importReportContacts();
  assert.equal(t.contact()['Campaign History Data'], raw); assert.equal(t.master.writes, writes);
  assert.equal(stats.campaignHistory.savedContacts, 0); assert.equal(stats.campaignHistory.unchangedContacts, 1);
});
test('contact-only imports can be backfilled even though the import log says seen', () => {
  const t = setup(); t.addReport([sourceRecord()]);
  const real = t.context.createCampaignHistoryStore;
  t.context.createCampaignHistoryStore = () => ({ queue() {}, commit() { return {}; } });
  t.context.importReportContacts(); const id = t.contact()['Contact ID'];
  t.context.createCampaignHistoryStore = real; t.context.importReportContacts();
  assert.equal(t.contact()['Contact ID'], id); assert.equal(t.history().length, 1);
});
test('same name and station without an email/social match remains for MA-05 review', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Email Address': '', 'Radio Station': 'Shared Station' })]);
  t.context.importReportContacts();
  t.addReport([sourceRecord({ 'Email Address': '', 'Radio Station': 'Shared Station', 'Report Source ID': 'REPORT_B',
    'Report Source URL': 'https://drive.google.com/file/d/REPORT_B/view' })], REPORT_HEADERS, 112);
  const stats = t.context.importReportContacts();
  assert.equal(t.history().length, 1); assert.equal(t.master.getLastRow(), 2);
  assert.equal(stats.campaignHistory.pendingIdentity, 1);
});
test('stale imported Contact ID is not reassigned by name', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  t.master.rows[1][0] = 'CT-REPLACED';
  assert.equal(t.context.importReportContacts().campaignHistory.pendingIdentity, 1);
});
test('social identities from different platforms do not match each other', () => {
  const t = setup();
  const r = t.context.contactMatchClassify({ 'Name / DJ Alias': 'One', 'Social Accounts': 'https://instagram.com/samehandle' },
    { 'Name / DJ Alias': 'Two', 'Social Accounts': 'https://soundcloud.com/samehandle' });
  assert.equal(r.status, 'NO_MATCH');
});
test('explicit status and raw relative timing are preserved', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Rating': '', 'Favorite Track': '', 'Comments': '',
    'Campaign Status': 'Listened about 17 hours ago' })]); t.context.importReportContacts();
  assert.equal(t.contact()['Campaign Status'], 'Listened about 17 hours ago');
  assert.equal(t.contact()['Activity Time'], 'Listened about 17 hours ago');
});
test('download without feedback has no invented remix, rating or activity time', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Rating': '', 'Favorite Track': '', 'Comments': '',
    'Campaign Status': 'Downloaded No Feedback' })]); t.context.importReportContacts();
  assert.equal(t.contact()['Campaign Status'], 'Downloaded No Feedback');
  for (const h of ['Campaign Rating', 'Favorite Track', 'Activity Time']) assert.equal(t.contact()[h], '');
});
test('future plans remain comments, not download status', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Comments': 'Downloading for my set this weekend' })]); t.context.importReportContacts();
  assert.equal(t.history()[0].status, ''); assert.equal(t.history()[0].activityTime, '');
});
test('same report correction updates the saved entry instead of adding another', () => {
  const t = setup(); const sheet = t.addReport([sourceRecord()]); t.context.importReportContacts();
  sheet.rows[1][REPORT_HEADERS.indexOf('Rating')] = '4';
  sheet.rows[1][REPORT_HEADERS.indexOf('Report Extracted At')] = '2026-11-07T11:00:00.000Z';
  t.context.importReportContacts(); assert.equal(t.history().length, 1); assert.equal(t.history()[0].rating, '4');
});
test('older extraction cannot overwrite newer saved response', () => {
  const t = setup(); const sheet = t.addReport([sourceRecord()]); t.context.importReportContacts();
  sheet.rows[1][REPORT_HEADERS.indexOf('Rating')] = '1';
  sheet.rows[1][REPORT_HEADERS.indexOf('Report Extracted At')] = '2026-11-06T11:00:00.000Z';
  t.context.importReportContacts(); assert.equal(t.history()[0].rating, '5');
});
test('sorting source rows does not duplicate history', () => {
  const t = setup(); const sheet = t.addReport([sourceRecord(), sourceRecord({ 'Name / DJ Alias': 'Other DJ', 'Email Address': 'other@example.test' })]);
  t.context.importReportContacts(); sheet.rows = [sheet.rows[0], ...sheet.rows.slice(1).reverse()];
  t.context.importReportContacts(); assert.equal(t.history(1).length, 1); assert.equal(t.history(2).length, 1);
});
test('copy of same source file in another tab does not add another response', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  t.addReport([sourceRecord()], REPORT_HEADERS, 112); t.context.importReportContacts(); assert.equal(t.history().length, 1);
});
test('legacy tabs with no provenance/date still backfill and remain idempotent', () => {
  const t = setup(); t.addReport([{ 'Name': 'Legacy DJ', 'Email Address': 'legacy@example.test', 'Rating': '0', 'Fave': 'Old Mix', 'Comments': 'No thanks' }],
    ['Name', 'Email Address', 'Rating', 'Fave', 'Comments']);
  t.context.importReportContacts(); t.context.importReportContacts();
  assert.equal(t.history().length, 1); assert.equal(t.history()[0].reportId, 'sheet:SOURCE:111');
  assert.equal(t.history()[0].favoriteTrack, 'Old Mix'); assert.equal(t.contact()['Campaign Rating'], '0');
});
test('dated old backfill cannot replace a newer campaign summary', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  t.clock.now += 10000; t.addReport([sourceRecord({ 'Report Source ID': 'OLD', 'Report Source URL': 'https://drive.google.com/file/d/OLD/view',
    'Campaign / Release': 'Older Release', 'Report Generated At': '2026-09-01', 'Rating': '1' })], REPORT_HEADERS, 112);
  t.context.importReportContacts(); assert.equal(t.history().length, 2); assert.equal(t.contact()['Latest Campaign'], 'Release A');
});
test('calendar validation rejects invalid dates instead of normalizing them', () => {
  const t = setup(); assert.equal(t.context.campaignReportDay('2026-02-30'), 0);
  assert.equal(t.context.campaignReportDay('October 29th, 2026 15:07'), 20261029);
});
test('contact-only row has no invented campaign response', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Rating': '', 'Favorite Track': '', 'Comments': '' })]); t.context.importReportContacts();
  assert.equal(t.contact()['Campaign History Data'], '');
});
test('formula-like comment is literal in cells and preserved in the note', () => {
  const t = setup(); t.addReport([sourceRecord({ 'Comments': '=HYPERLINK("test")' })]); t.context.importReportContacts();
  assert.equal(t.contact()['Campaign Feedback'], '\'=HYPERLINK("test")'); assert.match(t.note(), /Comments: =HYPERLINK/);
});
test('invalid saved history stops instead of silently discarding it', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  const col = t.master.rows[0].indexOf('Campaign History Data'); t.master.rows[1][col] = '{broken';
  assert.throws(() => t.context.importReportContacts(), /Invalid Campaign History Data/);
  assert.equal(t.master.rows[1][col], '{broken'); assert.equal(t.isLocked(), false);
});
test('conflicting rows in the same extraction require source review', () => {
  const t = setup(); t.addReport([sourceRecord(), sourceRecord({ 'Rating': '2' })]);
  assert.throws(() => t.context.importReportContacts(), /Conflicting rows/); assert.equal(t.history().length, 0);
});
test('history display can be rebuilt without duplicating records', () => {
  const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
  const col = t.master.rows[0].indexOf('Latest Campaign') + 1; t.master.getRange(2, col).setNote('deleted history display');
  t.context.importReportContacts(); assert.match(t.note(), /Comments: Nice track/); assert.equal(t.history().length, 1);
});
test('capacity limit retains old saved history', () => {
  const t = setup(); const sheet = t.addReport([sourceRecord()]); t.context.importReportContacts();
  const previous = t.contact()['Campaign History Data'];
  sheet.rows[1][REPORT_HEADERS.indexOf('Comments')] = 'x'.repeat(41000);
  sheet.rows[1][REPORT_HEADERS.indexOf('Report Extracted At')] = '2026-11-07T11:00:00.000Z';
  assert.throws(() => t.context.importReportContacts(), /40,000-character/); assert.equal(t.contact()['Campaign History Data'], previous);
});

function mockPdf(t, records, fileId = 'PDF1', name = 'campaign_report_pdf.pdf', finishReason = 'STOP') {
  let moved = false;
  t.context.geminiParsePDFUndefined = () => ({ getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(records) }] } }] }) });
  const file = { getName: () => name, getId: () => fileId, getUrl: () => 'https://drive.google.com/file/d/' + fileId + '/view',
    moveTo: () => { moved = true; } };
  return { file, moved: () => moved };
}
test('parser keeps columns appearing only in later recipients and owns provenance', () => {
  const t = setup(); const pdf = mockPdf(t, [{ Name: 'First', Rating: 4 },
    { Name: 'Second', Country: 'Australia', Email: 'second@example.test', Fave: 'Radio Mix', 'Report Source ID': 'FAKE' }]);
  t.context.parseUndefinedFile(pdf.file, {}, {});
  const sheet = t.books.SOURCE.sheets[0], headers = sheet.rows[0];
  assert.ok(headers.includes('Country')); assert.ok(headers.includes('Email Address'));
  assert.equal(sheet.rows[2][headers.indexOf('Report Source ID')], 'PDF1');
  assert.equal(sheet.rows[2][headers.indexOf('Favorite Track')], 'Radio Mix'); assert.equal(pdf.moved(), true);
});
test('parser aligns append columns with the existing header order', () => {
  const t = setup(); const sheet = new Sheet('campaign_report_pdf', 115, [['Comments', 'Name'], ['old', 'Old DJ']]);
  t.books.SOURCE.sheets.push(sheet);
  const pdf = mockPdf(t, [{ Name: 'New DJ', Rating: 3, Comments: 'new' }]); t.context.parseUndefinedFile(pdf.file, {}, {});
  assert.equal(sheet.rows[1][0], 'old'); assert.equal(sheet.rows[2][0], 'new'); assert.equal(sheet.rows[2][1], 'New DJ');
});
test('empty/truncated/malformed Gemini results do not move the input PDF', () => {
  for (const [records, finish] of [[[], 'STOP'], [[{ Name: 'DJ' }], 'MAX_TOKENS'], [[{ Name: { nested: true } }], 'STOP']]) {
    const t = setup(); const pdf = mockPdf(t, records, 'PDF1', 'campaign_report_pdf.pdf', finish);
    assert.throws(() => t.context.parseUndefinedFile(pdf.file, {}, {})); assert.equal(pdf.moved(), false);
  }
});
test('HTTP failure does not create an output sheet or move a PDF', () => {
  const t = setup(); const pdf = mockPdf(t, [{ Name: 'DJ' }]);
  t.context.geminiParsePDFUndefined = () => ({ getResponseCode: () => 429 });
  assert.throws(() => t.context.parseUndefinedFile(pdf.file, {}, {}), /PDF extraction failed/);
  assert.equal(t.books.SOURCE.sheets.length, 0); assert.equal(pdf.moved(), false);
});
test('parser-to-contact-to-note integration uses the actual uploaded matcher', () => {
  const t = setup(); const pdf = mockPdf(t, [sourceRecord()]);
  t.context.parseUndefinedFile(pdf.file, {}, {}); t.properties.CONTACT_REPORT_TAB_IDS = String(t.books.SOURCE.sheets[0].id);
  t.context.importReportContacts(); assert.equal(t.history().length, 1); assert.match(t.note(), /Release A/);
  t.clock.now += 1000;
  const rerun = mockPdf(t, [sourceRecord({ Rating: '4' })]); t.context.parseUndefinedFile(rerun.file, {}, {});
  t.context.importReportContacts(); assert.equal(t.history().length, 1); assert.equal(t.history()[0].rating, '4');
});
test('merge/undo guard allows old profiles but blocks profiles with campaign history', () => {
  const t = setup(); t.context.contactSafeMergeCheckCampaignHistory(t.books.DATABASE, ['CT-NONE']);
  t.addReport([sourceRecord()]); t.context.importReportContacts();
  assert.throws(() => t.context.contactSafeMergeCheckCampaignHistory(t.books.DATABASE, [t.contact()['Contact ID']]), /MA-05 must support/);
  assert.doesNotThrow(() => t.context.contactSafeMergeCheckCampaignHistory(t.books.DATABASE, ['CT-OTHER']));
});
test('both public merge and undo entry points invoke the history guard', () => {
  for (const undo of [false, true]) {
    const t = setup(); t.addReport([sourceRecord()]); t.context.importReportContacts();
    t.context.contactMergeHistoryReadBackup = () => ({ status: undo ? 'MERGED' : 'BACKUP_SAVED', backupVerified: true,
      primaryContactId: t.contact()['Contact ID'], duplicateContactId: 'CT-OTHER' });
    const fn = undo ? t.context.contactSafeMergeUndo : t.context.contactSafeMergeApplyApproved;
    assert.throws(() => fn(t.books.DATABASE, 'MERGE1'), /MA-05 must support/); assert.equal(t.isLocked(), false);
  }
});
