// @ts-check
// Site extensions: per-site readers the user explicitly asked for (2026-10-05).
// Triage, scoring, queues and records stay generic; an extension only reads.
//
// Contract: {id, matches(url)} plus one way of reading the site.
// - dom: {collect, results} runs on the page already open in Chrome. collect
//   runs inside the page and must be self-contained; results(raw, {opened})
//   (opened: the address the tab was navigated to, before any rewrite) returns
//   {listings:[{url,text}],pagination} or null (the generic reader keeps the page).
//   pagination holds the current page and, when there is one, the next page
//   with its url; null when the extension cannot tell. A pagination without a
//   next page tells the scan that this is the last results page. A site that
//   loads more results on the same page gives [{text, more: true}] instead
//   while more remain, and dom.more: runs inside the page like collect and
//   returns the element whose coming into view loads the next results (the
//   last result card). The scan scrolls it into view as a person does and
//   checks that the extension then reads more listings (../jev/more.mjs).
//   Optionally dom.listing {handles(url), open?(url), collect, read(raw)} reads
//   one posting page: open(url) gives the address to open it at in the browser
//   (default url), collect runs inside the page like dom.collect, read(raw) returns
//   {title, company, location, description, fields, closed} or null. Its text
//   becomes the page's listing evidence (like a schema.org JobPosting).
//   Optionally dom.pane {handles(url), key(url), card, collect, read(raw)} reads
//   a results page that shows one listing at a time in a pane beside its cards:
//   handles(url) names such results pages, key(url) gives a listing address's
//   key on the page (or null), card(key) runs inside the page and returns the
//   card to click, collect runs inside the page and returns raw with the key of
//   the listing the pane shows (raw.key), and read(raw) returns what
//   dom.listing.read returns. A scan then clicks each new card on the open
//   results page instead of opening every posting (../jev/pane.mjs).
// - http: {handles(url), read(url, options)} replaces the browser tab for the
//   addresses it handles and returns ordinary Jev page objects, or null for an
//   address it finds it cannot read without a browser (a redirect to another
//   site that renders its content with scripts); the browser tab reads it then.
// - collector: {templateId,searchUrl,acceptsQuery,readPage,readDetail,detail}
//   reads an API; the shared source worker queues its listings for Jev.
//   A card collector (../sources/card-collector.mjs) reads result cards from
//   the API and each listing separately; with listingIn: 'browser' the app
//   opens each listing in the browser and reads it with dom.listing, and with
//   cardsInBrowser it opens the results pages there too (dom.collect/results)
//   and, with dom.pane, reads the listings from the open results page first.
//   Such a site's `pacing` ({minIntervalMs, jitterMs, budget}) spaces and
//   bounds those page views; `pacing.pane` (the same shape) spaces and bounds
//   the card clicks of pane reads, which default to the page pacing.
// Optionally `listingKey(url)`: the one comparison key of a listing the site
// serves under several addresses (country hosts, title slugs), or null to keep
// the generic key. Records and remembered rejections compare listings by it.
// Optionally `suggestSearchValue(field, value, {signal})`: for a value the
// extension cannot write (SearchValueError), the address values the site's own
// lookup gives for it ([{param, value}], best first). The learning trial tries
// them first; the app still checks that the results follow the value.
// Optionally `search` (./search.mjs), or search(url) for a site with one host
// per country: the results address, its order and the filters the site
// accepts, so recipes are built from known parameters.
// A reader that reads a single listing returns it through listingPage()
// (./listing.mjs): title, the listing's own description and named facts. Jev
// then skips filtering site chrome out of that text. Without a description the
// page is an ordinary page.
import {listingPage} from './listing.mjs';
import stepstone from './stepstone.mjs';
import himalayas from './himalayas/index.mjs';
import linkedin from './linkedin.mjs';
import xing from './xing.mjs';
import berlinStartupJobs from './berlin-startup-jobs.mjs';
import arbeitnow from './arbeitnow.mjs';
import indeed from './indeed.mjs';
import freehire from './freehire.mjs';
import dice from './dice.mjs';
import builtIn from './builtin.mjs';
import workable from './workable.mjs';
import simplyhired from './simplyhired.mjs';
import hnHiring from './hn-hiring.mjs';
import themuse from './themuse.mjs';
import weWorkRemotely from './weworkremotely.mjs';
import jobdanmark from './jobdanmark.mjs';
import jobnet from './jobnet.mjs';
import reed from './reed.mjs';
import gupy from './gupy.mjs';
import werkNl from './werk-nl.mjs';
import jobindex from './jobindex.mjs';
import duckduckgo from './duckduckgo.mjs';
import wantedly from './wantedly.mjs';
import jobbankCa from './jobbank-ca.mjs';
import jobbankDk from './jobbank-dk.mjs';
import naukri from './naukri.mjs';
import kariyerNet from './kariyer-net.mjs';
import nationaleVacaturebank from './nationale-vacaturebank.mjs';

