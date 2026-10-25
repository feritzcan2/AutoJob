import {scanPageLabel} from '../app/sources/scan-page.mjs';
import {currentWork} from '../app/automation/current-work.mjs';
import {
  recipeSummary,
  SCAN_SEARCH_LISTINGS,
  SCAN_SEARCH_PAGES,
  RECIPE_PAGINATION_KINDS,
} from '../app/sources/recipe.mjs';
import {
  searchFilterValues,
  withSearchFilters,
  searchFilterLabels,
} from '../app/site-extensions/search.mjs';
import {workspaceSourceTabs} from './workspace-tabs.js';
import {positionMenu} from './popover-menu.js';
import {extensionBenchAvailable, extensionBenchPanel} from './extension-bench.js';
import {sourceActivityText} from '../app/sources/activity-text.mjs';

const paginationLabels = {
  auto: 'Detect automatically',
  url_param: 'Page parameter (page=2)',
  next_link: 'Next link',
  next_click: 'Next button',
  load_more: 'Load more',
  infinite_scroll: 'Infinite scroll',
  none: 'Single page',
};
// A site extension's results address sets the pagination and ordering of a
// url_template recipe whatever the recipe says; a collector pages its API itself.
const pagedByExtension = (source) =>
  source.extension?.kind === 'api' || Boolean(source.extension?.search?.pagination);
const readsNewestFirst = (source) =>
  (source.extension?.search && source.recipe?.entry.kind === 'url_template'
    ? source.extension.search.ordering
    : source.recipe?.ordering) === 'newest_first';
const methodLabels = {
  none: 'None yet · learned in the trial round',
  url_template: 'URL template',
  search_form: 'Search form',
  discovery: 'Discovery · the agent searches itself every round',
};
const runOutcomes = {
  completed: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked',
  timeout: 'Timed out',
  interrupted: 'Stopped',
  partial: 'Partially completed',
};
// How a source's listings are read, shown as the address tooltip.
const readerLabels = {
  api: "Read through the site's own API; no browser tab is opened.",
  http: 'Read over HTTP by a site extension; no browser tab is opened.',
  browser: 'Read in a Chrome tab by a site extension.',
  agent: 'Read in a Chrome tab; the agent learned how to search this site.',
};
const intervalChoices = [15, 30, 60, 120, 240, 480, 720, 1440];
const intervalLabel = (minutes) =>
  minutes === 1440
    ? 'Daily'
    : minutes % 1440 === 0
      ? `Every ${minutes / 1440} d`
      : minutes % 60 === 0
        ? `Every ${minutes / 60} h`
        : `Every ${minutes} min`;
const plural = (count, word, many = word + 's') => `${count} ${count === 1 ? word : many}`;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const time = (at) =>
  at
    ? new Date(at).toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
function timeUntil(at) {
  const remaining = at - Date.now();
  if (remaining <= 0) return 'due now';
  if (remaining < 60000) return 'within 1 min';
  const minutes = Math.ceil(remaining / 60000),
    parts = [
      [Math.floor(minutes / 1440), 'd'],
      [Math.floor(minutes / 60) % 24, 'h'],
      [minutes % 60, 'min'],
    ];
  return (
    'in ' +
    parts
      .filter(([value]) => value)
      .slice(0, 2)
      .map(([value, unit]) => `${value} ${unit}`)
      .join(' ')
  );
}
function timeAgo(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  const parts = [
    [Math.floor(minutes / 1440), 'd'],
    [Math.floor(minutes / 60) % 24, 'h'],
    [minutes % 60, 'min'],
  ];
  return (
    parts
      .filter(([value]) => value)
      .slice(0, 2)
      .map(([value, unit]) => `${value} ${unit}`)
      .join(' ') + ' ago'
  );
}
function scanStatsLine(stats) {
  return [
    plural(stats.searches, 'search', 'searches'),
    plural(stats.listings, 'new listing'),
    stats.jevRejected ? `Jev dropped ${stats.jevRejected}` : null,
    stats.reviewRejected ? `rejected on review ${stats.reviewRejected}` : null,
    stats.belowThreshold ? `${stats.belowThreshold} below save score` : null,
    `${stats.saved} saved`,
  ]
    .filter(Boolean)
    .join(' · ');
}
const updateLastRun = (node) => {
  node.textContent = 'Last scan ' + timeAgo(Number(node.dataset.sourceLastAt));
};
const updateNextRun = (node) => {
  node.textContent =
    node.dataset.sourceNextLabel +
    ' ' +
    timeUntil(Number(node.dataset.sourceNextAt)) +
    (node.dataset.sourceNextSuffix ?? '');
};

