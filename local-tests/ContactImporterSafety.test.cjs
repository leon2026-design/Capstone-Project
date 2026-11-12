
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const HEADERS = [
    'Contact ID', 'Name / DJ Alias', 'Role',
    'Station / Venue / Organization', 'City', 'State / Region',
    'Country', 'Email', 'Phone', 'Social Accounts',
    'Sources', 'Review Status', 'Review Notes', 'Last Updated'
];

const REPORT_HEADERS = [
    'Name / DJ Alias', 'Radio Station', 'Email Address',
    'Phone Number', 'Social Media Account',
    'Campaign / Release', 'Rating', 'Comments',
    'Report Source ID', 'Report Source URL', 'Report Extracted At'
];

class Sheet {
    constructor(name, id, rows = []) {
        this.name = name;
        this.id = id;
        this.rows = rows.map(row => [...row]);
        this.maxRows = Math.max(100, rows.length);
        this.maxColumns = 40;
        this.notes = new Map();
        this.writes = 0;
    }

    getName() {
        return this.name;
    }

    getSheetId() {
        return this.id;
    }

    getLastRow() {
        return this.rows.length;
    }

    getLastColumn() {
        return Math.max(0, ...this.rows.map(row => {
            let n = row.length;
            while (n && (row[n - 1] === '' || row[n - 1] == null)) {
                n--;
            }
            return n;
        }));
    }

    getMaxRows() {
        return this.maxRows;
    }

    getMaxColumns() {
        return this.maxColumns;
    }

    insertRowsAfter(_, count) {
        this.maxRows += count;
    }

    insertColumnsAfter(_, count) {
        this.maxColumns += count;
    }

    setFrozenRows() {}

    hideColumns() {}

    getDataRange() {
        return this.getRange(
            1,
            1,
            Math.max(1, this.getLastRow()),
            Math.max(1, this.getLastColumn())
        );
    }

    getRange(r, c, nr = 1, nc = 1) {
        assert.ok(r > 0 && c > 0 && nr > 0 && nc > 0);

        assert.ok(
            r + nr - 1 <= this.maxRows &&
            c + nc - 1 <= this.maxColumns
        );

        const sheet = this;

        return {
            getValues() {
                return Array.from({ length: nr }, (_, i) =>
                    Array.from({ length: nc }, (_, j) =>
                        sheet.rows[r + i - 1]?.[c + j - 1] ?? ''
                    )
                );
            },

            getDisplayValues() {
                return this.getValues().map(row => row.map(value =>
                    Object.prototype.toString.call(value) === '[object Date]'
                        ? value.toISOString()
                        : String(value).replace(/^'(?=[=+\-@])/, '')
                ));
            },

            getFormulas() {
                return this.getValues().map(row => row.map(() => ''));
            },

            getNote() {
                return sheet.notes.get(`${r},${c}`) || '';
            },

            setNote(value) {
                sheet.notes.set(`${r},${c}`, value);
                sheet.writes++;
                return this;
            },

            setValues(values) {
                assert.equal(values.length, nr);

                for (let i = 0; i < nr; i++) {
                    assert.equal(values[i].length, nc);
                    sheet.rows[r + i - 1] ??= [];

                    for (let j = 0; j < nc; j++) {
                        sheet.rows[r + i - 1][c + j - 1] = values[i][j];
                    }
                }

                sheet.writes++;
                return this;
            },

            setValue(value) {
                return this.setValues([[value]]);
            },

            setFontWeight() {
                return this;
            }
        };
    }
}

class Book {
    constructor(id, sheets = []) {
        this.id = id;
        this.sheets = sheets;
    }

    getId() {
        return this.id;
    }

    getUrl() {
        return 'https://docs.google.com/spreadsheets/d/' +
            this.id + '/edit';
    }

    getSheets() {
        return this.sheets;
    }

    getSheetByName(name) {
        return this.sheets.find(sheet => sheet.name === name) || null;
    }

