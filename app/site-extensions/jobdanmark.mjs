// @ts-check
// Jobdanmark site extension (HTTP reader; per-site extensions requested
// 2026-10-05). The search page /jobsoeger/find-job renders in the browser from
// a JSON search (POST /api/jobsearch/search/{page}) that has no descriptions,
// so the reader turns the page's own address (?freetext=…&municipality=…&p=N)
// into that call and lists the results as listing links. Listings
// (/job/<slug>) are server-rendered without a JobPosting; their text and facts
// are read from the HTML, and a removed one redirects to the search page.
// Observed 2026-10-16. Everything after the read stays generic.
import {decode, htmlText, inlineText, listingPage} from './listing.mjs';
import {
  READER_HEADERS,
  siteFetch,
  isMissing,
  readerPage,
  htmlPage,
  htmlTitle,
  pageEntries,
} from './http.mjs';

const BROWSER = 'Jobdanmark reader';
const ORIGIN = 'https://jobdanmark.dk';
const SEARCH_PATH = /^\/jobsoeger\/find-job\/?$/;
const LISTING_PATH = /^\/job\/([^/]+)\/?$/;
// Address parameters the page sends as search filters, in its own names.
const FILTER_TYPES = [
  'freetext',
  'category',
  'jobtitle',
  'city',
  'municipality',
  'administrativeRegion',
  'region',
  'zip',
];
const JOB_TYPES = ['fuldtid', 'deltid', 'fleksjob', 'elev', 'studiejob', 'praktik'];
// Parameters the page resolves through further lookups (an address, a place
// slug); the reader leaves those addresses to the browser.
const LOOKUP_PARAMS = ['location', 'locationMode', 'distance', 'addressId'];

export const isJobdanmarkUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?jobdanmark\.dk$/.test(u.hostname);
  } catch {
    return false;
  }
};

// {kind:'search', url, page, body, problem?} for the search page without path
// segments or lookup parameters, {kind:'listing', url} for /job/<slug>, else null.
export function jobdanmarkRequest(value) {
  if (!isJobdanmarkUrl(value)) return null;
  const url = new URL(value);
  url.hash = '';
  if (LISTING_PATH.test(url.pathname))
    return {kind: /** @type {const} */ ('listing'), url: url.href};
  if (!SEARCH_PATH.test(url.pathname)) return null;
  const params = url.searchParams;
  if (LOOKUP_PARAMS.some((param) => params.has(param))) return null;
  const p = params.get('p') ?? '1';
  if (!/^[1-9]\d*$/.test(p)) return null;
  const values = (param) =>
    params
      .getAll(param)
      .map((v) => v.trim())
      .filter(Boolean);
  const filters = FILTER_TYPES.flatMap((type) =>
    values(type).map((value) => ({type, value, displayText: value})),
  );
  const jobTypes = values('jobtype');
  const unknown = jobTypes.filter((type) => !JOB_TYPES.includes(type));
  const notNumeric = filters.filter(
    (f) => ['category', 'jobtitle'].includes(f.type) && !/^\d+$/.test(f.value),
  );
  const problem = unknown.length
    ? `Jobdanmark has no job type ${unknown.join(', ')}; it knows ${JOB_TYPES.join(', ')}.`
    : notNumeric.length
      ? `Jobdanmark ${notNumeric[0].type} filters take a numeric id, not "${notNumeric[0].value}".`
      : null;
  return {
    kind: /** @type {const} */ ('search'),
    url: url.href,
    page: Number(p),
    body: {jobTypes, filters, locationMode: 'Text', distance: 50},
    ...(problem ? {problem} : {}),
  };
}

// The search is the site's own JSON POST, sent through the shared site access
// rules like every other read.
async function postSearch(page, body, options = {}) {
  const response = await siteFetch(`${ORIGIN}/api/jobsearch/search/${page}`, {
    ...options,
    site: 'Jobdanmark',
    method: 'POST',
    headers: {...READER_HEADERS, Accept: 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Object.assign(Error(`Jobdanmark search failed (HTTP ${response.status}).`), {
      url: options.url,
    });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(Error('Jobdanmark search returned no JSON.'), {url: options.url});
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;
const isoDate = (value) => {
  const m = String(value ?? '').match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2})[.:](\d{2}))?/);
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4].padStart(2, '0')}:${m[5]}` : ''}` : '';
};
const text = (value) => (typeof value === 'string' ? inlineText(value) : '');

