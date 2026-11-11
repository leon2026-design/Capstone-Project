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
      getAs: type => { assert.equal(type, 'application/pdf'); return {id: id.replace('TEMP_', '')}; },
      setTrashed: value => { assert.equal(value, true); trashed.push(id); }
    })
  };
  t.context.Drive = {Files: {copy: (metadata, id, options) => {
    assert.equal(metadata.mimeType, 'application/vnd.google-apps.document');
    assert.equal(options.convert, true);
    conversions.push(id);
    return {id: 'TEMP_' + id};
  }}};
  t.context.geminiParsePDFUndefined = blob => {
    calls.push(blob.id);
    const file = files.find(item => item.getId() === blob.id);
    if (file.failExtraction) return {getResponseCode: () => 429};
    return {getResponseCode: () => 200, getContentText: () => JSON.stringify({
      candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(file.records)}]}}]
    })};
  };
  function upload(id, records, type = 'application/pdf', name = id + '.pdf') {
    const file = {
      records, folder: 'INPUT', failExtraction: false, failMove: false,
      getId: () => id, getName: () => name, getMimeType: () => type,
      getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
      getBlob: () => ({id}),
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
  return {...t, files, conversions, trashed, calls, upload, seed, actionable};
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
  assert.equal(t.books.SOURCE.sheets.length, 2);
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
