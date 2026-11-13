const test = require('node:test');
const assert = require('node:assert/strict');
const {BASE_HEADERS, setup, sourceRecord} = require('./support/marketingFixture.cjs');

function integration() {
  const t = setup(['DJIdentityResolver.js', 'DJIdentityReview.js', 'DJSocialProfileStore.js',
    'DJEngagementLinker.js', 'DJFollowUpQueue.js', 'apiInventory.js', 'ImportIntegration.js',
    'MarketingAgent.js', 'Main.js']);
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
      setTrashed: value => { assert.equal(value, true); trashed.push(id); },
      isTrashed: () => files.find(file => file.getId() === id).folder === 'TRASH',
      getParents: () => iterator([{getId: () => files.find(file => file.getId() === id).folder}])
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
    assert.doesNotMatch(url, /[?&]key=/, 'the API key must not be part of the request URL');
    assert.equal(options.headers['x-goog-api-key'], 'LOCAL_ONLY');
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
  // The timed-out pages 4-6 are split (not failed); no time remains to request them this run.
  assert.equal(t.context.runMarketingAgent().processed, 0);
  // Section 7 was not started: it could still be running when the run must finish.
  assert.deepEqual(attempts, {'1': 1, '4': 1});
  assert.equal(stagedRows(t), 1, 'the successful slow section was saved before the timeout');
  const state = job(t, 'LONG');
  assert.deepEqual(state.sections.map(s => [s.first, s.last, s.done]),
    [[1, 3, true], [4, 5, false], [7, null, false], [6, 6, false]]);
  assert.equal(state.sections[3].splitFrom, '4-6');
  assert.equal(state.sections[1].attempts, 0);
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
  assert.deepEqual(attempts, {'1': 1, '4': 2, '6': 1, '7': 1});
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 6', 'DJ 7']);
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

// --- OpenAI Responses provider (MarketingExtractionProvider.js), simulated endpoint ---
const OPENAI_FIELDS = ['name_dj_alias', 'first_name', 'last_name', 'additional_info_stations', 'radio_station', 'reach',
  'rating', 'favorite_track', 'comments', 'email_address', 'phone_number', 'social_media_account', 'city',
  'state_region', 'country', 'music_genre', 'campaign_release', 'report_generated_at', 'report_section', 'campaign_status',
  'activity_time', 'downloaded', 'downloads', 'listened', 'listens'];
const OPENAI_KEY = 'sk-test-SECRET1234567890';
const oaRecord = fields => ({...Object.fromEntries(OPENAI_FIELDS.map(key => [key, null])), additional_fields: [], ...fields});
const oaOk = records => [200, {status: 'completed', output: [{type: 'reasoning', summary: []},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({records})}]}],
  usage: {input_tokens: 1000, output_tokens: 200, output_tokens_details: {reasoning_tokens: 50}}}];
const oaError = (code, kind, message = 'simulated') => [code, {error: {code: kind, type: kind, message}}];

function openAI(respond, properties = {}) {
  const t = integration();
  Object.assign(t.properties, {MARKETING_EXTRACTION_PROVIDER: 'openai', OPENAI_API_KEY: OPENAI_KEY}, properties);
  // Gemini is configured but must never be used while OpenAI is selected.
  const requests = [];
  t.context.UrlFetchApp = {fetch: (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses', 'no automatic fallback to another provider');
    assert.equal(t.isLocked(), false, 'OpenAI must never be called while the script lock is held');
    assert.equal(options.timeoutSeconds, 90);
    assert.equal(options.headers.Authorization, 'Bearer ' + OPENAI_KEY);
    const body = JSON.parse(options.payload);
    const [file, prompt] = body.input[0].content;
    const scope = (prompt.text.match(/PDF page (\d+)/) || [, '1'])[1];
    const id = Buffer.from(file.file_data.replace('data:application/pdf;base64,', ''), 'base64')
      .toString().match(/%PDF (\S+)/)[1];
    requests.push({id, scope, body});
    const [code, reply] = respond(id, scope, requests.filter(r => r.id === id && r.scope === scope).length);
    return {getResponseCode: () => code, getContentText: () => typeof reply === 'string' ? reply : JSON.stringify(reply)};
  }};
  const runLog = () => JSON.stringify((t.books.DATABASE.getSheetByName('Marketing_Run_Log') || {rows: []}).rows);
  return {...t, requests, runLog};
}

