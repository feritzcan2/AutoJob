// @ts-check
import {webUrl, boundedText} from '../templates/catalog.mjs';
import {validateScanCompletion} from './scan.mjs';
import {siteKey} from '../browser/site-access.mjs';
import {searchLabel} from './recipe.mjs';

export function scanWork(run) {
  if (run.scan?.work) return structuredClone(run.scan.work);
  return {
    activeSearchId: 'default',
    counted: true,
    searches: [
      {
        id: 'default',
        label: 'Source scan',
        status: 'pending',
        pendingUrls: [...(run.scan?.pendingUrls ?? [])],
        processedUrls: [],
        pageProgress: run.pageProgress ?? null,
        plan: run.scanPlan ?? null,
      },
    ],
  };
}
export const activeSearch = (work) => work.searches.find((s) => s.id === work.activeSearchId);
// A recipe replay with several searches (one per term) scans each as its own
// search. Saved work keeps its searches and progress; replay searches it does
// not hold yet are added as pending. A scan never ends after only one term.
export function replayScanWork(scan, searches) {
  if (!searches || searches.length < 2) return scan;
  const fresh = (s, index) => ({
    id: `replay-${index + 1}`,
    label: searchLabel(s, s.url),
    url: s.url,
    status: 'pending',
    pendingUrls: [],
    processedUrls: [],
    pageProgress: null,
    plan: null,
  });
  const work = scan?.work
    ? structuredClone(scan.work)
    : {activeSearchId: 'replay-1', counted: true, searches: []};
  const held = new Set(work.searches.map((s) => s.url).filter(Boolean)),
    ids = new Set(work.searches.map((s) => s.id));
  for (const [index, search] of searches.entries())
    if (!held.has(search.url)) {
      let item = fresh(search, index);
      while (ids.has(item.id)) item = {...item, id: item.id + 'b'};
      ids.add(item.id);
      work.searches.push(item);
    }
  // A queue saved before the scan had separate searches stays with the first one.
  if (scan && !scan.work) work.searches[0].pendingUrls = [...new Set(scan.pendingUrls ?? [])];
  if (activeSearch(work)?.status === 'completed')
    work.activeSearchId =
      work.searches.find((s) => s.status !== 'completed')?.id ?? work.activeSearchId;
  return {...scan, complete: false, pendingUrls: pendingScanUrls(work), work};
}
export function pendingScanUrls(work) {
  return [...new Set(work.searches.flatMap((s) => s.pendingUrls))];
}
// Pages that kept failing leave the queue as handled; the scan goes on without them.
export function skipScanUrls(scan, urls) {
  if (!scan) return scan;
  const skip = new Set(urls);
  if (!scan.work)
    return {...scan, pendingUrls: (scan.pendingUrls ?? []).filter((url) => !skip.has(url))};
  const work = structuredClone(scan.work);
  for (const search of work.searches) {
    const held = search.pendingUrls.filter((url) => skip.has(url));
    search.pendingUrls = search.pendingUrls.filter((url) => !skip.has(url));
    search.processedUrls = [...new Set([...search.processedUrls, ...held])];
  }
  return {...scan, pendingUrls: pendingScanUrls(work), work};
}
export function hasUnblockedScanWork(run, sites) {
  const blocked = new Set(sites),
    work = scanWork(run);
  // Undiscovered searches still use the assigned source. A source-wide gate
  // must release the worker even when those searches have empty queues.
  if (run.sourceUrl && blocked.has(siteKey(run.sourceUrl))) return false;
  return work.searches.some(
    (s) =>
      s.status !== 'completed' &&
      (s.pendingUrls.some((url) => !blocked.has(siteKey(url))) ||
        (s.id !== work.activeSearchId && !s.pendingUrls.length)),
  );
}
export function withScanWork(run, work, patch = {}) {
  return {...run.scan, ...patch, complete: false, pendingUrls: pendingScanUrls(work), work};
}
export function scanQueue(run, {searchId = undefined, offset = 0, limit = 100} = {}) {
  const work = scanWork(run),
    search = work.searches.find((s) => s.id === (searchId ?? work.activeSearchId));
  if (!search) throw Error('Scan search not found.');
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw Error('Invalid queue range; read at most 100 addresses.');
  return {
    searchId: search.id,
    label: search.label,
    status: search.status,
    pageProgress: search.pageProgress,
    checkpoint: scanPlanView(search.plan)?.checkpoint ?? null,
    total: search.pendingUrls.length,
    offset,
    pendingUrls: search.pendingUrls.slice(offset, offset + limit),
    nextOffset: offset + limit < search.pendingUrls.length ? offset + limit : null,
    processedCount: search.processedUrls.length,
  };
}
export function scanWorkSummary(run) {
  const work = scanWork(run);
  return {
    activeSearchId: work.activeSearchId,
    searches: work.searches.map(
      ({id, label, url, status, pendingUrls, processedUrls, pageProgress, completion}) => ({
        id,
        label,
        ...(url ? {url} : {}),
        status,
        pendingCount: pendingUrls.length,
        processedCount: processedUrls.length,
        pageProgress,
        completion,
      }),
    ),
    queue: scanQueue(run),
  };
}
export function reportWorkPage(run, pageProgress) {
  const work = scanWork(run),
    search = activeSearch(work),
    previous = search.pageProgress;
  // A lower page can be visited to recover access. It is not a new checkpoint.
  if (search.status === 'completed')
    throw Error('This search is complete; choose a remaining search.');
  const revisiting = Boolean(previous && pageProgress.currentPage < previous.currentPage);
  if (!revisiting) {
    search.pageProgress = pageProgress;
    if (
      !search.processedUrls.includes(pageProgress.url) &&
      !search.pendingUrls.includes(pageProgress.url)
    )
      search.pendingUrls.push(pageProgress.url);
  }
  return {work, pageProgress: search.pageProgress, revisiting};
}
export function updateScanQueue(run, input) {
  const work = scanWork(run),
    search = activeSearch(work);
  if (search.status === 'completed')
    throw Error('No new work can be added to a completed search. Choose a remaining search.');
  const processed = input.processedUrls ?? [];
  if (!Array.isArray(processed) || processed.length > 100)
    throw Error('Save at most 100 processed addresses at a time.');
  const additions = [...new Set(input.pendingUrls.map(webUrl))],
    done = [...new Set(processed.map(webUrl))];
  if (done.some((url) => additions.includes(url)))
    throw Error('An address cannot be both pending and processed.');
  search.processedUrls = [...new Set([...search.processedUrls, ...done])];
  search.pendingUrls = [...new Set([...search.pendingUrls, ...additions])].filter(
    (url) => !search.processedUrls.includes(url),
  );
  if (input.excluded?.length) noteExcluded(search, input.excluded);
  if (input.cards?.length) noteCards(search, input.cards);
  // New listings by results page; a page read again after a restart keeps its count.
  if (input.newListings)
    search.newListings = {
      ...search.newListings,
      [input.newListings.url]: Math.max(
        search.newListings?.[input.newListings.url] ?? 0,
        input.newListings.count,
      ),
    };
  if (input.knownListings) noteKnownListings(search, input.knownListings);
  return work;
}
// Listings a results page held that the workspace already knew, by page; a
// page read again after a restart keeps its larger count.
export function noteKnownListings(search, {url, saved, excluded}) {
  const last = search.knownListings?.[url];
  search.knownListings = {
    ...search.knownListings,
    [url]: {
      saved: Math.max(last?.saved ?? 0, saved),
      excluded: Math.max(last?.excluded ?? 0, excluded),
    },
  };
}
export const searchNewListings = (search) =>
  Object.values(search?.newListings ?? {}).reduce((sum, count) => sum + count, 0);