    insertSheet(name) {
        const sheet = new Sheet(
            name,
            this.sheets.length + 100
        );

        this.sheets.push(sheet);
        return sheet;
    }
}

function setup() {
    const master = new Sheet('Master_Contacts', 1, [HEADERS]);

    const books = {
        SOURCE: new Book('SOURCE'),
        DATABASE: new Book('DATABASE', [master])
    };

    const properties = {
        SPREADSHEET_DATA_EXTRACTION: 'SOURCE',
        CONTACT_DATABASE_SPREADSHEET_ID: 'DATABASE'
    };

    let locked = false;
    let counter = 0;

    const context = vm.createContext({
        console: {
            log() {},
            error() {}
        },

        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key => properties[key] || null
            })
        },

        SpreadsheetApp: {
            openById(id) {
                assert.ok(books[id], 'Known spreadsheet: ' + id);
                return books[id];
            },

            flush() {}
        },

        LockService: {
            getScriptLock: () => ({
                waitLock() {
                    assert.equal(
                        locked,
                        false,
                        'Unexpected nested Script Lock'
                    );
                    locked = true;
                },

                releaseLock() {
                    assert.equal(locked, true);
                    locked = false;
                }
            })
        },

        Utilities: {
            DigestAlgorithm: {
                SHA_256: 'sha256'
            },

            Charset: {
                UTF_8: 'utf8'
            },

            getUuid: () => 'LOCAL-' + ++counter,

            computeDigest: (algorithm, value) =>
                crypto.createHash(algorithm).update(value).digest(),

            base64EncodeWebSafe: value =>
                Buffer.from(value).toString('base64url')
        }
    });

    //Load the real project implementations.
    for (const file of [
        'Constants.js',
        'DataExtractor.js',
        'ContactMatcher.js',
        'DJSocialProfileStore.js',
        'ContactImporter.js'
    ]) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, file), 'utf8'),
            context,
            { filename: file }
        );
    }

    function addReport(record, id) {
        const sheet = new Sheet('campaign_' + id, id, [
            REPORT_HEADERS,
            REPORT_HEADERS.map(header => record[header] ?? '')
        ]);

        books.SOURCE.sheets.push(sheet);
        return sheet;
    }

    function importTab(id) {
        return context.importReportContacts([id]);
    }

    function rowObject(sheet, index = 1) {
        const headers = sheet.rows[0];
        const values = sheet.rows[index] || [];

        return Object.fromEntries(
            headers.map((h, i) => [h, values[i] ?? ''])
        );
    }

    function logs() {
        const log = books.DATABASE.getSheetByName('Import_Log');

        return log
            ? log.rows.slice(1).map((_, index) =>
                rowObject(log, index + 1))
            : [];
    }

    return {
        master,
        context,
        addReport,
        importTab,
        contact: () => rowObject(master),
        logs,
        isLocked: () => locked
    };
}

function report(changes = {}) {
    return {
        'Name / DJ Alias': 'DJ Alex',
        'Radio Station': 'WXYZ',
        'Email Address': 'alex@example.test',
        'Phone Number': '(614) 555-1111',
        'Social Media Account': 'https://instagram.com/djalex',
        'Campaign / Release': 'Release A',
        Rating: '5',
        Comments: 'Played on air',
        'Report Source ID': 'REPORT-A',
        'Report Source URL':
            'https://drive.google.com/file/d/REPORT-A/view',
        'Report Extracted At': '2026-11-11T12:00:00.000Z',
        ...changes
    };
}

function initial(t) {
    t.addReport(report(), 101);

    const result = t.importTab(101);

    assert.equal(result.created, 1);
    assert.equal(t.master.getLastRow(), 2);
    assert.equal(t.isLocked(), false);

    return t.contact()['Contact ID'];
}

const nextReport = overrides => report({
    'Campaign / Release': 'Release B',
    'Report Source ID': 'REPORT-B',
    'Report Source URL':
        'https://drive.google.com/file/d/REPORT-B/view',
    ...overrides
});