test('OpenAI provider extracts through the unchanged workflow with structured output and usage tracking', () => {
  const t = openAI((id, scope) => {
    if (scope === '1') return oaOk([oaRecord({name_dj_alias: 'Low Rating DJ', rating: '1', email_address: 'low@example.test',
      campaign_status: 'Downloaded No Feedback', campaign_release: 'Release A'})]);
    if (scope === '4') return oaOk([oaRecord({name_dj_alias: 'Fan DJ', rating: '2', comments: 'Love this, full support!',
      favorite_track: 'Club Remix', social_media_account: 'Instagram @fan.dj', campaign_release: 'Release A',
      additional_fields: [{field: 'Station Format', value: 'Club'}, {field: 'Comments', value: 'must not overwrite'}]})]);
    return oaOk([]);
  }, {OPENAI_INPUT_USD_PER_1M_TOKENS: '1', OPENAI_OUTPUT_USD_PER_1M_TOKENS: '4'});
  const file = t.upload('OAI', [], 'application/pdf', 'inflyte.pdf', 9);
  const stats = t.context.runMarketingAgent();
  assert.equal(stats.processed, 1);
  assert.deepEqual(t.requests.map(r => r.scope), ['1', '4', '7']);
  const body = t.requests[0].body;
  assert.equal(body.model, 'gpt-6-luna', 'default model when OPENAI_EXTRACTION_MODEL is unset');
  assert.equal(body.store, false);
  assert.equal(body.reasoning, undefined, 'reasoning effort is sent only when configured');
  assert.equal(body.input[0].content[0].type, 'input_file');
  assert.match(body.input[0].content[0].file_data, /^data:application\/pdf;base64,/);
  assert.equal(body.input[0].content[1].type, 'input_text');
  assert.match(body.input[0].content[1].text, /Do not infer listening or downloads/);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  const recordSchema = body.text.format.schema.properties.records.items;
  assert.deepEqual([...recordSchema.required].sort(), [...OPENAI_FIELDS, 'additional_fields'].sort());
  assert.equal(file.folder, 'OUTPUT');

  const rows = t.actionable();
  const low = rows.find(row => row['DJ Name'] === 'Low Rating DJ');
  assert.equal(low['Suggested Follow-Up'], 'THANK_YOU_DOWNLOAD');
  const fan = rows.find(row => row['DJ Name'] === 'Fan DJ');
  assert.equal(fan['Favorite Remix'], 'Club Remix');
  assert.equal(fan['Engagement Status'], 'Written feedback', 'a favorite track is not a download');
  assert.equal(fan['Suggested Follow-Up'], 'RESPOND_TO_FEEDBACK');
  assert.equal(fan.Email, '', 'null contact fields stay blank');
  const report = t.books.SOURCE.sheets.find(sheet => sheet.rows[0] && sheet.rows[0].includes('Station Format'));
  assert.ok(report, 'report-specific fields are preserved');
  const fanRow = report.rows.find(row => row.includes('Fan DJ'));
  assert.equal(fanRow[report.rows[0].indexOf('Comments')], 'Love this, full support!');
  assert.ok(!JSON.stringify(report.rows).includes('null'));

  assert.deepEqual(JSON.parse(JSON.stringify(stats.extraction.OpenAI)), {model: 'gpt-6-luna', requests: 3, seconds: 0,
    inputTokens: 3000, outputTokens: 600, reasoningTokens: 150, estimatedUsd: 0.0054});
  assert.equal(stats.extraction.Gemini, undefined);

  const contacts = t.master.getLastRow();
  const history = JSON.stringify(t.master.rows);
  assert.equal(t.context.runMarketingAgent().processed, 0);
  assert.equal(t.requests.length, 3, 'a processed report is not requested again');
  assert.equal(t.master.getLastRow(), contacts);
  assert.equal(JSON.stringify(t.master.rows), history, 'repeat runs do not duplicate contacts or history');
});