// Jev's card reading of a waiting listing: its title, the probability it is
// kept, and the closest exclusion. Only waiting listings keep a note.
const EXCLUSIONS = ['hard_constraint', 'qualification', 'unrelated_role'];
export function noteCards(search, cards) {
  const notes = {};
  for (const c of cards) {
    const s = c.scores ?? {},
      risk = EXCLUSIONS.map((reason) => ({reason, p: s[reason] ?? 0})).sort((a, b) => b.p - a.p)[0];
    notes[webUrl(c.url)] = {
      title: String(c.title ?? '').slice(0, 200),
      ...(typeof s.keep === 'number' ? {keep: s.keep, risk} : {}),
    };
  }
  const pending = new Set(search.pendingUrls);
  search.cards = Object.fromEntries(
    Object.entries({...search.cards, ...notes}).filter(([url]) => pending.has(url)),
  );
}
// Listings Jev eliminated (on the card or after reading the detail), kept so
// the source memory shows what was dropped and why. Bounded per search.
// An entry with by:'agent' is the agent's own review rejection; the rest are Jev's.
export function noteExcluded(search, entries) {
  const fresh = entries.map((e) => ({
    url: webUrl(e.url),
    title: String(e.title ?? '').slice(0, 200),
    reason: String(e.reason ?? '').slice(0, 200),
    stage: e.stage === 'detail' ? 'detail' : 'card',
    by: e.by === 'agent' ? 'agent' : 'jev',
    ...(typeof e.confidence === 'number' ? {confidence: e.confidence} : {}),
  }));
  const urls = new Set(fresh.map((e) => e.url)),
    known = new Set((search.excluded ?? []).map((e) => e.url));
  for (const e of fresh)
    if (!known.has(e.url)) countScan(search, e.by === 'agent' ? 'reviewRejected' : 'jevRejected');
  search.excluded = [...(search.excluded ?? []).filter((e) => !urls.has(e.url)), ...fresh].slice(
    -300,
  );
  if (search.cards)
    search.cards = Object.fromEntries(
      Object.entries(search.cards).filter(([url]) => !urls.has(url)),
    );
}
// Per-search tallies of what the scan did with its listings. The excluded list
// is bounded, so these counters carry the totals the source row shows.
export function countScan(search, key) {
  search.counts = {...search.counts, [key]: (search.counts?.[key] ?? 0) + 1};
}
// Listings a search saved as records, so the source memory shows what passed
// beside what was dropped. Bounded per search like the excluded list.
export function noteSaved(search, entry) {
  const url = webUrl(entry.url);
  search.saved = [
    ...(search.saved ?? []).filter((e) => e.url !== url),
    {
      url,
      title: String(entry.title ?? '').slice(0, 200),
      ...(typeof entry.score === 'number' ? {score: entry.score} : {}),
    },
  ].slice(-300);
}
// Totals for a finished scan, or null for work saved before the scan counted.
export function scanStats(scan) {
  const work = scan?.work;
  if (!work?.counted) return null;
  const sum = (count) => work.searches.reduce((total, search) => total + count(search), 0),
    tally = (key) => sum((search) => search.counts?.[key] ?? 0);
  return {
    searches: work.searches.length,
    listings: sum(
      (search) =>
        searchNewListings(search) +
        Object.values(search.collector?.newListings ?? {}).reduce((a, b) => a + b, 0),
    ),
    jevRejected: tally('jevRejected'),
    reviewRejected: tally('reviewRejected'),
    belowThreshold: tally('belowThreshold'),
    saved: tally('saved'),
  };
}
export function completeScanSearch(run, completion, evidenceUrl) {
  const work = scanWork(run),
    search = activeSearch(work);
  if (search.pendingUrls.length)
    throw Error(
      `${search.pendingUrls.length} addresses are still pending; the search cannot be completed.`,
    );
  validateScanCompletion(
    run.scanPlan,
    {complete: true, pendingUrls: [], completion, evidenceUrl},
    search.pageProgress,
    run.id,
  );
  search.status = 'completed';
  search.completion = completion;
  search.plan = run.scanPlan;
  // The next unfinished search becomes active with its own page position.
  const next = work.searches.find((s) => s.status !== 'completed');
  if (next) work.activeSearchId = next.id;
  return work;
}
export function assertScanWorkFinished(run) {
  if (!run.scan?.work) return;
  const work = scanWork(run);
  if (pendingScanUrls(work).length)
    throw Error(
      'Pages or records are still pending. Save the processed addresses with processedUrls.',
    );
  if (work.searches.length > 1 && work.searches.some((s) => s.status !== 'completed'))
    throw Error(
      'Not all saved searches are finished; complete the remaining search with complete_scan_search.',
    );
}
// Every saved search was closed by complete_scan_search, or by a collector
// from its own API pages, and nothing is queued: the app has verified the
// whole scan itself. This holds for a single search too: after a restart the
// finish must not ask for an evidence page the closed search refuses to open.
export function scanWorkVerified(run) {
  const work = run.scan?.work;
  return Boolean(
    work &&
    work.searches.every((s) => s.status === 'completed') &&
    !pendingScanUrls(scanWork(run)).length,
  );
}
export function otherScanSearchesPending(run) {
  return Boolean(
    run.scan?.work?.searches.some(
      (s) => s.id !== run.scan.work.activeSearchId && s.status !== 'completed',
    ),
  );
}

