const test = require('node:test');
const assert = require('node:assert/strict');
const {BASE_HEADERS, setup, sourceRecord} = require('./support/marketingFixture.cjs');

function integration() {
  const t = setup(['DJIdentityResolver.js', 'DJIdentityReview.js', 'DJSocialProfileStore.js',
    'DJEngagementLinker.js', 'DJFollowUpQueue.js', 'apiInventory.js', 'MarketingAgent.js', 'Main.js']);
  const files = [], conversions = [], trashed = [], calls = [];
  const iterator = values => {
    let index = 0;
    return {hasNext: () => index < values.length, next: () => values[index++]};
  };
  const input = {
    getFiles: () => iterator(files.filter(file => file.folder === 'INPUT')),
    getFilesByType: type => iterator(files.filter(file => file.folder === 'INPUT' && file.getMimeType() === type))
  };
  const output = {};
  t.context.DriveApp = {
    getFolderById: id => {
      assert.ok(['INPUT', 'OUTPUT'].includes(id));
      return id === 'INPUT' ? input : output;
    },
    getFileById: id => ({
      getAs: type => {
        assert.equal(type, 'application/pdf');
        return files.find(file => file.getId() === id.replace('TEMP_', '')).getBlob();
      },
      setTrashed: value => { assert.equal(value, true); trashed.push(id); }
    })
  };
  t.context.Drive = {Files: {copy: (metadata, id, options) => {
    assert.equal(metadata.mimeType, 'application/vnd.google-apps.document');
    assert.equal(options.convert, true);
    conversions.push(id);
    return {id: 'TEMP_' + id};
  }}};
  // Simulated Gemini endpoint: the file is identified from the PDF bytes actually sent.
  const fetches = [];
  t.context.UrlFetchApp = {fetch: (url, options) => {
    fetches.push(options);
    const parts = JSON.parse(options.payload).contents[0].parts;
    const scope = (parts[0].text.match(/PDF page (\d+)/) || [, '1'])[1];
    const id = Buffer.from(parts[1].inline_data.data, 'base64').toString().match(/%PDF (\S+)/)[1];
    calls.push(id);
    assert.equal(t.isLocked(), false, 'Gemini must never be called while the script lock is held');
    assert.equal(options.timeoutSeconds, 90);
    const file = files.find(item => item.getId() === id);
    const [code, rows] = file.respond ? file.respond(scope) :
      file.failExtraction ? [429, []] : [200, scope === '1' ? file.records : []];
    return {getResponseCode: () => code, getContentText: () => JSON.stringify({
      candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(rows)}]}}]
    })};
  }};
  function upload(id, records, type = 'application/pdf', name = id + '.pdf', pages = 1) {
    const pdf = '%PDF ' + id + ' ' + Array(pages).fill('<< /Type /Page >>').join(' ');
    const file = {
      records, folder: 'INPUT', failExtraction: false, failMove: false, respond: null,
      getId: () => id, getName: () => name, getMimeType: () => type,
      getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
      getBlob: () => ({getBytes: () => Buffer.from(pdf), getDataAsString: () => pdf}),
      moveTo: target => {
        assert.equal(target, output);
        if (file.failMove) throw Error('Recoverable Drive move failure');
        file.folder = 'OUTPUT';
      }
    };
    files.push(file);
    return file;
  }
  function seed(id, name, email = '', status = '') {
    t.master.appendRow(BASE_HEADERS.map(header => ({
      'Contact ID': id, 'Name / DJ Alias': name, Email: email, 'Review Status': status
    })[header] || ''));
  }
  function actionable() {
    const sheet = t.books.DATABASE.getSheetByName('DJ_Actionable_Contacts');
    return sheet.rows.slice(1, sheet.getLastRow()).map(row =>
      Object.fromEntries(sheet.rows[0].map((header, i) => [header, row[i]])));
  }
  return {...t, files, conversions, trashed, calls, fetches, upload, seed, actionable};
}