test('retryable OpenAI failures keep completed sections and resume without re-requesting them', () => {
  const t = openAI((id, scope, attempt) => {
    if (scope === '1') return oaOk([oaRecord({name_dj_alias: 'DJ 1', email_address: 'dj1@example.test', comments: 'Nice track'})]);
    if (scope === '4' && attempt === 1) return oaError(503, 'server_error');
    if (scope === '4' && attempt === 2) return [200, {status: 'failed', error: {code: 'server_error'}, output: []}];
    if (scope === '7' && attempt === 1) return oaError(429, 'rate_limit_exceeded');
    if (scope === '7' && attempt === 2) return [200, {status: 'completed', output: [{type: 'message',
      content: [{type: 'output_text', text: '{"records": [ truncated'}]}]}];
    return oaOk([oaRecord({name_dj_alias: 'DJ ' + scope, email_address: 'dj' + scope + '@example.test', comments: 'Nice track'})]);
  });
  const file = t.upload('RETRY', [], 'application/pdf', 'retry.pdf', 9);
  assert.throws(() => t.context.runMarketingAgent(), /2 report\(s\) failed/);
  let state = job(t, 'RETRY');
  assert.deepEqual(state.sections.map(s => [s.done, s.failed, s.attempts]), [[true, false, 0], [false, false, 1], [false, false, 1]]);
  assert.equal(state.sections[0].provider, 'OpenAI gpt-6-luna');
  assert.match(state.sections[1].error, /OpenAI HTTP 503 \(server_error\)/);
  assert.match(state.sections[2].error, /OpenAI HTTP 429 \(rate_limit_exceeded\)/);
  assert.match(t.runLog(), /OPENAI_SECTION/);
  assert.equal(stagedRows(t), 1);

  t.clock.now += 5 * 60 * 1000;
  assert.throws(() => t.context.runMarketingAgent(), /2 report\(s\) failed/);
  state = job(t, 'RETRY');
  assert.match(state.sections[1].error, /OpenAI response failed/);
  assert.match(state.sections[2].error, /invalid JSON/);
  assert.deepEqual(state.sections.map(s => s.failed), [false, false, false]);

  t.clock.now += 10 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.equal(t.requests.filter(r => r.scope === '1').length, 1, 'the completed section was never requested again');
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
  assert.equal(file.folder, 'OUTPUT');
});

