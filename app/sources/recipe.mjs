// @ts-check
// A source recipe records how a results page for the current query is reached
// and how it pages. It is data learned per source, never code tied to a site.
// The app verifies every recipe by actually finding listings with it.
// This module is also bundled into the renderer; keep it free of app imports.
function boundedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw Error(`${label}: 1–${max} characters required`);
  return value.trim();
}

export const RECIPE_ENTRY_KINDS = ['url_template', 'search_form', 'discovery'];
export const RECIPE_PAGINATION_KINDS = [
  'auto',
  'url_param',
  'next_link',
  'next_click',
  'load_more',
  'infinite_scroll',
  'none',
];
export const RECIPE_FIELD_KEYS = ['query', 'location'];
// newest_first lets repeat scans stop once consecutive pages hold only known listings.
export const RECIPE_ORDERING_KINDS = ['unknown', 'newest_first'];
export const RECIPE_STALE_FAILURES = 2;
// User rule (2026-10-11, 5 pages since 2026-10-21), for every source scan and every kind of source: each
// search (one per recipe term) reads at most SCAN_SEARCH_PAGES result pages and
// ends with the page that brings its new listings to SCAN_SEARCH_LISTINGS. New
// listings are those the workspace had not recorded or rejected before.
export const SCAN_SEARCH_PAGES = 5;
export const SCAN_SEARCH_LISTINGS = 100;
export const RECIPE_TERM_LIMIT = 5;
// Further search setups beside the main address, for a profile that accepts
// different setups one address cannot carry (remote in a country, hybrid in a
// city). Every term runs in every setup, up to RECIPE_SEARCH_LIMIT searches.
export const RECIPE_VARIANT_LIMIT = 2;
export const RECIPE_SEARCH_LIMIT = 10;
const placeholderPattern = /\{([a-z_][a-z0-9_]*)\}/g;