test('one entry point completes mixed report ingestion, identity review, output, failure and retry', () => {
  const t = integration();
  t.seed('KNOWN', 'Known DJ', 'known@example.test', 'Reviewed');
  t.seed('AMB1', 'Ambiguous DJ', 'one@example.test');
  t.seed('AMB2', 'Ambiguous DJ', 'two@example.test');
  t.upload('INFLYTE', [
    sourceRecord({'Name / DJ Alias': 'New DJ', 'Email Address': 'new@example.test'}),
    sourceRecord({'Name / DJ Alias': 'Known DJ', 'Email Address': 'known@example.test', 'Campaign Status': 'Listened 2 days ago'}),
    sourceRecord({'Name / DJ Alias': 'Ambiguous DJ', 'Email Address': '', Comments: 'Nice'}),
    sourceRecord({'Name / DJ Alias': 'Low Rating DJ', 'Email Address': 'low@example.test', Rating: '1',
      'Campaign Status': 'Downloaded No Feedback', Comments: ''}),
    sourceRecord({'Name / DJ Alias': 'Support DJ', 'Email Address': '', Rating: '1', Comments: 'Love this! Full support.',
      'Campaign Status': '', 'Favorite Track': 'Club Remix'}),
    sourceRecord({'Name / DJ Alias': 'New DJ', 'Email Address': 'new@example.test'})
  ]);
  const failed = t.upload('RETRY', [sourceRecord({'Name / DJ Alias': 'Retry DJ', 'Email Address': 'retry@example.test'})]);
  failed.failExtraction = true;
  assert.throws(() => t.context.runAutomatedFunctions(), /1 report\(s\) failed/);
  assert.equal(t.files[0].folder, 'OUTPUT');
  assert.equal(failed.folder, 'INPUT');
  const rows = t.actionable();
  assert.equal(rows.length, 5);
  assert.equal(rows.find(row => row['DJ Name'] === 'Known DJ')['Contact ID'], 'KNOWN');
  assert.equal(rows.find(row => row['DJ Name'] === 'Known DJ')['Contact Status'], 'VERIFIED');
  assert.equal(rows.find(row => row['DJ Name'] === 'New DJ')['Contact Status'], 'UNVERIFIED');
  assert.equal(rows.find(row => row['DJ Name'] === 'Low Rating DJ')['Suggested Follow-Up'], 'THANK_YOU_DOWNLOAD');
  const support = rows.find(row => row['DJ Name'] === 'Support DJ');
  assert.equal(support['Suggested Follow-Up'], 'RESPOND_TO_FEEDBACK');
  assert.equal(support['Engagement Status'], 'Written feedback');
  assert.equal(support['Favorite Remix'], 'Club Remix');
  const ambiguous = rows.find(row => row['DJ Name'] === 'Ambiguous DJ');
  assert.equal(ambiguous['Contact ID'], '');
  assert.equal(ambiguous['Suggested Follow-Up'], 'IDENTITY_REVIEW');
  assert.ok(rows.every(row => row['Source Report'].includes('/INFLYTE/')));
  const review = t.books.DATABASE.getSheetByName('DJ_Identity_Review');
  assert.equal(review.getLastRow(), 2);
  assert.equal(review.rows[1][2], 'file:INFLYTE');
  assert.match(review.rows[1][7], /AMB1/);
  assert.match(review.rows[1][7], /AMB2/);
  assert.equal(t.books.DATABASE.getSheetByName('DJ_FollowUp_Queue').getLastRow(), 2);
  assert.ok(t.books.DATABASE.getSheetByName('Marketing_Run_Log').getLastRow() >= 2);
  const contacts = t.master.getLastRow();
  const reportRows = t.books.SOURCE.sheets[0].getLastRow();
  failed.failExtraction = false;
  // HTTP 429 is retried on a later timer run, not immediately.
  assert.equal(t.context.runMarketingAgent().processed, 0);
  t.clock.now += 5 * 60 * 1000;
  const result = t.context.runMarketingAgent();
  assert.equal(result.processed, 1);
  assert.equal(t.actionable().length, 6);
  assert.equal(t.master.getLastRow(), contacts + 1);
  assert.equal(t.books.SOURCE.sheets[0].getLastRow(), reportRows);
  assert.equal(t.calls.filter(id => id === 'INFLYTE').length, 1);
  t.context.runScripts();
  assert.equal(t.actionable().length, 6);
  assert.equal(t.master.getLastRow(), contacts + 1);
  assert.equal(t.isLocked(), false);
});