test('a section that times out or hits the output limit is split in page order without re-requesting completed sections', () => {
  const t = openAI((id, scope, attempt) => {
    const rec = (name, email = name.replace(/\W/g, '').toLowerCase() + '@example.test') =>
      oaRecord({name_dj_alias: name, email_address: email, comments: 'Nice track'});
    if (scope === '1') return oaOk([rec('DJ 1'), rec('Boundary DJ', null)]);
    if (scope === '4' && attempt === 1)
      return [200, {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, output: []}];
    if ((scope === '4' && attempt === 2) || (scope === '5' && attempt === 1)) {
      t.clock.now += 90000;
      throw new Error('Timeout: https://api.openai.com/v1/responses');
    }
    if (scope === '4') return oaOk([rec('Boundary DJ'), rec('DJ 4')]);
    return oaOk([rec('DJ ' + scope)]);
  });
  const file = t.upload('SPLIT', [], 'application/pdf', 'split.pdf', 9);
  // Pages 4-6 -> 4-5 + 6; 4-5 times out -> 4 + 5; single page 5 then times out and backs off.
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  let state = job(t, 'SPLIT');
  assert.deepEqual(state.sections.map(s => [s.first, s.last, s.done, s.attempts]),
    [[1, 3, true, 0], [4, 4, true, 0], [7, null, true, 0], [6, 6, true, 0], [5, 5, false, 1]]);
  assert.deepEqual(state.sections.map(s => s.splitFrom), [undefined, undefined, undefined, '4-6', '4-5']);
  assert.ok(state.sections[4].nextAt > t.clock.now, 'a single page that times out uses normal backoff');
  assert.match(t.requests.filter(r => r.scope === '4')[2].body.input[0].content[1].text, /page 4 through page 4/);
  assert.equal(stagedRows(t), 4);
  assert.equal(file.folder, 'INPUT');

  t.clock.now += 5 * 60 * 1000;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  const counts = scope => t.requests.filter(r => r.scope === scope).length;
  assert.deepEqual(['1', '4', '5', '6', '7'].map(counts), [1, 3, 2, 1, 1], 'completed sections are never requested again');
  assert.deepEqual(djNames(t), ['Boundary DJ', 'DJ 1', 'DJ 4', 'DJ 5', 'DJ 6', 'DJ 7']);
  assert.equal(t.actionable().find(row => row['DJ Name'] === 'Boundary DJ').Email, 'boundarydj@example.test',
    'an entry returned by two sections is kept once, using the fuller copy');
  const report = t.books.SOURCE.sheets.find(sheet => sheet.rows.some(row => row.includes('DJ 5')));
  const nameCol = report.rows[0].indexOf('Name / DJ Alias');
  assert.deepEqual(report.rows.slice(1).map(row => row[nameCol]),
    ['DJ 1', 'Boundary DJ', 'DJ 4', 'DJ 5', 'DJ 6', 'DJ 7'], 'split halves are combined in page order');
  assert.equal(file.folder, 'OUTPUT');

  const contacts = JSON.stringify(t.master.rows);
  assert.equal(t.context.runMarketingAgent().processed, 0);
  assert.equal(t.requests.length, 8);
  assert.equal(JSON.stringify(t.master.rows), contacts, 'rerunning does not duplicate contacts or history');
});

test('authentication, quota and refusal failures are permanent, sanitized and isolated to their report', () => {
  const t = openAI(id => ({
    AUTH: oaError(401, 'invalid_api_key', 'Incorrect API key provided: ' + OPENAI_KEY + '. Bearer ' + OPENAI_KEY),
    QUOTA: oaError(429, 'insufficient_quota', 'You exceeded your current quota.'),
    REFUSE: [200, {status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'I cannot help.'}]}]}],
    GOOD: oaOk([oaRecord({name_dj_alias: 'Good DJ', email_address: 'good@example.test', campaign_status: 'Downloaded No Feedback'})])
  })[id]);
  ['AUTH', 'QUOTA', 'REFUSE', 'GOOD'].forEach(id => t.upload(id, []));
  assert.throws(() => t.context.runMarketingAgent(), /3 report\(s\) failed/);
  assert.deepEqual(djNames(t), ['Good DJ']);
  assert.equal(t.files.find(f => f.getId() === 'GOOD').folder, 'OUTPUT');
  for (const [id, pattern] of [['AUTH', /HTTP 401 \(invalid_api_key\)/], ['QUOTA', /HTTP 429 \(insufficient_quota\)/],
    ['REFUSE', /refused extraction/]]) {
    const section = job(t, id).sections[0];
    assert.equal(section.failed, true, id + ' is not retried automatically');
    assert.match(section.error, pattern);
    assert.equal(t.files.find(f => f.getId() === id).folder, 'INPUT');
  }
  assert.match(job(t, 'AUTH').sections[0].error, /sk-\[redacted\]/);
  assert.doesNotMatch(t.runLog() + JSON.stringify(t.properties).replace(JSON.stringify(OPENAI_KEY), ''),
    /SECRET1234567890/, 'the OpenAI key never reaches logs or job state');
  t.clock.now += 2 * 60 * 60 * 1000;
  const requests = t.requests.length;
  assert.equal(t.context.runMarketingAgent().processed, 0);
  assert.equal(t.requests.length, requests, 'permanent failures wait for marketingRetryFailedReports');
});