const webAddress = (value, label) => {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw Error(`${label}: a valid web address is required`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error(`${label}: an HTTP(S) address without user credentials is required`);
  url.hash = '';
  return url.href;
};

export function normalizeSourceRecipe(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid source recipe');
  const entry = input.entry;
  if (!entry || typeof entry !== 'object' || !RECIPE_ENTRY_KINDS.includes(entry.kind))
    throw Error('The recipe method must be url_template, search_form or discovery');
  const recipe = {entry: {kind: entry.kind}};
  if (entry.kind === 'url_template') {
    const template = boundedText(entry.template, 'URL template', 2000);
    // A template without {query} is a fixed results address.
    webAddress(template.replace(placeholderPattern, 'x'), 'URL template');
    recipe.entry.template = template;
    if (entry.variants !== undefined && entry.variants !== null) {
      if (!Array.isArray(entry.variants) || entry.variants.length > RECIPE_VARIANT_LIMIT)
        throw Error(`Search setups: at most ${RECIPE_VARIANT_LIMIT} beside the main address`);
      if (entry.variants.length)
        recipe.entry.variants = entry.variants.map((variant) => {
          const label = boundedText(variant?.label, 'Search setup label', 80),
            address = boundedText(variant?.template, 'Search setup address', 2000);
          webAddress(address.replace(placeholderPattern, 'x'), 'Search setup address');
          if (hasQueryPlaceholder(address) !== hasQueryPlaceholder(template))
            throw Error('Every search setup takes {query} exactly when the main address does');
          return {label, template: address};
        });
    }
  } else if (entry.kind === 'search_form') {
    recipe.entry.url = webAddress(entry.url, 'Search form address');
    if (!Array.isArray(entry.fields) || !entry.fields.length || entry.fields.length > 6)
      throw Error('A search form needs 1–6 fields');
    const seen = new Set();
    recipe.entry.fields = entry.fields.map((field) => {
      if (!field || typeof field !== 'object' || !RECIPE_FIELD_KEYS.includes(field.key))
        throw Error('A form field key must be query or location');
      if (seen.has(field.key)) throw Error('Form field keys must be unique');
      seen.add(field.key);
      return {key: field.key, label: boundedText(field.label, 'Form field label', 120)};
    });
    if (!seen.has('query')) throw Error('The search form needs a query field');
  }
  const pagination = input.pagination ?? 'auto';
  if (!RECIPE_PAGINATION_KINDS.includes(pagination)) throw Error('Invalid pagination type');
  recipe.pagination = pagination;
  if (input.ordering !== undefined && input.ordering !== null && input.ordering !== 'unknown') {
    if (!RECIPE_ORDERING_KINDS.includes(input.ordering))
      throw Error('Ordering must be unknown or newest_first');
    if (recipe.entry.kind !== 'discovery') recipe.ordering = input.ordering;
  }
  if (input.loginRequired !== undefined && input.loginRequired !== null) {
    if (typeof input.loginRequired !== 'boolean')
      throw Error('loginRequired must be true or false');
    recipe.loginRequired = input.loginRequired;
  }
  if (input.notes !== undefined && input.notes !== null && input.notes !== '') {
    recipe.notes = boundedText(input.notes, 'Recipe note', 1000);
  }
  // The criteria values a learned recipe was made for (search-learning.mjs):
  // a recipe that writes a value the site's own way holds only that value.
  if (
    input.learnedFor &&
    typeof input.learnedFor === 'object' &&
    recipe.entry.kind !== 'discovery'
  ) {
    const learned = Object.entries(input.learnedFor).filter(
      ([key, value]) => /^[a-z_][a-z0-9_]*$/.test(key) && typeof value === 'string',
    );
    if (learned.length)
      recipe.learnedFor = Object.fromEntries(
        learned.map(([key, value]) => [key, boundedText(value, 'Learned value', 200)]),
      );
  }
  // Search terms replace {query} when the source query is a description rather
  // than a keyword. Each term is its own search on the same results pattern.
  if (input.terms !== undefined && input.terms !== null && recipe.entry.kind !== 'discovery') {
    if (
      !Array.isArray(input.terms) ||
      !input.terms.length ||
      input.terms.length > RECIPE_TERM_LIMIT
    )
      throw Error(`Search terms: 1–${RECIPE_TERM_LIMIT} items required`);
    recipe.terms = [...new Set(input.terms.map((term) => boundedText(term, 'Search term', 80)))];
    if (recipe.entry.kind === 'url_template' && !hasQueryPlaceholder(recipe.entry.template))
      throw Error('For search terms, the URL template must contain the {query} placeholder');
  }
  const setups = 1 + (recipe.entry.variants?.length ?? 0);
  if (setups * (recipe.terms?.length || 1) > RECIPE_SEARCH_LIMIT)
    throw Error(
      `${setups} search setups × ${recipe.terms.length} terms are more than ${RECIPE_SEARCH_LIMIT} searches; use fewer terms or setups`,
    );
  return recipe;
}
// The addresses a url_template recipe searches: the main one, then its setups.
const recipeTemplates = (recipe) =>
  recipe?.entry.kind === 'url_template'
    ? [{label: null, template: recipe.entry.template}, ...(recipe.entry.variants ?? [])]
    : [];
const hasQueryPlaceholder = (template) =>
  [...template.matchAll(placeholderPattern)].some((m) => m[1] === 'query');
// A search address with {query} but no terms would search for the source
// scope, a description rather than a keyword.
export const recipeNeedsTerms = (recipe) =>
  recipe?.entry.kind === 'url_template' &&
  hasQueryPlaceholder(recipe.entry.template) &&
  !recipe.terms?.length;

// {query} is the saved source query; other placeholders read the workspace
// criteria field with the same id. Empty values drop their query parameter.
// A criteria value saved with notes ("Germany (based in Berlin); remote
// within Germany") searches for the place before them: the whole note made
// every search return nothing or no site could write it (2026-10-21).
const beforeNotes = (value) => value.split(/[;(\n]/)[0].trim();
export function recipeValues(a, url) {
  const source = a.sourceSettings?.[url] ?? {};
  const values = {query: (source.query ?? a.goal ?? '').trim()};
  for (const [key, value] of Object.entries(a.criteria ?? {}))
    if (typeof value === 'string' && !(key in values)) values[key] = beforeNotes(value);
  return values;
}

// The search value this source has to learn before it scans: the one its site
// extension reported it cannot write (sourceState.searchLearning), while the
// criteria still hold it, or a value that differs from the one the saved
// recipe was learned for. null when nothing needs learning.
export function searchLearning(a, url) {
  const values = recipeValues(a, url),
    pending = a.sourceState?.[url]?.searchLearning;
  if (pending && (values[pending.field] ?? '') === pending.value) return pending;
  const learned = a.sourceSettings?.[url]?.recipe?.learnedFor ?? {};
  for (const [field, value] of Object.entries(learned))
    if ((values[field] ?? '') !== value)
      return {field, value: values[field] ?? '', learnedValue: value};
  return null;
}

// A template that quotes its placeholder (q=%22{query}%22) gets the value
// without its own quotes; "\"AI governance\"" inside them made ""AI governance"",
// which a phrase search reads as separate words (FreeHire: 313 results, not 3),
// and a quote inside ("\"software engineer\" .NET") left the phrase unclosed.
const quotedPlaceholder = /(%22|")$/i;
const unquoted = (value) => value.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
export function replayUrl(template, values) {
  const filled = template.replace(placeholderPattern, (_, key, offset) => {
    const value = values[key] ?? '';
    return encodeURIComponent(
      quotedPlaceholder.test(template.slice(0, offset)) ? unquoted(value) : value,
    );
  });
  const url = new URL(filled);
  for (const [key, value] of [...url.searchParams]) if (value === '') url.searchParams.delete(key);
  // Query parameters use form encoding consistently (spaces become +).
  if ([...url.searchParams].length) url.search = url.searchParams.toString();
  return url.href;
}

// One replay holds one search per term (or a single search with the source
// query) in each search setup. Scans run every search; checks verify the first
// one of each setup.
export function recipeReplay(recipe, values) {
  if (!recipe || recipe.entry.kind === 'discovery') return null;
  const terms = recipe.terms?.length ? recipe.terms : [null];
  const filled = (term) => (term === null ? values : {...values, query: term});
  if (recipe.entry.kind === 'url_template')
    return {
      kind: recipe.entry.kind,
      pagination: recipe.pagination,
      searches: recipeTemplates(recipe).flatMap(({label, template}) =>
        terms.map((term) => ({
          term,
          ...(label ? {setup: label} : {}),
          url: replayUrl(template, filled(term)),
        })),
      ),
    };
  const searches = terms.map((term) => ({
    term,
    url: recipe.entry.url,
    answers: recipe.entry.fields
      .map((f) => ({key: f.key, label: f.label, value: filled(term)[f.key] ?? ''}))
      .filter((a) => a.value),
  }));
  return {kind: recipe.entry.kind, pagination: recipe.pagination, searches};
}
// The label a search shows: its term, and its setup beside the main address.
export const searchLabel = (search, fallback) =>
  [search.term ?? fallback, search.setup].filter(Boolean).join(' · ');
// The first search of each setup, which a recipe check reads.
export const setupFirstSearches = (replay) => [
  ...new Map(replay.searches.map((search) => [search.setup ?? '', search])).values(),
];
export const replayUrls = (replay) =>
  replay ? [...new Set(replay.searches.map((s) => s.url))] : [];
// A scan belongs to a replayed search when it opened that address or the same
// address with extra parameters (a later page, a site-added token). Different
// routes or changed values are another search.
export function replayMatches(replay, url) {
  if (!replay || typeof url !== 'string') return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return replayUrls(replay).some((candidate) => {
    const base = new URL(candidate);
    return (
      base.origin === target.origin &&
      base.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') &&
      [...base.searchParams].every(([k, v]) => target.searchParams.getAll(k).includes(v))
    );
  });
}

export const recipeStatus = (recipe, state) =>
  !recipe
    ? 'none'
    : recipe.entry.kind === 'discovery'
      ? 'discovery'
      : state?.status === 'verified'
        ? 'verified'
        : state?.status === 'stale'
          ? 'stale'
          : 'candidate';

export const RECIPE_FAILURE_REASONS = new Set([
  'no_listing_links',
  'search_control_missing',
  'search_control_uncertain',
  'search_not_verified',
  'no_progress',
  'page_changed',
  'unmatched_answers',
  'fill_not_verified',
  'pagination_uncertain',
  'pagination_action_unconfirmed',
  'task_error',
]);

// A result link is a listing when discovery confirmed it, or when its detail
// was read and judged an individual opportunity (fit or not). Boards whose
// result links are redirects only prove themselves through details.
export const jevListingItem = (item) =>
  item.discovery?.decision === 'listing' ||
  Boolean(
    item.collected &&
    item.pageKind !== 'results' &&
    item.assessment &&
    (item.assessment.decision === 'possible' ||
      (item.assessment.decision === 'mismatch' && item.assessment.reason !== 'not_listing')),
  );

// Judge one finished scan from its Jev tasks. Access barriers and loading
// pages are neutral: they say nothing about whether the recipe still works.
// Details prove the replay when read from its scan, either by task or from
// the saved queue holding that scan's links.
export function recipeRunOutcome(replay, tasks) {
  if (!replay) return 'neutral';
  const relevant = tasks.filter(
    (t) =>
      ['scan_results', 'prepare_search'].includes(t.input?.operation) &&
      replayMatches(replay, t.input?.url),
  );
  if (!relevant.length) return 'neutral';
  const ids = new Set(relevant.map((t) => t.id)),
    leads = new Set(
      relevant.flatMap((t) => (t.items ?? []).flatMap((i) => [i.url, ...(i.aliases ?? [])])),
    );
  const fromScan = (item) => [item.url, ...(item.aliases ?? [])].some((url) => leads.has(url));
  const details = tasks
    .filter((t) => t.input?.operation === 'collect_details')
    .flatMap((t) =>
      t.input?.fromTaskId && ids.has(t.input.fromTaskId)
        ? (t.items ?? [])
        : (t.items ?? []).filter(fromScan),
    );
  // Listings this workspace already holds are retired without becoming items,
  // so a quiet repeat scan proves the replay through its page summaries.
  if (
    relevant.some((t) => (t.items ?? []).some(jevListingItem)) ||
    details.some(jevListingItem) ||
    relevant.some((t) => (t.pages ?? []).some((p) => p.knownListings > 0))
  )
    return 'success';
  if (
    relevant.some(
      (t) =>
        t.issue?.reason === 'access_barrier' ||
        t.status === 'running' ||
        t.status === 'continue' ||
        t.status === 'pending',
    )
  )
    return 'neutral';
  if (
    relevant.every(
      (t) =>
        (t.status === 'completed' && !(t.items ?? []).length) ||
        RECIPE_FAILURE_REASONS.has(t.issue?.reason),
    )
  )
    return 'failure';
  return 'neutral';
}

export function advanceRecipeState(state, outcome, {runId, now, reason = null, url = null}) {
  const current = {status: 'candidate', successCount: 0, failCount: 0, ...state};
  if (outcome === 'neutral') return current;
  if (outcome === 'success')
    return {
      ...current,
      status: 'verified',
      successCount: current.successCount + 1,
      failCount: 0,
      verifiedAt: now,
      lastRunId: runId,
      lastFailure: null,
    };
  const failCount = current.failCount + 1;
  return {
    ...current,
    status:
      failCount >= RECIPE_STALE_FAILURES
        ? 'stale'
        : current.status === 'verified'
          ? 'verified'
          : 'candidate',
    failCount,
    lastRunId: runId,
    lastFailure: {reason, url, at: now},
  };
}

export function recipeSummary(recipe, state) {
  const status = recipeStatus(recipe, state);
  if (status === 'none')
    return {status, label: 'No recipe', detail: 'It will be learned in the first trial turn.'};
  if (status === 'discovery')
    return {
      status,
      label: 'Discovery mode',
      detail: recipe.notes ?? 'The agent runs the search itself every turn.',
    };
  if (status === 'verified')
    return {
      status,
      label: 'Recipe verified',
      detail: `${state.successCount} successful turns${state.failCount ? `, ${state.failCount} failed` : ''}${recipe.terms?.length ? ` · ${recipe.terms.length} search terms` : ''} · new listings only · up to ${SCAN_SEARCH_LISTINGS} new listings or ${SCAN_SEARCH_PAGES} pages per search`,
    };
  if (status === 'stale')
    return {
      status,
      label: 'Recipe broken',
      detail: state.lastFailure?.reason
        ? `Last error: ${state.lastFailure.reason}. It will be learned again.`
        : 'It will be learned again.',
    };
  return {
    status,
    label: 'Recipe pending',
    detail: state?.lastFailure?.reason
      ? `Could not be verified: ${state.lastFailure.reason}`
      : 'It will be verified in the first scan.',
  };
}
