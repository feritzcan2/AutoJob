import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'node-html-parser';
import extension, {
  isNationaleVacaturebankUrl,
  collectNationaleVacaturebankPage,
  nationaleVacaturebankResults,
} from '../app/site-extensions/nationale-vacaturebank.mjs';
import {applySiteExtension} from '../app/site-extensions/index.mjs';
import {jobPostingDetail} from '../app/site-extensions/job-posting.mjs';

// Trimmed from pages saved in Chrome on 2026-10-16: two promoted cards, three
// result cards between the site's alert and filter boxes, the preview header.
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/nationale-vacaturebank/${name}`, import.meta.url), 'utf8');
const results = 'https://www.nationalevacaturebank.nl/vacature/zoeken?query=developer';
const listing = (path) => `https://www.nationalevacaturebank.nl/vacature/${path}`;

function collect(t, html, href = results) {
  globalThis.document = parse(html);
  globalThis.location = {href};
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
  });
  return collectNationaleVacaturebankPage();
}

test('result cards become their listing links with the card facts; more load by scrolling', (t) => {
  const raw = collect(t, fixture('search.html'));
  assert.equal(raw.url, results);
  assert.equal(raw.total, '1.283 banen');
  assert.equal(raw.cards.length, 5);
  const read = nationaleVacaturebankResults(raw);
  assert.deepEqual(read.listings.slice(0, 3), [
    {
      url: listing(
        '05078c9f-676b-45cc-9e9b-704f7b33aadf/teamleider-integraal-advies-noord-nederland',
      ),
      text: 'Teamleider Integraal Advies Noord-Nederland',
      siteCard:
        'Topbaan · Teamleider Integraal Advies Noord-Nederland · Goudappel · Leeuwarden · €5.500 - €8.500 · 32 - 40 uur · HBO · Gisteren',
    },
    {
      url: listing('56a62c4a-55e4-422d-b7ac-a6852911e064/business-developer-deeptech-en-startups'),
      text: 'Business Developer – Deeptech & Startups',
      siteCard:
        'Topbaan · Business Developer – Deeptech & Startups · HTCE Site Management B.V. · Eindhoven · €4.009 - €5.600 · 40 uur · HBO · 2 dagen geleden',
    },
    {
      url: listing('cfa0e1d1-81fc-429a-b614-54832d2bdb72/medior-backend-developer'),
      text: 'Medior Backend Developer',
      siteCard:
        'Medior Backend Developer · Nedap · Groenlo · €4.000 - €6.000 · 32 - 38 uur · HBO · Vandaag',
    },
  ]);
  assert.deepEqual(
    read.listings.slice(3).map((l) => l.url),
    [
      listing('6a2389d7-d0d6-493d-9d63-a54b67648187/stack-web-developer'),
      listing('15f92f72-0cdd-4e11-a46c-56a3880cb8f4/developer'),
    ],
  );
  // More results load by scrolling; ?page=N shows the first results again.
  assert.deepEqual(read.pagination, [{text: 'More results', more: true}]);
  // Once every result is loaded the list ends; promoted cards are results too.
  const all = `${read.listings.length} banen`;
  assert.deepEqual(nationaleVacaturebankResults({...raw, total: all}).pagination, []);
});

test('the same results under &page=2 are read the same way', (t) => {
  const read = nationaleVacaturebankResults(
    collect(t, fixture('search.html'), `${results}&page=2`),
  );
  assert.equal(read.listings.length, 5);
  assert.deepEqual(read.pagination, [{text: 'More results', more: true}]);
});

test('preview, menu and saved-listing links are not listings', (t) => {
  const read = nationaleVacaturebankResults(collect(t, fixture('search.html')));
  const document = {
    url: results,
    links: [
      {
        url: listing('cfa0e1d1-81fc-429a-b614-54832d2bdb72/medior-backend-developer'),
        text: 'Medior Backend Developer',
      },
      {
        url: 'https://www.nationalevacaturebank.nl/vacatures/werkgever/goudappel',
        text: 'Goudappel',
      },
      {url: 'https://www.nationalevacaturebank.nl/vacatures/plaats/leeuwarden', text: 'Leeuwarden'},
      {url: 'https://www.nationalevacaturebank.nl/vacature/zoeken', text: 'Vacature overzicht'},
      {
        url: 'https://www.nationalevacaturebank.nl/vacature/zoeken/favorieten',
        text: 'Bewaarde vacatures',
      },
    ],
    pagination: [{text: 'generic', url: null}],
  };
  const marked = applySiteExtension(document, read, 'nationale-vacaturebank');
  assert.deepEqual(
    marked.links.filter((l) => l.listing).map((l) => l.url),
    // Links already on the page keep their place; the other listings follow.
    [read.listings[2], ...read.listings.filter((_, i) => i !== 2)].map((l) => l.url),
  );
  assert.equal(marked.links.filter((l) => !l.listing).length, 4);
  // The extension's own pagination replaces the generic reader's.
  assert.deepEqual(marked.pagination, read.pagination);
  assert.equal(marked.paginationBy, 'nationale-vacaturebank');
  assert.equal(marked.siteExtension, 'nationale-vacaturebank');
});