test('provider configuration is validated before any request and the model is configurable', () => {
  const unsupported = openAI(() => { throw Error('no request expected'); }, {MARKETING_EXTRACTION_PROVIDER: 'claude'});
  unsupported.upload('X', []);
  assert.throws(() => unsupported.context.runMarketingAgent(), /Unsupported MARKETING_EXTRACTION_PROVIDER 'claude'/);
  const missing = openAI(() => { throw Error('no request expected'); });
  delete missing.properties.OPENAI_API_KEY;
  missing.upload('X', []);
  assert.throws(() => missing.context.runMarketingAgent(), /Missing Script Property: OPENAI_API_KEY/);
  const custom = openAI(() => oaOk([oaRecord({name_dj_alias: 'DJ', email_address: 'dj@example.test'})]),
    {OPENAI_EXTRACTION_MODEL: 'gpt-6-sol', OPENAI_REASONING_EFFORT: 'low'});
  custom.upload('X', []);
  assert.equal(custom.context.runMarketingAgent().processed, 1);
  assert.equal(custom.requests[0].body.model, 'gpt-6-sol');
  assert.deepEqual(custom.requests[0].body.reasoning, {effort: 'low'});
});

// --- Stabilization: page subsets, report sections, informational notes, content fingerprint ---
function classicPdf(tag, pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /MediaBox [0 0 612 792] /Kids [' +
      Array.from({length: pageCount}, (_, i) => (i + 3) + ' 0 R').join(' ') + '] /Count ' + pageCount + ' >>'];
  for (let i = 0; i < pageCount; i++) objects.push('<< /Type /Page /Parent 2 0 R /Contents (page ' + (i + 1) + ' >> text) >>');
  let out = '%PDF-1.4\n%PDF ' + tag + '\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; return at; });
  const xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f\r\n' +
    offsets.map(at => String(at).padStart(10, '0') + ' 00000 n\r\n').join('') +
    'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R /ID [<AB> <CD>] >>\nstartxref\n' + xref + '\n%%EOF\n';
  return out;
}

test('each section sends only its pages plus context, in original page numbering, with whole-PDF fallback', () => {
  const sent = [];
  const t = openAI((id, scope, attempt) => {
    const request = t.requests[t.requests.length - 1];
    const bytes = Buffer.from(request.body.input[0].content[0].file_data.split(',')[1], 'base64');
    const layout = t.context.marketingPdfLayout_(bytes);
    const pages = layout.kids.map(kid => Number(kid.split(' ')[0]) - 2);
    sent.push(Array.from(pages));
    const first = Number(request.body.input[0].content[1].text.match(/begins on original page (\d+)/)[1]);
    return oaOk([oaRecord({name_dj_alias: 'DJ ' + first, email_address: 'dj' + first + '@example.test', comments: 'Nice'})]);
  });
  const file = t.upload('SUB', []);
  const pdf = classicPdf('SUB', 9);
  file.getBlob = () => ({getBytes: () => Buffer.from(pdf, 'latin1'), getDataAsString: () => pdf});
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.deepEqual(sent, [[1, 2, 3, 4], [1, 3, 4, 5, 6, 7], [1, 6, 7, 8, 9]]);
  const scope = t.requests[1].body.input[0].content[1].text;
  assert.match(scope, /only original pages 1, 3, 4, 5, 6, 7; file page 1 is original page 1, file page 2 is original page 3/);
  assert.match(scope, /begins on original page 4 through original page 6\./);
  assert.match(t.requests[2].body.input[0].content[1].text, /begins on original page 7 through original page 9\./);
  // The excerpt is an incremental update: the original bytes are unchanged and the page objects are shared.
  const subset = Buffer.from(t.requests[0].body.input[0].content[0].file_data.split(',')[1], 'base64').toString('latin1');
  assert.ok(subset.startsWith(pdf));
  assert.match(subset.slice(pdf.length), /^\n2 0 obj\n<< \/Type \/Pages \/MediaBox \[0 0 612 792\] \/Kids \[3 0 R 4 0 R 5 0 R 6 0 R\] \/Count 4 >>/);
  assert.match(subset, /trailer\n<< \/Size 12 \/Root 1 0 R \/ID \[<AB> <CD>\] \/Prev \d+ >>\nstartxref\n\d+\n%%EOF\n$/);
  assert.deepEqual(djNames(t), ['DJ 1', 'DJ 4', 'DJ 7']);
  assert.equal(t.properties.MA_JOB_SUB, undefined, 'job removed after finalizing');

  // Encrypted or cross-reference-stream PDFs and nested page trees fall back to the whole file.
  const ctx = t.context;
  assert.equal(ctx.marketingPdfLayout_(Buffer.from(pdf.replace('/ID [<AB> <CD>]', '/Encrypt 9 0 R'), 'latin1')), null);
  assert.equal(ctx.marketingPdfLayout_(Buffer.from('%PDF-1.5\n1 0 obj << /Type /XRef >> endobj\nstartxref\n9\n%%EOF', 'latin1')), null);
  assert.equal(ctx.marketingPdfLayout_(Buffer.from(pdf.replace('/Type /Page /Parent', '/Type /Pages /Parent'), 'latin1')), null);
  const whole = ctx.marketingSectionPayload_({bytes: Buffer.from('%PDF x << /Type /Page >>'), pageCount: 1}, {first: 1, last: null});
  assert.equal(whole.scope, '');
});