test('Word conversion uses the same parser/importer and retains original source and report fields', () => {
  const t = integration();
  t.upload('WORD', [{
    Name: 'Word DJ', Email: 'word@example.test', 'Favorite Remix': 'Dub',
    Downloads: '1', Listens: '4', 'Territory Detail': 'Reported region', Rating: 0,
    Comments: 'Supporting this', 'Campaign / Release': 'Word Release'
  }], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'new-report.docx');
  const result = t.context.runMarketingAgent();
  assert.equal(result.processed, 1);
  assert.deepEqual(t.conversions, ['WORD']);
  assert.deepEqual(t.trashed, ['TEMP_WORD']);
  assert.deepEqual(t.calls, ['WORD']);
  assert.equal(t.history()[0].reportId, 'file:WORD');
  assert.equal(t.history()[0].reportedFields.territorydetail, 'Reported region');
  const row = t.actionable()[0];
  assert.equal(row['Source Report'], 'https://drive.google.com/file/d/WORD/view');
  assert.equal(row['Favorite Remix'], 'Dub');
  assert.equal(row.Rating, '0');
  assert.match(row['Engagement Status'], /Confirmed download\nConfirmed listen/);
  assert.equal(row['Suggested Follow-Up'], 'THANK_YOU_DOWNLOAD');
});

test('archive failure retries without a second extraction, conversion or contact import', () => {
  const t = integration();
  const file = t.upload('ARCHIVE', [sourceRecord()], 'application/msword', 'legacy.doc');
  file.failMove = true;
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  const log = t.books.DATABASE.getSheetByName('Import_Log');
  const count = log.getLastRow();
  file.failMove = false;
  t.context.runMarketingAgent();
  assert.equal(file.folder, 'OUTPUT');
  assert.equal(t.master.getLastRow(), 2);
  assert.equal(t.history().length, 1);
  assert.equal(log.getLastRow(), count);
  assert.deepEqual(t.calls, ['ARCHIVE']);
  assert.deepEqual(t.conversions, ['ARCHIVE']);
});

test('interrupted new contact write recovers without creating a duplicate or self-review', () => {
  const t = integration();
  t.upload('PARTIAL', [sourceRecord({'Name / DJ Alias': 'Name Only DJ', 'Email Address': ''})]);
  const original = t.master.getRange.bind(t.master);
  let interrupted = false;
  t.master.getRange = (...args) => {
    const range = original(...args);
    const write = range.setValues.bind(range);
    range.setValues = values => {
      const result = write(values);
      if (!interrupted && args[0] === 2 && args[1] === 1) {
        interrupted = true;
        throw Error('Connection lost after new contact row write');
      }
      return result;
    };
    return range;
  };
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  t.master.getRange = original;
  t.context.runMarketingAgent();
  assert.equal(t.master.getLastRow(), 2);
  assert.equal(t.history().length, 1);
  assert.equal(t.actionable()[0]['DJ Name'], 'Name Only DJ');
  assert.equal(t.books.DATABASE.getSheetByName('DJ_Identity_Review'), undefined);
  assert.equal(t.calls.length, 1);
});

test('interrupted history write repairs from the existing observation log', () => {
  const t = integration();
  t.upload('HISTORY', [sourceRecord()]);
  t.context.marketingInitialize_();
  const column = t.master.rows[0].indexOf('Campaign History Data') + 1;
  const original = t.master.getRange.bind(t.master);
  t.master.getRange = (...args) => {
    const range = original(...args);
    if (args[0] === 2 && args[1] === column)
      range.setValue = () => { throw Error('Temporary history write failure'); };
    return range;
  };
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  t.master.getRange = original;
  t.context.runMarketingAgent();
  assert.equal(t.history().length, 1);
  assert.equal(t.master.getLastRow(), 2);
  assert.equal(t.calls.length, 1);
});