test('a listing shown twice is one listing; query and fragment are not part of its address', () => {
  const card = {
    hrefs: ['/vacature/15f92f72-0cdd-4e11-a46c-56a3880cb8f4/developer?utm_source=x#top'],
    title: 'Developer',
  };
  const read = nationaleVacaturebankResults({
    url: results,
    total: '3 banen',
    cards: [card, {...card, hrefs: ['/vacature/15f92f72-0cdd-4e11-a46c-56a3880cb8f4/developer']}],
  });
  assert.deepEqual(read.listings, [
    {
      url: listing('15f92f72-0cdd-4e11-a46c-56a3880cb8f4/developer'),
      text: 'Developer',
      siteCard: 'Developer',
    },
  ]);
});

test('a listing page with similar cards, the privacy gate or broken cards leave the generic reader', (t) => {
  assert.equal(nationaleVacaturebankResults(null), null);
  assert.equal(nationaleVacaturebankResults({url: results, total: '0 banen', cards: []}), null);
  // A listing page shows its own and similar listings in the same cards, without a result count.
  const similar = collect(
    t,
    fixture('listing.html'),
    listing('15f92f72-0cdd-4e11-a46c-56a3880cb8f4/developer'),
  );
  assert.equal(similar.cards.length, 2);
  assert.equal(similar.total, null);
  assert.equal(nationaleVacaturebankResults(similar), null);
  // Cards rendered before the count, or a count without cards (still loading).
  const raw = collect(t, fixture('search.html'));
  assert.equal(nationaleVacaturebankResults({...raw, total: null}), null);
  assert.equal(nationaleVacaturebankResults({...raw, cards: []}), null);
  // A card without its listing link, or with a search link instead.
  for (const hrefs of [[], ['/vacature/zoeken'], ['/vacatures/werkgever/goudappel']])
    assert.equal(
      nationaleVacaturebankResults({...raw, cards: [...raw.cards, {hrefs, title: 'X'}]}),
      null,
    );
  // The privacy gate is another host; a gate page there is never read as results.
  assert.equal(
    nationaleVacaturebankResults({
      ...raw,
      url: 'https://myprivacy.dpgmedia.nl/consent?siteKey=x&callbackUrl=https%3A%2F%2Fwww.nationalevacaturebank.nl%2Fprivacygate-confirm',
    }),
    null,
  );
});

test('the listing page carries one JobPosting that the generic reader takes', () => {
  const html = fixture('listing.html');
  const detail = jobPostingDetail(
    {
      title: html.match(/<title>([^<]*)/)[1],
      headings: [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map((m) => m[1]),
      jobPostings: [
        ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
      ].map((m) => m[1]),
    },
    Date.parse('2026-10-16T12:00:00Z'),
  );
  assert.equal(detail.title, 'Developer');
  assert.equal(detail.company, 'CareerValue');
  assert.match(detail.description, /ervaren PHP ontwikkelaar/);
  assert.deepEqual(detail.fields.location, ['Oss, Noord-Brabant, NL']);
  assert.equal(detail.fields.salary, '3000–4500 EUR per month');
});

test('only nationalevacaturebank.nl is matched; it reads in the browser with its search', () => {
  assert.equal(extension.id, 'nationale-vacaturebank');
  assert.equal(isNationaleVacaturebankUrl(results), true);
  assert.equal(isNationaleVacaturebankUrl('https://nationalevacaturebank.nl/'), true);
  for (const url of [
    'http://www.nationalevacaturebank.nl/',
    'https://www.nationalevacaturebank.nl.evil.test/',
    'https://evilnationalevacaturebank.nl/',
    'https://api.nationalevacaturebank.nl/api/jobs/v3/sites/nationalevacaturebank.nl/jobs',
    'https://myprivacy.dpgmedia.nl/consent',
    'not a url',
  ])
    assert.equal(extension.matches(url), false, url);
  assert.equal(typeof extension.dom.collect, 'function');
  assert.equal(extension.http, undefined);
  assert.equal(extension.collector, undefined);
  assert.equal(extension.search.pagination, 'infinite_scroll');
  assert.equal(extension.search.ordering, undefined);
  assert.equal(extension.search.template.replace('{query}', 'developer'), results);
});