export const SITE_EXTENSIONS = [
  stepstone,
  himalayas,
  linkedin,
  xing,
  berlinStartupJobs,
  arbeitnow,
  indeed,
  freehire,
  dice,
  builtIn,
  workable,
  simplyhired,
  hnHiring,
  themuse,
  weWorkRemotely,
  jobdanmark,
  jobnet,
  reed,
  gupy,
  werkNl,
  jobindex,
  duckduckgo,
  wantedly,
  jobbankCa,
  jobbankDk,
  naukri,
  kariyerNet,
  nationaleVacaturebank,
];
export const siteExtensionFor = (url) => SITE_EXTENSIONS.find((e) => e.matches(url)) ?? null;
export const siteListingKey = (url) => {
  try {
    return siteExtensionFor(url)?.listingKey?.(url) ?? null;
  } catch {
    return null;
  }
};
// The address a posting opens at in the browser for the site's posting reader.
export const siteListingAddress = (url) => siteExtensionFor(url)?.dom?.listing?.open?.(url) ?? url;
// What reads this source for the source list: api (collector, only for its
// template), http (reader) or browser (DOM extension on the open page), with
// the site's results address and filters (`search`, ./search.mjs) when known.
export function siteExtensionKind(url, templateId) {
  const extension = siteExtensionFor(url);
  if (!extension) return null;
  if (extension.collector && extension.collector.templateId !== templateId) return null;
  return {
    id: extension.id,
    kind: extension.collector ? 'api' : extension.http ? 'http' : 'browser',
    // A site with one host per country gives the search of this address.
    ...(extension.search
      ? {search: typeof extension.search === 'function' ? extension.search(url) : extension.search}
      : {}),
  };
}
// The HTTP reader that serves this address instead of a browser tab, if any.
export const siteReaderFor = (url) => {
  const reader = siteExtensionFor(url)?.http;
  return reader?.handles(url) ? reader : null;
};

// Marks the extension's listings as listings and every other link on the page
// as not a listing. Links stay visible to agents (filters, sorting); Jev scans
// only queue the marked listings.
export function applySiteExtension(document, read, id) {
  const listings = new Map(read.listings.map((l) => [l.url, l])),
    seen = new Set();
  const links = (document.links ?? []).map((link) => {
    const listing = listings.get(link.url);
    if (!listing) return {...link, listing: false};
    seen.add(link.url);
    return {...listing, ...link, text: link.text || listing.text, listing: true};
  });
  for (const listing of read.listings)
    if (!seen.has(listing.url)) {
      seen.add(listing.url);
      links.push({...listing, listing: true});
    }
  return {
    ...document,
    links,
    pagination: read.pagination ?? document.pagination,
    siteExtension: id,
    ...(read.pagination ? {paginationBy: id} : {}),
  };
}

// Runs a collector of `dom` on the page. Collectors run in Jev's isolated
// world, where the DOM is shared but the page's own globals are not; a reader
// that needs the page's own state (dom.pageWorld) runs in its main world.
export function collectSiteData(page, dom, collect) {
  return dom?.pageWorld && page.evaluateInPageWorld
    ? page.evaluateInPageWorld(collect)
    : page.evaluate(collect);
}

// Reads the extension data of the page in this slot. Errors and unknown pages
// leave the generic document unchanged.
export async function readSiteExtension(slot, document) {
  const extension = siteExtensionFor(document.url);
  const dom = extension?.dom;
  if (!dom) return document;
  if (dom.listing?.handles(document.url)) {
    const raw = await collectSiteData(slot.page, dom, dom.listing.collect).catch(() => null);
    const job = raw?.url === document.url ? dom.listing.read(raw) : null;
    return job?.description ? {...document, siteListing: siteListing(document.url, job)} : document;
  }
  if (!dom.collect) return document;
  const raw = await collectSiteData(slot.page, dom, dom.collect).catch(() => null);
  // A redirect between the two reads would mix two pages.
  const read = raw?.url === document.url ? dom.results(raw, {opened: slot.openedUrl}) : null;
  return read ? applySiteExtension(document, read, extension.id) : document;
}
// A posting a site's own reader read, in the shape of the page's listing
// evidence: its text (title, facts, description) and named facts.
export function siteListing(url, job) {
  const page = listingPage({
    url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: {company: job.company, location: job.location, ...job.fields},
    notes: job.closed ? ['No longer accepting applications.'] : [],
    people: job.people,
  });
  return {
    text: page.text,
    fields: page.listing?.fields ?? {},
    title: job.title,
    ...(page.listing?.people ? {people: page.listing.people} : {}),
  };
}