test('approved identity is linked automatically on the next timer without requiring linker execution', () => {
  const t = integration();
  t.seed('EXISTING', 'Same Name');
  t.upload('REVIEW', [sourceRecord({'Name / DJ Alias': 'Same Name', 'Email Address': ''})]);
  t.context.runMarketingAgent();
  const review = t.books.DATABASE.getSheetByName('DJ_Identity_Review');
  review.rows[1][2] = 'Legacy reviewer report label';
  t.context.djIdentityReviewDecision(t.books.DATABASE, review.rows[1][0], 'CONFIRM_LINK',
    'EXISTING', 'Test Reviewer', 'Confirmed against original record');
  t.context.runMarketingAgent();
  assert.equal(t.actionable().length, 1);
  assert.equal(t.actionable()[0]['Contact ID'], 'EXISTING');
  assert.equal(t.history().length, 1);
  assert.equal(t.books.DATABASE.getSheetByName('DJ_FollowUp_Queue').rows[1][11], 'RESOLVED');
  t.context.runMarketingAgent();
  assert.equal(t.history().length, 1);
});

test('negative or zero activity and a favorite never become a download', () => {
  const t = integration();
  for (const status of ['Not downloaded', '0 downloads', 'Downloaded: No', 'Downloaded 0 times', 'Checked No Feedback']) {
    assert.notEqual(t.context.marketingEngagement_({status, comments: '', favoriteTrack: 'Mix',
      reportedFields: {downloads: '0'}}).followUp, 'THANK_YOU_DOWNLOAD', status);
  }
});

test('unavailable fields remain blank and an empty input folder still publishes an empty list', () => {
  const t = integration();
  const result = t.context.runMarketingAgent();
  assert.equal(result.actionable.rows, 0);
  t.upload('MINIMAL', [{Name: 'Minimal DJ', Comments: 'Full support'}]);
  t.context.runMarketingAgent();
  const row = t.actionable()[0];
  for (const field of ['Email', 'Social Accounts', 'Rating', 'Favorite Remix']) assert.equal(row[field], '');
});

test('installer replaces only Marketing timers and validates configuration first', () => {
  const t = integration();
  const triggers = ['runScripts', 'runAutomatedFunctions', 'unrelatedTimer'].map(handler => ({getHandlerFunction: () => handler}));
  let created = 0;
  t.context.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: handler => {
      assert.equal(handler, 'runMarketingAgent');
      return {timeBased() { return this; }, everyMinutes(minutes) {
        assert.equal(minutes, 5); return this;
      }, create() { created++; triggers.push({getHandlerFunction: () => handler}); }};
    },
    deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1)
  };
  t.context.installMarketingAgentTrigger();
  t.context.installMarketingAgentTrigger();
  assert.equal(created, 2);
  assert.deepEqual(triggers.map(trigger => trigger.getHandlerFunction()).sort(), ['runMarketingAgent', 'unrelatedTimer']);
  t.properties.PARSER_OUTPUT_FOLDER = 'INPUT';
  assert.throws(() => t.context.installMarketingAgentTrigger(), /distinct/);
  assert.equal(created, 2);
});

test('same-name different files do not mix provenance or contact activity', () => {
  const t = integration();
  t.upload('FIRST', [sourceRecord({'Name / DJ Alias': 'First DJ', 'Email Address': 'first@example.test'})], 'application/pdf', 'same.pdf');
  t.upload('SECOND', [sourceRecord({'Name / DJ Alias': 'Second DJ', 'Email Address': 'second@example.test'})], 'application/pdf', 'same.pdf');
  t.context.runMarketingAgent();
  const staging = t.books.SOURCE.getSheetByName('MA_Section_Staging');
  assert.equal(staging.getLastRow(), 1, 'staged sections are removed after import');
  assert.equal(t.books.SOURCE.sheets.filter(sheet => sheet !== staging).length, 2);
  assert.deepEqual(t.actionable().map(row => row['Source Report']).sort(), [
    'https://drive.google.com/file/d/FIRST/view', 'https://drive.google.com/file/d/SECOND/view'
  ]);
});