// A changed search recipe keeps queued listings but forgets where the old
// results pages left off: the next turn opens the new recipe's first page.
// Old results pages (addresses the previous recipe produced) leave the queue.
export function forgetPlanPosition(plan) {
  if (!plan) return plan;
  const {checkpoint, ...rest} = plan;
  return {...rest, order: null, boundary: null};
}
export function forgetScanPosition(state, isOldResultsPage = (_url) => false) {
  if (!state) return state;
  const keep = (urls) => (urls ?? []).filter((url) => !isOldResultsPage(url));
  const next = {...state, pageProgress: null, observedPage: null};
  if (state.scan) {
    const work = state.scan.work
      ? {
          ...state.scan.work,
          searches: state.scan.work.searches.map((s) => ({
            ...s,
            pageProgress: null,
            pendingUrls: keep(s.pendingUrls),
            plan: forgetPlanPosition(s.plan),
          })),
        }
      : undefined;
    next.scan = dropRecipeSearches(
      {...state.scan, pendingUrls: keep(state.scan.pendingUrls), ...(work ? {work} : {})},
      isOldResultsPage,
    );
  }
  if (state.scanState?.active)
    next.scanState = {...state.scanState, active: forgetPlanPosition(state.scanState.active)};
  return next;
}

// Searches of a replaced recipe leave the scan unless they are finished, hold
// queued listings, or are the search the running agent is on (keepId).
export function dropRecipeSearches(scan, isOldResultsPage, keepId = null) {
  if (!scan?.work) return scan;
  const searches = scan.work.searches.filter(
    (s) =>
      s.id === keepId ||
      s.status === 'completed' ||
      s.pendingUrls.length ||
      !s.url ||
      !isOldResultsPage(s.url),
  );
  if (searches.length === scan.work.searches.length) return scan;
  if (!searches.length) {
    const {work: _work, ...rest} = scan;
    return {...rest, complete: false, pendingUrls: []};
  }
  const work = {...scan.work, searches},
    active = activeSearch(work);
  if (!active || active.status === 'completed')
    work.activeSearchId = (searches.find((s) => s.status !== 'completed') ?? searches[0]).id;
  return {...scan, pendingUrls: pendingScanUrls(work), work};
}

