const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..', '..');

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
  appendRow(row) {
    this.maxRows = Math.max(this.maxRows, this.getLastRow() + 1);
    this.getRange(this.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  }
  moveColumns(range, destination) {
    const source = range.column - 1;
    this.rows.forEach(row => row.splice(destination - 1, 0, row.splice(source, 1)[0] ?? ''));
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(r, c, nr = 1, nc = 1) {
    assert.ok(r > 0 && c > 0 && nr > 0 && nc > 0, 'valid range');
    assert.ok(r + nr - 1 <= this.maxRows && c + nc - 1 <= this.maxCols, 'range within allocated grid');
    const s = this;
    return {
      column: c,
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
      clearContent() { return this.setValues(Array.from({length: nr}, () => Array(nc).fill(''))); },
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

function setup(extraFiles = []) {
  const master = new Sheet('Master_Contacts', 1, [[...BASE_HEADERS]]);
  const books = { SOURCE: new Book('SOURCE'), DATABASE: new Book('DATABASE', [master]) };
  const properties = { SPREADSHEET_DATA_EXTRACTION: 'SOURCE', CONTACT_DATABASE_SPREADSHEET_ID: 'DATABASE',
    CONTACT_REPORT_TAB_IDS: '', GEMINI_API_KEY: 'LOCAL_ONLY', PARSER_INPUT_FOLDER: 'INPUT', PARSER_OUTPUT_FOLDER: 'OUTPUT' };
  const clock = { now: Date.parse('2026-11-07T12:00:00.000Z') };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  let locked = false;
  const context = {
    console: { log() {}, warn() {}, error() {} }, Date: ClockDate,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties[key] ?? null,
      setProperty: (key, value) => { properties[key] = value; },
      deleteProperty: key => { delete properties[key]; },
      getKeys: () => Object.keys(properties)
    }) },
    SpreadsheetApp: {
      openById: id => { assert.ok(books[id], 'known spreadsheet ID'); return books[id]; },
      openByUrl: url => { const id = url.match(/\/d\/([^/]+)/)[1]; assert.ok(books[id]); return books[id]; },
      flush() {}, WrapStrategy: { WRAP: 'WRAP' }
    },
    MimeType: {CSV: 'text/csv'},
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      tryLock() { if (locked) return false; locked = true; return true; }, releaseLock() { locked = false; }
    }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, text, enc) => crypto.createHash(alg).update(text, enc).digest(),
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'), base64Encode: value => Buffer.from(value).toString('base64'),
      base64Decode: value => [...Buffer.from(value, 'base64')],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }), sleep() {} },
    trackedFetch() { throw Error('Unexpected external API call in local test'); }
  };
  vm.createContext(context);
  for (const name of new Set(['Constants.js', 'DataExtractor.js', 'ContactMatcher.js', 'Parser.js', 'MarketingExtractionProvider.js', 'ContactImporter.js',
    'ContactSafeMerge.js', 'DJSocialProfileStore.js', ...extraFiles]))
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

function mockPdf(t, records, fileId = 'PDF1', name = 'campaign_report_pdf.pdf', finishReason = 'STOP') {
  let moved = false;
  t.context.geminiParsePDFUndefined = () => ({ getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(records) }] } }] }) });
  const file = { getName: () => name, getId: () => fileId, getUrl: () => 'https://drive.google.com/file/d/' + fileId + '/view',
    moveTo: () => { moved = true; } };
  return { file, moved: () => moved };
}

module.exports = {Sheet, Book, BASE_HEADERS, REPORT_HEADERS, sourceRecord, setup, mockPdf};