test(
    'new protected values on a matched contact stay unchanged and are recorded for review',
    () => {
        const t = setup();
        const id = initial(t);
        const original = t.contact();

        t.addReport(nextReport({
            'Radio Station': 'WNEW',
            'Email Address':
                'alex@example.test\nnew@example.test',
            'Phone Number':
                '(614) 555-1111\n(614) 555-2222',
            'Social Media Account':
                'https://instagram.com/newalex'
        }), 102);

        const stats = t.importTab(102);
        const after = t.contact();

        assert.equal(stats.matched, 1);
        assert.equal(t.master.getLastRow(), 2);
        assert.equal(after['Contact ID'], id);

        for (const field of [
            'Email',
            'Phone',
            'Station / Venue / Organization',
            'Social Accounts'
        ]) {
            assert.equal(
                after[field],
                original[field],
                field + ' must not change'
            );

            assert.ok(
                after['Review Notes'].includes(field),
                'Missing review note for ' + field
            );
        }

        assert.equal(after['Review Status'], 'Needs Review');

        assert.match(
            after['Review Notes'],
            /manual review required/
        );

        assert.equal(
            JSON.parse(after['Campaign History Data']).length,
            2
        );

        assert.equal(
            t.logs().filter(row => row.Outcome === 'Matched').length,
            1
        );

        assert.equal(t.isLocked(), false);
    }
);

test(
    'different email with the same name and station is Review identity, not an automatic match',
    () => {
        const t = setup();

        initial(t);
        const old = t.contact();

        t.addReport(nextReport({
            'Email Address': 'someone-else@example.test'
        }), 102);

        const result = t.importTab(102);

        assert.equal(result.matched, 0);
        assert.equal(result.campaignHistory.pendingIdentity, 1);
        assert.equal(t.master.getLastRow(), 2);
        assert.equal(t.contact().Email, old.Email);

        assert.equal(
            JSON.parse(t.contact()['Campaign History Data']).length,
            1
        );

        const review = t.logs().find(
            row => row.Outcome === 'Review identity'
        );

        assert.ok(review);
        assert.equal(review['Contact IDs'], old['Contact ID']);
        assert.equal(t.isLocked(), false);
    }
);

test(
    'same social account without a matching email cannot automatically link contacts',
    () => {
        const t = setup();

        initial(t);

        t.addReport(nextReport({
            'Email Address': ''
        }), 102);

        const result = t.importTab(102);

        assert.equal(result.matched, 0);
        assert.equal(result.campaignHistory.pendingIdentity, 1);

        assert.ok(
            t.logs().some(row =>
                row.Outcome === 'Review identity'
            )
        );
    }
);

test(
    'shared office email cannot automatically link two records',
    () => {
        const t = setup();

        t.addReport(report({
            'Email Address': 'info@wxyz.test'
        }), 101);

        assert.equal(t.importTab(101).created, 1);

        t.addReport(nextReport({
            'Email Address': 'info@wxyz.test'
        }), 102);

        const result = t.importTab(102);

        assert.equal(result.matched, 0);
        assert.equal(result.campaignHistory.pendingIdentity, 1);

        assert.ok(
            t.logs().some(row =>
                row.Outcome === 'Review identity'
            )
        );
    }
);

test(
    'new contact is created with available fields, not blocked by existing-contact rules',
    () => {
        const t = setup();

        t.addReport(report(), 101);

        const result = t.importTab(101);

        assert.equal(result.created, 1);
        assert.equal(t.contact().Email, 'alex@example.test');
        assert.equal(t.contact().Phone, '(614) 555-1111');

        assert.equal(
            t.contact()['Station / Venue / Organization'],
            'WXYZ'
        );

        assert.equal(
            t.contact()['Social Accounts'],
            'https://instagram.com/djalex'
        );

        assert.equal(t.isLocked(), false);
    }
);

test(
    'reimporting an unchanged report does not duplicate contacts or engagement history',
    () => {
        const t = setup();

        initial(t);

        const old = t.contact();
        const result = t.importTab(101);

        assert.equal(result.skipped, 1);
        assert.equal(t.master.getLastRow(), 2);

        assert.equal(
            t.contact()['Campaign History Data'],
            old['Campaign History Data']
        );

        assert.equal(t.isLocked(), false);
    }
);
