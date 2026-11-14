// Synthetic fixtures only. No HTTP requests or real contact records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const c = vm.createContext({ console, URL });
for (const name of ['DJIdentityResolver.js', 'DJEnrichment.js', 'DJEnrichmentOpenAIProvider.js', 'DJEnrichmentLive.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), c);
}
test('Resident Advisor uses artist slug; professional content URLs canonicalize to accounts', () => {
  assert.equal(c.djEnrichmentOpenAIControlled_('https://ra.co/dj/velvetfox', {}, ['Velvet Fox']), true);
  assert.equal(c.djIdentityProfile('https://mixcloud.com/velvetfox/stream/').profileUrl, 'https://mixcloud.com/velvetfox');
  assert.equal(c.djIdentityProfile('https://soundcloud.com/velvetfox/a-track').profileUrl, 'https://soundcloud.com/velvetfox');
  assert.equal(c.djIdentityProfile('https://mixcloud.com/discover/'), null);
});
test('multi-person biography attributes only links in matching heading section', () => {
  const identity = { station: 'Synthetic FM' };
  const names = ['Velvet Fox'];
  const html = '<h2>Other Artist</h2>Synthetic FM instagram.com/otherartist' +
    '<h2>Velvet Fox</h2>Synthetic FM instagram.com/velvetfox' +
    '<h2>Third Artist</h2>instagram.com/thirdartist<h2>Fourth Artist</h2>instagram.com/fourthartist';
  const page = { url: 'https://partners.example/people', controlled: false };
  page.sections = c.djEnrichmentOpenAISections_(html, page, { names });
  page.links = c.djEnrichmentOpenAIPageLinks_(html, page.url, names);
  assert.equal(c.djEnrichmentOpenAIAttributable_(page, page.links.get('https://instagram.com/velvetfox'), identity, names), true);
  assert.equal(c.djEnrichmentOpenAIAttributable_(page, page.links.get('https://instagram.com/otherartist'), identity, names), false);
});

test('explicit alias and exact affiliation support one identity hypothesis', () => {
  const html = 'Rory Vale also known as Velvet Fox, resident at Synthetic FM.';
  const page = { url: 'https://artists.example/rory', html, comparable: c.djEnrichmentOpenAIComparable_(html) };
  const hypothesis = c.djEnrichmentOpenAIHypothesis_(page, { station: 'Synthetic FM' }, ['Rory Vale']);
  assert.equal(hypothesis.aliases[0].value, 'Velvet Fox');
  assert.equal(hypothesis.contactMatch, 'EXACT_AFFILIATION_SUPPORTED');
  const other = c.djEnrichmentOpenAIHypothesis_(page, { station: 'Different FM' }, ['Rory Vale']);
  assert.equal(other.contactMatch, 'UNRESOLVED');
  assert.notEqual(hypothesis.sourceOwnership, 'VERIFIED');
});

test('recursive professional links share fetch budget, preserve hypothesis and stop cycles', () => {
  const root = 'https://artists.example/rory', child = 'https://links.example/rory';
  const html = new Map([[root, 'Rory Vale also known as Velvet Fox, Synthetic FM. <a href="' + child + '">Website</a>'],
    [child, 'Velvet Fox <a href="' + root + '">Website</a> instagram.com/velvetfox']]);
  const calls = [];
  const state = { identity: { station: 'Synthetic FM' }, names: ['Rory Vale'], pages: new Map(),
    fetched: 0, maxPages: 2, allowedHosts: new Set(), session: { maxDepth: 2, deadline: Date.now() + 300000 } };
  c.djEnrichmentOpenAIExplore_(state, { fetch(api, url) { calls.push(url); return {
    getResponseCode: () => 200, getContentText: () => html.get(url), getHeaders: () => ({})
  }; } }, [root]);
  assert.deepEqual(calls, [root, child]);
  assert.equal(state.pages.get(child).hypothesis.id, root);
  assert.equal(state.pages.get(child).namesDJ, true);
});

test('track-page collaborator links never establish official ownership', () => {
  const page = { namesDJ: true, controlled: true, contentPage: true,
    links: new Map([['x', { platform: 'INSTAGRAM' }]]) };
  assert.equal(c.djEnrichmentOpenAIAttributable_(page, { platform: 'INSTAGRAM', handle: 'velvetfox' }, {}, ['Velvet Fox']), false);
});

test('competing identity hypotheses remain separate in candidate storage keys', () => {
  assert.notEqual(c.djEnrichmentHypothesisKey_({ hypothesisId: 'https://us.example/artist' }),
    c.djEnrichmentHypothesisKey_({ hypothesisId: 'https://uk.example/artist' }));
  const candidate = c.djEnrichmentOpenAIAssess_({ platform: 'RADIO_DIRECTORY', sourceUrl: 'https://directory.example/artist' }, null);
  assert.equal(candidate.channelRole, 'IDENTITY_EVIDENCE');
  assert.equal(candidate.assessments.contactIdentity, 'UNRESOLVED');
  assert.equal(candidate.assessments.publication, 'NOT_VERIFIED');
});

test('cohort metrics count contacts separately for social and usable professional channels', () => {
  const summary = c.djEnrichmentBenchmarkSummary([
    { contactId: 'fixture-1', researched: true, instagramCandidate: true, usableChannelConfirmed: true },
    { contactId: 'fixture-2', researched: true, usableChannelConfirmed: true },
    { contactId: 'fixture-3', researched: true, identityAmbiguous: true }
  ]);
  assert.equal(summary.contactsWithInstagramCandidates, 1);
  assert.equal(summary.contactsWithUsableProfessionalChannels, 2);
  assert.equal(summary.contactsWithUnresolvedAmbiguity, 1);
  assert.equal(summary.usage.estimatedUsd, null);
  assert.throws(() => c.djEnrichmentBenchmarkSummary([{ contactId: 'same' }, { contactId: 'same' }]), /unique/);
});

test('deadline and depth budgets prevent further fetches', () => {
  const state = { identity: {}, names: ['Velvet Fox'], pages: new Map(), fetched: 0, maxPages: 6,
    allowedHosts: new Set(), session: { maxDepth: 2, deadline: Date.now() } };
  let calls = 0;
  c.djEnrichmentOpenAIExplore_(state, { fetch() { calls++; } }, ['https://artist.example/about']);
  assert.equal(calls, 0);
  assert.equal(state.pages.get('https://artist.example/about').status, 'BUDGET_EXHAUSTED');
});

test('a named partner biography attributes links without asserting the original contact identity', () => {
  const names = ['Rory Vale'];
  const page = { url: 'https://partner.example/partners', controlled: false };
  const html = '<h2>Rory Vale</h2>Professional DJ instagram.com/velvetfox<h2>Another Person</h2>instagram.com/otherperson';
  page.sections = c.djEnrichmentOpenAISections_(html, page, { names });
  page.links = c.djEnrichmentOpenAIPageLinks_(html, page.url, names);
  assert.equal(c.djEnrichmentOpenAIAttributable_(page, page.links.get('https://instagram.com/velvetfox'), {}, names), true);
  const assessed = c.djEnrichmentOpenAIAssess_({ platform: 'INSTAGRAM', sourceUrl: page.url,
    sourceVerification: 'PAGE_CONTAINS_LINK' }, page);
  assert.equal(assessed.assessments.contactIdentity, 'UNRESOLVED');
  assert.equal(assessed.assessments.profileOwnership, 'ATTRIBUTED_LINK_OBSERVED');
});

test('research deadline honors configured budget and reserves cleanup time', () => {
  assert.equal(c.djEnrichmentLiveResearchDeadline_(1000, 210000), 181000);
  assert.equal(c.djEnrichmentLiveResearchDeadline_(1000, 120000), 91000);
  assert.equal(c.djEnrichmentLiveResearchDeadline_(1000, 600000), 301000);
});

test('a collaborator context from another biography cannot authorize a link', () => {
  const names = ['Rory Vale'];
  const page = { url: 'https://partner.example/partners', controlled: true };
  const html = '<h2>Rory Vale</h2>Collaborator instagram.com/otherperson' +
    '<h2>Other Person</h2>instagram.com/otherperson';
  page.sections = c.djEnrichmentOpenAISections_(html, page, { names });
  page.links = c.djEnrichmentOpenAIPageLinks_(html, page.url, names);
  assert.equal(c.djEnrichmentOpenAIAttributable_(page, page.links.get('https://instagram.com/otherperson'), {}, names), false);
});

test('cross-site redirects and unsafe recursive URLs are not followed', () => {
  const state = { identity: {}, names: ['Rory Vale'], pages: new Map(), fetched: 0, maxPages: 6,
    allowedHosts: new Set(), session: { deadline: Date.now() + 300000 } };
  const calls = [];
  c.djEnrichmentOpenAIFetchPage_('https://artist.example/about', state, { fetch(api, url) {
    calls.push(url); return { getResponseCode: () => 302, getHeaders: () => ({ Location: 'https://other.example/redirect' }) };
  } });
  assert.deepEqual(calls, ['https://artist.example/about']);
  for (const url of ['http://artist.example/', 'https://127.0.0.1/', 'https://user@artist.example/', 'https://service.internal/']) {
    assert.equal(c.djEnrichmentPublicUrl(url), null);
  }
});

test('candidate evidence cannot combine independent professional identity hypotheses', () => {
  const first = 'https://us.example/rory', second = 'https://uk.example/rory';
  const pages = new Map([first, second].map(url => [url, { status: 'FETCHED',
    comparable: 'rory vale synthetic fm', links: new Map(), hypothesis: { id: url, names: ['Rory Vale'] } }]));
  const result = c.djEnrichmentOpenAICandidates_([{ platform: 'WEBSITE', profile_url: first,
    source_url: first, station: 'Synthetic FM', evidence: [{ type: 'STATION_AFFILIATION',
      source_url: second, excerpt: 'Synthetic FM' }] }], [first, second], { pages });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidence.length, 0);
  assert.ok(result.rejected.includes('EVIDENCE_FROM_COMPETING_HYPOTHESIS'));
});
