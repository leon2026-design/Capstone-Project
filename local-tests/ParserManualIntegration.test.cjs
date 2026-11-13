
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const PROVENANCE = [
    'Report Source ID',
    'Report Source URL',
    'Report Extracted At'
];

class MockSheet {
    constructor(name, id, headers, dataRows = [['DJ Alex', 'PDF-1', 'https://example.test', '2026-11-11']]) {
        this.name = name;
        this.id = id;
        this.rows = [headers, ...dataRows].map(row => [...row]);
    }

    getName() { return this.name; }
    getSheetId() { return this.id; }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows[0].length; }
    setFrozenRows() {}
    hideColumns() {}

    getRange(row, column, height = 1, width = 1) {
        const sheet = this;

        return {
            getDisplayValues() {
                return Array.from({ length: height }, (_, i) =>
                    Array.from({ length: width }, (_, j) =>
                        String(sheet.rows[row + i - 1]?.[column + j - 1] ?? '')
                    )
                );
            },

            setValues(values) {
                assert.equal(values.length, height);

                values.forEach((valuesRow, i) => {
                    assert.equal(valuesRow.length, width);

                    valuesRow.forEach((value, j) => {
                        sheet.rows[row + i - 1][column + j - 1] = value;
                    });
                });

                return this;
            },

            setFontWeight() { return this; }
        };
    }

    getDataRange() {
        return { setWrapStrategy() {} };
    }

    moveColumns() {
        throw new Error('Unexpected column movement in the test fixture');
    }
}

function fixture(options = {}) {
    const events = [];
    const errors = [];
    const importedIds = [];
    const importResult = { imported: 2, reviews: 1 };
    const validHeaders = ['Name / DJ Alias', ...PROVENANCE];

    const sheets = options.sheets || [
        new MockSheet('report-one', 101, validHeaders)
    ];

    const spreadsheet = { getSheets: () => sheets };

    const context = vm.createContext({
        console: {
            log() {},
            error(message) {
                errors.push(String(message));
            }
        },

        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key =>
                    key === 'SPREADSHEET_DATA_EXTRACTION' ? 'SOURCE' : ''
            })
        },

        SPREADSHEET_DATA_EXTRACTION: 'SOURCE',

        SpreadsheetApp: {
            WrapStrategy: { WRAP: 'WRAP' },

            openById(id) {
                assert.equal(id, 'SOURCE');
                events.push('open');
                return spreadsheet;
            },

            flush() {
                events.push('flush');
            }
        },

        normalizeKey(value) {
            return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
        },

        buildHeaderAliasLookup() {
            return new Map();
        },

        asLiteralCellValue(value) {
            return value;
        }
    });

    for (const file of ['Constants.js', 'Parser.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, file), 'utf8'),
            context,
            { filename: file }
        );
    }

    //Run the actual manual entry point from Parser.js.
    //Mock only external importer and MA-05 sync boundaries.
    context.importReportContacts = ids => {
        events.push('MA04');
        importedIds.push(...ids);

        if (options.importError) {
            throw new Error('MA-04 import failed');
        }

        return importResult;
    };

    context.importIntegrationSync = () => {
        events.push('MA05');

        if (options.syncError) {
            throw new Error('MA-05 sync failed');
        }

        return { observations: 1 };
    };

    return {
        run: () => context.importProcessedReportContacts(),
        events,
        errors,
        importedIds,
        importResult,
        sheets
    };
}

test('manual entry imports eligible reports before starting MA-05 and preserves MA-04 return value', () => {
    const t = fixture();

    assert.strictEqual(t.run(), t.importResult);
    assert.deepEqual(t.importedIds, [101]);
    assert.deepEqual(t.events, [
        'open', 'flush', 'MA04', 'flush', 'MA05'
    ]);
    assert.deepEqual(t.errors, []);
});

test('manual entry skips irrelevant sheets and selects every eligible report tab', () => {
    const headers = ['Name / DJ Alias', ...PROVENANCE];

    const t = fixture({
        sheets: [
            new MockSheet('report-one', 101, headers),
            new MockSheet('notes', 102, [
                'Name / DJ Alias', 'Report Source ID'
            ]),
            new MockSheet('report-two', 103, headers),
            new MockSheet('empty', 104, headers, [])
        ]
    });

    assert.strictEqual(t.run(), t.importResult);
    assert.deepEqual(t.importedIds, [101, 103]);
    assert.equal(
        t.events.filter(event => event === 'MA05').length,
        1
    );
});

test('manual entry does not run MA-05 when MA-04 import throws', () => {
    const t = fixture({ importError: true });

    assert.throws(
        () => t.run(),
        /MA-04 import failed/
    );

    assert.deepEqual(t.events, [
        'open', 'flush', 'MA04'
    ]);
    assert.deepEqual(t.errors, []);
});

test('MA-05 sync failure is logged and original successful MA-04 result is returned', () => {
    const t = fixture({ syncError: true });

    assert.strictEqual(t.run(), t.importResult);

    assert.deepEqual(t.events, [
        'open', 'flush', 'MA04', 'flush', 'MA05'
    ]);

    assert.equal(t.errors.length, 1);
    assert.match(
        t.errors[0],
        /MA-05 review sync failed: Error: MA-05 sync failed/
    );
});

test('manual entry stops before importing if no eligible source report exists', () => {
    const t = fixture({
        sheets: [
            new MockSheet('notes', 102, [
                'Name / DJ Alias', 'Report Source ID'
            ])
        ]
    });

    assert.throws(
        () => t.run(),
        /No processed PDF report tabs/
    );

    assert.deepEqual(t.events, ['open']);
});

test('malformed duplicate headers stop the manual import before MA-04 and MA-05', () => {
    const t = fixture({
        sheets: [
            new MockSheet('duplicate-columns', 201, [
                'Name / DJ Alias',
                'Name / DJ Alias',
                ...PROVENANCE
            ])
        ]
    });

    assert.throws(
        () => t.run(),
        /Blank or duplicate report headers/
    );

    assert.deepEqual(t.events, ['open']);
});