test('only verified, nonconflicting social matches or unique email matches auto-link', () => {
  const t = integration();
  const person = {'Contact ID': 'SOCIAL', 'Name / DJ Alias': 'Social DJ',
    'Social Accounts': 'https://instagram.com/socialdj'};
  const candidate = {'Name / DJ Alias': 'Social DJ', 'Social Accounts': person['Social Accounts']};
  assert.ok(t.context.findContactMatch([person], candidate).review);
  person.verifiedSocialProfiles = [{profileUrl: person['Social Accounts']}];
  assert.equal(t.context.findContactMatch([person], candidate).person['Contact ID'], 'SOCIAL');
  person.Email = 'existing@example.test';
  assert.ok(t.context.findContactMatch([person], {...candidate, Email: 'different@example.test'}).review);
  assert.equal(t.context.findContactMatch([person], {...candidate, Email: person.Email}).person['Contact ID'], 'SOCIAL');
  assert.ok(t.context.findContactMatch([person, {...person, 'Contact ID': 'DUPLICATE'}],
    {...candidate, Email: person.Email}).review);
});

test('complete-row updates preserve existing formulas and formula-like literal text', () => {
  const t = integration();
  t.seed('EXISTING', 'Existing DJ', 'existing@example.test');
  t.master.rows[0].push('Existing Formula');
  t.master.rows[1][BASE_HEADERS.indexOf('Role')] = '=Literal external text';
  t.master.rows[1].push('computed value');
  const original = t.master.getRange.bind(t.master);
  t.master.getRange = (...args) => {
    const range = original(...args);
    if (args[0] === 2 && args[1] === 1 && args[3] > BASE_HEADERS.length)
      range.getFormulas = () => [Array.from({length: args[3]}, (_, i) =>
        i === BASE_HEADERS.length ? '=1+1' : '')];
    return range;
  };
  t.upload('PATCH', [sourceRecord({'Name / DJ Alias': 'Existing DJ', 'Email Address': 'existing@example.test'})]);
  t.context.runMarketingAgent();
  assert.equal(t.master.rows[1][BASE_HEADERS.indexOf('Role')], "'=Literal external text");
  assert.equal(t.master.rows[1][BASE_HEADERS.length], '=1+1');
});

test('a summary failure after history persistence is repaired without damaging a known profile', () => {
  const t = integration();
  t.seed('EXISTING', 'Existing DJ', 'existing@example.test');
  t.master.rows[1][BASE_HEADERS.indexOf('Role')] = 'DJ';
  t.context.marketingInitialize_();
  t.upload('SUMMARY', [sourceRecord({'Name / DJ Alias': 'Existing DJ', 'Email Address': 'existing@example.test'})]);
  const column = t.master.rows[0].indexOf('Latest Campaign') + 1;
  const original = t.master.getRange.bind(t.master);
  t.master.getRange = (...args) => {
    const range = original(...args);
    if (args[0] === 2 && args[1] === column) range.setValue = () => { throw Error('Temporary summary failure'); };
    return range;
  };
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  assert.equal(t.history().length, 1);
  t.master.getRange = original;
  t.context.runMarketingAgent();
  assert.equal(t.history().length, 1);
  assert.equal(t.contact().Role, 'DJ');
  assert.equal(t.contact()['Contact ID'], 'EXISTING');
  assert.match(t.note(), /Nice track/);
  assert.deepEqual(t.calls, ['SUMMARY']);
});

