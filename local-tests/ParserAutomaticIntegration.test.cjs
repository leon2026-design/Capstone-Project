
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function fixture(options = {}) {
    const events = [];
    const errors = [];
    const sheet = { getSheetId: () => 111, getLastRow: () => 0 };
    const targetFolder = { name: 'processed' };
    const properties = new Map();
    const file = {
        getName: () => 'report.pdf',
        getId: () => 'PDF-1',
        getUrl: () => 'https://drive.google.com/file/d/PDF-1/view',
        moveTo(destination) {
            assert.equal(destination, targetFolder);
            events.push('move');
        }
    };
    const sourceBook = {
        getSheetByName: () => sheet,
        insertSheet() {
            throw Error('Unexpected sheet creation');
        }
    };
    const context = vm.createContext({
        console: {
            log() {},
            error(message) { errors.push(String(message)); }
        },
        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => properties.get(key) || null,
                setProperty: (key, value) => properties.set(key, value),
                getKeys: () => [...properties.keys()]
            })
        },
        SPREADSHEET_DATA_EXTRACTION: 'SOURCE',
        GEMINI_URL: 'https://example.test/generateContent',
        LockService: {
            getScriptLock: () => ({
                waitLock() {},
                releaseLock() {}
            })
        },
        SpreadsheetApp: {
            openById(id) {
                assert.equal(id, 'SOURCE');
                events.push('open');
                return sourceBook;
            },
            flush() { events.push('flush'); }
        },
        normalizeKey(value) {
            return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
        },
        buildHeaderAliasLookup() { return new Map(); }
    });

    vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'Parser.js'), 'utf8'),
        context,
        { filename: 'Parser.js' }
    );

    //Only external PDF, Sheets writes and imported-module boundaries are mocked.
    //parseUndefinedFile itself runs from the actual Parser.js file.
    context.geminiParsePDFUndefined = () => {
        events.push('gemini');
        const rows = options.rows === undefined
            ? [{ Name: 'DJ Alex', Rating: '5' }]
            : options.rows;
        return {
            getResponseCode: () => options.httpStatus || 200,
            getContentText: () => JSON.stringify({
                candidates: [{
                    finishReason: options.finishReason || 'STOP',
                    content: { parts: [{ text: JSON.stringify(rows) }] }
                }]
            })
        };
    };
    context.appendCampaignReportRows = () => { events.push('append'); };
    context.formatCampaignReportSheet = () => { events.push('format'); };
    context.importReportContactsUnlocked_ = ids => {
        assert.equal(ids.length, 1);
        assert.equal(ids[0], 111);
        events.push('MA04');
        if (options.importError) throw Error('MA-04 import failed');
        return { imported: 1 };
    };
    context.importIntegrationSync = () => {
        events.push('MA05');
        if (options.syncError) throw Error('MA-05 sync failed');
        return { observations: 1 };
    };
    context.marketingRememberContent_ = () => {};

    return {
        context,
        events,
        errors,
        run: () => context.parseUndefinedFile(file, {}, targetFolder)
    };
}

test('PDF runs MA-04 before MA-05, then returns the source sheet ID', () => {
    const t = fixture();
    assert.equal(t.run(), 111);
    assert.deepEqual(t.events, [
        'gemini', 'open', 'append', 'format', 'flush',
        'MA04', 'flush', 'move', 'MA05'
    ]);
    assert.deepEqual(t.errors, []);
});

test('MA-04 failure prevents both PDF move and MA-05 sync', () => {
    const t = fixture({ importError: true });
    assert.throws(() => t.run(), /MA-04 import failed/);
    assert.equal(t.events.includes('move'), false);
    assert.equal(t.events.includes('MA05'), false);
});

test('MA-05 failure is logged after moving the successfully imported PDF', () => {
    const t = fixture({ syncError: true });
    assert.equal(t.run(), 111);
    assert.ok(t.events.indexOf('move') < t.events.indexOf('MA05'));
    assert.equal(t.errors.length, 1);
    assert.match(t.errors[0], /MA-05 review sync failed: Error: MA-05 sync failed/);
});

test('Gemini HTTP failure prevents sheet writes, MA-04, MA-05 and PDF move', () => {
    const t = fixture({ httpStatus: 429 });
    assert.throws(() => t.run(), /PDF extraction failed/);
    assert.deepEqual(t.events, ['gemini']);
});

test('truncated Gemini output is rejected before importing or moving the PDF', () => {
    const t = fixture({ finishReason: 'MAX_TOKENS' });
    assert.throws(() => t.run(), /Incomplete PDF extraction/);
    assert.deepEqual(t.events, ['gemini']);
});

test('empty PDF extraction is rejected before importing or moving the PDF', () => {
    const t = fixture({ rows: [] });
    assert.throws(() => t.run(), /No report rows returned/);
    assert.deepEqual(t.events, ['gemini']);
});