test('report section headings and row status stay distinct; continued tables are labelled, not reinterpreted', () => {
  const t = openAI((id, scope) => {
    if (scope === '1') return oaOk([
      oaRecord({name_dj_alias: 'Rated DJ', rating: '4', report_section: 'DJs', campaign_status: 'DJs', email_address: 'r@example.test'}),
      oaRecord({name_dj_alias: 'Quiet DJ', report_section: 'Checked No Feedback', campaign_status: 'Listened 3 days ago',
        email_address: 'q@example.test'})]);
    if (scope === '4') return oaOk([
      oaRecord({name_dj_alias: 'Later DJ', campaign_status: 'Listened 5 days ago', email_address: 'l@example.test'}),
      oaRecord({name_dj_alias: 'Rated Later', rating: '5', report_section: 'Radio', campaign_status: 'Radio', email_address: 'rl@example.test'})]);
    return oaOk([oaRecord({name_dj_alias: 'Pool DJ', campaign_status: 'Downloaded No Feedback', email_address: 'p@example.test'})]);
  });
  t.upload('SEC', [], 'application/pdf', 'sections.pdf', 9);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  const rows = t.actionable();
  const status = name => rows.find(row => row['DJ Name'] === name)['Engagement Status'];
  assert.equal(status('Quiet DJ'), 'Report section: Checked No Feedback\nListened 3 days ago\nConfirmed listen');
  assert.equal(status('Later DJ'), 'Report section: Checked No Feedback\nListened 5 days ago\nConfirmed listen');
  assert.equal(status('Pool DJ'), 'Downloaded No Feedback\nConfirmed download', 'an unheaded table after a rated row is not relabelled');
  const report = t.books.SOURCE.sheets.find(sheet => sheet.rows.some(row => row.includes('Later DJ')));
  const header = report.rows[0];
  const later = report.rows.find(row => row.includes('Later DJ'));
  assert.equal(later[header.indexOf('Report Section')], 'Checked No Feedback');
  assert.equal(later[header.indexOf('Report Section Basis')], 'Table continued from an earlier page');
  const quiet = report.rows.find(row => row.includes('Quiet DJ'));
  assert.equal(quiet[header.indexOf('Report Section Basis')], '');
});