// {jobs, page, totalPages, total} of a search response; throws on any other
// shape, so a changed or partial answer never reads as an empty search.
export function parseJobdanmarkSearch(data) {
  if (
    !data ||
    !Array.isArray(data.items) ||
    !count(data.currentPage) ||
    !count(data.totalPages) ||
    !count(data.totalItems)
  )
    throw Error('Jobdanmark search returned an unexpected response.');
  const jobs = data.items.map((item) => {
    const path = typeof item?.url === 'string' ? item.url : '';
    if (!LISTING_PATH.test(path) || !text(item.title))
      throw Error('Jobdanmark search returned a result without a listing address or title.');
    return {
      url: new URL(path, ORIGIN).href,
      title: text(item.title),
      company: text(item.companyName),
      address: text(item.companyAddress),
      jobTypes: Array.isArray(item.jobTypes) ? item.jobTypes.map(text).filter(Boolean) : [],
      postedAt: isoDate(item.publishedDate),
      deadline: isoDate(item.applicationDeadline),
      promoted: item.boostJob === true,
    };
  });
  return {
    jobs,
    page: data.currentPage,
    totalPages: data.totalPages,
    total: data.totalItems,
  };
}

// A results page: the listings as listing links in the site's order (promoted
// listings first on page 1, then the newest) and the next page while the
// stated page count is not reached.
export function jobdanmarkSearchPage(url, page, {jobs, totalPages, total}) {
  const unique = [...new Map(jobs.map((job) => [job.url, job])).values()];
  const lines = [
    `Jobdanmark job search results, page ${totalPages ? `${page} of ${totalPages}` : page} (${total} listings)`,
  ];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = card(job);
    if (facts) lines.push(facts);
  }
  if (!unique.length)
    lines.push(
      total
        ? 'This results page has no listings: the search has no further results.'
        : 'This search has no results.',
    );
  const next = new URL(url);
  next.searchParams.set('p', String(page + 1));
  return readerPage({
    browser: BROWSER,
    url,
    title: 'Jobdanmark jobs',
    text: lines.join('\n'),
    links: unique.map((job) => ({
      text: job.title,
      url: job.url,
      listing: true,
      siteCard: [job.title, card(job)].filter(Boolean).join(' · '),
    })),
    pagination: pageEntries(url, page, totalPages || null, page < totalPages ? next.href : null),
  });
}
const card = (job) =>
  [
    job.company,
    job.address,
    job.jobTypes.join(', '),
    job.postedAt && `published ${job.postedAt}`,
    job.deadline && `deadline ${job.deadline}`,
    job.promoted && 'promoted',
  ]
    .filter(Boolean)
    .join(' · ');

// The inner HTML of the first <div> whose class list has `name`, up to its
// matching close tag; null when absent or unbalanced.
function divContent(html, name) {
  const open = new RegExp(`<div\\b[^>]*\\bclass="(?:[^"]*\\s)?${name}(?:\\s[^"]*)?"[^>]*>`, 'i');
  const start = html.match(open);
  if (!start || start.index === undefined) return null;
  const from = start.index + start[0].length;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = from;
  let depth = 1;
  for (let m; (m = tags.exec(html));)
    if (!(depth += m[1] ? -1 : 1)) return html.slice(from, m.index);
  return null;
}
const OVERVIEW = {
  arbejdssted: 'location',
  jobtype: 'employmentType',
  udgivet: 'postedAt',
  ansøgningsfrist: 'deadline',
};

