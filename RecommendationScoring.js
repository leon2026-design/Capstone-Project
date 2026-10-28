/** Phase 1 matching/scoring. No Sheets writes or external API calls. */
const PHASE1_FORMAT_RULES = {
    'Country': [['Country', 'Contemporary Country'], ['Americana', 'Adult Contemporary'], ['Classical', 'Sports', 'News/Talk']],
    'Hip-Hop': [['Urban', 'Rhythmic'], ['Top 40 / CHR'], ['Country', 'Classical', 'News/Talk']],
    'Pop': [['Top 40 / CHR', 'Pop'], ['Hot AC', 'Adult Contemporary'], ['Classical', 'Sports', 'News/Talk']],
    'Rock': [['Mainstream Rock', 'Alternative Rock'], ['AAA', 'Classic Rock'], ['Country', 'Classical', 'Sports']],
    'R&B': [['Urban AC', 'R&B'], ['Rhythmic', 'Adult Contemporary'], ['Country', 'Classical', 'Sports']],
    'Folk / Americana': [['Americana', 'Folk'], ['AAA', 'Country'], ['Urban', 'EDM', 'Sports']],
    'Electronic / Dance / Disco': [['Dance', 'EDM'], ['Top 40 / CHR', 'Rhythmic'], ['Country', 'Classical', 'News/Talk']],
    'Christian / Gospel': [['Contemporary Christian', 'Gospel'], ['Adult Contemporary'], ['EDM', 'Hip-Hop', 'Classical']],
    'Latin': [['Spanish Contemporary', 'Regional Mexican'], ['Rhythmic', 'Top 40 / CHR'], ['Country', 'Classical', 'News/Talk']],
    'Jazz': [['Jazz', 'Smooth Jazz'], ['Adult Contemporary', 'AAA'], ['EDM', 'Hip-Hop', 'Sports']]
  };
  
  // These weights come from Recommendation Scoring v1.
  const PHASE1_WEIGHTS = [40, 25, 15, 10, 10];
  const PHASE1_FACTOR_NAMES = [
    'Genre / Format Fit', 'Geographic Relevance', 'Previous Campaign Response',
    'Existing Relationship / Sponsor Relevance', 'Collaborator / Crossover Relevance'
  ];
  
  // Trims text and turns missing values into "". Rejects non-text values.
  function p1Text(value) {
    if (value == null) return '';
    if (typeof value !== 'string') throw new Error('Text fields must contain strings.');
    return value.trim();
  }
  
  // Makes text comparable by lowercasing it and removing spaces/punctuation.
  function p1Key(value) {
    return p1Text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  
  // Checks that an input, such as target markets, is an array of text values.
  function p1List(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error(label + ' must be an array of nonempty strings.');
    }
    return value.map(v => v.trim());
  }
  
  function p1Genre(value) {
    const key = p1Key(value);
    const aliases = {
      folk: 'Folk / Americana', americana: 'Folk / Americana',
      electronic: 'Electronic / Dance / Disco', dance: 'Electronic / Dance / Disco',
      disco: 'Electronic / Dance / Disco', edm: 'Electronic / Dance / Disco',
      christian: 'Christian / Gospel', gospel: 'Christian / Gospel'
    };
    return Object.keys(PHASE1_FORMAT_RULES).find(g => p1Key(g) === key) || aliases[key];
  }
  
  function p1Format(value) {
    const key = p1Key(value);
    return ({ ac: 'adultcontemporary', chr: 'top40chr', top40: 'top40chr',
      adultcontemporaryac: 'adultcontemporary' })[key] || key;
  }
  
  function p1Country(value) {
    const key = p1Key(value);
    return ({ us: 'unitedstates', usa: 'unitedstates',
      unitedstatesofamerica: 'unitedstates', uk: 'unitedkingdom' })[key] || key;
  }
  
  // Match one station format against a genre's primary/secondary/excluded lists.
  function p1FormatFit(genre, format) {
    const rules = PHASE1_FORMAT_RULES[genre];
    const key = p1Format(format);
    if (rules[2].some(f => p1Format(f) === key)) return -1;
    if (rules[0].some(f => p1Format(f) === key)) return 1;
    if (rules[1].some(f => p1Format(f) === key)) return 0.5;
    return null;
  }
  
  // Proposed geographic ratings: requested market/same state = Strong;
  // same country = Moderate; different country = None; missing country = unassessed.
  function p1Geography(release, station, targetMarkets) {
    if (targetMarkets.some(m => p1Key(m) === p1Key(station.market))) {
      return [1, 'Station serves a sponsor-requested market.'];
    }
    const artistCountry = p1Country(release.artistCountry);
    const stationCountry = p1Country(station.country);
    if (!artistCountry || !stationCountry) return [null, 'Country information is missing.'];
    if (artistCountry !== stationCountry) return [0, 'Outside the artist’s home country.'];
    const artistState = p1Key(release.artistState);
    if (artistState && artistState === p1Key(station.state)) {
      return [1, 'Station is in the artist’s home state/region.'];
    }
    return [0.5, 'Station is in the artist’s home country.'];
  }
  
  // Convert an already-recorded status into a factor value. No prose interpretation.
  function p1EvidenceFactor(status, evidence, allowed, label) {
    const key = p1Key(status);
    if (!key) return [null, label + ' has not been assessed.'];
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) {
      throw new Error('Unsupported ' + label + ': ' + status);
    }
    if (!p1Text(evidence)) throw new Error(label + ' needs an evidence note.');
    return [allowed[key], p1Text(evidence)];
  }
  
  /**
   * Input: one release object and an array of station objects.
   * Output: { recommendations, skipped }.
   * Pass result.recommendations to the EXISTING writeRecommendationOutput().
   *
   * PROPOSED missing-data policy: normalize over assessed weights only.
   * Unknown stays null, not zero. Partial scores are explicitly provisional.
   * Have Brad confirm this policy and geographic/status rules before adoption.
   */
  function generateRecommendations(release, stations) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      throw new Error('Provide one release object.');
    }
    if (!Array.isArray(stations)) throw new Error('Provide an array of stations.');
    for (const field of ['primaryArtist', 'trackName', 'primaryGenre']) {
      if (!p1Text(release[field])) throw new Error('Release is missing ' + field);
    }
    const genre = p1Genre(release.primaryGenre);
    if (!genre) throw new Error('No genre rules exist for ' + release.primaryGenre);
    const targets = p1List(release.targetMarkets, 'targetMarkets');
    const exclusions = p1List(release.excludedMarkets, 'excludedMarkets').map(p1Key);
    // Omitted/null means unknown; [] means reviewed and no additional genre applies.
    const crossoverAssessed = release.crossoverGenres != null;
    const crossoverGenres = p1List(release.crossoverGenres, 'crossoverGenres').map(g => {
      const canonical = p1Genre(g);
      if (!canonical) throw new Error('Unknown crossover genre: ' + g);
      if (canonical === genre) throw new Error('crossoverGenres must not repeat the primary genre.');
      return canonical;
    });
    const recommendations = [];
    const skipped = [];
  
    for (const station of stations) {
      if (!station || typeof station !== 'object' || Array.isArray(station)) {
        throw new Error('Each station must be an object.');
      }
      const name = p1Text(station.radioStation);
      if (!name) throw new Error('A station is missing radioStation.');
      const market = p1Text(station.market);
      const format = p1Text(station.stationFormat);
      if (market && exclusions.includes(p1Key(market))) {
        skipped.push({ radioStation: name, reason: 'Sponsor-excluded market.' });
        continue;
      }
      // Missing market cannot safely pass an explicit market-exclusion filter.
      if (!market && exclusions.length) {
        skipped.push({ radioStation: name, reason: 'Review market before applying exclusions.' });
        continue;
      }
      const genreFit = p1FormatFit(genre, format);
      if (genreFit === -1 || genreFit === null) {
        skipped.push({ radioStation: name, reason: genreFit === -1
          ? 'Station format is excluded for this genre.'
          : 'Station format is missing or not covered by this genre’s rules; review needed.' });
        continue;
      }
  
      // Compute the five factors from the release and station information.
      const geography = p1Geography(release, station, targets);
      const history = p1EvidenceFactor(station.previousResponse, station.responseEvidence,
        { positive: 1, mixed: 0.5, negative: 0, noresponse: 0 }, 'Previous campaign response');
      let relationship = p1EvidenceFactor(station.relationship, station.relationshipEvidence,
        { established: 1, limited: 0.5, none: 0 }, 'Existing relationship');
      if (station.sponsorPriority != null && typeof station.sponsorPriority !== 'boolean') {
        throw new Error('sponsorPriority must be true, false, or omitted.');
      }
      if (station.sponsorPriority === true) {
        if (!p1Text(station.sponsorPriorityEvidence)) throw new Error('Sponsor priority needs an evidence note.');
        relationship = [1, 'Sponsor priority: ' + p1Text(station.sponsorPriorityEvidence)];
      }
      const crossoverFit = crossoverAssessed ? Math.max(0, ...crossoverGenres.map(g => {
        const fit = p1FormatFit(g, format);
        return fit == null || fit < 0 ? 0 : fit;
      })) : null;
      const pairs = [
        [genreFit, genre + ' compared with ' + format + '.'], geography, history, relationship,
        [crossoverFit, crossoverAssessed
          ? 'Additional confirmed genres: ' + (crossoverGenres.join(', ') || 'none') + '.'
          : 'Additional genre/collaborator information is unassessed.']
      ];
      const factors = pairs.map(([value, evidence], i) => ({
        name: PHASE1_FACTOR_NAMES[i], weight: PHASE1_WEIGHTS[i], value, evidence
      }));
      const assessed = factors.filter(f => f.value !== null);
      const assessedWeight = assessed.reduce((sum, f) => sum + f.weight, 0);
      const weightedPoints = assessed.reduce((sum, f) => sum + f.weight * f.value, 0);
      const score = Math.round(weightedPoints / assessedWeight * 1000) / 10;
      const missing = factors.filter(f => f.value === null).map(f => f.name);
  
      // Reasons describe the actual factor results; Gemini is not needed.
      const reason = assessed.map(f => {
        const rating = f.value === 1 ? 'Strong' : f.value === 0.5 ? 'Moderate' : 'None';
        return f.name + ': ' + rating + '. ' + f.evidence;
      }).join(' ');
      const sources = p1Text(station.sources);
      const director = p1Text(station.programDirector);
      const contact = p1Text(station.contactInfo);
      if ((director || contact) && !sources) throw new Error(name + ': contact details need Sources.');

// Check whether the station has a usable source reference.
// A URL supports review, but does not prove the information is verified.
const hasSourceReference =
/https?:\/\/[^\s]+/i.test(sources);

// Check the information needed to support geographic matching.
const coreComplete = Boolean(
market &&
p1Country(station.country) &&
geography[0] !== null
);

// Current inputs do not establish that sources are current and verified.
// Use Medium for complete, sourced records; otherwise use Low.
// Missing optional scoring factors do not affect this decision.
const confidence =
coreComplete && hasSourceReference ? "Medium" : "Low";

// Explain scoring coverage and confidence separately.
const notes = [
"Assessed weight: " + assessedWeight + "/100. " +
  "Score = " + weightedPoints + "/" +
  assessedWeight + " × 100.",

missing.length
  ? "Provisional score; unassessed: " +
    missing.join(", ") + "."
  : "",

!hasSourceReference
  ? "A supporting source URL is needed."
  : "Source currency and accuracy still need verification.",

!coreComplete
  ? "Market or geographic information is incomplete."
  : "",

p1Text(station.reviewNotes)
].filter(Boolean).join(" ");
      // Property names match your existing RecommendationOutput.js.
      recommendations.push({
        primaryArtist: p1Text(release.primaryArtist), trackName: p1Text(release.trackName),
        isrc: p1Text(release.isrc), primaryGenre: p1Text(release.primaryGenre),
        radioStation: name, stationFormat: format, market,
        recommendationScore: score, recommendationReason: reason,
        confidenceLevel: confidence, reviewNotes: notes,
        programDirector: director, contactInfo: contact, sources,
        factorScores: factors // Extra detail for debugging; output writer ignores it.
      });
    }
    return { recommendations, skipped };
  }
  
  /** Synthetic example. Logs results only; does not change any spreadsheet. */
  function demoPhase1Recommendations() {
    const release = {
      primaryArtist: 'Example Artist',
      trackName: 'Example Song',
      primaryGenre: 'Country',
      artistState: 'Ohio',
      artistCountry: 'United States',
      targetMarkets: [],
      excludedMarkets: [],
      crossoverGenres: ['Pop'] // Confirmed additional genre, not inferred from an artist name.
    };
    const stations = [
      {
        radioStation: 'Example Country A',
        stationFormat: 'Contemporary Country',
        market: 'Columbus, Ohio, United States',
        state: 'Ohio',
        country: 'United States',
        previousResponse: 'Positive',
        responseEvidence: 'Synthetic history: positive response in an earlier campaign.',
        relationship: 'Limited',
        relationshipEvidence: 'Synthetic history: one previous interaction.',
        sources: 'Synthetic fixture only; not a verified real station.',
        dataVerified: false
      },
      {
        radioStation: 'Example Country B',
        stationFormat: 'Country',
        market: 'Nashville, Tennessee, United States',
        state: 'Tennessee',
        country: 'United States',
        previousResponse: 'Mixed',
        responseEvidence: 'Synthetic history: mixed response in an earlier campaign.',
        relationship: 'None',
        relationshipEvidence: 'Synthetic sponsor input: no existing relationship.',
        sources: 'Synthetic fixture only; not a verified real station.',
        dataVerified: false
      },
      {
        radioStation: 'Example Talk C',
        stationFormat: 'News/Talk',
        market: 'Columbus, Ohio, United States',
        state: 'Ohio',
        country: 'United States'
      }
    ];
    const result = generateRecommendations(release, stations);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  