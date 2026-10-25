import {positionMenu} from './popover-menu.js';
import {eligibilityLabels, assessmentEligibility, oldScoringMethod} from './scoring-state.js';
import {recordTable, recordCell, recordState, recordActions} from './record-table.js';
import {
  recordOperationStatus,
  recordActivityAt,
  recordIsWorking,
  recordNeedsAnswer,
  recordProblem,
  recordWaitsOnUser,
} from './record-operation-status.js';
import {recordTabs} from './workspace-tabs.js';
import {scoreBreakdown, ruleSummary} from './score-breakdown.js';
import {decidingRule, shortRule} from './hard-rules.js';
import {devToolsAvailable} from './agent-trace.js';
import {recordDevPanel} from './record-dev-panel.js';

// A listing's contacts in its row: once a search ran, the people it found
// (or its state) replace "Find contacts"; each opens the Contacts page.
const contactStates = {
  proposed: 'to approve',
  listed: 'on the listing',
  queued: 'sending',
  invited: 'invited',
  messaged: 'messaged',
  uncertain: 'check',
  failed: 'not sent',
};
const contactEntryOf = (data, recordId) =>
  (data.automation.recordContacts ?? []).find((e) => e.recordId === recordId);
const contactsKey = (data, recordId) => {
  const entry = contactEntryOf(data, recordId);
  return entry && [entry.state, entry.contacts.map((c) => [c.name, c.headline, c.state])];
};
function contactsFound(data, recordId, findContacts) {
  const entry = contactEntryOf(data, recordId);
  if (!entry) return [findContacts];
  // A person's chip shows their title (the profile headline) under the name.
  const chip = (text, tone, title, headline = '') => {
    const node = findContacts.cloneNode(false);
    node.textContent = text;
    if (headline) {
      const line = document.createElement('small');
      line.textContent = headline;
      node.append(line);
    }
    node.className = 'record-contact-chip';
    node.dataset.tone = tone;
    node.title = title;
    node.onclick = findContacts.onclick;
    return node;
  };
  const chips = entry.contacts.map((c) =>
    chip(
      `${c.name} · ${contactStates[c.state] ?? c.state}`,
      ['invited', 'messaged'].includes(c.state)
        ? 'done'
        : ['uncertain', 'failed'].includes(c.state)
          ? 'blocked'
          : c.state === 'queued'
            ? 'active'
            : 'waiting',
      [c.headline, 'Open on the Contacts page'].filter(Boolean).join(' · '),
      c.headline,
    ),
  );
  if (entry.state === 'searching')
    chips.unshift(chip('Searching contacts…', 'active', 'Open on the Contacts page'));
  else if (!chips.length)
    chips.push(
      chip(
        entry.state === 'failed' ? 'Contact search stopped' : 'No contact found',
        'muted',
        entry.error || entry.noneReason || 'Open on the Contacts page',
      ),
    );
  return chips;
}
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
const source = (result) => {
  try {
    return new URL(result.url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
};
const tabIdentity = (tabs) =>
  JSON.stringify(
    tabs
      .map(({tabId, recordId, runId}) => [tabId, recordId, runId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
const menuControlKey = (control) => {
  for (const key of [
    'recordMenuAction',
    'recordOperation',
    'recordDirect',
    'recordDismiss',
    'recordAction',
  ])
    if (control?.dataset[key]) return key + ':' + control.dataset[key];
};
// The row menu lists page links first, then work on the record, then status changes.
const menuGroup = ({dataset}) =>
  ['tab', 'open', 'detail'].includes(dataset.recordMenuAction)
    ? 0
    : dataset.recordSubmitted ||
        dataset.recordDismiss ||
        dataset.recordRestore ||
        dataset.recordAction
      ? 2
      : 1;
const groupMenu = (actions) => {
  const controls = [...actions.children].sort((a, b) => menuGroup(a) - menuGroup(b));
  actions.replaceChildren();
  controls.forEach((control, index) => {
    if (index && menuGroup(control) !== menuGroup(controls[index - 1])) {
      const separator = el('div', null, 'record-menu-separator');
      separator.setAttribute('role', 'separator');
      actions.append(separator);
    }
    actions.append(control);
  });
};
// Short relative time; the exact time stays in the element title.
const relativeTime = (at, now = Date.now()) => {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  if (minutes < 24 * 60) return Math.round(minutes / 60) + ' h ago';
  if (minutes < 7 * 24 * 60) return Math.round(minutes / 1440) + ' d ago';
  return new Date(at).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
};
const storedPageSize = () => {
  try {
    return [10, 25, 50].find((size) => size === Number(localStorage.getItem('recordPageSize')));
  } catch {
    return undefined;
  }
};
// The sort is remembered per automation, like the page size.
const sortStorageKey = (id) => 'recordSort:' + id;
const storedSort = (id) => {
  try {
    const value = JSON.parse(localStorage.getItem(sortStorageKey(id)));
    return typeof value?.key === 'string' && [1, -1].includes(value.direction) ? value : null;
  } catch {
    return null;
  }
};
// Empty or non-numeric values sort last.
const sortNumber = (value) =>
  value == null || String(value).trim() === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
const editable = (node) =>
  node instanceof HTMLElement &&
  (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));

// The setup agent's brief for one listing's "Evaluate criteria".
export function criteriaReviewMessage(result) {
  const assessment = result.assessment,
    decided = decidingRule(assessment),
    score = assessment.score === null ? 'could not be assessed' : `${assessment.score}/100`;
  return [
    `Evaluate the criteria for the listing "${result.title}" (record ${result.id}).`,
    `Fit score: ${score}.` +
      (decided
        ? ` ${decided.kind === 'eliminated' ? 'Eliminated' : 'On hold'} by the rule: ${decided.rule.text}`
        : ''),
    'Read the record with get_automation_result and explain why it scored this way or was eliminated: which criteria, elimination rules or listing facts caused it, and whether the judgement looks right.',
    'Do not change anything yet. If I ask for a change in this chat, propose it as a profile draft for me to review.',
  ].join('\n');
}

export function automationResultsTable(
  root,
  {
    button,
    badge,
    time,
    api,
    refresh,
    statusNames,
    onQuestion = () => {},
    onContacts = () => {},
    onEvaluateCriteria = null,
    onCoverLetter = () => {},
  },
) {
  let data,
    busy = false,
    page = 1,
    // null picks the default: fit score when the table has one, otherwise activity.
    sort = null,
    direction = -1,
    filterValue = 'all',
    detailId = null,
    cursorId = null,
    pageSize = storedPageSize() ?? 25,
    // Record ids in their last shown order; rows keep it while the pointer is on them.
    shownOrder = [],
    scrollLeft = 0,
    disposeTable = () => {};
  let batchSubmitting = null,
    selectionOwner = null;
  let tabOwner = null,
    liveTabs = [],
    liveTabIdentity = '[]',
    tabVersion = 0;
  // Frequent change notifications must not replace controls under the pointer:
  // the table stays mounted and only parts whose inputs changed are rebuilt.
  let mounted = null;
  const renderKeys = new WeakMap(),
    changed = (node, key) => renderKeys.get(node) !== key && (renderKeys.set(node, key), true),
    rows = new Map();
  const selectedIds = new Set(),
    requests = new Set(),
    visibleTabButtons = new Map();
  const review = el('dialog', null, 'automation-record-review'),
    reviewTitle = el('h2'),
    reviewSummary = el('p'),
    proposal = el('pre'),
    changes = el('textarea'),
    reviewError = el('p'),
    reviewActions = el('div', null, 'actions');
  const cancel = button('Cancel', () => review.close()),
    requestChanges = button('Request changes', () => {}),
    confirm = button('Approve and apply', () => {}, 'primary');
  changes.placeholder = 'What should change in the draft? (optional)';
  changes.maxLength = 2000;
  reviewError.setAttribute('role', 'alert');
  reviewActions.append(cancel, requestChanges, confirm);
  review.append(reviewTitle, reviewSummary, proposal, changes, reviewError, reviewActions);
  root.append(review);
  let reviewed = null,
    submitting = false;
  const sendOperation = async (result, kind, input = {}) => {
    const workspace = data.automation.id,
      key = workspace + ':' + result.id;
    if (requests.has(key)) return;
    requests.add(key);
    render();
    try {
      await api.automationRecordRun(workspace, result.id, kind, input);
      await refresh();
    } finally {
      requests.delete(key);
      render();
    }
  };
  const submitReview = async (kind, input) => {
    if (!reviewed || submitting) return;
    submitting = true;
    confirm.disabled = requestChanges.disabled = true;
    reviewError.textContent = '';
    try {
      await api.automationRecordRun(reviewed.workspace, reviewed.id, kind, input);
      review.close();
      await refresh();
    } catch (error) {
      reviewError.textContent = error.message;
    } finally {
      submitting = false;
      confirm.disabled = requestChanges.disabled = false;
    }
  };
  confirm.onclick = () => submitReview('execute', {digest: reviewed?.digest});
  // The draft goes back to preparation with the note; it needs approval again.
  requestChanges.onclick = () => {
    if (!changes.value.trim()) {
      reviewError.textContent = 'First write what you want changed.';
      return changes.focus();
    }
    submitReview('prepare', {changes: changes.value.trim()});
  };
  const toolbar = el('div', null, 'automation-results-toolbar'),
    search = el('input'),
    filter = el('div', null, 'record-filter-chips'),
    filterChips = new Map(),
    pageSizeSelect = el('select'),
    pagination = el('div', null, 'jobs-pagination'),
    content = el('div'),
    activity = el('div', null, 'record-activity-summary'),
    notice = el('p', null, 'record-notice');
  activity.setAttribute('role', 'status');
  notice.setAttribute('role', 'alert');
  notice.hidden = true;
  let noticeTimer = 0;
  // Action errors show here instead of a blocking alert.
  const showNotice = (message) => {
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.hidden = true), 8000);
  };
  search.type = 'search';
  search.id = 'automation-result-search';
  search.placeholder = 'Search results…';
  search.setAttribute('aria-label', 'Search results');
  filter.id = 'automation-result-filter';
  filter.setAttribute('role', 'group');
  filter.setAttribute('aria-label', 'Filter records');
  pageSizeSelect.id = 'automation-result-page-size';
  pageSizeSelect.setAttribute('aria-label', 'Records per page');
  for (const size of [10, 25, 50]) pageSizeSelect.add(new Option(size + ' per page', String(size)));
  pageSizeSelect.value = String(pageSize);
  pageSizeSelect.onchange = () => {
    pageSize = Number(pageSizeSelect.value);
    try {
      localStorage.setItem('recordPageSize', String(pageSize));
    } catch {}
    page = 1;
    render();
  };
  const pinnedNote = (count) => {
    const note = el('span', `${count} pinned on top`, 'record-pinned-note');
    note.title = 'Records that need your answer or are working stay above the sorted records.';
    return note;
  };
  const setFilter = (value) => {
    filterValue = value;
    page = 1;
    render();
  };
  const scoreFilter = el('div', null, 'record-score-filter'),
    scoreComparison = el('select'),
    scoreMinimum = el('input');
  scoreComparison.id = 'automation-result-score-comparison';
  scoreComparison.setAttribute('aria-label', 'Score comparison');
  scoreComparison.append(new Option('>', 'gt'), new Option('<', 'lt'));
  scoreMinimum.type = 'number';
  scoreMinimum.id = 'automation-result-score-minimum';
  scoreMinimum.min = '0';
  scoreMinimum.max = '100';
  scoreMinimum.step = 'any';
  scoreMinimum.placeholder = 'All';
  scoreMinimum.setAttribute('aria-label', 'Score limit');
  scoreFilter.append(el('span', 'Score'), scoreComparison, scoreMinimum);
  toolbar.append(search, scoreFilter, pageSizeSelect);
  root.previousElementSibling.append(toolbar);
  // Details open in a side panel so the table keeps its layout.
  const drawer = el('aside', null, 'record-drawer'),
    drawerHead = el('header', null, 'record-drawer-head'),
    drawerTitle = el('h2'),
    drawerMeta = el('p', null, 'record-drawer-meta'),
    drawerBody = el('div', null, 'record-drawer-body'),
    drawerTools = el('div', null, 'record-drawer-tools');
  drawer.id = 'record-drawer';
  drawer.popover = 'manual';
  drawer.setAttribute('aria-labelledby', 'record-drawer-title');
  drawerTitle.id = 'record-drawer-title';
  const closeDrawer = () => {
    const id = detailId;
    detailId = null;
    render();
    root.querySelector(`[data-result-id="${id}"]`)?.focus({preventScroll: true});
  };
  const drawerClose = button('×', closeDrawer, 'record-drawer-close');
  drawerClose.setAttribute('aria-label', 'Close details');
  drawerHead.append(drawerTitle, drawerClose);
  drawer.append(drawerHead, drawerMeta, drawerTools, drawerBody);
  const toggleDetail = (id) => {
    detailId = detailId === id ? null : id;
    cursorId = id;
    render();
  };
  root.replaceChildren(filter, activity, pagination, notice, content, review, drawer);
  search.oninput =
    scoreMinimum.oninput =
    scoreComparison.onchange =
      () => {
        page = 1;
        render();
      };
  const selection = el('div', null, 'record-selection-toolbar'),
    selectionCount = el('span'),
    selectionError = el('span', null, 'record-selection-error');
  selectionCount.setAttribute('role', 'status');
  selectionError.setAttribute('role', 'alert');
  const eligible = (result) =>
    Boolean(
      result.recordAction?.scoreOperation &&
      !result.recordAction.scoreOperation.disabled &&
      !requests.has(data.automation.id + ':' + result.id),
    );
  const deletable = (result) =>
    Boolean(
      api.automationRecordsDelete &&
      !result.recordAction?.task &&
      result.status !== 'executing' &&
      !requests.has(data.automation.id + ':' + result.id),
    );
  const selectableRecord = (result) => eligible(result) || deletable(result);
  const clearSelection = button('Clear selection', () => {
    selectedIds.clear();
    selectionError.textContent = '';
    render();
  });
  const scoreSelected = button(
    'Score selected',
    async () => {
      if (
        batchSubmitting ||
        busy ||
        !selectedIds.size ||
        selectedIds.size > 100 ||
        data.results.some((result) => selectedIds.has(result.id) && !eligible(result))
      )
        return;
      const workspace = data.automation.id,
        ids = [...selectedIds];
      batchSubmitting = 'score';
      selectionError.textContent = '';
      for (const id of ids) requests.add(workspace + ':' + id);
      render();
      try {
        await api.automationRecordsScore(workspace, ids);
        if (selectionOwner === workspace) for (const id of ids) selectedIds.delete(id);
        await refresh();
      } catch (error) {
        if (selectionOwner === workspace) selectionError.textContent = error.message;
      } finally {
        for (const id of ids) requests.delete(workspace + ':' + id);
        batchSubmitting = null;
        render();
      }
    },
    'primary',
  );
  scoreSelected.dataset.recordsScore = '';
  const deleteSelected = button(
    'Delete selected',
    async () => {
      if (
        batchSubmitting ||
        busy ||
        !selectedIds.size ||
        data.results.some((result) => selectedIds.has(result.id) && !deletable(result))
      )
        return;
      const workspace = data.automation.id,
        ids = [...selectedIds];
      if (!window.confirm(`Permanently delete ${ids.length} selected record(s)?`)) return;
      batchSubmitting = 'delete';
      selectionError.textContent = '';
      for (const id of ids) requests.add(workspace + ':' + id);
      render();
      try {
        await api.automationRecordsDelete(workspace, ids);
        if (selectionOwner === workspace) {
          for (const id of ids) selectedIds.delete(id);
          if (ids.includes(detailId)) detailId = null;
          if (ids.includes(reviewed?.id)) {
            review.close();
            reviewed = null;
          }
        }
        await refresh();
      } catch (error) {
        if (selectionOwner === workspace) selectionError.textContent = error.message;
      } finally {
        for (const id of ids) requests.delete(workspace + ':' + id);
        batchSubmitting = null;
        render();
      }
    },
    'danger',
  );
  deleteSelected.dataset.recordsDelete = '';
  const skippable = (result) =>
    Boolean(
      api.automationDismiss &&
      ['found', 'prepared', 'uncertain'].includes(result.status) &&
      !result.recordAction?.task &&
      !requests.has(data.automation.id + ':' + result.id),
    );
  const skipSelected = button('Skip selected', async () => {
    if (
      batchSubmitting ||
      busy ||
      !selectedIds.size ||
      data.results.some((result) => selectedIds.has(result.id) && !skippable(result))
    )
      return;
    const workspace = data.automation.id,
      ids = [...selectedIds];
    batchSubmitting = 'skip';
    selectionError.textContent = '';
    for (const id of ids) requests.add(workspace + ':' + id);
    render();
    try {
      for (const id of ids) {
        await api.automationDismiss(workspace, id);
        if (selectionOwner === workspace) selectedIds.delete(id);
      }
      await refresh();
    } catch (error) {
      if (selectionOwner === workspace) selectionError.textContent = error.message;
      await refresh();
    } finally {
      for (const id of ids) requests.delete(workspace + ':' + id);
      batchSubmitting = null;
      render();
    }
  });
  skipSelected.dataset.recordsSkip = '';
  selection.append(
    selectionCount,
    scoreSelected,
    skipSelected,
    deleteSelected,
    clearSelection,
    selectionError,
  );
  root.insertBefore(selection, pagination);

  function syncTabButtons() {
    for (const {result, control, place, remove} of visibleTabButtons.values()) {
      if (recordTabs(result, liveTabs, data).length) {
        if (!control.isConnected) place();
      } else remove();
    }
  }
  async function refreshTabs() {
    if (!tabOwner) return;
    const id = tabOwner,
      version = ++tabVersion;
    const next = await api.workspaceTabs(id).catch(() => []);
    if (tabOwner !== id || version !== tabVersion) return;
    const identity = tabIdentity(next),
      changed = identity !== liveTabIdentity;
    liveTabs = next;
    liveTabIdentity = identity;
    if (changed) render();
    else syncTabButtons();
  }
  const tabTimer = setInterval(() => {
    const visible = root.isConnected && root.getClientRects().length > 0;
    if (visible) void refreshTabs();
    // The side panel sits in the top layer, so it follows the table's visibility.
    if (!visible && drawer.matches(':popover-open')) drawer.hidePopover();
    else if (visible && detailId && !drawer.matches(':popover-open')) renderDrawer();
  }, 1000);
  function positionOpenMenu() {
    const panel = content.querySelector('.record-row-actions:popover-open');
    if (panel)
      positionMenu(panel, panel.closest('[data-result-id]').querySelector('.record-row-menu'));
  }

  // The Listing tab shows the description saved with the record. It is fetched
  // on demand, not with every snapshot, and fetched again after the record changes.
  let drawerTab = 'fit';
  const descriptions = new Map();
  async function loadDescription(result, read = false) {
    const workspace = data.automation.id,
      entry = {status: read ? 'reading' : 'loading', at: result.updatedAt, value: null, error: ''};
    descriptions.set(result.id, entry);
    try {
      entry.value = await (read
        ? api.automationRecordDescriptionRead(workspace, result.id)
        : api.automationRecordDescription(workspace, result.id));
      entry.status = entry.value ? 'ready' : 'missing';
    } catch (error) {
      entry.status = 'error';
      entry.error = error.message;
    }
    if (descriptions.get(result.id) === entry && detailId === result.id) {
      renderKeys.delete(drawer);
      renderDrawer();
    }
  }
  function listingContent(result) {
    const cell = el('div', null, 'record-listing');
    if (!api.automationRecordDescription) return cell;
    let entry = descriptions.get(result.id);
    if (
      !entry ||
      (entry.at !== result.updatedAt && !['loading', 'reading'].includes(entry.status))
    ) {
      void loadDescription(result);
      entry = descriptions.get(result.id);
    }
    const readButton = (label) => {
      const read = button(label, () => loadDescription(result, true));
      read.disabled = entry.status === 'reading';
      return read;
    };
    if (entry.status === 'loading')
      cell.append(el('p', 'Loading the description…', 'record-listing-state'));
    else if (entry.status === 'reading')
      cell.append(el('p', 'Reading the listing…', 'record-listing-state'));
    else if (entry.status === 'ready') {
      cell.append(el('div', entry.value.text, 'record-listing-text'));
      const footer = el('div', null, 'record-listing-footer');
      footer.append(
        el('small', `Saved ${time(entry.value.readAt)} from ${source({url: entry.value.url})}`),
        readButton('Read again'),
      );
      cell.append(footer);
    } else {
      cell.append(
        el(
          'p',
          entry.status === 'error'
            ? `Could not read the description: ${entry.error}`
            : 'No description was saved for this listing yet. Records found from now on keep the description their scan or scoring read.',
          'record-listing-state',
        ),
        readButton('Read listing'),
      );
    }
    return cell;
  }

  // Development builds: a developer section per record, kept across rebuilds.
  let devAvailable = false;
  const devPanels = new Map();
  void devToolsAvailable(api).then((available) => {
    devAvailable = available;
    if (available && detailId) {
      renderKeys.delete(drawer);
      renderDrawer();
    }
  });
  // The side panel leads with the verdict and its reasons; the calculation and
  // the record's history stay folded below.
  function detailContent(result) {
    const cell = el('div');
    const assessment = result.assessment;
    if (assessment) {
      const verdict = el('section', null, 'record-verdict'),
        score = el('p', null, 'record-verdict-score'),
        text = el('div');
      verdict.dataset.tone = assessment.score === null ? 'none' : assessmentEligibility(assessment);
      score.append(
        el('strong', assessment.score === null ? '–' : String(assessment.score)),
        el('span', '/100'),
      );
      text.append(
        el(
          'p',
          assessment.score === null
            ? 'Could not be assessed'
            : eligibilityLabels[assessmentEligibility(assessment)],
          'record-verdict-label',
        ),
      );
      if (assessment.summary) text.append(el('p', assessment.summary));
      verdict.append(score, text);
      cell.append(verdict);
      if (oldScoringMethod(assessment))
        cell.append(
          el(
            'p',
            'Scored with the previous method; rescore for a current fit score.',
            'record-score-stale',
          ),
        );
      const rules = ruleSummary(assessment);
      if (rules) cell.append(rules);
      const notes = el('div', null, 'record-fit-notes');
      for (const [label, items] of [
        ['Matches', assessment.strengths],
        ['Gaps', [...(assessment.gaps ?? []), ...(assessment.uncertainties ?? [])]],
      ])
        if (items?.length) {
          const column = el('div'),
            list = el('ul');
          for (const note of items) list.append(el('li', note));
          column.dataset.kind = label.toLowerCase();
          column.append(el('h4', label), list);
          notes.append(column);
        }
      if (notes.childElementCount) cell.append(notes);
    }
    if (result.summary) cell.append(el('h3', 'About the listing'), el('p', result.summary));
    if (assessment) {
      const how = el('details', null, 'record-drawer-section');
      how.append(el('summary', 'How the score was calculated'), scoreBreakdown(assessment));
      if (assessment.rubric)
        how.append(el('h4', 'Scoring criteria used'), el('p', assessment.rubric));
      if (assessment.evidence) how.append(el('blockquote', assessment.evidence));
      how.append(
        button('Assessed listing ↗', () => api.openLink(assessment.evidenceUrl)),
        el('small', `Assessed ${time(assessment.scoredAt)} · Not a probability of success.`),
      );
      cell.append(how);
    }
    const activity = [
      ['Work note', result.proposal, 'pre'],
      ['Last action', result.recordAction?.lastTask?.summary, 'p'],
      ['Outcome evidence', result.evidence, 'blockquote'],
    ].filter(([, text]) => text);
    if (activity.length) {
      const section = el('details', null, 'record-drawer-section');
      section.append(el('summary', 'Activity'));
      for (const [label, text, tag] of activity) section.append(el('h4', label), el(tag, text));
      cell.append(section);
    }
    if (devAvailable) {
      if (!devPanels.has(result.id))
        devPanels.set(
          result.id,
          recordDevPanel(api, {workspace: () => data.automation.id, recordId: result.id}),
        );
      const panel = devPanels.get(result.id);
      panel.update(result);
      cell.append(panel.element);
    }
    return cell;
  }

  function render() {
    if (!data) return;
    const openMenu = content.querySelector('.record-row-actions:popover-open'),
      openRow = openMenu?.closest('[data-result-id]'),
      focused = document.activeElement;
    const focusedAction = openMenu?.contains(focused) ? menuControlKey(focused) : null,
      focusedToggle = openRow?.querySelector('.record-row-menu') === focused,
      menuScroll = openMenu?.scrollTop;
    const active = data.results.filter((r) => recordOperationStatus(r)?.active),
      queued = active.filter((r) => r.recordAction?.task?.state === 'pending').length,
      waiting = data.results.filter(recordNeedsAnswer).length;
    if (changed(activity, JSON.stringify([active.length, queued, waiting]))) {
      activity.replaceChildren();
      activity.hidden = !active.length;
    }
    if (active.length && !activity.childElementCount)
      activity.append(
        el(
          'span',
          `${active.length} record(s) in progress · ${queued} queued${waiting ? ` · ${waiting} awaiting an answer` : ''}`,
        ),
      );
    // Filter chips carry their counts; empty ones hide unless selected.
    const matchesFilter = (r, value) =>
      value === 'all' ||
      (value === 'attention'
        ? recordNeedsAnswer(r) || Boolean(recordWaitsOnUser(r))
        : value === 'active'
          ? recordOperationStatus(r)?.active
          : value === 'trial'
            ? r.trial
            : value === 'starred'
              ? r.starred
              : value === 'eliminated' || value === 'held'
                ? !r.trial &&
                  ['found', 'prepared'].includes(r.status) &&
                  decidingRule(r.assessment)?.kind === value
                : !r.trial && recordState(r, data.definition).id === value);
    if (!filterChips.has(filterValue)) filterValue = 'all';
    for (const [value, chip] of filterChips) {
      const count = data.results.filter((r) => matchesFilter(r, value)).length,
        selected = value === filterValue;
      chip.hidden = !count && !selected && value !== 'all';
      chip.setAttribute('aria-pressed', String(selected));
      chip.lastChild.textContent = String(count);
      chip.dataset.attention = String(value === 'attention' && count > 0);
    }
    const query = search.value.trim().toLocaleLowerCase('en-GB').split(/\s+/).filter(Boolean);
    const hasScore = Boolean(
      data.definition.recordOperations?.score ||
      data.automation.table?.columns?.some((column) => column.key === 'score'),
    );
    scoreFilter.hidden = !hasScore;
    const threshold =
      hasScore && Number.isFinite(scoreMinimum.valueAsNumber) ? scoreMinimum.valueAsNumber : null;
    const matchesScore = (result) => {
      const score = result.assessment ? result.assessment.score : result.cells?.score;
      return (
        threshold === null ||
        (score != null &&
          String(score).trim() !== '' &&
          Number.isFinite(Number(score)) &&
          (scoreComparison.value === 'lt' ? Number(score) < threshold : Number(score) > threshold))
      );
    };
    const results = data.results.filter(
      (r) =>
        matchesScore(r) &&
        matchesFilter(r, filterValue) &&
        query.every((q) =>
          [
            r.title,
            r.summary,
            r.url,
            ...Object.values(r.cells ?? {}),
            recordState(r, data.definition).label,
            recordOperationStatus(r)?.label ?? '',
          ]
            .join(' ')
            .toLocaleLowerCase('en-GB')
            .includes(q),
        ),
    );
    const openIds = new Set(
      liveTabs.length
        ? results
            .filter((result) => recordTabs(result, liveTabs, data).length)
            .map((result) => result.id)
        : [],
    );
    const columns = data.automation.table?.columns ?? [
      {key: 'source', label: 'Source', type: 'text'},
      {key: 'title', label: 'Record', type: 'text'},
    ];
    // Source and short text columns read as one line under the title, so the
    // table needs fewer columns and rarely scrolls sideways.
    const hasTitle = columns.some((c) => c.key === 'title'),
      folded = hasTitle
        ? columns.filter((c) => c.key === 'source' || (c.type === 'text' && c.key !== 'title'))
        : [],
      shown = columns.filter((c) => !folded.includes(c));
    if (!['status', 'updatedAt', ...shown.map((c) => c.key)].includes(sort)) {
      sort = shown.some((c) => c.key === 'score') ? 'score' : 'updatedAt';
      direction = -1;
    }
    const numericColumn = (key) =>
      key === 'updatedAt' || ['number', 'money'].includes(columns.find((c) => c.key === key)?.type);
    const numeric = numericColumn(sort) || sort === 'status',
      states = data.definition?.records?.states ?? [];
    // Status follows the workflow order of the states, not their labels.
    const value = (r) => {
      if (sort === 'status') {
        const index = states.findIndex((s) => s.id === recordState(r, data.definition).id);
        return index < 0 ? states.length : index;
      }
      const raw =
        sort === 'updatedAt'
          ? recordActivityAt(r)
          : sort === 'title'
            ? r.title
            : sort === 'score' && r.assessment
              ? r.assessment.score
              : r.cells?.[sort];
      return numeric ? sortNumber(raw) : String(raw ?? '').trim() || null;
    };
    const priority = (result) => (recordNeedsAnswer(result) ? 0 : recordIsWorking(result) ? 1 : 2);
    // Missing values stay last in both directions; ties show the latest activity first.
    results.sort((a, b) => {
      const rank = priority(a) - priority(b);
      if (rank) return rank;
      const av = value(a),
        bv = value(b);
      if (av === null || bv === null) {
        if (av !== bv) return av === null ? 1 : -1;
      } else {
        const order = direction * (numeric ? av - bv : collator.compare(av, bv));
        if (order) return order;
      }
      return recordActivityAt(b) - recordActivityAt(a) || collator.compare(a.id, b.id);
    });
    // While the pointer is on the rows, refreshes do not move the rows that were
    // already shown; new rows take their sorted place. Leaving the rows re-sorts.
    if (mounted?.body.matches(':hover')) {
      const held = new Map(shownOrder.map((id, index) => [id, index])),
        known = results
          .filter((r) => held.has(r.id))
          .sort((a, b) => held.get(a.id) - held.get(b.id));
      let next = 0;
      results.forEach((r, index) => {
        if (held.has(r.id)) results[index] = known[next++];
      });
    }
    shownOrder = results.map((r) => r.id);
    const pinned = results.filter((r) => priority(r) < 2).length;
    const pages = Math.max(1, Math.ceil(results.length / pageSize));
    page = Math.min(page, pages);
    const start = (page - 1) * pageSize,
      visible = results.slice(start, start + pageSize);
    const selectable = Boolean(
        data.definition.recordOperations?.score || api.automationRecordsDelete,
      ),
      visibleEligible = visible.filter(selectableRecord);
    selection.hidden = !selectable || !selectedIds.size;
    selectionCount.textContent = selectedIds.size + ' record(s) selected';
    const selectedResults = data.results.filter((result) => selectedIds.has(result.id)),
      allScorable = selectedResults.every(eligible),
      allDeletable = selectedResults.every(deletable);
    scoreSelected.hidden = !data.definition.recordOperations?.score;
    deleteSelected.hidden = !api.automationRecordsDelete;
    scoreSelected.textContent =
      batchSubmitting === 'score' ? 'Queueing…' : `Score selected (${selectedIds.size})`;
    scoreSelected.disabled =
      busy ||
      Boolean(batchSubmitting) ||
      !selectedIds.size ||
      selectedIds.size > 100 ||
      !allScorable;
    scoreSelected.title =
      selectedIds.size > 100
        ? 'At most 100 records can be scored at once.'
        : !allScorable
          ? 'Some selected records cannot be scored right now.'
          : '';
    deleteSelected.textContent =
      batchSubmitting === 'delete' ? 'Deleting…' : `Delete selected (${selectedIds.size})`;
    deleteSelected.disabled =
      busy || Boolean(batchSubmitting) || !selectedIds.size || !allDeletable;
    deleteSelected.title = !allDeletable
      ? 'Stop the queued or running operations of the selected records before deleting.'
      : '';
    const allSkippable = selectedResults.every(skippable);
    skipSelected.hidden = !api.automationDismiss;
    skipSelected.textContent =
      batchSubmitting === 'skip' ? 'Skipping…' : `Skip selected (${selectedIds.size})`;
    skipSelected.disabled = busy || Boolean(batchSubmitting) || !selectedIds.size || !allSkippable;
    skipSelected.title = !allSkippable
      ? 'Only found or ready records without a running operation can be skipped.'
      : 'Skip the selected records and close their pending questions';
    clearSelection.disabled = Boolean(batchSubmitting);
    const selectCheckbox = (label, checked, change) => {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.setAttribute('aria-label', label);
      input.disabled = busy || batchSubmitting;
      input.onchange = change;
      return input;
    };

    const paginationChanged = changed(
      pagination,
      JSON.stringify([start, visible.length, results.length, page, pages, pinned]),
    );
    if (paginationChanged) {
      const keys = el(
        'span',
        'Keys: j/k move · Enter details · a next step · s skip · x select · o open',
        'record-shortcuts',
      );
      keys.title = 'Keyboard shortcuts work while the table is visible and no field has focus.';
      pagination.replaceChildren(
        el(
          'span',
          results.length
            ? `${start + 1}–${start + visible.length} / ${results.length} records`
            : '0 records',
          'pagination-count',
        ),
        ...(pinned ? [pinnedNote(pinned)] : []),
        ...(visible.length ? [keys] : []),
      );
    }
    if (paginationChanged && pages > 1) {
      const previous = button('Previous', () => {
          page--;
          render();
        }),
        next = button('Next', () => {
          page++;
          render();
        });
      previous.disabled = page === 1;
      next.disabled = page === pages;
      pagination.append(previous, el('span', `${page} / ${pages}`), next);
    }
    visibleTabButtons.clear();
    const tableColumns = [
      ...(selectable ? [{key: 'selection', label: 'Select'}] : []),
      ...shown,
      {key: 'updatedAt', label: 'Activity'},
      {key: 'status', label: 'Status'},
    ];
    const tableKey = JSON.stringify([data.automation.id, tableColumns]),
      previousTable = mounted && renderKeys.get(mounted.table) !== tableKey ? mounted : null;
    if (!mounted || previousTable) {
      disposeTable();
      rows.clear();
      mounted = recordTable(tableColumns, {
        className: 'jobs-table automation-results-table',
        scrollLeft,
        onScroll: (value) => {
          scrollLeft = value;
        },
        onLayout: positionOpenMenu,
      });
      renderKeys.set(mounted.table, tableKey);
      disposeTable = mounted.dispose;
      mounted.table.setAttribute('aria-label', 'Tracked records and results');
      mounted.table.style.minWidth = 600 + Math.max(0, shown.length - 2) * 110 + 'px';
      content.append(mounted.element);
      mounted.body.addEventListener('pointerleave', () => render());
    }
    const {element, table, body} = mounted,
      headRow = table.tHead.rows[0];
    if (
      changed(
        headRow,
        JSON.stringify([
          sort,
          direction,
          visibleEligible.map((result) => [result.id, selectedIds.has(result.id)]),
          busy,
          Boolean(batchSubmitting),
        ]),
      )
    )
      tableColumns.forEach(({key, label}, index) => {
        const th = headRow.cells[index];
        if (key === 'selection') {
          const count = visibleEligible.filter((result) => selectedIds.has(result.id)).length;
          const selectPage = selectCheckbox(
            'Select records on this page',
            visibleEligible.length > 0 && count === visibleEligible.length,
            () => {
              for (const result of visibleEligible)
                selectPage.checked ? selectedIds.add(result.id) : selectedIds.delete(result.id);
              selectionError.textContent = '';
              render();
            },
          );
          selectPage.indeterminate = count > 0 && count < visibleEligible.length;
          selectPage.disabled ||= !visibleEligible.length;
          selectPage.dataset.recordsSelectPage = '';
          th.replaceChildren(selectPage);
        } else {
          const active = sort === key;
          th.setAttribute(
            'aria-sort',
            active ? (direction === 1 ? 'ascending' : 'descending') : 'none',
          );
          // Numbers and activity start with the highest value, text and status with the first.
          const control = button(
            label,
            () => {
              direction = active ? -direction : numericColumn(key) ? -1 : 1;
              sort = key;
              page = 1;
              shownOrder = [];
              try {
                localStorage.setItem(
                  sortStorageKey(data.automation.id),
                  JSON.stringify({key: sort, direction}),
                );
              } catch {}
              render();
            },
            'sort-button',
          );
          control.append(
            el('span', active ? (direction === 1 ? '↑' : '↓') : '↕', 'sort-indicator'),
          );
          control.title = active
            ? `Sorted by ${label}, ${direction === 1 ? 'ascending' : 'descending'}. Click to reverse.`
            : `Sort by ${label}`;
          control.dataset.resultSort = key;
          th.replaceChildren(control);
        }
      });
    // Rows keep their nodes while their inputs are unchanged. Changed rows are
    // inserted around the kept ones, so a kept row is not moved under the pointer.
    const rowKeys = new Map(
      visible.length
        ? visible.map((result) => [
            result.id,
            JSON.stringify([
              result,
              requests.has(data.automation.id + ':' + result.id),
              busy,
              batchSubmitting,
              selectedIds.has(result.id),
              detailId === result.id,
              openIds.has(result.id),
              data.workers?.find((w) => w.id === result.recordAction?.task?.workerId)?.name,
              data.automation.revision,
              (data.automation.questions ?? [])
                .filter((q) => q.coverLetter && q.recordId === result.id)
                .map((q) => [q.id, q.answer != null, q.coverLetter.path]),
              contactsKey(data, result.id),
            ]),
          ])
        : [['', JSON.stringify([Boolean(data.results.length)])]],
    );
    const kept = new Set(),
      placed = new Set();
    for (const [id, key] of rowKeys) {
      const cached = rows.get(id);
      if (cached?.key === key) kept.add(cached.row);
      else rows.delete(id);
    }
    for (const id of rows.keys()) if (!rowKeys.has(id)) rows.delete(id);
    let cursor = body.firstChild;
    const place = (node) => {
      while (cursor && !kept.has(cursor)) cursor = cursor.nextSibling;
      placed.add(node);
      if (node === cursor) cursor = node.nextSibling;
      else if (node.parentNode === body) body.moveBefore(node, cursor);
      else body.insertBefore(node, cursor);
    };
    const reuse = (id) => {
      const cached = rows.get(id);
      if (!cached) return false;
      place(cached.row);
      if (cached.tab) visibleTabButtons.set(id, cached.tab);
      return true;
    };
    if (!visible.length) {
      if (!reuse('')) {
        const row = el('tr'),
          cell = el('td', null, 'empty');
        cell.colSpan = tableColumns.length;
        cell.append(
          el(
            'strong',
            data.results.length ? 'No results match this search or filter.' : 'No records yet',
          ),
          el(
            'p',
            data.results.length
              ? 'Try a different search or filter.'
              : 'Records the agent finds, application notes and action results will appear here.',
          ),
        );
        row.append(cell);
        place(row);
        rows.set('', {key: rowKeys.get(''), row});
      }
    }
    for (const result of visible) {
      if (reuse(result.id)) continue;
      const progress = recordOperationStatus(result),
        requesting = requests.has(data.automation.id + ':' + result.id),
        // The reason and its actions live under the record title.
        problem =
          requesting || !columns.some((c) => c.key === 'title') ? null : recordProblem(result),
        problemActions = el('div', null, 'record-problem-actions');
      const keepMenu = openRow?.dataset.resultId === result.id;
      const row = el('tr'),
        state = el('td'),
        updated = el('td'),
        actionsPanel = keepMenu ? openMenu : el('div', null, 'record-row-actions'),
        actions = el('div', null, 'table-actions'),
        actionsToggle = keepMenu
          ? openRow.querySelector('.record-row-menu')
          : button(
              '⋯',
              () => {
                if (actionsPanel.matches(':popover-open')) {
                  actionsPanel.hidePopover();
                  return;
                }
                actionsPanel.showPopover();
                positionMenu(actionsPanel, actionsToggle);
              },
              'record-row-menu',
            );
      row.dataset.resultId = result.id;
      row.dataset.needsAnswer = String(recordNeedsAnswer(result));
      row.dataset.working = String(recordIsWorking(result));
      row.dataset.openTab = String(openIds.has(result.id));
      row.dataset.outcome =
        !progress && !requesting
          ? recordState(result, data.definition).closed
            ? 'closed'
            : result.status
          : '';
      row.dataset.problem = String(Boolean(problem));
      actionsPanel.popover = 'auto';
      actionsPanel.id = 'record-row-actions-' + result.id;
      actionsToggle.setAttribute('aria-controls', actionsPanel.id);
      actionsToggle.setAttribute('aria-expanded', String(keepMenu));
      actionsToggle.setAttribute('aria-label', result.title + ' · Actions');
      actionsToggle.title = 'Actions';
      actionsPanel.ontoggle = () =>
        actionsToggle.setAttribute('aria-expanded', String(actionsPanel.matches(':popover-open')));
      row.dataset.selected = String(selectedIds.has(result.id));
      if (selectable) {
        const cell = el('td');
        cell.dataset.column = 'selection';
        const checkbox = selectCheckbox(
          result.title + ' · Select',
          selectedIds.has(result.id),
          () => {
            checkbox.checked ? selectedIds.add(result.id) : selectedIds.delete(result.id);
            selectionError.textContent = '';
            render();
            root.querySelector(`[data-record-select="${result.id}"]`)?.focus();
          },
        );
        checkbox.dataset.recordSelect = result.id;
        checkbox.disabled ||= !selectableRecord(result);
        checkbox.title = !selectableRecord(result)
          ? 'An operation for this record is queued or running'
          : '';
        cell.append(checkbox);
        row.append(cell);
      }
      for (const column of shown) {
        const cell = el('td');
        cell.dataset.column = column.key;
        if (column.key === 'title') {
          cell.className = 'role-cell';
          const heading = el('strong', result.title);
          heading.title = result.title;
          cell.append(heading);
          const meta = el('div', null, 'record-meta');
          for (const column of folded) {
            const text =
              column.key === 'source' ? source(result) : String(result.cells?.[column.key] ?? '');
            if (!text.trim()) continue;
            const part = el('span', text);
            part.title = column.label + ': ' + text;
            meta.append(part);
          }
          if (folded.some((c) => c.key === 'source')) {
            const star = button(
              result.starred ? '★' : '☆',
              async () => {
                await api.automationStar(data.automation.id, result.id, !result.starred);
                await refresh();
              },
              'job-star',
            );
            star.setAttribute('aria-label', result.starred ? 'Remove star' : 'Star');
            star.setAttribute('aria-pressed', String(Boolean(result.starred)));
            meta.prepend(star);
          }
          if (meta.childElementCount) cell.append(meta);
          if (recordIsWorking(result)) {
            const worker = data.workers?.find((w) => w.id === result.recordAction.task.workerId),
              mark = el(
                'span',
                'Agent working' + (worker?.name ? ' · ' + worker.name : ''),
                'record-working-badge',
              );
            cell.prepend(mark);
          }
          if (recordNeedsAnswer(result)) {
            const question = result.recordAction.question,
              mark = el(
                'span',
                question.verification
                  ? 'CAPTCHA to solve'
                  : question.code
                    ? 'Code to enter'
                    : 'Awaiting answer',
                'record-question-badge',
              ),
              // Questions are answered on the Answers page; the row only links there.
              reply = button(
                'Open in Answers',
                () => onQuestion(question.id),
                'record-question-link',
              );
            mark.title = question.text;
            reply.dataset.recordQuestion = question.id;
            reply.setAttribute('aria-label', result.title + ' · Open in Answers');
            if (question.verification || question.code) mark.dataset.verification = 'true';
            cell.append(mark, reply);
          }
          if (problem) {
            const box = el('div', null, 'record-problem'),
              reason = el('span', problem.reason, 'record-problem-reason');
            box.dataset.category = problem.category ?? '';
            box.append(el('span', problem.label, 'record-problem-badge'), reason);
            if (problem.next) box.append(el('span', problem.next, 'record-problem-next'));
            box.append(problemActions);
            cell.append(box);
          }
        } else if (column.key === 'score' && result.assessment) {
          const assessment = result.assessment,
            score = button(
              assessment.score === null ? 'Could not be assessed' : `${assessment.score}/100`,
              () => toggleDetail(result.id),
              'record-score-chip',
            );
          score.title = assessment.summary;
          score.setAttribute('aria-expanded', String(detailId === result.id));
          score.setAttribute('aria-controls', drawer.id);
          score.dataset.tone =
            assessment.score === null ? 'none' : assessmentEligibility(assessment);
          score.setAttribute('aria-label', result.title + ' · Scoring rationale');
          score.dataset.recordScore = result.id;
          const decided = decidingRule(assessment);
          const eligibility = decided
            ? el(
                'small',
                `${decided.kind === 'eliminated' ? 'Eliminated' : 'Hold'}: ${shortRule(decided.rule.text)}`,
                'record-score-eligibility record-score-rule',
              )
            : el(
                'small',
                eligibilityLabels[assessmentEligibility(assessment)],
                'record-score-eligibility',
              );
          if (decided) {
            eligibility.title = decided.rule.text;
            eligibility.dataset.kind = decided.kind;
          }
          cell.append(score, eligibility);
          if (oldScoringMethod(assessment))
            cell.append(el('small', 'Old method · rescore', 'record-score-stale'));
        } else {
          row.append(
            recordCell(column, result.cells?.[column.key], {openLink: (url) => api.openLink(url)}),
          );
          continue;
        }
        row.append(cell);
      }
      state.dataset.column = 'status';
      updated.dataset.column = 'updatedAt';
      state.append(
        el(
          'span',
          requesting
            ? batchSubmitting === 'delete'
              ? 'Deleting'
              : 'Queueing'
            : (progress?.label ?? recordState(result, data.definition).label),
          'automation-badge ' + (requesting ? 'queued' : (progress?.tone ?? result.status)),
        ),
      );
      if (result.closed?.evidence && row.dataset.outcome === 'closed')
        state.lastChild.title = 'Source says: ' + result.closed.evidence;
      if (progress?.detail && !problem) {
        const detail = el('span', progress.detail, 'record-operation-detail');
        detail.title = progress.detail;
        state.append(detail);
      }
      if (result.workflowState && result.workflowState !== result.status)
        state.append(badge(result.status));
      if (result.trial)
        state.append(
          el(
            'span',
            result.sampleKind === 'interview' ? 'Research sample' : 'Trial sample',
            'automation-trial-label',
          ),
        );
      // A record sent back after an unsent attempt looks new without this label.
      if (result.notSubmitted && ['found', 'prepared'].includes(result.status)) {
        const label = el('span', 'Not submitted · earlier attempt', 'automation-trial-label');
        label.title =
          result.notSubmitted.kind === 'user'
            ? 'You reported that the earlier attempt was not submitted. It can be sent again.'
            : 'Verification found that the earlier attempt was not submitted. It can be sent again.';
        state.append(label);
      }
      const activityAt = recordActivityAt(result),
        date = el('time', relativeTime(activityAt));
      date.dateTime = new Date(activityAt).toISOString();
      date.dataset.at = String(activityAt);
      date.title = time(activityAt);
      updated.append(date);
      const detail = button(detailId === result.id ? 'Close details' : 'Details', () => {
        if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        toggleDetail(result.id);
      });
      detail.dataset.resultDetail = result.id;
      detail.dataset.recordMenuAction = 'detail';
      detail.setAttribute('aria-expanded', String(detailId === result.id));
      detail.setAttribute('aria-controls', drawer.id);
      const open = button('Open ↗', () => {
        if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        api.openLink(result.url);
      });
      open.dataset.recordMenuAction = 'open';
      open.setAttribute('aria-label', result.title + ' · Open source');
      // Opens the Contacts page; a record without contacts starts the search at once.
      const findContacts = button('Find contacts', () => {
        if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        onContacts(result);
      });
      findContacts.dataset.recordMenuAction = 'contacts';
      // Asks the setup agent why this listing scored as it did; criteria change only on request.
      const evaluateCriteria = button('Evaluate criteria', () => {
        if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        onEvaluateCriteria(criteriaReviewMessage(result));
      });
      evaluateCriteria.dataset.recordMenuAction = 'criteria';
      const tabWorkspace = data.automation.id,
        tabFeedback =
          keepMenu && !problem
            ? actionsPanel.querySelector('.record-tab-feedback')
            : el('span', null, 'record-tab-feedback'),
        tabChoices =
          keepMenu && !problem
            ? actionsPanel.querySelector('.record-tab-choices')
            : el('div', null, 'record-tab-choices');
      tabFeedback.setAttribute('role', 'status');
      if (problem) problemActions.after(tabChoices, tabFeedback);
      const focusTab = async (tab) => {
        try {
          await api.focusWorkspaceTab(tabWorkspace, tab.tabId);
          tabChoices.replaceChildren();
          tabFeedback.textContent = '';
          if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        } catch (error) {
          tabFeedback.textContent = error.message;
          void refreshTabs();
        }
      };
      const showTab = async () => {
        tabFeedback.textContent = '';
        tabChoices.replaceChildren();
        try {
          const version = ++tabVersion,
            openTabs = await api.workspaceTabs(tabWorkspace);
          if (tabOwner !== tabWorkspace) return;
          if (version === tabVersion) {
            const identity = tabIdentity(openTabs),
              changed = identity !== liveTabIdentity;
            liveTabs = openTabs;
            liveTabIdentity = identity;
            if (changed) render();
            else syncTabButtons();
          }
          const current = data.results.find((item) => item.id === result.id),
            tabs = current ? recordTabs(current, openTabs, data) : [];
          if (!tabs.length) {
            tabFeedback.textContent = 'No open tab was found for this record.';
            return;
          }
          if (tabs.length === 1) {
            await focusTab(tabs[0]);
            return;
          }
          tabFeedback.textContent = 'Choose the open tab:';
          for (const tab of tabs) tabChoices.append(button(tab.url, () => focusTab(tab)));
        } catch (error) {
          tabFeedback.textContent = error.message;
          void refreshTabs();
        }
      };
      const goToTab = button('Go to tab', showTab);
      goToTab.dataset.recordTab = result.id;
      goToTab.dataset.recordMenuAction = 'tab';
      actions.append(open, detail);
      // A row shows "Find contacts" above its next step; a problem card keeps it in the menu.
      const contactsRow =
        api.recordContactsFind && !result.trial && !problem
          ? el('div', null, 'record-contacts-action')
          : null;
      if (contactsRow) contactsRow.append(...contactsFound(data, result.id, findContacts));
      else if (api.recordContactsFind && !result.trial) actions.append(findContacts);
      if (onEvaluateCriteria && result.assessment) actions.append(evaluateCriteria);
      // A problem card shows its open tab next to the reason.
      if (problem) goToTab.textContent = 'Show page ↗';
      // A row with an open tab also shows the button outside the menu. Several
      // tabs open the menu, where the tab chooser lives.
      const quickTab = problem
        ? null
        : button(
            'Go to tab ↗',
            async () => {
              await showTab();
              if (tabChoices.childElementCount && !actionsPanel.matches(':popover-open')) {
                actionsPanel.showPopover();
                positionMenu(actionsPanel, actionsToggle);
              }
            },
            'quiet record-quick-tab',
          );
      quickTab?.setAttribute('aria-label', result.title + ' · Go to tab');
      const placeTab = () => {
        if (problem) return problemActions.prepend(goToTab);
        actions.insertBefore(goToTab, open);
        state.insertBefore(quickTab, actionsToggle.parentNode === state ? actionsToggle : null);
      };
      const tab = {
        result,
        control: goToTab,
        place: placeTab,
        remove: () => {
          goToTab.remove();
          quickTab?.remove();
        },
      };
      visibleTabButtons.set(result.id, tab);
      if (openIds.has(result.id)) placeTab();
      recordActions(actions, result, data.definition, async (action) => {
        try {
          await api.workspaceTransition(data.automation.id, result.id, action);
          await refresh();
        } catch (error) {
          showNotice(error.message);
        }
      });
      const recordAction = result.recordAction,
        // The record's next step stays visible in the row; the rest is in the menu.
        next = el('div', null, 'record-next-action'),
        nextStep = !problem && !recordAction?.task && !recordNeedsAnswer(result);
      if (recordAction?.scoreOperation) {
        const op = recordAction.scoreOperation,
          score = button(
            requesting
              ? 'Queueing…'
              : recordAction.task?.kind === 'score'
                ? progress.label
                : op.label,
            async () => {
              try {
                await sendOperation(result, 'score');
              } catch (error) {
                showNotice(error.message);
              }
            },
          );
        score.dataset.recordOperation = 'score';
        score.disabled = busy || requesting || op.disabled;
        score.title =
          op.reason ?? 'Assess the listing against the saved scoring criteria, profile and CV.';
        (nextStep && !result.assessment && !recordAction.operation ? next : actions).append(score);
      }
      if (recordAction?.retryOperation) {
        const op = recordAction.retryOperation,
          retry = button(
            requesting ? 'Queueing…' : 'Retry',
            async () => {
              try {
                await sendOperation(
                  result,
                  op.kind,
                  op.direct ? {direct: true, ...(op.applyAnyway ? {applyAnyway: true} : {})} : {},
                );
              } catch (error) {
                showNotice(error.message);
              }
            },
            'record-retry',
          );
        retry.dataset.recordRetry = result.id;
        retry.disabled = busy || requesting || op.disabled;
        retry.title =
          op.reason ??
          (op.kind === 'verify'
            ? 'Verify the outcome of the action before resending it.'
            : 'Retry the last unfinished action.');
        // The user may apply although the listing or form excludes them; the
        // agent still answers every question truthfully. A plain retry would
        // stop on the same requirement, so this card offers only this button.
        const notEligible = problem?.category === 'not_eligible' && op.kind === 'execute';
        if (!notEligible) (problem ? problemActions : state).append(retry);
        if (notEligible) {
          const anyway = button(
            requesting ? 'Queueing…' : 'Apply anyway',
            async () => {
              if (
                !window.confirm(
                  'Apply although you do not meet this requirement? The agent answers every question truthfully, so the employer may reject the application.',
                )
              )
                return;
              try {
                await sendOperation(result, 'execute', {direct: true, applyAnyway: true});
              } catch (error) {
                showNotice(error.message);
              }
            },
            'record-apply-anyway',
          );
          anyway.dataset.recordApplyAnyway = result.id;
          anyway.disabled = retry.disabled;
          anyway.title =
            op.reason ??
            'Submit the application anyway, answering the eligibility questions truthfully.';
          problemActions.append(anyway);
        }
      }
      if (recordAction?.directOperation && !recordAction.task) {
        const op = recordAction.directOperation,
          apply = button(
            requesting ? 'Queueing…' : op.label,
            async () => {
              try {
                await sendOperation(result, 'execute', {direct: true});
              } catch (error) {
                showNotice(error.message);
              }
            },
            'primary',
          );
        apply.dataset.recordDirect = 'execute';
        apply.disabled = busy || requesting || op.disabled;
        apply.title =
          op.reason ??
          'The agent checks the required information and completes the action for this record. If anything is missing, it asks you.';
        actions.append(apply);
      }
      if (recordAction?.operation) {
        const op = recordAction.operation,
          action = button(
            requesting ? 'Queueing…' : recordAction.task ? progress.label : op.label,
            async () => {
              // "Apply" applies directly: there is no draft review step.
              if (op.kind === 'execute' && actionsPanel.matches(':popover-open'))
                actionsPanel.hidePopover();
              try {
                await sendOperation(result, op.kind, op.kind === 'execute' ? {direct: true} : {});
              } catch (error) {
                showNotice(error.message);
              }
            },
            recordAction.directOperation && !recordAction.task ? '' : 'primary',
          );
        action.dataset.recordOperation = op.kind;
        action.disabled = busy || requesting || op.disabled;
        action.title =
          op.reason ??
          (op.kind === 'execute'
            ? 'The agent fills the form with the saved information and submits the application. If anything is missing, it asks all at once.'
            : '');
        // Verifying is the way out of an unclear outcome, so it stays next to the reason.
        const target =
          problem && op.kind === 'verify' && !recordAction.retryOperation
            ? problemActions
            : nextStep
              ? next
              : actions;
        // A running task already shows its label in the status badge.
        if (!(recordAction.task && target === actions)) target.append(action);
      }
      if (['found', 'prepared', 'uncertain'].includes(result.status)) {
        const submitted = button('Applied', async () => {
          if (
            !window.confirm(
              'Did you verify that this application was submitted (e.g. a confirmation email)? The record counts as completed and will not be submitted again.',
            )
          )
            return;
          try {
            await api.automationMarkSubmitted(data.automation.id, result.id);
          } catch (error) {
            showNotice(error.message);
          }
          await refresh();
        });
        submitted.dataset.recordSubmitted = result.id;
        submitted.disabled = busy || requesting;
        submitted.title =
          'If you verified that the application was submitted, mark the record as completed';
        (problem ? problemActions : actions).append(submitted);
      }
      if (['found', 'prepared', 'uncertain'].includes(result.status)) {
        const dismiss = button('Skip', async () => {
          await api.automationDismiss(data.automation.id, result.id);
          await refresh();
        });
        dismiss.dataset.recordDismiss = result.id;
        dismiss.disabled = busy || requesting;
        dismiss.title = 'Skip this record and close its pending questions';
        // Every problem card offers Skip next to its reason.
        (problem ? problemActions : actions).append(dismiss);
      }
      if (result.status === 'dismissed' && api.automationRestore && !result.trial) {
        const restore = async () => {
          await api.automationRestore(data.automation.id, result.id);
          await refresh();
        };
        // A record skipped while uncertain may already be submitted; it
        // returns to verification, not straight to a new submission.
        if (data.definition.recordOperations?.execute && !result.skippedFrom) {
          const apply = button(
            'Apply',
            async () => {
              if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
              try {
                await restore();
                await sendOperation(result, 'execute', {direct: true});
              } catch (error) {
                showNotice(error.message);
              }
            },
            'primary',
          );
          apply.dataset.recordRestoreApply = result.id;
          apply.disabled = busy || requesting;
          apply.title = 'Take back the skip and apply to this record';
          actions.append(apply);
        }
        const unskip = button('Restore', async () => {
          try {
            await restore();
          } catch (error) {
            showNotice(error.message);
          }
        });
        unskip.dataset.recordRestore = result.id;
        unskip.disabled = busy || requesting;
        unskip.title = result.skippedFrom
          ? 'Take back the skip; the record returns to its unverified state'
          : 'Take back the skip; the record returns to the found list';
        actions.append(unskip);
      }
      for (const control of actions.querySelectorAll('[data-idle]'))
        control.disabled = busy || requesting || Boolean(recordAction?.task);
      groupMenu(actions);
      if (problem) {
        const why = button(detailId === result.id ? 'Hide details' : 'Details', () =>
          toggleDetail(result.id),
        );
        why.dataset.recordProblemDetail = result.id;
        why.setAttribute('aria-expanded', String(detailId === result.id));
        why.setAttribute('aria-controls', drawer.id);
        problemActions.append(why);
      }
      if (contactsRow) state.append(contactsRow);
      if (next.childElementCount) state.append(next);
      // The record's latest cover letter: an approved one opens its PDF, one
      // being written or waiting for review opens the Files page.
      const letter = (data.automation.questions ?? []).findLast(
        (q) => q.coverLetter && q.recordId === result.id,
      );
      if (letter) {
        const approved = letter.answer != null && letter.coverLetter.path,
          cover = button(
            'Cover letter ↗',
            () =>
              approved
                ? api.openDocument(data.automation.id, letter.coverLetter.path)
                : onCoverLetter(),
            'quiet record-quick-tab',
          );
        cover.dataset.recordCoverLetter = result.id;
        cover.title = approved
          ? 'Open the cover letter sent with this application'
          : 'Review the cover letter on the Files page';
        state.append(cover);
      }
      if (!keepMenu) state.append(actionsToggle);
      row.append(updated, state);
      place(row);
      if (keepMenu) {
        // Keep the connected native popover in the top layer while rebuilding the table.
        state.moveBefore(actionsToggle, null);
        state.moveBefore(actionsPanel, null);
        actionsPanel.querySelector('.table-actions').replaceWith(actions);
        if (focusedAction) {
          const control = [...actions.children].find(
            (control) => menuControlKey(control) === focusedAction && !control.disabled,
          );
          (control ?? actionsToggle).focus({preventScroll: true});
        } else if (focusedToggle) actionsToggle.focus({preventScroll: true});
        actionsPanel.scrollTop = menuScroll;
      } else {
        actionsPanel.append(actions);
        if (!problem) actionsPanel.append(tabChoices, tabFeedback);
        state.append(actionsPanel);
      }
      rows.set(result.id, {key: rowKeys.get(result.id), row, tab});
    }
    for (const node of [...body.children]) if (!placed.has(node)) node.remove();
    previousTable?.element.remove();
    if (openMenu?.isConnected) {
      element.querySelector('.jobs-table-wrap').scrollLeft = scrollLeft;
      positionOpenMenu();
    }
    if (!visible.some((result) => result.id === cursorId)) cursorId = null;
    for (const result of visible) {
      const row = rows.get(result.id)?.row;
      if (!row) continue;
      row.tabIndex = -1;
      row.dataset.cursor = String(result.id === cursorId);
      row.dataset.detailOpen = String(result.id === detailId);
    }
    renderDrawer();
  }
  function renderDrawer() {
    const result = detailId && data.results.find((item) => item.id === detailId);
    if (!result) {
      detailId = null;
      changed(drawer, '');
      if (drawer.matches(':popover-open')) drawer.hidePopover();
      return;
    }
    const description = descriptions.get(result.id);
    if (
      changed(
        drawer,
        JSON.stringify([
          result,
          data.automation.revision,
          drawerTab,
          drawerTab === 'listing' && description?.status,
        ]),
      )
    ) {
      // Build the body first: the title and meta change only with it.
      const body = drawerTab === 'listing' ? listingContent(result) : detailContent(result);
      body.id = 'automation-result-detail-' + result.id;
      drawerTitle.textContent = result.title;
      const columns = data.automation.table?.columns ?? [];
      const status = el(
        'span',
        recordOperationStatus(result)?.label ?? recordState(result, data.definition).label,
        'record-drawer-status',
      );
      drawerMeta.replaceChildren(
        ...[
          ['Source', source(result)],
          ...columns
            .filter((c) => !['source', 'title', 'score'].includes(c.key))
            .map((c) => [c.label, result.cells?.[c.key]]),
        ]
          .filter(([, value]) => String(value ?? '').trim())
          .map(([label, value]) => {
            const chip = el('span', String(value));
            chip.title = label;
            return chip;
          }),
        status,
      );
      const tabs = el('div', null, 'record-drawer-tabs');
      tabs.setAttribute('role', 'tablist');
      for (const [key, label] of [
        ['fit', 'Fit'],
        ['listing', 'Listing'],
      ]) {
        const tab = button(label, () => {
          drawerTab = key;
          renderDrawer();
        });
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(drawerTab === key));
        tab.setAttribute('aria-controls', body.id);
        tabs.append(tab);
      }
      drawerTools.replaceChildren(
        tabs,
        button('Open ↗', () => api.openLink(result.url)),
      );
      drawerBody.replaceChildren(body);
      drawerBody.scrollTop = 0;
    }
    if (!drawer.matches(':popover-open')) drawer.showPopover();
  }
  // Keyboard review: j/k move through the page, the other keys act on the
  // highlighted record. Typing in a field or an open menu or dialog is left alone.
  const onKey = (event) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !data ||
      !root.isConnected ||
      !root.getClientRects().length ||
      editable(event.target) ||
      document.querySelector('dialog[open], .record-row-actions:popover-open')
    )
      return;
    const rowsOnPage = [...content.querySelectorAll('tr[data-result-id]')],
      index = rowsOnPage.findIndex((row) => row.dataset.resultId === cursorId),
      row = rowsOnPage[index],
      key = event.key;
    const move = (to) => {
      const target = rowsOnPage[Math.max(0, Math.min(rowsOnPage.length - 1, to))];
      if (!target) return;
      cursorId = target.dataset.resultId;
      if (detailId) detailId = cursorId;
      render();
      target.focus({preventScroll: true});
      target.scrollIntoView({block: 'nearest'});
    };
    if (key === 'Escape' && detailId) closeDrawer();
    else if (key === 'j') move(index + 1);
    else if (key === 'k') move(index < 0 ? 0 : index - 1);
    else if (!row) return;
    else if (key === 'Enter' && !(event.target instanceof HTMLButtonElement))
      toggleDetail(cursorId);
    else if (key === 'o') api.openLink(data.results.find((r) => r.id === cursorId)?.url);
    else if (key === 'a')
      row
        .querySelector(
          '[data-record-question], .record-next-action button:not(:disabled), .record-problem-actions button:not(:disabled)',
        )
        ?.click();
    else if (key === 's') row.querySelector('[data-record-dismiss]:not(:disabled)')?.click();
    else if (key === 'x') row.querySelector('[data-record-select]:not(:disabled)')?.click();
    else return;
    event.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  // Relative activity times age without rebuilding rows.
  const clockTimer = setInterval(() => {
    for (const node of content.querySelectorAll('time[data-at]'))
      node.textContent = relativeTime(Number(node.dataset.at));
  }, 30000);
  return {
    dispose: () => {
      content.querySelector('.record-row-actions:popover-open')?.hidePopover();
      clearInterval(tabTimer);
      clearInterval(clockTimer);
      clearTimeout(noticeTimer);
      document.removeEventListener('keydown', onKey);
      if (drawer.matches(':popover-open')) drawer.hidePopover();
      tabOwner = null;
      tabVersion++;
      disposeTable();
      mounted = null;
      rows.clear();
    },
    // Opens a record from another page: the "Needs you" list, its page and its details.
    showRecord(id) {
      if (!data?.results.some((r) => r.id === id)) return;
      search.value = scoreMinimum.value = '';
      filterValue = filterChips.has('attention') ? 'attention' : 'all';
      detailId = cursorId = id;
      page = 1;
      render();
      const index = shownOrder.indexOf(id);
      if (index >= pageSize) {
        page = Math.floor(index / pageSize) + 1;
        render();
      }
      content
        .querySelector(`[data-result-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({block: 'center', behavior: 'smooth'});
    },
    update(snapshot, isBusy) {
      if (data?.automation.id !== snapshot.automation.id) {
        content.querySelector('.record-row-actions:popover-open')?.hidePopover();
        review.close();
        reviewed = null;
        scrollLeft = 0;
        page = 1;
        ({key: sort, direction} = storedSort(snapshot.automation.id) ?? {key: null, direction: -1});
        shownOrder = [];
        scoreMinimum.value = '';
        scoreComparison.value = 'gt';
        selectedIds.clear();
        selectionError.textContent = '';
        filterValue = 'all';
        detailId = cursorId = null;
        notice.hidden = true;
      }
      if (tabOwner !== snapshot.automation.id) {
        liveTabs = [];
        liveTabIdentity = '[]';
        tabVersion++;
      }
      tabOwner = snapshot.automation.id;
      data = snapshot;
      busy = isBusy;
      selectionOwner = snapshot.automation.id;
      const currentIds = new Set(data.results.filter(selectableRecord).map((result) => result.id));
      for (const id of selectedIds)
        if (!currentIds.has(id) && !requests.has(selectionOwner + ':' + id)) selectedIds.delete(id);
      const options = [
        ['All', 'all'],
        ['Needs you', 'attention'],
        ['In progress', 'active'],
        ...(data.definition?.records.states ?? []).map((s) => [s.label, s.id]),
        ['Eliminated', 'eliminated'],
        ['Waiting for my decision', 'held'],
        ['★ Starred', 'starred'],
        ['Trial samples', 'trial'],
      ];
      // Chips are rebuilt only when the workflow states change; counts update in place.
      if (changed(filter, JSON.stringify(options))) {
        filterChips.clear();
        for (const [label, value] of options) {
          const chip = button('', () => setFilter(value), 'record-filter-chip');
          chip.dataset.filter = value;
          chip.append(el('span', label), el('span', '0', 'record-filter-count'));
          filterChips.set(value, chip);
        }
        filter.replaceChildren(...filterChips.values());
      }
      render();
      void refreshTabs();
    },
  };
}