// {title, company, description, fields} of a listing page, or null when the
// page has no listing details (a changed layout, another page).
export function parseJobdanmarkListing(html) {
  const details = divContent(html, 'job-list-details');
  if (details === null) return null;
  const head = divContent(details, 'job-details-head') ?? '';
  const body = divContent(details, 'job-details-body') ?? details;
  const fields = {
    company: inlineText(
      head.match(/<ul\b[^>]*class="meta"[\s\S]*?<strong\b[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? '',
    ),
  };
  const overview = html.match(/<ul\b[^>]*class="job-overview\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1];
  for (const item of (overview ?? '').split(/<li\b[^>]*>/i).slice(1)) {
    const m = item.match(/^\s*<strong\b[^>]*>([\s\S]*?):?\s*<\/strong>([\s\S]*)$/i);
    const key = m && OVERVIEW[inlineText(m[1]).replace(/:$/, '').toLowerCase()];
    if (!key) continue;
    const value = inlineText(m[2]);
    fields[key] = key === 'postedAt' || key === 'deadline' ? isoDate(value) || value : value;
  }
  const apply = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((m) => m[0])
    .find((tag) => /\bclass="(?=[^"]*\baction\b)(?=[^"]*\bprimary\b)[^"]*"/i.test(tag));
  const href = apply?.match(/\bhref="([^"]+)"/i)?.[1];
  if (href)
    try {
      fields.applyUrl = new URL(decode(href), ORIGIN).href;
    } catch {}
  return {
    title: inlineText(head.match(/<h5\b[^>]*class="title"[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? ''),
    description: htmlText(body),
    fields,
  };
}

const removedPage = (url) =>
  readerPage({
    browser: BROWSER,
    url,
    title: 'Jobdanmark job',
    text: 'This Jobdanmark listing was not found; it has been removed or is no longer available.',
  });

// A listing through its details block; a page without one is read as its
// visible text.
export function jobdanmarkListingPage(url, html) {
  const listing = parseJobdanmarkListing(html);
  if (!listing)
    return readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Jobdanmark job',
      text: htmlPage(html),
    });
  const title = listing.title || htmlTitle(html).replace(/\s*\|\s*Jobdanmark\s*$/i, '');
  return listingPage({browser: BROWSER, url, ...listing, title});
}

export async function readJobdanmark(url, options = {}) {
  const request = jobdanmarkRequest(url);
  if (!request) throw Error('Jobdanmark reader does not handle this address');
  if (request.kind === 'search') {
    if (request.problem) throw Object.assign(Error(request.problem), {url});
    const data = await postSearch(request.page, request.body, {...options, url});
    let result;
    try {
      result = parseJobdanmarkSearch(data);
    } catch (error) {
      throw Object.assign(error, {url});
    }
    if (result.page !== request.page)
      throw Object.assign(
        Error(`Jobdanmark answered page ${result.page} for page ${request.page}.`),
        {url},
      );
    return jobdanmarkSearchPage(request.url, request.page, result);
  }
  const response = await siteFetch(request.url, {...options, site: 'Jobdanmark', url});
  // A removed listing redirects to the search page.
  const landed = response.redirected && response.url ? new URL(response.url).pathname : null;
  if (isMissing(response) || (landed !== null && !LISTING_PATH.test(landed)))
    return removedPage(url);
  return jobdanmarkListingPage(url, await response.text());
}

export default {
  id: 'jobdanmark',
  matches: isJobdanmarkUrl,
  http: {handles: (url) => Boolean(jobdanmarkRequest(url)), read: readJobdanmark},
  // The search page's own address parameters (observed 2026-10-16 in its
  // script and checked against the JSON search). No sort control, but the
  // default order is newest first (checked 2026-10-18 for udvikler, python and
  // sygeplejerske: publishedDate never stepped back across pages 1, 2, 3 and 20);
  // only page 1 puts its few promoted, older listings first.
  search: {
    template: `${ORIGIN}/jobsoeger/find-job?freetext={query}`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {param: 'municipality', label: 'Municipality'},
      {
        param: 'administrativeRegion',
        label: 'Region',
        values: Object.fromEntries(
          ['Hovedstaden', 'Sjælland', 'Syddanmark', 'Midtjylland', 'Nordjylland'].map((r) => [
            `Region ${r}`,
            `Region ${r}`,
          ]),
        ),
      },
      {
        param: 'region',
        label: 'Part of the country',
        values: Object.fromEntries(
          [
            'Byen København',
            'Københavns omegn',
            'Nordsjælland',
            'Bornholm',
            'Østsjælland',
            'Vest- og Sydsjælland',
            'Sjælland',
            'Fyn',
            'Sydjylland',
            'Østjylland',
            'Vestjylland',
            'Nordjylland',
            'Jylland',
          ].map((r) => [r, r]),
        ),
      },
      {param: 'zip', label: 'Postcode'},
      {
        param: 'category',
        label: 'Category',
        values: {
          227972: 'Teaching, education and research',
          227973: 'Crafts, industry, transport and agriculture',
          227974: 'Sales, communication, marketing and design',
          227975: 'Care, social work and health',
          227976: 'Hotel, service, restaurant and security',
          227977: 'Office, finance and economics',
          227978: 'IT, engineering and energy',
          227979: 'Management, HR and project management',
          543415: 'Church, culture and entertainment',
          227980: 'Other jobs',
        },
      },
      {
        param: 'jobtype',
        label: 'Job type',
        values: {
          fuldtid: 'Full time',
          deltid: 'Part time',
          fleksjob: 'Flex job',
          elev: 'Apprentice',
          studiejob: 'Student job',
          praktik: 'Internship',
        },
      },
    ],
    notes:
      '30 listings per page via &p=N (page 1 has no p); the search states its page count. freetext matches words in the title and text, also as word prefixes (udvikler matched 1531 listings on 2026-10-16); repeated freetext parameters are ORed. Filters repeat the same way (two municipality values are either). municipality takes a municipality name (Aarhus, København), zip a postcode; an unknown name gives no results. category ids come from /api/jobsearch/settings. Order: promoted listings first on page 1, then newest first; there is no sort parameter. Addresses with path segments (/find-job/fuldtid/aarhus) or location, distance and addressId parameters are left to the browser. Listings are https://jobdanmark.dk/job/<slug>.',
  },
};