export function scanPlanView(plan) {
  if (!plan || !plan.checkpoint?.pendingUrls || plan.checkpoint.pendingUrls.length <= 100)
    return plan;
  return {
    ...plan,
    checkpoint: {
      ...plan.checkpoint,
      pendingUrls: plan.checkpoint.pendingUrls.slice(0, 100),
      pendingCount: plan.checkpoint.pendingUrls.length,
      nextOffset: 100,
    },
  };
}
export function validateWorkCompletion(run, scan) {
  if (
    (run.scan?.work?.searches.length ?? 0) <= 1 &&
    !run.scan?.collector &&
    !scanWorkVerified(run)
  ) {
    const completion = validateScanCompletion(run.scanPlan, scan, run.pageProgress, run.id);
    assertScanWorkFinished(run);
    return completion;
  }
  assertScanWorkFinished(run);
  // Each search was verified by complete_scan_search or its collector; the agent's own
  // completion word adds nothing and weak agents guessed it wrong.
  const completions = run.scan.work.searches.map((s) => s.completion);
  return completions.includes('user_stop')
    ? 'user_stop'
    : completions.includes('cutoff')
      ? 'cutoff'
      : 'end';
}

export function scanProgressView(run) {
  if (!run.scan) return null;
  const {work, ...scan} = run.scan;
  if (!work && scan.pendingUrls.length <= 100) return scan;
  return {
    ...scan,
    pendingUrls: scan.pendingUrls.slice(0, 100),
    pendingCount: scan.pendingUrls.length,
    nextOffset: scan.pendingUrls.length > 100 ? 100 : null,
  };
}
