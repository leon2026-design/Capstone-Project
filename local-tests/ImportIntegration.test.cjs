
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

//Only Google Sheets and Apps Script services are mocked.
//The matching and identity modules come from actual project files.
class Sheet {
    constructor(name, rows = []) {
        this.name = name;
        this.rows = rows.map(row => [...row]);
        this.maxRows = 100;
        this.maxCols = 40;
        this.writes = 0;
    }

    getName() {
        return this.name;
    }

    getLastRow() {
        let count = this.rows.length;

        while (
            count &&
            !this.rows[count - 1].some(
                value => value !== '' && value != null
            )
        ) {
            count--;
        }

        return count;
    }

    getLastColumn() {
        return Math.max(0, ...this.rows.map(row => {
            let count = row.length;

            while (
                count &&
                (row[count - 1] === '' || row[count - 1] == null)
            ) {
                count--;
            }

            return count;
        }));
    }

    getMaxRows() {
        return this.maxRows;
    }

    insertRowsAfter(_, count) {
        this.maxRows += count;
    }

    setFrozenRows() {}

    appendRow(row) {
        this.rows.push([...row]);
        this.writes++;
    }

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
            c + nc - 1 <= this.maxCols
        );

        const sheet = this;

        return {
            getValues() {
                return Array.from(
                    { length: nr },
                    (_, i) => Array.from(
                        { length: nc },
                        (_, j) =>
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

            setValues(values) {
                assert.equal(values.length, nr);
                values.forEach(row => assert.equal(row.length, nc));

                values.forEach((row, i) => {
                    sheet.rows[r + i - 1] ??= [];

                    row.forEach((value, j) => {
                        sheet.rows[r + i - 1][c + j - 1] = value;
                    });
                });

                sheet.writes++;
                return this;
            },

            setValue(value) {
                return this.setValues([[value]]);
            }
        };
    }
}

const MASTER_HEADERS = [
    'Contact ID',
    'Name / DJ Alias',
    'Role',
    'Station / Venue / Organization',
    'City',
    'State / Region',
    'Country',
    'Email',
    'Phone',
    'Social Accounts',
    'Sources',
    'Review Status',
    'Review Notes',
    'Last Updated'
];

const LOG_HEADERS = [
    'Timestamp',
    'Run ID',
    'Source Tab',
    'Source URL',
    'Source Row',
    'Observation Key',
    'Outcome',
    'Contact IDs',
    'Details'
];

const SOCIAL_HEADERS = [
    'Profile ID',
    'Observation ID',
    'Platform',
    'Profile URL',
    'Evidence Source',
    'Source Report ID',
    'Source Page',
    'Source Section',
    'Source URL',
    'Contact ID',
    'Verification Status',
    'Reviewer',
    'Review Date',
    'Notes'
];

const candidate = (changes = {}) => ({
    'Name / DJ Alias': 'DJ Alex',
    'Station / Venue / Organization': 'WXYZ',
    Email: 'other@example.test',
    Phone: '',
    'Social Accounts': 'https://instagram.com/djalex',
    City: '',
    'State / Region': '',
    Country: '',
    ...changes
});

const contact = (changes = {}) => ({
    'Contact ID': 'CT-001',
    'Name / DJ Alias': 'DJ Alex',
    'Station / Venue / Organization': 'WXYZ',
    Email: 'alex@example.test',
    ...changes
});

function setup(options = {}) {
    const makeSheet = (name, headers, records) =>
        new Sheet(
            name,
            [
                headers,
                ...records.map(record =>
                    headers.map(h => record[h] ?? '')
                )
            ]
        );

    const imports = options.imports === undefined
        ? [{
            key: 'OBS-1',
            details: candidate(),
            contactIds: 'CT-001'
        }]
        : options.imports;

    const logRows = imports.map(item => ({
        Timestamp: '2026-11-11T12:00:00Z',
        'Run ID': 'RUN-1',
        'Source Tab': 'campaign_report',
        'Source URL':
            'https://docs.google.com/spreadsheets/d/SRC/edit#gid=101',
        'Source Row': '2',
        'Observation Key': item.key,
        Outcome: item.outcome || 'Review identity',
        'Contact IDs': item.contactIds ?? '',
        Details: item.rawDetails ??
            JSON.stringify({
                candidate: item.details,
                rawInfo: '',
                pdf: ''
            })
    }));

    const sheets = new Map([
        [
            'Master_Contacts',
            makeSheet(
                'Master_Contacts',
                MASTER_HEADERS,
                options.contacts || [contact()]
            )
        ],
        [
            'Import_Log',
            makeSheet('Import_Log', LOG_HEADERS, logRows)
        ]
    ]);

    if (options.socialRecords) {
        sheets.set(
            'DJ_Social_Profiles',
            makeSheet(
                'DJ_Social_Profiles',
                SOCIAL_HEADERS,
                options.socialRecords
            )
        );
    }

    const database = {
        getSheetByName(name) {
            return sheets.get(name) || null;
        },

        insertSheet(name) {
            assert.equal(sheets.has(name), false);

            const sheet = new Sheet(name);
            sheets.set(name, sheet);

            return sheet;
        }
    };

    const source = {
        getId: () => 'SRC'
    };

    const links = new Set();
    const linkCalls = [];

    let locked = false;
    let serial = 0;

    const context = vm.createContext({
        console,

        Utilities: {
            getUuid: () => String(++serial).padStart(4, '0')
        },

        LockService: {
            getScriptLock: () => ({
                waitLock() {
                    assert.equal(
                        locked,
                        false,
                        'nested Script Lock'
                    );

                    locked = true;
                },

                releaseLock() {
                    assert.equal(locked, true);
                    locked = false;
                }
            })
        },

        SpreadsheetApp: {
            flush() {},

            openById(id) {
                if (id === 'DB') return database;
                if (id === 'SRC') return source;

                throw new Error('Unknown spreadsheet: ' + id);
            }
        },

        PropertiesService: {
            getScriptProperties: () => ({
                getProperty: key =>
                    key === 'CONTACT_DATABASE_SPREADSHEET_ID'
                        ? 'DB'
                        : ''
            })
        },

        SPREADSHEET_DATA_EXTRACTION: 'SRC'
    });

    //Load actual project source files.
    for (const filename of [
        'ContactMatcher.js',
        'ContactImporter.js',
        'DJIdentityResolver.js',
        'DJIdentityReview.js',
        'DJSocialProfileStore.js',
        'DJFollowUpQueue.js',
        'DJEngagementLinker.js',
        'ImportIntegration.js'
    ]) {
        vm.runInContext(
            fs.readFileSync(
                path.join(ROOT, filename),
                'utf8'
            ),
            context,
            { filename }
        );
    }

    //The approved engagement writer is tested separately.
    //This mock verifies the integration approval boundary.
    context.djEngagementLinkApproved = (
        book,
        extraction,
        observationId
    ) => {
        assert.equal(book, database);
        assert.equal(extraction, source);

        linkCalls.push(observationId);

        if (links.has(observationId)) {
            return { status: 'ALREADY_LINKED' };
        }

        links.add(observationId);

        return { status: 'LINKED' };
    };

    const sheet = name => sheets.get(name);

    const records = name => {
        const rows = sheet(name)?.rows || [];

        if (!rows.length) return [];

        return rows.slice(1).map(row =>
            Object.fromEntries(
                rows[0].map((h, i) => [
                    h,
                    row[i] ?? ''
                ])
            )
        );
    };

    return {
        context,
        database,
        source,
        sheet,
        records,
        linkCalls,
        isLocked: () => locked
    };
}

test(
    'MA-04 pending import reaches actual MA-05 identity, social and follow-up sheets',
    () => {
        const t = setup();

        const original = JSON.stringify(
            t.sheet('Master_Contacts').rows
        );

        const result = t.context.importIntegrationSyncReviews(
            t.database
        );

        assert.equal(result.observations, 1);
        assert.equal(result.queued, 1);
        assert.equal(result.socialProfiles, 1);
        assert.equal(result.followUps.created, 2);

        assert.equal(
            t.records('DJ_Identity_Review')[0]['Observation ID'],
            'OBS-1'
        );

        assert.equal(
            t.records('DJ_Identity_Review')[0]['Source Report ID'],
            'campaign_report'
        );

        assert.equal(
            t.records('DJ_Identity_Review')[0]['Source URL'],
            'https://docs.google.com/spreadsheets/d/SRC/edit#gid=101'
        );

        assert.equal(
            t.records('DJ_Identity_Review')[0]['Review Status'],
            'PENDING'
        );

        assert.equal(
            t.records('DJ_Social_Profiles')[0]['Verification Status'],
            'PENDING_REVIEW'
        );

        assert.deepEqual(
            t.records('DJ_FollowUp_Queue')
                .map(row => row['Follow-Up Type'])
                .sort(),
            ['IDENTITY', 'SOCIAL_PROFILE']
        );

        assert.equal(
            JSON.stringify(t.sheet('Master_Contacts').rows),
            original
        );

        assert.equal(t.isLocked(), false);
    }
);

test(
    're-running the same import does not create duplicate review or profile rows',
    () => {
        const t = setup();

        t.context.importIntegrationSyncReviews(t.database);

        const again = t.context.importIntegrationSyncReviews(
            t.database
        );

        assert.equal(again.followUps.created, 0);
        assert.equal(t.records('DJ_Identity_Review').length, 1);
        assert.equal(t.records('DJ_Social_Profiles').length, 1);
        assert.equal(t.records('DJ_FollowUp_Queue').length, 2);
        assert.equal(t.isLocked(), false);
    }
);

test(
    'a changed email with the same name and station requires review',
    () => {
        const t = setup();

        t.context.importIntegrationSyncReviews(t.database);

        const review = t.records('DJ_Identity_Review')[0];

        assert.equal(
            review['Match Status'],
            'POSSIBLE_MATCH'
        );

        assert.equal(
            review['Candidate Contact IDs'],
            'CT-001'
        );

        assert.equal(
            review['Review Status'],
            'PENDING'
        );
    }
);

test(
    'an exact email still cannot auto-approve an import already flagged for review',
    () => {
        const t = setup({
            imports: [{
                key: 'OBS-1',
                details: candidate({
                    Email: 'alex@example.test'
                }),
                contactIds: 'CT-001'
            }]
        });

        t.context.importIntegrationSyncReviews(t.database);

        const row = t.records('DJ_Identity_Review')[0];

        assert.equal(row['Review Status'], 'PENDING');
        assert.equal(
            row['Candidate Contact IDs'],
            'CT-001'
        );

        assert.equal(t.linkCalls.length, 0);
    }
);

test(
    'a legacy name-only candidate is preserved when the resolver finds NO_MATCH',
    () => {
        const t = setup({
            imports: [{
                key: 'OBS-1',
                contactIds: 'CT-001',
                details: candidate({
                    Email: '',
                    'Station / Venue / Organization': 'OTHER',
                    'Social Accounts': ''
                })
            }]
        });

        t.context.importIntegrationSyncReviews(t.database);

        const row = t.records('DJ_Identity_Review')[0];

        assert.equal(
            row['Match Status'],
            'POSSIBLE_MATCH'
        );

        assert.equal(
            row['Candidate Contact IDs'],
            'CT-001'
        );
    }
);

test(
    'verified social profiles are loaded as evidence, not used to auto-approve reviews',
    () => {
        const t = setup({
            socialRecords: [{
                'Profile ID': 'DJSP-EXISTING',
                'Observation ID': 'OLD',
                Platform: 'INSTAGRAM',
                'Profile URL':
                    'https://instagram.com/djalex',
                'Contact ID': 'CT-001',
                'Verification Status': 'VERIFIED'
            }]
        });

        const contacts = t.context.importIntegrationContacts(
            t.database
        );

        assert.equal(
            contacts[0].verifiedSocialProfiles.length,
            1
        );

        assert.equal(
            contacts[0].verifiedSocialProfiles[0]
                .verificationStatus,
            'VERIFIED'
        );

        t.context.importIntegrationSyncReviews(t.database);

        assert.equal(
            t.records('DJ_Identity_Review')[0]['Review Status'],
            'PENDING'
        );
    }
);

test(
    'invalid Import_Log JSON fails before any MA-05 sheet is written',
    () => {
        const t = setup({
            imports: [{
                key: 'OBS-1',
                rawDetails: '{invalid'
            }]
        });

        assert.throws(
            () => t.context.importIntegrationSyncReviews(
                t.database
            ),
            /Invalid identity details/
        );

        assert.equal(
            t.sheet('DJ_Identity_Review'),
            undefined
        );

        assert.equal(
            t.sheet('DJ_Social_Profiles'),
            undefined
        );
    }
);

test(
    'duplicate Master_Contacts IDs are rejected without creating review records',
    () => {
        const t = setup({
            contacts: [
                contact(),
                contact()
            ]
        });

        assert.throws(
            () => t.context.importIntegrationSyncReviews(
                t.database
            ),
            /duplicate Contact ID/
        );

        assert.equal(
            t.sheet('DJ_Identity_Review'),
            undefined
        );
    }
);

test(
    'no pending import means no identity or social records are created',
    () => {
        const t = setup({
            imports: []
        });

        const result = t.context.importIntegrationSyncReviews(
            t.database
        );

        assert.equal(result.observations, 0);

        assert.equal(
            t.sheet('DJ_Identity_Review'),
            undefined
        );

        assert.equal(
            t.sheet('DJ_Social_Profiles'),
            undefined
        );

        assert.equal(result.followUps.created, 0);
    }
);

test(
    'approval linking is opt-in and a second call does not create a duplicate',
    () => {
        const t = setup();

        t.context.importIntegrationSyncReviews(t.database);

        assert.equal(
            t.context.importIntegrationApplyApproved(
                t.database,
                t.source
            ).approved,
            0
        );

        assert.equal(t.linkCalls.length, 0);

        const review = t.sheet('DJ_Identity_Review');
        const columns = review.rows[0];

        review.rows[1][
            columns.indexOf('Review Status')
        ] = 'APPROVED_LINK';

        review.rows[1][
            columns.indexOf('Selected Contact ID')
        ] = 'CT-001';

        review.rows[1][
            columns.indexOf('Reviewer')
        ] = 'Test Reviewer';

        review.rows[1][
            columns.indexOf('Review Date')
        ] = '2026-11-11';

        const first = t.context.importIntegrationApplyApproved(
            t.database,
            t.source
        );

        const second = t.context.importIntegrationApplyApproved(
            t.database,
            t.source
        );

        assert.equal(first.linked, 1);
        assert.equal(second.alreadyLinked, 1);

        assert.deepEqual(
            t.linkCalls,
            ['OBS-1', 'OBS-1']
        );
    }
);

test(
    'an incomplete approval cannot reach the engagement-linking function',
    () => {
        const t = setup();

        t.context.importIntegrationSyncReviews(t.database);

        const review = t.sheet('DJ_Identity_Review');

        review.rows[1][
            review.rows[0].indexOf('Review Status')
        ] = 'APPROVED_LINK';

        assert.throws(
            () => t.context.importIntegrationApplyApproved(
                t.database,
                t.source
            ),
            /no Contact ID/
        );

        assert.equal(t.linkCalls.length, 0);
    }
);

test(
    'manual entry points use the configured database and source spreadsheets',
    () => {
        const t = setup({
            imports: []
        });

        assert.equal(
            t.context.importIntegrationSync().observations,
            0
        );

        assert.equal(
            t.context.importIntegrationLinkApproved().approved,
            0
        );
    }
);