test('a Word conversion failure leaves the original in input and does not block a PDF', () => {
  const t = integration();
  const word = t.upload('WORD_FAIL', [sourceRecord()], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx');
  t.upload('PDF_OK', [sourceRecord({'Name / DJ Alias': 'PDF DJ', 'Email Address': 'pdf@example.test'})]);
  const copy = t.context.Drive.Files.copy;
  t.context.Drive.Files.copy = () => { throw Error('Temporary Word conversion failure'); };
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  assert.equal(word.folder, 'INPUT');
  assert.equal(t.files[1].folder, 'OUTPUT');
  assert.equal(t.actionable().length, 1);
  t.context.Drive.Files.copy = copy;
  t.context.runMarketingAgent();
  assert.equal(word.folder, 'OUTPUT');
  assert.equal(t.actionable().length, 2);
  assert.deepEqual(t.calls, ['PDF_OK', 'WORD_FAIL']);
});

function oneShot(pageCount, script) {
  const t = setup(['apiInventory.js']);
  const sent = [];
  t.context.UrlFetchApp = {fetch: (url, options) => {
    assert.equal(options.timeoutSeconds, 90);
    const scope = (JSON.parse(options.payload).contents[0].parts[0].text.match(/PDF page (\d+)/) || [, '1'])[1];
    sent.push(scope);
    const [code, rows] = script(scope);
    return {getResponseCode: () => code, getContentText: () => JSON.stringify({candidates: [{finishReason: 'STOP',
      content: {parts: [{text: JSON.stringify(rows)}]}}]})};
  }};
  const pdf = '%PDF ' + Array.from({length: pageCount}, () => '<< /Type /Page >>').join(' ') + ' << /Type /Pages >>';
  const response = t.context.geminiParsePDFUndefined({getBytes: () => Buffer.from(pdf), getDataAsString: () => pdf});
  return {t, sent, response, rows: () => JSON.parse(JSON.parse(response.getContentText()).candidates[0].content.parts[0].text)};
}

test('one-shot extraction requests bounded page sections in order and merges a split entry', () => {
  const run = oneShot(19, scope => {
    if (scope === '1') return [200, [{'Name / DJ Alias': 'Split DJ'}, {'Name / DJ Alias': 'First DJ', Rating: '2'}]];
    if (scope === '5') return [200, [{'Name / DJ Alias': 'Split DJ', Comments: 'Great', Rating: '4'}]];
    return [200, []];
  });
  assert.deepEqual(run.sent, ['1', '5', '9', '13', '17']);
  assert.deepEqual(run.rows().map(row => [row['Name / DJ Alias'], row.Rating]), [['Split DJ', '4'], ['First DJ', '2']]);
  assert.equal(run.t.context.printApiInventory(), 5);
});

test('a failed section rejects one-shot extraction without requesting later sections', () => {
  const run = oneShot(9, scope => scope === '4' ? [503, []] : [200, [{'Name / DJ Alias': 'DJ ' + scope}]]);
  assert.equal(run.response.getResponseCode(), 503);
  assert.deepEqual(run.sent, ['1', '4']);
});

test('short reports use one unscoped request and unknown page counts keep an open-ended final range', () => {
  const short = oneShot(3, () => [200, [{'Name / DJ Alias': 'Only DJ'}]]);
  assert.deepEqual(short.sent, ['1']);
  const ranges = setup(['apiInventory.js']).context.marketingPageRanges_(0);
  assert.equal(ranges.length, 8);
  assert.equal(ranges[7].last, null);
});

// Nine pages become three sections, beginning on pages 1, 4 and 7.
const sectionRecord = scope => sourceRecord({'Name / DJ Alias': 'DJ ' + scope, 'Email Address': 'dj' + scope + '@example.test'});
const job = (t, id) => JSON.parse(t.properties['MA_JOB_' + id]);
const stagedRows = t => {
  const sheet = t.books.SOURCE.getSheetByName('MA_Section_Staging');
  return sheet ? sheet.getLastRow() - 1 : 0;
};
const djNames = t => t.actionable().map(row => row['DJ Name']).sort();

test('slow and timed-out Gemini sections are bounded, saved independently and resumed later', () => {
  const t = integration();
  const file = t.upload('LONG', [], 'application/pdf', 'long.pdf', 9);
  const attempts = {};
  file.respond = scope => {
    attempts[scope] = (attempts[scope] || 0) + 1;
    if (scope === '1') { t.clock.now += 80000; return [200, [sectionRecord('1')]]; }
    if (scope === '4' && attempts[scope] === 1) {
      // UrlFetchApp throws once timeoutSeconds elapses.
      t.clock.now += 90000;
      throw new Error('Timeout: https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=FAKE-SECRET-KEY');
    }
    return [200, [sectionRecord(scope)]];
  };
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  // Section 7 was not started: it could still be running when the run must finish.
  assert.deepEqual(attempts, {'1': 1, '4': 1});
  assert.equal(stagedRows(t), 1, 'the successful slow section was saved before the timeout');
  const state = job(t, 'LONG');
  assert.deepEqual(state.sections.map(section => section.done), [true, false, false]);
  assert.equal(state.sections[1].attempts, 1);
  assert.match(state.sections[1].error, /Timeout: .*key=\[redacted\]/);
  assert.equal(file.folder, 'INPUT');
  assert.deepEqual(t.actionable(), []);
  const runLog = t.books.DATABASE.getSheetByName('Marketing_Run_Log').rows;
  assert.match(runLog.map(row => row[1]).join(','), /GEMINI_SECTION/);
  assert.doesNotMatch(JSON.stringify(runLog) + JSON.stringify(t.properties), /FAKE-SECRET-KEY/,
    'the API key in a UrlFetchApp error URL is never stored');
  assert.equal(t.properties.MA_RUN_LEASE, undefined);

  t.clock.now += 5 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.deepEqual(attempts, {'1': 1, '4': 2, '7': 1});
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
  assert.equal(file.folder, 'OUTPUT');
  assert.equal(stagedRows(t), 0);
  assert.equal(t.properties.MA_JOB_LONG, undefined);
});

test('HTTP 503 sections back off without blocking other sections or reports', () => {
  const t = integration();
  const busy = t.upload('BUSY', [], 'application/pdf', 'busy.pdf', 9);
  const other = t.upload('OTHER', [sourceRecord({'Name / DJ Alias': 'Other DJ', 'Email Address': 'other@example.test'})]);
  let unavailable = 2;
  busy.respond = scope => scope === '4' && unavailable-- > 0 ? [503, []] : [200, [sectionRecord(scope)]];
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  assert.equal(other.folder, 'OUTPUT');
  assert.equal(busy.folder, 'INPUT');
  assert.deepEqual(job(t, 'BUSY').sections.map(section => section.done), [true, false, true]);
  assert.deepEqual(djNames(t), ['Other DJ']);

  // The next timer inside the backoff window sends nothing.
  const sent = t.calls.length;
  t.clock.now += 60 * 1000;
  t.context.runMarketingAgent();
  assert.equal(t.calls.length, sent);

  t.clock.now += 4 * 60 * 1000;
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  assert.equal(job(t, 'BUSY').sections[1].attempts, 2);

  t.clock.now += 10 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7', 'Other DJ']);
  assert.equal(t.calls.filter(id => id === 'BUSY').length, 5, 'only the unavailable section was re-sent');
  assert.equal(t.master.getLastRow(), 5);
});

test('a permanent Gemini error blocks only its report until an explicit retry', () => {
  const t = integration();
  const file = t.upload('DENIED', [], 'application/pdf', 'denied.pdf', 9);
  let denied = true;
  file.respond = scope => scope === '7' && denied ? [403, []] : [200, [sectionRecord(scope)]];
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  assert.equal(job(t, 'DENIED').sections[2].failed, true);
  t.clock.now += 2 * 60 * 60 * 1000;
  const sent = t.calls.length;
  assert.equal(t.context.runMarketingAgent().blocked, 1);
  assert.equal(t.calls.length, sent);
  denied = false;
  assert.equal(t.context.marketingRetryFailedReports(), 1);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.equal(t.calls.length, sent + 1, 'saved sections were not requested again');
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
});

test('a timer that fires during a Gemini request is skipped and no lock is held during the request', () => {
  const t = integration();
  const file = t.upload('OVERLAP', [sourceRecord({'Name / DJ Alias': 'Overlap DJ', 'Email Address': 'overlap@example.test'})]);
  let overlapped;
  file.respond = () => {
    overlapped = overlapped || t.context.runMarketingAgent();
    return [200, file.records];
  };
  t.context.runMarketingAgent();
  assert.equal(overlapped.skipped, true);
  assert.deepEqual(t.calls, ['OVERLAP']);
  assert.deepEqual(djNames(t), ['Overlap DJ']);
  assert.equal(t.properties.MA_RUN_LEASE, undefined);
  // Legacy direct callers honour an active lease too.
  t.properties.MA_RUN_LEASE = JSON.stringify({owner: 'other', expiresAt: t.clock.now + 60000});
  assert.equal(t.context.processNewPDFs().skipped, true);
  assert.equal(t.context.runMarketingAgent().skipped, true);
});

test('an execution killed mid-report keeps saved sections; its stale lease expires and the next run resumes', () => {
  const t = integration();
  const file = t.upload('KILLED', [], 'application/pdf', 'killed.pdf', 9);
  const scopes = [];
  let kill = true;
  file.respond = scope => {
    scopes.push(scope);
    if (scope === '7' && kill) throw new Error('Exceeded maximum execution time');
    return [200, [sectionRecord(scope)]];
  };
  // Apps Script terminates the execution: no failure handler or lease release runs.
  const saved = ['marketingRecordSectionFailure_', 'marketingReleaseRun_', 'logMarketingFailure_']
    .map(name => [name, t.context[name]]);
  t.context.marketingRecordSectionFailure_ = (run, state, index, error) => { throw error; };
  t.context.logMarketingFailure_ = (stage, id, error) => { throw error; };
  t.context.marketingReleaseRun_ = () => {};
  assert.throws(() => t.context.runMarketingAgent(), /maximum execution time/);
  saved.forEach(([name, value]) => { t.context[name] = value; });
  kill = false;
  assert.equal(stagedRows(t), 2);
  assert.deepEqual(job(t, 'KILLED').sections.map(section => section.done), [true, true, false]);
  assert.ok(t.properties.MA_RUN_LEASE, 'the killed run left its lease behind');

  t.clock.now += 5 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().skipped, true);
  t.clock.now += 3 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.deepEqual(scopes, ['1', '4', '7', '7']);
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
  assert.equal(t.master.getLastRow(), 4);
});