test('unparsed affiliation text is an informational note, not a mandatory review', () => {
  const t = integration();
  t.upload('INFO', [sourceRecord({'Name / DJ Alias': 'Info DJ', 'Email Address': 'info@example.test',
    'Additional Info / Stations': 'Club Night Residency, Somewhere'})]);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  const contact = t.contact(1);
  assert.equal(contact['Review Status'], 'Not Reviewed');
  assert.match(contact['Review Notes'], /^Info: unparsed affiliation\/location: Club Night Residency, Somewhere — /);
  const log = t.books.DATABASE.getSheetByName('Import_Log');
  const completed = JSON.parse(log.rows.find(row => row[6] === 'Completed')[8]);
  assert.equal(completed.review, 0);
  assert.equal(completed.warnings, 1);
});

test('an identical report uploaded as a new Drive file is recognised by content and not extracted or imported again', () => {
  const t = integration();
  const original = t.upload('ORIG', [sourceRecord({'Name / DJ Alias': 'Copy DJ', 'Email Address': 'copy@example.test'})]);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  const fingerprint = Object.keys(t.properties).find(key => key.startsWith('MA_CONTENT_'));
  assert.deepEqual(JSON.parse(t.properties[fingerprint]).fileId, 'ORIG');
  const contacts = JSON.stringify(t.master.rows);
  const actionable = JSON.stringify(t.actionable());
  const tabs = t.books.SOURCE.sheets.length;
  const calls = t.calls.length;

  const copy = t.upload('COPY', [], 'application/pdf', 'renamed copy.pdf');
  copy.getBlob = original.getBlob;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.equal(t.calls.length, calls, 'no extraction request for identical content');
  assert.equal(copy.folder, 'OUTPUT');
  assert.equal(JSON.stringify(t.master.rows), contacts, 'no duplicate contacts or campaign history');
  assert.equal(JSON.stringify(t.actionable()), actionable);
  assert.equal(t.books.SOURCE.sheets.length, tabs, 'no second report tab');
  assert.deepEqual(JSON.parse(t.properties.MA_REPORT_COPY),
    {sheetId: JSON.parse(t.properties[fingerprint]).sheetId, state: 'IMPORTED', duplicateOf: 'ORIG'});

  // A changed file is still extracted normally.
  t.upload('CHANGED', [sourceRecord({'Name / DJ Alias': 'Changed DJ', 'Email Address': 'changed@example.test'})]);
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.equal(t.calls.length, calls + 1);
  assert.deepEqual(djNames(t), ['Changed DJ', 'Copy DJ']);
});

test('identical copies wait only for a live job, and stale fingerprints are replaced', () => {
  const t = integration();
  const original = t.upload('FIRST', [sourceRecord({'Name / DJ Alias': 'Wait DJ', 'Email Address': 'wait@example.test'})]);
  const digest = t.context.marketingDigest_(original.getBlob().getBytes());
  t.properties['MA_CONTENT_' + digest] = JSON.stringify({fileId: 'DELETED_EARLIER', sheetId: 999});
  original.failExtraction = true;
  assert.throws(() => t.context.runMarketingAgent(), /1 report\(s\) failed/);
  assert.ok(t.properties.MA_JOB_FIRST, 'retryable failure keeps the job');
  const calls = t.calls.length;

  const copy = t.upload('SECOND', [], 'application/pdf', 'copy.pdf');
  copy.getBlob = original.getBlob;
  t.context.runMarketingAgent();
  assert.equal(t.calls.length, calls, 'a copy waits while the original job is live in the input folder');
  assert.equal(copy.folder, 'INPUT');
  assert.equal(t.properties.MA_JOB_SECOND, undefined);

  // The user deletes the stuck original; its leftover job must not hold the copy forever.
  original.folder = 'TRASH';
  original.failExtraction = false;
  assert.equal(t.context.runMarketingAgent().processed, 1);
  assert.equal(t.calls.length, calls + 1);
  assert.equal(copy.folder, 'OUTPUT');
  assert.deepEqual(djNames(t), ['Wait DJ']);
  assert.equal(JSON.parse(t.properties['MA_CONTENT_' + digest]).fileId, 'SECOND',
    'a fingerprint pointing to a missing import is replaced');
});
