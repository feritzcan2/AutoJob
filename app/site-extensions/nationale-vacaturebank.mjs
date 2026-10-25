// @ts-check
// Nationale Vacaturebank site extension, kind dom (per-site extensions
// requested 2026-10-05). The search page renders client-side: a result list
// of job cards beside a preview of the selected listing. The generic reader
// would leave the preview's company, place and filter links
// (/vacatures/werkgever/…, /vacatures/plaats/…) and the menu's place and
// job-title pages to card triage among the listings. Each card (article.JobCard_card__*) holds one listing link,
// /vacature/<uuid>/<slug>; save and "open in new tab" are buttons. The two
// "Topbaan" cards on top are promoted listings and shown on every load.
// More results load on scroll (the page fetches the site API ten at a time);
// the address has no page parameter (?page=2 shows the first results again),
// so the extension asks the scan to scroll for more (pagination `more`). Listing pages show
// similar listings in the same cards but no result count, and carry one
// schema.org JobPosting that the generic reader takes. DPG Media's privacy
// gate (myprivacy.dpgmedia.nl) is another host and stays with the generic
// consent handling. Observed 2026-10-16 from saved Chrome pages.
export const isNationaleVacaturebankUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?nationalevacaturebank\.nl$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; nationaleVacaturebankResults() decides.
// Class names carry a build hash after "__", so only their prefix is matched.
export function collectNationaleVacaturebankPage() {
  const line = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const total = document.querySelector('[class*="_totalNumberOfJobs__"]');
  return {
    url: location.href,
    total: total ? line(total) : null,
    cards: [...document.querySelectorAll('article[class*="JobCard_card__"]')].map((card) => ({
      hrefs: [...card.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
      title: line(card.querySelector('h2')),
      badge: line(card.querySelector('[class*="JobCard_badge__"]')),
      company: line(card.querySelector('[class*="JobCard_companyName__"]')),
      location: line(card.querySelector('[class*="JobCard_companyDetails__"] > span')),
      attributes: [...card.querySelectorAll('[class*="JobCard_attribute__"]')]
        .map(line)
        .filter(Boolean),
      age: line(card.querySelector('[class*="JobCard_publishedDate__"]')),
    })),
  };
}

const LISTING_PATH =
  /^\/vacature\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+\/?$/i;
// The card's listing address. The id and slug in the path name the listing;
// cards carry no query, so none is kept.
function listingUrl(hrefs, base) {
  const urls = hrefs
    .map((href) => {
      try {
        const u = new URL(href, base);
        return isNationaleVacaturebankUrl(u.href) && LISTING_PATH.test(u.pathname)
          ? `${u.origin}${u.pathname}`
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return new Set(urls).size === 1 ? urls[0] : null;
}

// Returns {listings,pagination} for a page of result cards, or null when there
// are none (still loading, the privacy gate, a changed layout) or the page is
// a listing with similar listings beside it; the generic reader then handles
// the page. More results load by scrolling the same page: pagination asks for
// that while fewer cards than the result count ("1.272 banen") are loaded, and
// is empty (the last results) once all are. Promoted cards count toward the
// result count too.
export function nationaleVacaturebankResults(raw) {
  if (!raw?.cards?.length || !isNationaleVacaturebankUrl(raw.url) || !raw.total) return null;
  const total = Number(/^([\d.]+)/.exec(raw.total)?.[1].replaceAll('.', ''));
  const listings = new Map();
  for (const card of raw.cards) {
    const url = listingUrl(card.hrefs ?? [], raw.url);
    if (!url) return null;
    if (!listings.has(url))
      listings.set(url, {
        url,
        text: card.title || '',
        siteCard: [
          card.badge,
          card.title,
          card.company,
          card.location,
          ...(card.attributes ?? []),
          card.age,
        ]
          .filter(Boolean)
          .join(' · '),
      });
  }
  return {
    listings: [...listings.values()],
    pagination: !total ? null : listings.size < total ? [{text: 'More results', more: true}] : [],
  };
}

// Runs inside the page: the last result card. Bringing it into view loads the
// next ten results.
export function nationaleVacaturebankMore() {
  return [...document.querySelectorAll('article[class*="JobCard_card__"]')].at(-1) ?? null;
}

// The search address seen in the saved pages (2026-10-16). The page asks the
// site API for sort=date itself; the address takes no sort or page parameter.
const search = {
  template: 'https://www.nationalevacaturebank.nl/vacature/zoeken?query={query}',
  pagination: 'infinite_scroll',
  filters: [],
  notes:
    'Results load ten at a time as the page is scrolled; ?page=N is ignored and shows the first results again. Two promoted "Topbaan" cards stay on top of every search. Listings open as /vacature/<id>/<slug>.',
};

export default {
  id: 'nationale-vacaturebank',
  matches: isNationaleVacaturebankUrl,
  dom: {
    collect: collectNationaleVacaturebankPage,
    results: nationaleVacaturebankResults,
    more: nationaleVacaturebankMore,
  },
  search,
};