test('a run whose lease was reclaimed cannot save a late Gemini result', () => {
  const t = integration();
  const file = t.upload('STALE', [], 'application/pdf', 'stale.pdf', 9);
  let takeover, reclaiming = false;
  file.respond = scope => {
    if (scope === '4' && !reclaiming) {
      // This request outlives the lease; a later timer reclaims it and completes the report.
      reclaiming = true;
      t.clock.now += 8 * 60 * 1000;
      takeover = t.context.runMarketingAgent();
      return [200, [sectionRecord('4 late')]];
    }
    return [200, [sectionRecord(scope)]];
  };
  assert.throws(() => t.context.runMarketingAgent(), /lease was taken over/);
  assert.equal(takeover.processed, 1);
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
  assert.equal(file.folder, 'OUTPUT');
  assert.equal(stagedRows(t), 0);
  assert.equal(t.properties.MA_JOB_STALE, undefined);
  assert.equal(t.isLocked(), false);
});

test('a staged section lost before finalization is requested again instead of finalizing a partial report', () => {
  const t = integration();
  const file = t.upload('PARTIAL', [], 'application/pdf', 'partial.pdf', 9);
  file.respond = scope => scope === '7' && !file.ready ? [503, []] : [200, [sectionRecord(scope)]];
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  // Simulate damage to one saved section, then let the last section succeed.
  const staging = t.books.SOURCE.getSheetByName('MA_Section_Staging');
  staging.rows[1][4] = 'b64:corrupt';
  file.ready = true;
  t.clock.now += 5 * 60 * 1000;
  assert.throws(() => t.context.runMarketingAgent(), /1 report/);
  assert.match(t.books.DATABASE.getSheetByName('Marketing_Run_Log').rows.map(row => row[3]).join('\n'),
    /will be requested again/);
  assert.equal(file.folder, 'INPUT');
  assert.deepEqual(t.actionable(), []);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
});