// One row per source: its name, one status line and its schedule. Editing,
// relearning and deleting sit behind the ⋯ menu; scan internals are dev-only.
export function automationSourcesPanel(host, api, {refresh, notice, ask}) {
  let data,
    owner,
    editing = null,
    memory = null,
    order = null,
    adding = false,
    saving = false,
    benchAvailable = false,
    benchSource = null,
    headBench = null;
  host.innerHTML =
    '<div class="sources-head"><div><h2>Sources</h2><p></p></div><div class="sources-head-actions"></div></div><div data-add></div><ul class="source-list"></ul>';
  const head = host.querySelector('.sources-head'),
    headActions = head.querySelector('.sources-head-actions'),
    list = host.querySelector('.source-list'),
    addHost = host.querySelector('[data-add]');
  const rows = new Map(),
    otherHost = el('li', null, 'source-tabs-other'),
    empty = el('li', null, 'source-empty');
  empty.append(
    el('strong', 'No sources yet'),
    document.createTextNode(
      'Add a job site or ask the agent to find one. In the first round the agent works out the site once and saves its search recipe.',
    ),
  );
  list.append(otherHost);
  const countdown = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(countdown);
      return;
    }
    if (host.getClientRects().length) {
      for (const node of host.querySelectorAll('[data-source-next-at]')) updateNextRun(node);
      for (const node of host.querySelectorAll('[data-source-last-at]')) updateLastRun(node);
    }
  }, 30000);
  const tabsControl = workspaceSourceTabs(api, {notice});
  const action = (fn) => async (event) => {
    event?.preventDefault();
    if (saving) return;
    saving = true;
    notice('');
    try {
      await fn();
    } catch (error) {
      notice(error.message);
    } finally {
      saving = false;
    }
  };
  const button = (label, fn, cls = 'quiet') => {
    const b = el('button', label, cls);
    b.type = 'button';
    b.onclick = action(fn);
    return b;
  };
  const busySource = (url) =>
    (data.activeRuns ?? []).some(
      (run) =>
        run.kind !== 'interview' &&
        (run.sourceUrl
          ? run.sourceUrl === url
          : (run.sources ?? data.automation.sources).includes(url)),
    );
  const recipeStale = (source) =>
    recipeSummary(source.recipe ?? null, source.recipeState ?? null).status === 'stale';
  // A source the user has to look at: it will not scan, or scans without results.
  const needsAttention = (source) =>
    source.enabled &&
    !source.scanning &&
    Boolean(
      source.blocked ||
      source.siteWait?.exhausted ||
      source.trial?.status === 'failed' ||
      recipeStale(source),
    );

  // Header actions: add a source or ask the agent to find one.
  const add = button(
    '＋ Add source',
    () => {
      adding = !adding;
      render();
    },
    'primary',
  );
  headActions.append(add);
  if (ask) {
    const discover = button('Find with the agent', ask);
    discover.dataset.sourceDiscover = '';
    headActions.append(discover);
  }
  // Development builds: the extension test bench.
  const benches = new Map();
  const benchFor = (url) => {
    if (!benches.has(url))
      benches.set(
        url,
        extensionBenchPanel(api, {
          scope: () => owner,
          url,
          onClose: () => {
            benchSource = null;
            render();
          },
        }),
      );
    return benches.get(url);
  };
  extensionBenchAvailable(api).then((available) => {
    if (!available || !host.isConnected) return;
    benchAvailable = true;
    const toggle = button('Test bench', () => {
      if (headBench?.element.isConnected) {
        headBench.element.remove();
        return;
      }
      headBench ??= extensionBenchPanel(api, {
        scope: () => owner,
        onClose: () => headBench.element.remove(),
      });
      head.after(headBench.element);
      headBench.focus();
    });
    toggle.title = 'Read an address with the site extensions, without agents or records.';
    headActions.append(toggle);
    if (data) render();
  });

  const proposal = el('section', null, 'source-proposal');
  proposal.setAttribute('aria-label', 'Agent’s source suggestions');
  proposal.hidden = true;
  head.after(proposal);
  function renderProposal() {
    const draft = data.automation.sourceDraft;
    proposal.hidden = !draft;
    proposal.replaceChildren();
    if (!draft) return;
    const scope = owner,
      current = data.automation.sources,
      added = draft.sources.filter((url) => !current.includes(url)),
      removed = current.filter((url) => !draft.sources.includes(url)),
      searches = Object.entries(draft.searches ?? {});
    proposal.append(
      el('h3', 'Agent’s source suggestions'),
      el('p', 'Review and apply the changes. The first round of a new source is a trial.'),
    );
    const changes = el('ul');
    for (const [label, urls] of [
      ['To add', added],
      ['To remove', removed],
    ])
      for (const url of urls) {
        const item = el('li');
        item.append(el('b', label + ': '), el('span', url));
        changes.append(item);
      }
    for (const [url, choice] of searches) {
      const item = el('li');
      item.append(
        el('b', 'Search: '),
        el('span', url),
        el(
          'small',
          [
            ...(choice.terms ? ['Terms: ' + choice.terms.join(', ')] : []),
            ...choice.filters.map((f) => f.label),
            ...(choice.setups ?? []).map((setup) =>
              ['Also: ' + setup.label, setup.location, ...setup.filters.map((f) => f.label)]
                .filter(Boolean)
                .join(', '),
            ),
          ].join(' · '),
        ),
      );
      changes.append(item);
    }
    proposal.append(changes);
    const actions = el('div', null, 'actions'),
      apply = button(
        'Apply suggestions',
        async () => {
          await api.automationSourceDraft(scope, draft.id, true);
          await refresh();
          notice('Source suggestions applied.');
        },
        'primary',
      );
    const busy = [...removed, ...searches.map(([url]) => url)].some(busySource);
    apply.disabled = busy;
    const discard = button('Discard suggestions', async () => {
      await api.automationSourceDraft(scope, draft.id, false);
      await refresh();
      notice('Source suggestions discarded.');
    });
    actions.append(apply, discard);
    proposal.append(actions);
    if (busy)
      proposal.append(
        el('small', 'To apply, stop the running tasks of the sources to be removed or changed.'),
      );
  }

  function sourceRow(url) {
    const view = {
      row: el('li', null, 'source-row'),
      toggle: el('input', null, 'switch'),
      main: el('div', null, 'source-main'),
      actions: el('div', null, 'source-actions'),
      tabHost: el('div', null, 'source-tabs-control'),
      run: button('', () => {}),
      menuToggle: el('button', '⋯', 'quiet source-row-menu'),
      menu: el('div', null, 'source-row-actions'),
      edit: button('', () => {}, 'source-edit'),
      restart: button('Start over', () => {}, 'source-restart'),
      relearn: button('Relearn', () => {}),
      remove: button('Delete source', () => {}, 'source-remove'),
      memoryButton: button('', () => {}, 'quiet source-memory-toggle'),
      bench: button('Test extension', () => {}, 'source-bench-toggle'),
      pending: null,
    };
    view.toggle.type = 'checkbox';
    view.row.dataset.sourceId = url;
    view.relearn.dataset.sourceRelearn = '';
    // Secondary actions live in a popover; each closes it before acting.
    const {menu, menuToggle} = view;
    menuToggle.type = 'button';
    menuToggle.title = 'More actions';
    menu.popover = 'auto';
    menu.id = 'source-row-actions-' + rows.size;
    menuToggle.setAttribute('aria-controls', menu.id);
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.onclick = () => {
      if (menu.matches(':popover-open')) return menu.hidePopover();
      menu.showPopover();
      positionMenu(menu, menuToggle);
    };
    menu.ontoggle = () =>
      menuToggle.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
    menu.addEventListener('click', (event) => {
      if (event.target.closest('button') && menu.matches(':popover-open')) menu.hidePopover();
    });
    menu.append(view.edit, view.restart, view.relearn, view.remove, view.bench);
    view.actions.append(view.run, view.memoryButton, view.tabHost, menuToggle, menu);
    view.row.append(view.toggle, view.main, view.actions);
    // A click on the row itself opens or closes its scan details; controls,
    // open panels and text selection keep their own behaviour.
    view.row.addEventListener('click', (event) => {
      if (getSelection()?.toString()) return;
      if (
        event.target.closest(
          'button, a, input, select, textarea, label, summary, [popover], .source-memory, .source-editor, .extension-bench',
        )
      )
        return;
      view.memoryButton.click();
    });
    rows.set(url, view);
    return view;
  }
  async function scanAction(view, scope, url, stop, fresh = false, force = false) {
    if (view.pending) return;
    const current = () => owner === scope && rows.get(url) === view && host.isConnected;
    view.pending = stop ? 'stop' : 'start';
    notice('');
    render();
    try {
      await (stop
        ? api.automationSourceStop(scope, url)
        : api.automationSourceRun(scope, url, {fresh, force}));
      if (current()) {
        await refresh();
        if (current())
          notice(
            stop
              ? 'Scan stopped. Saved progress was kept.'
              : fresh
                ? 'The scan will start from the first page. Saved listings are not read again.'
                : 'Scan request received. It starts when the source is ready.',
          );
      }
    } catch (error) {
      if (current()) notice(error.message);
    } finally {
      view.pending = null;
      if (current()) render();
    }
  }

  // The one state the row reports: a problem when there is one, otherwise
  // what the last scan brought. `tone` colours it.
  function sourceState(source) {
    const outcome = source.lastRun ?? {
      status: source.lastStatus,
      summary: source.lastResult,
      finishedAt: source.lastRunAt,
    };
    if (source.scanning) {
      if (source.scanIssue)
        return {
          tone: 'warning',
          label: 'Page could not load',
          detail: `${source.scanIssue.url} · attempt ${source.scanIssue.attempts}`,
          title: source.scanIssue.evidence,
        };
      if (source.trialRunning)
        return {
          tone: 'scanning',
          label: 'Trying the site',
          detail: source.searchLearning
            ? `The agent learns how the site writes the ${source.searchLearning.field} “${source.searchLearning.value}”. Nothing is submitted.`
            : 'First round: the agent learns how to search it. Nothing is submitted.',
        };
      const page = scanPageLabel(source.pageProgress);
      return {
        tone: 'scanning',
        label: 'Scanning',
        detail:
          currentWork(data).find((row) => row.stop?.sourceUrl === source.url)?.progress ??
          (page ? 'Last verified: ' + page : null),
      };
    }
    if (source.siteTurn)
      return {
        tone: 'waiting',
        label: source.siteTurn.scanning
          ? `Waiting for “${source.siteTurn.workspace}” to finish`
          : `Starts at ${new Date(source.siteTurn.until).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}`,
        detail: source.siteTurn.scanning
          ? `Workspaces scan ${source.siteTurn.site} one at a time; this scan starts automatically 30 min after that one ends.`
          : `30 min after “${source.siteTurn.workspace}” finished scanning ${source.siteTurn.site}. Scan now starts it right away.`,
      };
    if (source.blocker?.stop?.retryExhausted)
      return {
        tone: 'danger',
        label: 'Access problem persists',
        detail: source.siteWait?.message ?? outcome.summary,
      };
    if (source.siteWait?.exhausted)
      return {tone: 'danger', label: 'Automatic retries stopped', detail: source.siteWait.message};
    if (source.siteWait)
      return {tone: 'waiting', label: 'Waiting for site access', detail: source.siteWait.message};
    if (source.recovery && data.automation.status === 'enabled')
      return {tone: 'waiting', label: 'Continues automatically', detail: null};
    if (source.blocked)
      return source.lastStatus === 'failed' || source.blocker?.stop?.kind === 'technical'
        ? {tone: 'danger', label: 'Scan could not finish', detail: outcome.summary}
        : {tone: 'warning', label: 'Blocked', detail: outcome.summary};
    // A due round that waits for a free worker.
    if (source.batchId && source.enabled && data.automation.status === 'enabled')
      return {
        tone: 'waiting',
        label: 'Queued',
        detail: source.trialReady
          ? 'Starts automatically when a worker is free.'
          : 'Starts automatically when a worker is free. The first round is a trial.',
      };
    if (source.trial?.status === 'failed')
      return {tone: 'danger', label: 'First try failed', detail: outcome.summary};
    if (source.searchLearning)
      return {
        tone: 'waiting',
        label: `Learning the ${source.searchLearning.field}`,
        detail: `The next round learns how the site writes “${source.searchLearning.value}”, then the scan starts again.`,
      };
    if (recipeStale(source))
      return {
        tone: 'warning',
        label: 'Search stopped working',
        detail: recipeSummary(source.recipe, source.recipeState).detail,
      };
    if (source.lastStatus === 'partial')
      return {
        tone: 'warning',
        label: `Partial scan · ${plural(source.scan?.pendingUrls.length ?? 0, 'address', 'addresses')} left`,
        detail: null,
      };
    if (outcome.status && outcome.status !== 'completed')
      return {
        tone: ['failed', 'timeout'].includes(outcome.status) ? 'danger' : 'warning',
        label: `Last scan: ${runOutcomes[outcome.status] ?? outcome.status}`,
        detail: outcome.summary,
        lastRun: outcome.status,
      };
    // A counted scan shows what it saved; the funnel behind it is the tooltip.
    const stats = source.lastRun?.scanStats;
    if (stats)
      return {
        tone: stats.saved ? 'found' : 'idle',
        label: `${stats.saved} saved of ${plural(stats.listings, 'new listing')}`,
        detail: null,
        title:
          scanStatsLine(stats) +
          (outcome.summary && outcome.summary !== 'Scan finished normally.'
            ? '\n' + outcome.summary
            : ''),
      };
    if (outcome.finishedAt)
      return {
        tone: source.lastFound ? 'found' : 'idle',
        label: `${plural(source.resultCount ?? source.lastFound ?? 0, 'record')} in total`,
        detail: null,
        title: outcome.summary,
      };
    return {
      tone: 'idle',
      label: 'Not scanned yet',
      detail: source.trialReady ? null : 'The first round is a trial.',
    };
  }
  function statusLine(source) {
    const state = sourceState(source),
      status = el('div', null, 'source-status'),
      label = el('b', state.label);
    status.dataset.tone = state.tone;
    if (state.lastRun) {
      label.className = 'source-last-run';
      label.dataset.status = state.lastRun;
    }
    status.append(label);
    if (state.detail) status.append(el('span', state.detail, 'source-detail'));
    status.title = state.title ?? state.detail ?? '';
    return status;
  }
  // Request rate: how fast the app reaches this site, counted across all
  // workspaces and applications. Shown while scanning or after recent requests.
  function requestLine(source) {
    const rate = source.requests;
    if (!rate || (!source.scanning && !rate.lastHour)) return null;
    const seconds = (ms) => Math.round(ms / 1000),
      spacing = rate.jitterMs
        ? `${seconds(rate.minGapMs)}–${seconds(rate.minGapMs + rate.jitterMs)} s apart`
        : `at least ${seconds(rate.minGapMs)} s apart`,
      budget = rate.budget,
      window =
        budget &&
        (budget.windowMs === 3600000 ? 'hour' : `${Math.round(budget.windowMs / 60000)} min`);
    const line = el(
      'div',
      budget
        ? `Request rate: ${budget.used}/${budget.requests} per ${window} · ${spacing}`
        : `Request rate: ${rate.lastTenMinutes} in the last 10 min · ${spacing}`,
      'source-requests',
    );
    line.title = `Requests this app sent to ${new URL(source.url).hostname.replace(/^www\./, '')} for all workspaces and applications: ${rate.lastTenMinutes} in the last 10 minutes, ${rate.lastHour} in the last hour.${budget ? ` The site allows at most ${budget.requests} per ${window}; over that the scan waits instead of being blocked.` : ''}`;
    return line;
  }
  // What the scan does right now: the app reading a results page or posting
  // n of m (and waiting for the site's pace), or the agent's current step.
  function activityLine(source) {
    const text = source.scanning ? sourceActivityText(source.activity) : null;
    if (!text) return null;
    const line = el('div', text, 'source-requests source-activity');
    line.title = `Updated ${new Date(source.activity.at).toLocaleTimeString('en-GB')}`;
    return line;
  }
  // Schedule: last scan, next scan and the interval, which changes in place.
  function scheduleLine(source, scope) {
    const meta = el('div', null, 'source-meta');
    const lastAt = source.lastRun?.finishedAt ?? source.lastRunAt;
    if (lastAt && !source.scanning) {
      const lastScan = el('span', null, 'source-last-scan');
      lastScan.dataset.sourceLastAt = String(lastAt);
      lastScan.title = 'Last scan ' + time(lastAt);
      updateLastRun(lastScan);
      meta.append(lastScan);
    }
    // A source waiting for another workspace's turn says so in its status.
    const nextAt =
      source.enabled && !source.siteTurn
        ? (source.siteWait?.retryAt ??
          (!source.scanning && !source.blocked && data.automation.status === 'enabled'
            ? source.nextRunAt
            : null))
        : null;
    if (nextAt) {
      const timing = el('span', null, 'source-timing'),
        next = el('b');
      next.dataset.sourceNextAt = String(nextAt);
      next.dataset.sourceNextLabel = source.siteWait ? 'Access check' : 'Next scan';
      next.title = next.dataset.sourceNextLabel + ' ' + time(nextAt);
      updateNextRun(next);
      timing.append(next);
      meta.append(timing);
    } else if (source.enabled && !source.scanning && data.automation.status !== 'enabled')
      meta.append(el('span', 'Tracking paused', 'source-timing'));
    const interval = el('select', null, 'source-interval'),
      minutes = source.intervalMinutes;
    interval.setAttribute('aria-label', source.name + ' scan interval');
    for (const value of [...new Set([...intervalChoices, minutes])].sort((a, b) => a - b))
      interval.append(new Option(intervalLabel(value), String(value)));
    interval.value = String(minutes);
    interval.onchange = action(async () => {
      await api.automationSourceSave(scope, source.url, {
        intervalMinutes: Number(interval.value),
      });
      await refresh();
    });
    meta.append(interval);
    return meta;
  }

  // Scan details: this round, its searches with the
  // queue, and the recipe, each as one labelled list.
  const exclusionLabels = {
    hard_constraint: 'Hard constraint',
    qualification: 'Qualification conflict',
    unrelated_role: 'Unrelated role',
    not_listing: 'Not a listing',
  };
  const scopeReasons = {
    initial: 'The first successful full scan has not happened yet.',
    periodic: 'A regular full scan is due.',
    ordering_unverified: 'Newest-first ordering could not be verified; all pages will be scanned.',
    start_unverified:
      'It could not be verified that the scan started on the first page; all pages will be scanned.',
    dates_unverified: 'Listing dates are missing or unclear; all pages will be scanned.',
    ordering_changed: 'The date order of the listings is inconsistent; all pages will be scanned.',
  };
  function progressDetails(source) {
    const section = el('section', null, 'source-progress-details source-memory'),
      page = source.pageProgress,
      scan = source.scan,
      state = source.scanState,
      cycle = state?.active ?? state?.lastCompleted,
      pending = scan?.complete === false ? (scan.pendingUrls ?? []) : [],
      searches = scan?.work?.searches ?? [],
      pct = (p) => `${Math.round(p * 100)}%`,
      link = (url, text = url) => button(text, () => api.openLink(url), 'source-progress-url');
    section.dataset.sourceId = source.url;
    section.setAttribute('aria-label', 'Scan details');
    // One group: a heading and label/value rows; empty values are skipped.
    const group = (title, rows, always = false) => {
      const shown = rows.filter(([, value]) => value != null && value !== '');
      if (!shown.length && !always) return null;
      const block = el('div', null, 'source-progress-group');
      block.append(el('h4', title));
      if (shown.length) {
        const list = el('dl', null, 'source-progress-facts');
        for (const [label, value] of shown) {
          const row = el('div'),
            dd = el('dd');
          dd.append(value);
          row.append(el('dt', label), dd);
          list.append(row);
        }
        block.append(list);
      }
      section.append(block);
      return block;
    };

    const resumeUrl = page?.url ?? cycle?.checkpoint?.url;
    // A finished round stays on show until the next one starts.
    group(!state?.active && state?.lastCompleted ? 'Last round' : 'This round', [
      [
        'Scan type',
        cycle?.mode === 'incremental'
          ? 'New record check'
          : cycle
            ? 'Full scan'
            : source.trialReady
              ? 'All pages in the first scan'
              : 'Source trial in the first round',
      ],
      ['Why this scope', scopeReasons[cycle?.reason]],
      ['Started', cycle?.startedAt ? time(cycle.startedAt) : null],
      ['New records since', cycle?.mode === 'incremental' ? time(cycle.cutoffAt) : null],
      ['Last full scan', state?.lastFullScanAt ? time(state.lastFullScanAt) : null],
      [
        page ? 'Reported page' : 'Resume page',
        resumeUrl
          ? link(
              resumeUrl,
              page
                ? `Page ${page.currentPage}${page.totalPages ? ` / ${page.totalPages}` : ''}`
                : resumeUrl,
            )
          : null,
      ],
      [
        'Last opened page',
        source.observedPage && page && source.observedPage.currentPage !== page.currentPage
          ? `Page ${source.observedPage.currentPage}. Saved progress and remaining addresses are kept.`
          : null,
      ],
      ['Resume marker', cycle?.checkpoint?.cursor],
      [
        'Date cutoff',
        cycle?.boundary
          ? 'All records on the last page were verified as older than the cutoff.'
          : null,
      ],
      [
        'Automatic resume',
        source.recovery
          ? `${time(source.recovery.readyAt)} · the interrupted session picks up at the same point.`
          : null,
      ],
      [scan?.complete ? 'Completion note' : 'Resume note', scan?.reason],
      [
        'Last result',
        source.lastResult && source.lastResult !== 'Scan finished normally.'
          ? source.lastResult
          : null,
      ],
    ]);

    // Searches, each with the addresses it still has waiting, the listings it
    // saved and what was dropped; a single search keeps them under the heading.
    const cards = Object.assign({}, ...searches.map((s) => s.cards ?? {}));
    const addressList = (waiting, saved, excluded) => {
      if (!waiting.length && !saved.length && !excluded.length) return null;
      const details = el('details', null, 'source-progress-pending');
      details.open = waiting.length === 1;
      details.append(
        el(
          'summary',
          `${plural(waiting.length, 'address', 'addresses')} waiting${saved.length ? ` · ${saved.length} saved` : ''}${excluded.length ? ` · ${excluded.length} excluded` : ''}`,
        ),
      );
      const rows = [
          ...waiting.map((url) => ({url})),
          ...saved.map((row) => ({...row, saved: true})),
          ...excluded,
        ],
        urls = el('ol');
      let shown = 0;
      const more = button('Show the next 100 addresses', () => append());
      const append = () => {
        for (const row of rows.slice(shown, shown + 100)) {
          const item = el('li'),
            card = cards[row.url],
            title = row.title ?? card?.title;
          const address = new URL(row.url);
          item.append(link(row.url, title ?? address.pathname + address.search));
          if (row.stage) {
            item.className = 'source-progress-excluded';
            item.append(
              el(
                'small',
                `Excluded ${row.stage === 'detail' ? 'on detail' : 'on card'}: ${exclusionLabels[row.reason] ?? row.reason}${row.confidence != null ? ` · Jev ${pct(row.confidence)}` : ''}`,
              ),
            );
          } else if (row.saved) {
            item.className = 'source-progress-saved';
            item.append(el('small', row.score != null ? `Saved · score ${row.score}` : 'Saved'));
          } else if (card?.keep != null)
            item.append(
              el(
                'small',
                `Keep ${pct(card.keep)}${card.risk?.p >= 0.1 ? ` · ${exclusionLabels[card.risk.reason]} ${pct(card.risk.p)}` : ''}`,
              ),
            );
          item.title = row.url;
          urls.append(item);
        }
        shown = Math.min(shown + 100, rows.length);
        more.hidden = shown >= rows.length;
      };
      append();
      details.append(urls, more);
      return details;
    };
    const perSearch = searches.length > 1;
    const searchRows = perSearch
      ? searches.map((search) => {
          // New listings this search collected and how many it saved, from its own
          // tallies, then the listings its pages held that the workspace already knew.
          const sum = (counts) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0),
            collected = sum(search.newListings) + sum(search.collector?.newListings),
            savedCount = search.counts?.saved ?? 0,
            known = Object.values(search.knownListings ?? {}),
            alreadySaved = known.reduce((a, k) => a + k.saved, 0),
            alreadyExcluded = known.reduce((a, k) => a + k.excluded, 0);
          const status =
            (search.status === 'completed'
              ? 'Completed'
              : `${search.pendingUrls.length} waiting${search.pageProgress ? ` · page ${search.pageProgress.currentPage}` : ''}`) +
            (collected || savedCount ? ` · ${collected} collected · ${savedCount} saved` : '') +
            (alreadySaved ? ` · ${alreadySaved} already saved` : '') +
            (alreadyExcluded ? ` · ${alreadyExcluded} excluded earlier` : '');
          const label = search.label + (search.id === scan.work.activeSearchId ? ' (current)' : '');
          // The searched address under the status, so the user can open it.
          const value = document.createDocumentFragment();
          value.append(el('div', status));
          if (search.url) value.append(link(search.url));
          const addresses = addressList(
            scan?.complete === false ? search.pendingUrls : [],
            [...(search.saved ?? [])].reverse(),
            [...(search.excluded ?? [])].reverse(),
          );
          if (addresses) value.append(addresses);
          return [label, value];
        })
      : [];
    const shared = perSearch
      ? null
      : addressList(
          pending,
          searches.flatMap((s) => s.saved ?? []).reverse(),
          searches.flatMap((s) => s.excluded ?? []).reverse(),
        );
    const queue = group(
      scan?.complete ? 'Searches of the last round' : 'Searches',
      searchRows,
      Boolean(shared),
    );
    if (shared) queue.append(shared);

    const recipe = source.recipe,
      summary = recipeSummary(recipe ?? null, source.recipeState ?? null),
      rs = source.recipeState,
      filters =
        recipe?.entry.kind === 'url_template' && source.extension?.search
          ? searchFilterLabels(source.extension.search, recipe.entry.template)
          : [];
    group('Search recipe', [
      [
        'Status',
        summary.label +
          (rs?.verifiedAt
            ? ` · ${rs.successCount} succeeded, ${rs.failCount} failed · checked ${time(rs.verifiedAt)}`
            : ''),
      ],
      ['Method', recipe ? methodLabels[recipe.entry.kind] : null],
      [
        'Address',
        recipe?.entry.kind === 'url_template'
          ? el('code', recipe.entry.template)
          : recipe?.entry.kind === 'search_form'
            ? el(
                'code',
                `${recipe.entry.url} · ${recipe.entry.fields.map((f) => `${f.key}=“${f.label}”`).join(', ')}`,
              )
            : null,
      ],
      ['Site filters', filters.join(' · ')],
      ['Other setups', recipe?.entry.variants?.length ? setupList(recipe.entry.variants) : null],
      ['Search terms', recipe?.terms?.join(', ')],
      [
        'Pagination',
        !recipe || recipe.entry.kind === 'discovery'
          ? null
          : pagedByExtension(source)
            ? 'Set by the site extension'
            : paginationLabels[recipe.pagination ?? 'auto'],
      ],
      ['Note', recipe?.notes],
      [
        'Last error',
        rs?.lastFailure
          ? `${time(rs.lastFailure.at)}: ${rs.lastFailure.reason}${rs.lastFailure.url ? ' · ' + rs.lastFailure.url : ''}`
          : null,
      ],
    ]);
    section.append(
      el(
        'small',
        readsNewestFirst(source)
          ? `Each search reads newest first, up to ${SCAN_SEARCH_LISTINGS} new listings or ${SCAN_SEARCH_PAGES} pages, and repeat scans stop at known listings.`
          : `Each search reads up to ${SCAN_SEARCH_LISTINGS} new listings or ${SCAN_SEARCH_PAGES} pages.`,
        'source-progress-rule',
      ),
    );
    return section;
  }

  // The search setups a recipe runs beside its main address.
  function setupList(variants) {
    const list = el('div');
    for (const variant of variants) {
      const row = el('div');
      row.append(el('b', variant.label + ': '), el('code', variant.template));
      list.append(row);
    }
    return list;
  }

  // Editor: the name and search terms; the recipe, which the trial round
  // learns by itself, and the per-source scope and instructions fold away.
  function recipeFields(form, recipe) {
    const f = form.elements;
    f.method.value = recipe ? recipe.entry.kind : 'none';
    f.template.value = recipe?.entry.kind === 'url_template' ? recipe.entry.template : '';
    f.formUrl.value = recipe?.entry.kind === 'search_form' ? recipe.entry.url : '';
    f.queryLabel.value =
      recipe?.entry.kind === 'search_form'
        ? (recipe.entry.fields.find((x) => x.key === 'query')?.label ?? '')
        : '';
    f.locationLabel.value =
      recipe?.entry.kind === 'search_form'
        ? (recipe.entry.fields.find((x) => x.key === 'location')?.label ?? '')
        : '';
    f.terms.value = recipe?.terms?.join(', ') ?? '';
    f.pagination.value = recipe?.pagination ?? 'auto';
    f.notes.value = recipe?.notes ?? '';
    syncRecipeFields(form);
  }
  function syncRecipeFields(form) {
    const method = form.elements.method.value;
    form.querySelector('[data-recipe-template]').hidden = method !== 'url_template';
    form.querySelector('[data-recipe-form]').hidden = method !== 'search_form';
    form.querySelector('[data-recipe-terms]').hidden = form.querySelector(
      '[data-recipe-pagination]',
    ).hidden = !['url_template', 'search_form'].includes(method);
    if (form.pagedByExtension) form.querySelector('[data-recipe-pagination]').hidden = true;
    form.querySelector('[data-recipe-notes]').hidden = method === 'none';
    form.querySelector('[data-recipe-site]').hidden = method !== 'url_template' || !form.siteSearch;
    form.elements.template.required = method === 'url_template';
    form.elements.formUrl.required = form.elements.queryLabel.required = method === 'search_form';
  }
  function readRecipe(form, existing) {
    const f = form.elements,
      method = f.method.value;
    if (method === 'none') return null;
    const keep =
      existing && existing.entry.kind === method && existing.loginRequired !== undefined
        ? {loginRequired: existing.loginRequired}
        : {};
    if (method === 'discovery')
      return {
        entry: {kind: 'discovery'},
        pagination: 'auto',
        ...keep,
        ...(f.notes.value.trim() ? {notes: f.notes.value.trim()} : {}),
      };
    const terms = f.terms.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const base = {
      pagination: f.pagination.value,
      ...keep,
      ...(terms.length ? {terms} : {}),
      ...(f.notes.value.trim() ? {notes: f.notes.value.trim()} : {}),
    };
    // The editor changes the main address; further search setups stay.
    if (method === 'url_template')
      return {
        ...base,
        entry: {
          kind: 'url_template',
          template: f.template.value.trim(),
          ...(existing?.entry.variants ? {variants: existing.entry.variants} : {}),
        },
      };
    return {
      ...base,
      entry: {
        kind: 'search_form',
        url: f.formUrl.value.trim(),
        fields: [
          {key: 'query', label: f.queryLabel.value.trim()},
          ...(f.locationLabel.value.trim()
            ? [{key: 'location', label: f.locationLabel.value.trim()}]
            : []),
        ],
      },
    };
  }
  // A site extension's known results address: its filters become controls
  // that rewrite the template, so nobody guesses parameters.
  function siteSearchFields(form, search) {
    form.siteSearch = search;
    if (!search) return;
    const f = form.elements,
      block = form.querySelector('[data-recipe-site]'),
      list = block.querySelector('.source-site-filters');
    const controls = search.filters.map((filter) => {
      const label = el('label', filter.label);
      let control;
      if (filter.values) {
        control = el('select');
        control.append(new Option('—', ''));
        for (const [value, text] of Object.entries(filter.values))
          control.append(new Option(text, value));
      } else {
        control = el('input');
        control.maxLength = 80;
      }
      control.dataset.param = filter.param;
      control.onchange = () => {
        f.template.value = withSearchFilters(f.template.value, {[filter.param]: control.value});
      };
      label.append(control);
      list.append(label);
      return control;
    });
    const sync = () => {
      const values = searchFilterValues(search, f.template.value);
      for (const control of controls) control.value = values[control.dataset.param] ?? '';
    };
    f.template.addEventListener('input', sync);
    const use = button('Use the site template', () => {
      f.template.value = search.template;
      f.pagination.value = search.pagination ?? 'auto';
      sync();
    });
    block
      .querySelector('small')
      .append(
        search.ordering === 'newest_first'
          ? 'The site template sorts newest first. '
          : 'The site’s known search address. ',
        use,
      );
    sync();
  }
  function editor(source) {
    const form = el('form', null, 'source-editor');
    form.dataset.sourceId = source.url;
    form.innerHTML = `<div class="source-editor-main">
<label>Name<input name="name" required maxlength="120"></label>
<label data-recipe-terms>Search terms<input name="terms" maxlength="500" placeholder="Backend Engineer, .NET, Platform Engineer" spellcheck="false"><small>Comma-separated, up to 5. Each term is its own search on this site.</small></label></div>
<details class="source-advanced"><summary>Advanced: search recipe and instructions</summary>
<div class="source-editor-section">
<label class="source-editor-wide">Search method <small class="source-recipe-legend"></small><select name="method"></select><small data-method-help>The trial round learns this by itself. A recipe written here is verified in the next scan.</small></label>
<label class="source-editor-wide" data-recipe-template>URL template<input name="template" maxlength="2000" placeholder="https://site/jobs?q={query}&l={location}&sort=date" spellcheck="false"><small>{query} takes each search term, or the search scope when there are none. Other placeholders such as {location} come from the criteria field of the same name.</small></label>
<div class="source-editor-wide source-site-search" data-recipe-site><b>Site filters</b><small></small><div class="source-recipe-form source-site-filters"></div></div>
<div class="source-editor-wide source-recipe-form" data-recipe-form><label>Search form page<input name="formUrl" type="url" placeholder="https://site/jobs"></label><label>Search field label<input name="queryLabel" maxlength="120" placeholder="Stichwort"></label><label>Location field label (optional)<input name="locationLabel" maxlength="120" placeholder="Ort"></label></div>
<label data-recipe-pagination>Pagination<select name="pagination"></select></label>
<label class="source-editor-wide" data-recipe-notes>Note to the agent<textarea name="notes" maxlength="1000" placeholder="Filters, ordering, things to watch out for…"></textarea></label>
<label class="source-editor-wide">Search scope<textarea name="query" maxlength="2000"></textarea><small>What this source looks for. Empty uses the workspace goal.</small></label>
<label class="source-editor-wide">Working instructions<textarea name="instructions" maxlength="6000" placeholder="Extra rules for this source (optional)"></textarea></label>
</div></details>
<div class="source-editor-foot"></div>`;
    const f = form.elements,
      footer = form.querySelector('.source-editor-foot'),
      scope = owner;
    // A site extension's known results address takes a URL template; a
    // collector reads nothing else. The saved method always stays selectable.
    const ext = source.extension,
      fixed = Boolean(ext?.search) || ext?.kind === 'api',
      offered = (value) =>
        !fixed ||
        value === source.recipe?.entry.kind ||
        ['none', 'url_template', ...(ext.kind === 'api' ? [] : ['discovery'])].includes(value);
    for (const [value, label] of Object.entries(methodLabels))
      if (offered(value)) f.method.append(new Option(label, value));
    if (fixed)
      form.querySelector('[data-method-help]').textContent =
        'The site extension defines the results address: choose the search terms and site filters. A recipe written here is verified in the next scan.';
    form.pagedByExtension = pagedByExtension(source);
    for (const value of RECIPE_PAGINATION_KINDS)
      f.pagination.append(new Option(paginationLabels[value], value));
    f.name.value = source.name;
    f.query.value = source.query?.trim() === data.automation.goal?.trim() ? '' : source.query;
    f.query.placeholder = data.automation.goal ?? '';
    f.instructions.value = source.instructions ?? '';
    siteSearchFields(form, source.extension?.search ?? null);
    recipeFields(form, source.recipe ?? null);
    f.method.onchange = () => syncRecipeFields(form);
    const cancel = button('Cancel', () => {
      editing = null;
      render();
    });
    cancel.dataset.cancel = '';
    const submit = el('button', 'Save', 'primary');
    submit.type = 'submit';
    footer.append(cancel, submit);
    form.onsubmit = action(async () => {
      const query = f.query.value.trim() || data.automation.goal;
      submit.disabled = true;
      try {
        await api.automationSourceSave(scope, source.url, {
          name: f.name.value,
          ...(query && query !== source.query ? {query} : {}),
          instructions: f.instructions.value,
          recipe: readRecipe(form, source.recipe ?? null),
        });
        editing = null;
        await refresh();
        notice('Source saved.');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }
  function updateEditor(form, source) {
    const locked = Boolean(source.scanning);
    for (const field of form.querySelectorAll('input,select,button[type=submit]'))
      field.disabled = locked;
    for (const field of form.querySelectorAll('textarea')) field.readOnly = locked;
    const summary = recipeSummary(source.recipe ?? null, source.recipeState ?? null),
      legend = form.querySelector('.source-recipe-legend');
    legend.textContent =
      summary.label +
      (source.recipeState?.verifiedAt ? ` · ${time(source.recipeState.verifiedAt)}` : '');
    legend.dataset.status = summary.status;
    form.querySelector('.source-editor-foot').title = locked
      ? 'The source is running. Stop the scan first to change it.'
      : '';
  }

  // Adding: one click for a site the app knows, or any address pasted in.
  // The name, scope and interval take their defaults; Edit changes them.
  function renderCatalog(section) {
    const groups = data.sourceCatalog ?? [],
      key = groups.flatMap((group) => group.choices.map((choice) => choice.url)).join(' ');
    if (section.dataset.key === key) return;
    section.dataset.key = key;
    section.hidden = !groups.length;
    const rows = el('ul');
    for (const group of groups) {
      const row = el('li'),
        about = el('div'),
        [first] = group.choices,
        many = group.choices.length > 1;
      about.append(
        el('b', many ? group.name : first.name),
        el(
          'small',
          many
            ? `${group.choices.length} countries`
            : `${new URL(first.url).hostname.replace(/^www\./, '')} · ${first.label}`,
        ),
      );
      row.append(about);
      // The workspace country, when the board serves it, is the first choice.
      const country = el('select');
      country.setAttribute('aria-label', `${group.name} country`);
      for (const choice of group.choices) country.append(new Option(choice.label, choice.url));
      if (many) row.append(country);
      const add = button('Add', async () => {
        const scope = owner,
          choice = group.choices.find((c) => c.url === country.value) ?? first;
        await api.automationSourceAdd(scope, {url: choice.url});
        if (owner !== scope) return;
        await refresh();
        notice(`${choice.name} added. It is tried automatically in its first round.`);
      });
      add.dataset.catalogAdd = group.name;
      row.append(add);
      rows.append(row);
    }
    section.replaceChildren(
      el('h3', 'Sites the app knows'),
      el('small', 'Their name and search come ready; add one with a click.'),
      rows,
    );
  }
  function addForm() {
    const form = el('form', null, 'source-add');
    form.innerHTML =
      '<label>Another site<input name="url" type="url" required placeholder="Paste the address of a job board or careers page"></label>';
    const submit = el('button', 'Add source', 'primary'),
      cancel = button('Cancel', () => {
        adding = false;
        render();
      });
    submit.type = 'submit';
    form.append(submit, cancel);
    form.onsubmit = action(async () => {
      const scope = owner;
      submit.disabled = true;
      try {
        await api.automationSourceAdd(scope, {url: form.elements.url.value});
        if (owner !== scope) return;
        adding = false;
        await refresh();
        notice('Source added. In its first round the agent learns how to search it.');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  // Opening the screen puts active sources first, then the one that works
  // soonest. The order then holds so rows do not jump while the screen is open;
  // sources added meanwhile go to the end.
  const workAt = (source) =>
    source.scanning ? 0 : (source.siteWait?.retryAt ?? source.nextRunAt ?? Infinity);
  function ordered(sources) {
    order ??= [...sources]
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || workAt(a) - workAt(b) || 0)
      .map((source) => source.url);
    const rank = (source) => {
      const index = order.indexOf(source.url);
      return index < 0 ? order.length : index;
    };
    return [...sources].sort((a, b) => rank(a) - rank(b));
  }

  function render() {
    if (!data) return;
    const sources = ordered(data.sources ?? []),
      enabled = sources.filter((s) => s.enabled),
      attention = enabled.filter(needsAttention).length,
      upcoming = enabled
        .filter((s) => !s.scanning && !s.blocked && s.nextRunAt)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const overview = head.querySelector('p');
    overview.textContent = sources.length
      ? `${enabled.length} active${sources.length - enabled.length ? `, ${sources.length - enabled.length} off` : ''}${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}. `
      : '';
    if (data.automation.status !== 'enabled' && sources.length)
      overview.append(document.createTextNode('Tracking is paused.'));
    else if (upcoming) {
      const next = el('span');
      next.dataset.sourceNextAt = String(upcoming.nextRunAt);
      next.dataset.sourceNextLabel = 'Next scan';
      next.dataset.sourceNextSuffix = `: ${upcoming.name}.`;
      next.title = time(upcoming.nextRunAt);
      updateNextRun(next);
      overview.append(next);
    }
    renderProposal();
    add.setAttribute('aria-expanded', String(adding));
    if (adding) {
      if (!addHost.firstChild) {
        const panel = el('section', null, 'source-add-panel');
        panel.append(el('section', null, 'source-catalog'), addForm());
        addHost.append(panel);
        panel.querySelector('[name=url]').focus();
      }
      renderCatalog(addHost.querySelector('.source-catalog'));
    } else addHost.replaceChildren();
    const kept = list.querySelector('.source-editor'),
      keptMemory = list.querySelector('.source-memory'),
      tabHosts = new Map(),
      urls = new Set(sources.map((source) => source.url));
    for (const [url, view] of rows)
      if (!urls.has(url)) {
        view.row.remove();
        rows.delete(url);
      }
    let previous = null;
    for (const source of sources) {
      const view = rows.get(source.url) ?? sourceRow(source.url),
        {row, toggle, main, run, restart, edit, relearn, remove, memoryButton, tabHost} = view,
        open = editing === source.url,
        memoryOpen = memory === source.url,
        scope = owner,
        locked = Boolean(source.scanning) || busySource(source.url);
      const next = previous ? previous.nextElementSibling : list.firstElementChild;
      if (next !== row) list.insertBefore(row, next);
      previous = row;
      row.dataset.open = String(open || memoryOpen);
      row.dataset.tone = source.enabled ? 'on' : 'off';
      row.dataset.trial = source.trialRunning
        ? 'running'
        : (source.trial?.status ?? (source.trialReady ? 'skipped' : 'pending'));
      toggle.checked = source.enabled;
      toggle.disabled = Boolean(source.stopping || view.pending);
      toggle.setAttribute('aria-label', source.name + ' active');
      toggle.onchange = action(async () => {
        const enabled = toggle.checked;
        toggle.disabled = true;
        let saved = false;
        try {
          await api.automationSourceSave(scope, source.url, {enabled});
          saved = true;
          await refresh();
        } catch (error) {
          if (!saved) toggle.checked = source.enabled;
          throw error;
        } finally {
          toggle.disabled = false;
        }
      });
      const name = el('div', source.name, 'source-name'),
        link = button(
          new URL(source.url).hostname.replace(/^www\./, ''),
          () => api.openLink(source.url),
          'source-url',
        );
      link.title = [source.url, readerLabels[source.extension?.kind ?? 'agent']].join('\n');
      name.append(link);
      main.replaceChildren(
        ...[
          name,
          statusLine(source),
          activityLine(source),
          requestLine(source),
          scheduleLine(source, scope),
        ].filter(Boolean),
      );
      const closing =
        (data.activeRuns ?? []).some(
          (r) => r.sourceUrl === source.url && !r.recordId && !r.recordOperation,
        ) && !source.scanning;
      // A timed site wait resumes by itself; Force retry ends it now.
      const timedWait = Boolean(source.siteWait?.waiting && !source.siteWait.exhausted);
      let runLabel = closing
          ? 'Session closing…'
          : timedWait
            ? 'Force retry'
            : source.blocked || source.siteWait?.exhausted
              ? 'Retry'
              : 'Scan now',
        runDisabled = closing || !source.enabled || !data.progress?.reviewed;
      run.title = timedWait
        ? 'The site asked us to slow down; this scan resumes by itself at the access check. Force retry ends the wait now and continues from the saved point. If the site still refuses, the wait starts again.'
        : source.trial?.status === 'passed'
          ? ''
          : 'The first round is a trial: the agent works out the site and saves the search recipe.';
      if (source.scanning || source.stopping) {
        runLabel = source.stopping ? 'Stopping…' : 'Stop scan';
        runDisabled = source.stopping;
        run.dataset.sourceStop = source.url;
      } else delete run.dataset.sourceStop;
      if (view.pending) {
        runLabel = view.pending === 'stop' ? 'Stopping…' : 'Starting…';
        runDisabled = true;
      }
      if (run.textContent !== runLabel) run.textContent = runLabel;
      run.disabled = Boolean(runDisabled);
      run.setAttribute('aria-busy', String(Boolean(view.pending || source.stopping)));
      run.onclick = (event) => {
        event.preventDefault();
        if (!run.disabled)
          void scanAction(
            view,
            scope,
            source.url,
            Boolean(source.scanning),
            false,
            timedWait && !source.scanning,
          );
      };
      // A scan left unfinished resumes where it stopped; this starts it over.
      const resumable =
        !source.scanning &&
        !source.stopping &&
        (source.scan?.complete === false || Boolean(source.scanState?.active));
      if (resumable)
        run.title = 'Continues from the page where it stopped and the remaining addresses.';
      // Stopped retries resume at the page that kept failing; starting over is
      // the other way out, so it stays available then.
      restart.hidden =
        !resumable || runDisabled || Boolean(source.siteWait && !source.siteWait.exhausted);
      restart.disabled = Boolean(view.pending);
      restart.title =
        'Clears the saved page position and remaining addresses and starts the scan from the first results page. Saved listings are not read again.';
      restart.onclick = (event) => {
        event.preventDefault();
        if (!restart.disabled) void scanAction(view, scope, source.url, false, true);
      };
      edit.textContent = open ? 'Close editor' : 'Edit';
      edit.onclick = action(() => {
        editing = open ? null : source.url;
        render();
      });
      edit.setAttribute('aria-expanded', String(open));
      // A site extension defines how this site is searched; there is nothing to relearn.
      relearn.hidden = Boolean(source.extension);
      relearn.disabled = remove.disabled = locked;
      relearn.title = locked
        ? 'Stop the scan first.'
        : 'Runs the trial round again and relearns how to search this site.';
      relearn.onclick = action(async () => {
        await api.automationSourceRelearn(scope, source.url);
        await refresh();
        notice('The next round of this source is a trial; the agent learns the search again.');
      });
      remove.title = locked
        ? 'Stop the scan first.'
        : 'Deletes the source and its search recipe. Found records are kept.';
      remove.onclick = action(async () => {
        if (!confirm(`Delete ${source.name}? Records it found are kept.`)) return;
        await api.automationSourceRemove(scope, source.url);
        if (owner !== scope) return;
        if (editing === source.url) editing = null;
        if (memory === source.url) memory = null;
        await refresh();
        notice('Source deleted. Found records were kept.');
      });
      view.menuToggle.setAttribute('aria-label', source.name + ' · More actions');
      memoryButton.textContent = memoryOpen ? 'Hide details' : 'Details';
      memoryButton.onclick = action(() => {
        memory = memoryOpen ? null : source.url;
        render();
      });
      memoryButton.setAttribute('aria-expanded', String(memoryOpen));
      const benchOpen = benchAvailable && benchSource === source.url;
      view.bench.hidden = !benchAvailable;
      view.bench.textContent = benchOpen ? 'Close test bench' : 'Test extension';
      view.bench.onclick = (event) => {
        event.preventDefault();
        benchSource = benchOpen ? null : source.url;
        render();
        if (!benchOpen) benchFor(source.url).open(source.url);
      };
      tabHosts.set(source.url, tabHost);
      row.querySelector(':scope > .source-memory')?.remove();
      if (!open) row.querySelector(':scope > .source-editor')?.remove();
      if (open) {
        const form = kept?.dataset.sourceId === source.url ? kept : editor(source);
        updateEditor(form, source);
        if (form.parentElement !== row) row.append(form);
      }
      if (memoryOpen) {
        const details = progressDetails(source),
          previousPending =
            keptMemory?.dataset.sourceId === source.url
              ? keptMemory.querySelector('.source-progress-pending')
              : null,
          pending = details.querySelector('.source-progress-pending');
        if (previousPending && pending) pending.open = previousPending.open;
        // Before an open bench, which is never moved: moving it would drop its focus.
        const bench = benches.get(source.url)?.element;
        row.insertBefore(details, bench?.parentElement === row ? bench : null);
      }
      if (benchOpen) {
        const panel = benchFor(source.url).element;
        if (panel.parentElement !== row) row.append(panel);
      } else benches.get(source.url)?.element.remove();
    }
    if (!sources.length) {
      if (!empty.isConnected) list.insertBefore(empty, otherHost);
    } else empty.remove();
    tabsControl.update(
      owner,
      sources.map((source) => ({id: source.url, url: source.url})),
      tabHosts,
      otherHost,
      list,
    );
  }
  return {
    update(snapshot, id) {
      if (owner !== id) {
        editing = null;
        memory = null;
        adding = false;
        addHost.replaceChildren();
        benchSource = null;
        for (const bench of benches.values()) bench.element.remove();
        benches.clear();
        headBench?.element.remove();
        headBench = null;
        for (const view of rows.values()) view.row.remove();
        rows.clear();
        order = null;
      }
      owner = id;
      data = snapshot;
      render();
    },
    resort() {
      order = null;
      render();
    },
  };
}
