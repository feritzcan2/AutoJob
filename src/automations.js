import {activeRecordOperations} from './record-operation-status.js';
import {answersPage} from './answers-page.js';
import {coverLetterReview} from './cover-letter-review.js';
import {contactsPage, contactsToReview, contactsWorking} from './contacts-page.js';
import {automationReady} from '../app/sources/trial.mjs';
import {templateFields} from './template-fields.js';
import {
  PROFILE_SECTIONS,
  PROFILE_SECTION_IDS,
  fieldSection,
} from '../app/templates/profile-sections.mjs';
import {renderJevProfile} from './jev-profile.js';
import {profileChanged} from '../app/automation/profile-updates.mjs';
import {DEFAULT_SCORE_THRESHOLD} from '../app/scoring/thresholds.mjs';
import {autoContactsMode} from '../app/records/operation-definitions.mjs';
import {automationProgress, runKindLabel} from '../app/automation/progress.mjs';
import {prepareAutomationChat} from './automation-chat.js';
import {workspaceChat} from './workspace-chat.js';
import {setupAgentSettingsPanel} from './setup-agent-settings.js';
import {interviewRun, interviewBusy, hasBlockingRun} from '../app/workspaces/conversation.mjs';
import {automationResultsTable} from './automation-results.js';
import {minimumSaveScoreSettings} from './minimum-save-score.js';
import {automationSourcesPanel} from './automation-sources.js';
import {automationAttentionPanel} from './automation-attention.js';
import {renderCurrentWork} from './current-work.js';
import {devToolsAvailable, openAgentTrace} from './agent-trace.js';
import './automation-attention.css';
import './automations.css';
import './run-history.css';

const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
// TypeSafe jev-latest list price (docs.typesafe.ai/models, 2026-10-09).
const JEV_USD_PER_MILLION_TOKENS = 0.042;
const statusNames = {
  draft: 'Setup',
  ready: 'Ready for trial',
  enabled: 'Running regularly',
  paused: 'Paused',
  blocked: 'Needs help',
  complete: 'Completed',
  running: 'Running',
  completed: 'Completed',
  partial: 'Partial · will continue',
  failed: 'Could not finish',
  interrupted: 'Stopped',
  timeout: 'Timed out',
  found: 'Found',
  prepared: 'Ready to apply',
  executing: 'In progress',
  uncertain: 'Outcome needs verification',
  dismissed: 'Skipped',
};
const time = (value) => (value ? new Date(value).toLocaleString('en-GB') : '—');
const modeNames = {
  observe: 'Only find',
  prepare: 'Find, apply when I say (older setting)',
  auto: 'Find and apply',
};

export function automationsPage(
  api,
  {
    notice,
    getCatalog,
    navigate,
    deleteWorkspace,
    isDeleting = () => false,
    onSnapshot = () => {},
    focusAgent = () => {},
    syncWorkspaceMenu = () => {},
    refreshWorkspaces = async () => {},
    openOnboarding = () => false,
  },
) {
  let sourcePanel, chatPanel, saveScoreSettings, coverLetters;
  const host = el('section', null, 'automations-page');
  host.id = 'automations';
  host.hidden = true;
  document.querySelector('main').append(host);
  const setupPage = el('section');
  setupPage.id = 'setup-agent';
  setupPage.hidden = true;
  setupPage.dataset.webOnly = '';
  document.querySelector('#agent').before(setupPage);
  const setupAttention = el('section', null, 'automation-attention');
  setupAttention.id = 'setup-agent-attention';
  setupAttention.hidden = true;
  setupPage.append(setupAttention);
  const setupSettings = setupAgentSettingsPanel({api, getCatalog, refresh});
  setupPage.append(setupSettings.element);
  const setupTabs = el('div', null, 'agent-view-tabs setup-agent-tabs');
  setupTabs.setAttribute('role', 'tablist');
  setupTabs.setAttribute('aria-label', 'Setup agent view');
  setupPage.append(setupTabs);
  const agentConversation = el('div', null, 'workspace-conversation');
  setupPage.append(agentConversation);
  const chatTerminal = el('section', null, 'terminal-section');
  chatTerminal.id = 'setup-agent-terminal';
  chatTerminal.hidden = true;
  chatTerminal.append(
    el(
      'p',
      'The chat has not started yet. The terminal appears here once you send a message from the Chat tab.',
      'setup-terminal-empty',
    ),
  );
  setupPage.append(chatTerminal);
  agentConversation.id = 'setup-agent-chat';
  const setupViews = new Map();
  for (const [view, label, panel] of [
    ['chat', 'Chat', agentConversation],
    ['terminal', 'Terminal', chatTerminal],
  ]) {
    const tab = el('button', label);
    tab.type = 'button';
    tab.id = 'setup-agent-tab-' + view;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.onclick = () => showSetupView(view);
    setupTabs.append(tab);
    setupViews.set(view, {tab, panel});
  }
  setupTabs.onkeydown = (event) => {
    const keys = [...setupViews.keys()],
      index = keys.findIndex((view) => setupViews.get(view).tab === document.activeElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? keys.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + keys.length) % keys.length;
    showSetupView(keys[next]);
    setupViews.get(keys[next]).tab.focus();
  };
  function showSetupView(view) {
    if (!setupViews.has(view)) view = 'chat';
    setupPage.dataset.view = view;
    for (const [name, {tab, panel}] of setupViews) {
      const active = name === view;
      panel.hidden = !active;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    if (selected) localStorage.setItem('setup-agent-view:' + selected, view);
  }
  const setupNav = el('button');
  setupNav.type = 'button';
  setupNav.dataset.view = 'setup-agent';
  setupNav.innerHTML =
    '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 1-8 8H4l-2 3V11a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/></svg><span>Setup agent</span><span id="setup-agent-status" class="agent-nav-status" aria-hidden="true" hidden></span>';
  document.querySelector('aside nav button[data-view=agent]').after(setupNav);
  const progressBox = el('div', null, 'workspace-progress');
  progressBox.dataset.webOnly = '';
  progressBox.innerHTML =
    '<ol id="automation-steps" aria-label="Setup progress"></ol><p id="automation-next-step"></p><div id="automation-next-actions" class="actions"></div><section id="automation-agent-reply" aria-label="Agent’s last reply"><b>Agent’s reply</b><p></p></section>';
  document.querySelector('#now-history').before(progressBox);
  const steps = progressBox.querySelector('#automation-steps');
  steps.dataset.webOnly = '';
  document.querySelector('#now-panel').prepend(steps);
  const find = (selector) =>
    host.querySelector(selector) ?? agentConversation.querySelector(selector);
  let progressSignature = '';
  let runTab = 'all',
    runPhase = 'all',
    runTabOwner = null;
  let templates = [],
    selected = null,
    data = null,
    pane = null,
    generation = 0,
    busy = false,
    dirty = false,
    // The open document rename form ({path, value}); it survives re-renders.
    renaming = null,
    formRevision = '',
    formBaseline = null,
    resultsTable = null;
  const answersSection = el('section');
  answersSection.dataset.automationPane = 'answers';
  const answers = answersPage(answersSection, api, {refresh, openFiles: () => setPane('files')});
  function showAnswers(id) {
    navigate('answers');
    answers.focus(id);
  }
  const attentionSection = el('section', null, 'attention-page'),
    attentionEmpty = el(
      'p',
      'Nothing needs your attention. Blocked sources and other situations the agent waits on appear here.',
      'attention-empty',
    );
  attentionSection.dataset.automationPane = 'attention';
  attentionSection.innerHTML =
    '<div class="section-title"><h2>Attention needed</h2><span>Situations the agent cannot resolve on its own</span></div>';
  attentionSection.append(attentionEmpty);
  const attention = automationAttentionPanel(api, {
    container: attentionSection,
    navigate,
    refresh,
    getConversation: () => chatPanel,
    showRecordQuestions: () => showAnswers(),
    showRecord: (id) => {
      navigate('board');
      resultsTable?.showRecord(id);
    },
  });
  const contactsSection = el('section');
  contactsSection.dataset.automationPane = 'contacts';
  const contactsView = contactsPage(contactsSection, api, {refresh});
  // A listing's "Find contacts": a first search starts at once, then the page opens on it.
  async function showContacts(result) {
    const known = (data?.automation.recordContacts ?? []).some((e) => e.recordId === result.id);
    navigate('contacts');
    contactsView.focus(result.id);
    if (known) return;
    try {
      await api.recordContactsFind(selected, result.id, '');
      await refresh();
    } catch (error) {
      notice(error.message);
    }
  }
  // A listing's "Evaluate criteria": the setup agent explains the score in its chat.
  async function evaluateCriteria(text) {
    openConversation();
    try {
      await sendMessage(text);
    } catch (error) {
      notice(error.message);
    }
  }
  const boardNav = document.querySelector('[data-view=board]'),
    recordWork = el('span', null, 'board-nav-work');
  recordWork.id = 'board-nav-work';
  recordWork.hidden = true;
  recordWork.setAttribute('aria-hidden', 'true');
  boardNav.append(recordWork);
  const answersNav = el('button'),
    questionBadge = el('span', null, 'agent-nav-status board-nav-status');
  answersNav.type = 'button';
  answersNav.dataset.view = 'answers';
  answersNav.innerHTML =
    '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/></svg><span>Answers</span>';
  questionBadge.id = 'question-badge';
  questionBadge.dataset.tone = 'waiting';
  questionBadge.setAttribute('aria-hidden', 'true');
  questionBadge.hidden = true;
  answersNav.append(questionBadge);
  boardNav.after(answersNav);
  const attentionNav = el('button'),
    attentionBadge = el('span', null, 'agent-nav-status');
  attentionNav.type = 'button';
  attentionNav.dataset.view = 'attention';
  attentionNav.innerHTML =
    '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg><span>Attention needed</span>';
  attentionBadge.id = 'attention-nav-status';
  attentionBadge.dataset.tone = 'waiting';
  attentionBadge.setAttribute('aria-hidden', 'true');
  attentionBadge.hidden = true;
  attentionNav.append(attentionBadge);
  attentionNav.onclick = () => navigate('attention');
  answersNav.after(attentionNav);
  // Contacts sits above Files; its badge counts suggestions waiting for approval.
  const contactsNav = el('button'),
    contactsBadge = el('span', null, 'agent-nav-status');
  contactsNav.type = 'button';
  contactsNav.dataset.view = 'contacts';
  contactsNav.innerHTML =
    '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/></svg><span>Contacts</span>';
  contactsBadge.dataset.tone = 'waiting';
  contactsBadge.setAttribute('aria-hidden', 'true');
  contactsBadge.hidden = true;
  // A running search or send shows like Sources' "1 scanning".
  const contactsWork = el('span', null, 'agent-nav-status');
  contactsWork.dataset.tone = 'active';
  contactsWork.setAttribute('aria-hidden', 'true');
  contactsWork.hidden = true;
  contactsNav.append(contactsWork, contactsBadge);
  contactsNav.onclick = () => navigate('contacts');
  document.querySelector('[data-view=files]').before(contactsNav);
  // Files shows a badge while a cover letter waits for the user's review.
  const filesNav = document.querySelector('[data-view=files]'),
    filesHome = document.querySelector('[data-view=background]'),
    letterBadge = el('span', null, 'agent-nav-status');
  letterBadge.dataset.tone = 'waiting';
  letterBadge.setAttribute('aria-hidden', 'true');
  letterBadge.hidden = true;
  filesNav.append(letterBadge);
  // Pages with something waiting on the user rise to the top of the sidebar and
  // glow; once handled they return to their place (Answers and Attention needed
  // below the Tracking table, Files below Background work).
  function pinPending(questions, issues, letters = 0) {
    const nav = boardNav.parentElement,
      items = [
        [answersNav, questions > 0, null],
        [filesNav, letters > 0, filesHome],
        [attentionNav, issues > 0, null],
      ],
      pinned = items.filter(([, on]) => on).map(([node]) => node);
    for (const [node, on] of items) node.toggleAttribute('data-pending', on);
    // Answers and Attention needed leave the menu while their lists are empty.
    answersNav.hidden = !questions;
    attentionNav.hidden = !issues;
    letterBadge.hidden = !letters;
    letterBadge.textContent = letters ? String(letters) : '';
    filesNav.title = letters ? `${letters} cover letter${letters > 1 ? 's' : ''} to review` : '';
    filesNav.setAttribute('aria-label', ['Files', filesNav.title].filter(Boolean).join(' · '));
    // Move nodes only when out of place, so focus and hover are not disturbed.
    if (pinned.some((node, n) => nav.children[n] !== node)) nav.prepend(...pinned);
    let anchor = boardNav;
    for (const [node, on, home] of items) {
      if (on) continue;
      if (home) {
        if (home.nextElementSibling !== node) home.after(node);
        continue;
      }
      if (anchor.nextElementSibling !== node) anchor.after(node);
      anchor = node;
    }
  }
  const hasUnsaved = () => dirty;
  const profileSaveDialog = el('dialog');
  profileSaveDialog.id = 'automation-profile-save-dialog';
  profileSaveDialog.setAttribute('aria-labelledby', 'automation-profile-save-title');
  profileSaveDialog.setAttribute('aria-describedby', 'automation-profile-save-warning');
  profileSaveDialog.innerHTML =
    '<form method="dialog"><h2 id="automation-profile-save-title">Restart the running agents?</h2><p id="automation-profile-save-warning"></p><div class="workspace-dialog-actions"><button class="quiet" value="cancel">Cancel</button><button class="quiet" value="later" autofocus>Save, don’t restart</button><button class="primary" value="restart">Save and restart</button></div></form>';
  document.body.append(profileSaveDialog);
  const queueExistingDialog = el('dialog');
  queueExistingDialog.id = 'automation-queue-existing-dialog';
  queueExistingDialog.setAttribute('aria-labelledby', 'automation-queue-existing-title');
  queueExistingDialog.innerHTML =
    '<form method="dialog"><h2 id="automation-queue-existing-title">Apply to listings you already have?</h2><p></p><div class="workspace-dialog-actions"><button class="quiet" value="cancel">Cancel</button><button class="quiet" value="new">Only new listings</button><button class="primary" value="queue" autofocus>Queue them too</button></div></form>';
  document.body.append(queueExistingDialog);
  // Resolves true (queue existing), false (only new) or null (cancel the save).
  function askQueueExisting(count, threshold) {
    return new Promise((resolve) => {
      queueExistingDialog.querySelector('p').textContent =
        `${count} saved listing(s) have not been applied to yet. Queue those scoring ${threshold} or more whose required conditions are met, or apply only to listings found from now on?`;
      queueExistingDialog.returnValue = 'cancel';
      queueExistingDialog.addEventListener(
        'close',
        () => resolve({queue: true, new: false}[queueExistingDialog.returnValue] ?? null),
        {once: true},
      );
      queueExistingDialog.showModal();
    });
  }
  // Resolves true (restart now), false (apply after current tasks) or null (cancel).
  function confirmProfileSave(count) {
    return new Promise((resolve) => {
      profileSaveDialog.querySelector('p').textContent =
        `${count} agent(s) are working in this workspace. The profile is saved either way. Restart them now, or let them continue: their current task keeps going and their next read uses the new profile.`;
      profileSaveDialog.returnValue = 'cancel';
      profileSaveDialog.addEventListener(
        'close',
        () => resolve({restart: true, later: false}[profileSaveDialog.returnValue] ?? null),
        {once: true},
      );
      profileSaveDialog.showModal();
    });
  }
  const attempt =
    (fn) =>
    async (...args) => {
      args[0]?.preventDefault?.();
      if (busy || isDeleting()) return;
      busy = true;
      setBusy();
      notice('');
      try {
        return await fn(...args);
      } catch (error) {
        notice(error.message);
      } finally {
        busy = false;
        setBusy();
      }
    };
  const button = (label, fn, cls = 'quiet') => {
    const b = el('button', label, cls);
    b.type = 'button';
    b.onclick = attempt(fn);
    return b;
  };
  const badge = (status) => el('span', statusNames[status] ?? status, 'automation-badge ' + status);
  const sectionTitle = (title, description) => {
    const head = el('div', null, 'automation-section-head');
    head.append(el('h2', title));
    if (description) head.append(el('p', description));
    return head;
  };
  function setBusy() {
    for (const b of host.querySelectorAll('button[data-idle]'))
      b.disabled = busy || hasBlockingRun(data);
    host.setAttribute('aria-busy', String(busy));
    if (selected && data) {
      renderControls();
      renderProfileState();
      chatPanel?.update(data);
      // Table actions run through attempt() and refresh while busy, so the table
      // must see busy end. Not on start: rebuilding rows there would replace the
      // control that was just clicked, such as the row menu it is about to open.
      if (!busy) resultsTable?.update(data, busy);
    }
  }
  async function catalog() {
    if (!templates.length) templates = await api.automationTemplates();
  }
  async function loadList() {
    const current = ++generation;
    await catalog();
    if (current !== generation || selected) return;
    renderStart();
  }
  // Job search is the only workspace type, so a new workspace starts from it directly.
  async function create() {
    const a = await api.workspaceCreate('job-search', {});
    await select(a.id);
  }
  function renderStart() {
    if (selected || host.hidden) return;
    host.replaceChildren();
    const heading = el('div', null, 'automation-heading');
    heading.append(
      sectionTitle(
        'Start a job search',
        'Pick a workspace on the left or open a new job search. The setup agent asks questions to tailor the search to you.',
      ),
    );
    host.append(heading, button('Start a new job search →', create, 'primary'));
    host.append(
      el(
        'p',
        'Runs on this computer. Keep the app and the computer on for regular checks.',
        'automation-local-note',
      ),
    );
  }
  async function select(id, {onboarding = true} = {}) {
    answers.update(null);
    notice('');
    selected = id;
    data = null;
    host.hidden = false;
    localStorage.setItem('selected-workspace', id);
    pane = null;
    formRevision = '';
    dirty = false;
    renaming = null;
    buildDetail();
    navigate('board');
    await refresh();
    if (selected !== id) return;
    if (!data) {
      data = await api.workspaceSnapshot(id);
      if (selected !== id) return;
      renderChromeCard(busy || isDeleting());
      renderDetail();
    }
    if (onboarding && openOnboarding(id, data)) return;
    if (automationProgress(data).fresh) {
      openConversation();
      if (data.automation.templateId !== 'custom') {
        await api.automationSetup(id);
        if (selected === id) await refresh();
      }
    }
  }
  function buildDetail() {
    resultsTable?.dispose();
    chatPanel?.dispose();
    chatPanel = null;
    showSetupView(localStorage.getItem('setup-agent-view:' + selected) ?? 'chat');
    agentConversation.replaceChildren();
    progressSignature = '';
    host.innerHTML = `<div id="automation-controls" class="actions"></div><p id="automation-runtime-note" class="automation-runtime-note" role="status"></p>
<div class="automation-setup-grid"><section class="automation-conversation"><div class="automation-section-head"><h2>Set up with the assistant</h2><p>Describe what you need, answer the questions or write the change you want.</p></div><div id="automation-messages" class="automation-messages" role="log" aria-label="Setup conversation"></div><form id="automation-chat"><label for="automation-message">Your message</label><textarea id="automation-message" placeholder="For example: I am looking for a two-room flat in Berlin up to 1,500 euros…" maxlength="12000" required></textarea><div class="actions"><button id="automation-send" data-idle type="submit" class="primary">Send</button><button id="automation-add-document" data-idle type="button" class="quiet">Add document</button></div><small>A change conversation pauses regular runs. New details appear in the workspace profile.</small></form></section>
<section class="automation-plan"><div class="automation-section-head"><h2>Setup card</h2><p>Review and edit what the assistant prepared. You choose the permission here.</p></div><form id="automation-plan-form"><label>Name<input name="title" required maxlength="150"></label><label>Goal<textarea name="goal" required maxlength="6000"></textarea></label><label>Workflow<textarea name="instructions" maxlength="12000"></textarea></label><details><summary>Personal details and documents</summary><label>Details this automation may use<textarea name="facts" maxlength="12000" placeholder="Only the details needed for this work. Do not share passwords here."></textarea></label><div id="automation-documents"></div><div id="automation-jev-profile" class="jev-profile"></div></details><label>Action permission<select name="mode"><option value="observe">Only find</option><option value="auto">Find and apply</option></select></label><div class="automation-plan-footer"><small id="automation-save-state" role="status"></small><button data-idle type="submit" class="primary">Save setup</button></div></form></section></div>
<section class="automation-results-section"><div class="automation-heading"><div><h2>Results</h2></div><button id="automation-export" type="button" class="quiet">Export results</button></div><div id="automation-results"></div></section>
<section class="automation-history-section"><div class="automation-section-head"><h2>Run history</h2><p>The outcome of each round and, when needed, the agent screen.</p></div><div id="automation-runs"></div></section><div class="automation-bottom-actions"><button id="automation-delete" type="button" class="quiet danger">Delete automation</button></div>`;
    const $ = (id) => find('#' + id),
      form = $('automation-plan-form');
    resultsTable = automationResultsTable($('automation-results'), {
      button,
      badge,
      time,
      api,
      refresh,
      statusNames,
      onQuestion: showAnswers,
      onContacts: showContacts,
      onEvaluateCriteria: evaluateCriteria,
      onCoverLetter: () => navigate('files'),
    });
    saveScoreSettings = minimumSaveScoreSettings({
      save: async (owner, value, options) => {
        const saved = await api.automationSaveScoreThreshold(owner, value, options);
        if (owner === selected) await refresh();
        return saved;
      },
    });
    $('automation-results').before(saveScoreSettings.element);
    const chatFeedback = el('p', null, 'automation-chat-feedback');
    chatFeedback.id = 'automation-chat-feedback';
    chatFeedback.setAttribute('role', 'status');
    chatFeedback.setAttribute('aria-live', 'polite');
    $('automation-chat').querySelector('.actions').after(chatFeedback);
    const profileEdited = () => {
      dirty = profileChanged(readForm(), formBaseline ?? data.automation);
      notice('');
      renderControls();
      onSnapshot(data);
    };
    form.addEventListener('input', profileEdited);
    form.onsubmit = attempt(async () => {
      if (!profileNeedsSave()) return;
      const owner = selected,
        input = readForm(),
        expectedRevision = Number(form.dataset.revision);
      delete input.criteria.save_score_threshold;
      const snapshot = await api.workspaceSnapshot(owner);
      if (owner !== selected || isDeleting()) return;
      const activeCount = (snapshot.activeRuns ?? []).filter(
        (run) => run.kind !== 'interview',
      ).length;
      const restart = activeCount ? await confirmProfileSave(activeCount) : true;
      if (restart === null || owner !== selected || isDeleting()) return;
      const options = {expectedRevision, restart};
      if (input.mode === 'auto' && snapshot.automation.mode !== 'auto') {
        const existing = (snapshot.results ?? []).filter(
          (r) => !r.trial && ['found', 'prepared'].includes(r.status),
        ).length;
        if (existing) {
          options.queueExisting = await askQueueExisting(existing, input.criteria.score_threshold);
          if (options.queueExisting === null || owner !== selected || isDeleting()) return;
        } else options.queueExisting = true;
      }
      const result = await api.automationProfileSave(owner, input, options);
      if (owner !== selected) return;
      dirty = false;
      formRevision = '';
      await refresh();
      notice(
        result?.restarted === false
          ? 'Profile saved. Running agents use it from their next read.'
          : 'Profile saved and applied.',
      );
    });
    $('automation-add-document').onclick = attempt(async () => {
      await api.pickDocument(selected);
      await refresh();
    });
    $('automation-export').onclick = attempt(() => api.automationExportResults(selected));
    $('automation-delete').onclick = () =>
      deleteWorkspace({id: selected, title: data.automation.title});
    const setupGrid = find('.automation-setup-grid'),
      plan = find('.automation-plan'),
      conversation = find('.automation-conversation'),
      results = find('.automation-results-section'),
      history = find('.automation-history-section');
    plan.dataset.automationPane = 'profile';
    plan.className = 'profile automation-plan';
    plan.querySelector('h2').textContent = 'Workspace profile';
    form.classList.add('profile-form');
    results.dataset.automationPane = 'board';
    history.dataset.automationPane = 'background';
    const agent = agentConversation;
    conversation.hidden = true;
    conversation.querySelector('.automation-section-head').remove();
    const chat = $('automation-chat');
    chat.className = 'workspace-chat-form';
    const messages = $('automation-messages'),
      intro = buildIntro(chat);
    agent.append(conversation);
    chatPanel = workspaceChat({
      root: conversation,
      form: chat,
      log: messages,
      input: $('automation-message'),
      send: $('automation-send'),
      attach: $('automation-add-document'),
      intro,
      api,
      owner: selected,
      onSend: sendMessage,
      onShow: () => showSetupView('chat'),
      onReviewSources: () => navigate('sources'),
      onReviewProfile: () => {
        navigate('profile');
        plan.querySelector('.profile-head').scrollIntoView({block: 'start'});
      },
      onClose: async () => {
        const run = interviewRun(data);
        if (run) await api.stopWorker(selected, run.workerId ?? 'main');
        await refresh();
      },
    });
    const profileHead = plan.querySelector('.automation-section-head'),
      profileCopy = el('div');
    profileCopy.append(...profileHead.children);
    profileHead.replaceChildren(profileCopy);
    profileHead.className = 'profile-head';
    const improve = button('Improve with the agent', openConversation);
    plan.querySelector('.profile-head').append(improve);
    const profileSave = el('button', 'Save profile', 'primary');
    profileSave.id = 'automation-profile-save';
    profileSave.type = 'submit';
    profileSave.setAttribute('form', form.id);
    profileHead.append(profileSave);
    const profileState = el('p', null, 'profile-save-status');
    profileState.id = 'automation-profile-state';
    profileState.setAttribute('role', 'status');
    profileHead.after(profileState);
    const profileSection = (title, description, ...parts) => {
        const section = el('div', null, 'profile-section'),
          copy = el('div', null, 'profile-section-copy'),
          fields = el('div', null, 'profile-fields');
        copy.append(el('h3', title), el('p', description));
        fields.append(...parts);
        section.append(copy, fields);
        return section;
      },
      field = (name) => form.elements[name].closest('label'),
      // fillForm renders each template field into the box of its profile section.
      criteriaBox = (id) => {
        const box = el('div', null, 'profile-criteria');
        box.dataset.criteriaSection = id;
        return box;
      },
      titled = (id, ...before) => {
        const section = PROFILE_SECTIONS.find((s) => s.id === id);
        return [section.title, section.description, ...before, criteriaBox(id)];
      };
    const profileSections = [
      profileSection(
        'Workspace',
        'The name and goal of this automation.',
        field('title'),
        field('goal'),
      ),
      profileSection(...titled('search')),
      profileSection(
        ...titled('candidate'),
        field('facts'),
        $('automation-documents'),
        $('automation-jev-profile'),
      ),
      profileSection(...titled('rules')),
      profileSection('Workflow', 'The steps the agent follows.', field('instructions')),
      profileSection(...titled('actions', field('mode'))),
    ];
    const mode = profileSections.flatMap((section) => [
        ...section.querySelectorAll('select[name=mode]'),
      ])[0],
      authorization = el('div', null, 'authorization');
    for (const [value, title, description] of [
      [
        'observe',
        'Only find',
        'Search, score and save suitable listings; never apply on its own. You can still press "Apply".',
      ],
      [
        'auto',
        'Find and apply',
        'Also applies on its own to listings that reach the minimum score.',
      ],
    ]) {
      const choice = el('label', null, 'choice'),
        input = el('input'),
        copy = el('span');
      input.type = 'radio';
      input.name = 'mode';
      input.value = value;
      input.required = true;
      copy.append(el('b', title), el('small', description));
      choice.append(input, copy);
      authorization.append(choice);
    }
    // criteria.auto_contacts: works with either choice and shares the minimum score.
    const contacts = el('label', null, 'choice'),
      contactsInput = el('input'),
      contactsCopy = el('span');
    contactsInput.type = 'checkbox';
    contactsInput.name = 'auto-contacts';
    contactsInput.value = 'find';
    contactsCopy.append(
      el('b', 'Find contacts automatically'),
      el(
        'small',
        'Searches LinkedIn for up to two people to write to about each new listing that reaches the minimum score. You still approve every message.',
      ),
    );
    contacts.append(contactsInput, contactsCopy);
    authorization.append(contacts);
    // fillForm renders the fields for automatic actions here.
    authorization.append(el('div', null, 'authorization-score'));
    authorization.addEventListener('change', syncApplyScore);
    mode.closest('label').replaceWith(authorization);
    const footer = form.querySelector('.automation-plan-footer');
    footer.className = 'profile-foot';
    footer.querySelector('button').textContent = 'Save profile';
    footer.querySelector('button').removeAttribute('data-idle');
    form.replaceChildren(...profileSections, footer);
    history.className = 'automation-history-section';
    history.innerHTML =
      '<div id="automation-current-work" class="current-work"></div><div class="section-title"><h2>Run history</h2></div><div id="automation-run-tabs" class="run-tabs" role="tablist" aria-label="Run history by source"></div><div id="automation-run-phases" class="run-tabs" role="tablist" aria-label="Source runs by phase" hidden></div><div id="automation-runs" class="run-list"></div>';
    const pipeline = el('div', null, 'pipeline');
    pipeline.id = 'automation-pipeline';
    const top = el('div', null, 'pipeline-top');
    $('automation-runtime-note').className = 'campaign-state';
    top.append($('automation-runtime-note'), $('automation-controls'));
    pipeline.append(top, el('div', null, 'automation-metrics'));
    results.prepend(pipeline);
    results.querySelector('.automation-heading').className = 'section-title';
    results.querySelector('h2').id = 'automation-table-title';
    const sources = el('section');
    sources.dataset.automationPane = 'sources';
    sourcePanel = automationSourcesPanel(sources, api, {
      refresh,
      notice,
      ask: () => {
        openConversation();
        const input = find('#automation-message');
        if (!input.value.trim())
          input.value =
            'Research and suggest sources that fit my goal and help me prepare my tracking plan.';
      },
    });
    const files = el('section');
    files.dataset.automationPane = 'files';
    files.innerHTML =
      '<div class="section-title"><h2>Files</h2><span>The workspace’s documents</span></div><label class="cover-letter-auto"><input type="checkbox" id="cover-letter-auto-approve"><span>Accept cover letters automatically<small>The application continues as soon as the cover letter agent saves a letter. Letters already waiting for review still need your approval.</small></span></label><div class="cover-letter-review" hidden></div><h3 class="file-group-title">User uploaded files</h3><div id="automation-file-list"></div><h3 class="file-group-title">Agent generated files</h3><div id="automation-generated-file-list"></div>';
    coverLetters = coverLetterReview(files.querySelector('.cover-letter-review'), api, {refresh});
    const autoApprove = files.querySelector('#cover-letter-auto-approve');
    autoApprove.onchange = async () => {
      autoApprove.disabled = true;
      try {
        await api.setCoverLetterAutoApprove(selected, autoApprove.checked);
        await refresh();
      } catch (error) {
        autoApprove.checked = !autoApprove.checked;
        notice(error.message);
      } finally {
        autoApprove.disabled = false;
      }
    };
    files.querySelector('.section-title').append(
      button('Add document', async () => {
        await api.pickDocument(selected);
        await refresh();
      }),
    );
    host.append(
      results,
      answersSection,
      attentionSection,
      contactsSection,
      history,
      files,
      sources,
      plan,
      find('.automation-bottom-actions'),
    );
    setupGrid.remove();
    find('.automation-bottom-actions').dataset.automationPane = 'profile';
  }
  // Initial setup and later conversations share the dedicated setup page.
  function buildIntro(chat) {
    const intro = el('div', null, 'workspace-intro');
    intro.hidden = true;
    intro.append(
      el('span', 'NEW WORKSPACE', 'workspace-intro-eyebrow'),
      el('h2', 'What should this workspace do?'),
      el(
        'p',
        'One sentence is enough. The agent asks for what is missing; you decide the sources, criteria and action permission together.',
      ),
    );
    const steps = el('ol', null, 'workspace-intro-steps');
    steps.setAttribute('aria-label', 'Setup steps');
    for (const [index, text] of [
      'Describe what you want',
      'The agent asks questions',
      'Confirm the profile and start',
    ].entries()) {
      const step = el('li');
      if (!index) step.className = 'current';
      step.append(el('span', String(index + 1)), text);
      steps.append(step);
    }
    const examples = el('div', null, 'workspace-intro-examples');
    examples.setAttribute('aria-label', 'Examples');
    for (const text of [
      'Find a two-room rental flat in Berlin up to €1,500 and list the suitable ones.',
      'Track and score remote-friendly product manager listings in Istanbul.',
      'Let me know when Tokyo–Istanbul flights drop below €600.',
    ]) {
      const chip = el('button', text);
      chip.type = 'button';
      chip.onclick = () => {
        const input = chat.querySelector('#automation-message');
        input.value = text;
        input.dispatchEvent(new Event('input'));
        input.focus();
        input.setSelectionRange(text.length, text.length);
      };
      examples.append(chip);
    }
    intro.append(steps, examples);
    return intro;
  }
  function renderIntro() {
    if (!data) return;
    const intro = find('.workspace-intro'),
      fresh = automationProgress(data).fresh,
      message = find('#automation-message');
    document.body.classList.toggle('workspace-fresh', fresh);
    if (fresh && setupPage.dataset.view !== 'chat') showSetupView('chat');
    if (intro) intro.hidden = !fresh;
    if (message)
      message.placeholder = fresh
        ? 'Describe in one sentence what you want to do…'
        : 'Write a message to the agent…';
    chatPanel?.update(data);
  }
  function setPane(name) {
    const page = {results: 'board', setup: 'profile', history: 'background'}[name] ?? name;
    if (page === 'sources' && pane !== 'sources') sourcePanel?.resort();
    pane = page;
    localStorage.setItem('selected-view', page);
    for (const b of document.querySelectorAll('aside nav button'))
      b.classList.toggle('selected', b.dataset.view === page);
    for (const section of host.querySelectorAll('[data-automation-pane]'))
      section.hidden = section.dataset.automationPane !== page;
  }
  const extensionMissingText =
    'The AutoJob extension is not installed in the selected Chrome profile. Open chrome://extensions, turn on Developer mode and drag the extension folder onto the page.';
  const profileKey = (a) => a.chromeProfile?.directory ?? '';
  let extensionCheck = {profile: null, installed: null, busy: false};
  // Bounded to the visible, idle card: one local file check every two seconds.
  // Once the user installs the missing extension, the card connects once.
  async function watchExtension() {
    const connection = data?.browserStatus ?? {};
    if (
      !selected ||
      !data ||
      extensionCheck.busy ||
      document.hidden ||
      connection.ready ||
      (connection.state ?? 'idle') !== 'idle'
    )
      return;
    const owner = selected,
      profile = profileKey(data.automation);
    extensionCheck.busy = true;
    const installed = await api.extensionInstalled?.(profile || undefined).catch(() => null);
    extensionCheck.busy = false;
    if (owner !== selected || installed == null) return;
    const before = extensionCheck.profile === profile ? extensionCheck.installed : null;
    extensionCheck = {profile, installed, busy: false};
    if (installed === before) return;
    renderChromeCard(busy || isDeleting());
    if (before === false && installed) api.browserReconnect(owner).catch(() => {});
  }
  setInterval(() => void watchExtension(), 2000);
  function renderChromeCard(locked) {
    if (!selected || !data) return;
    const a = data.automation;
    const chrome = document.querySelector('.chrome-status'),
      connection = data.browserStatus ?? {};
    chrome.hidden = false;
    chrome.dataset.state = connection.state ?? 'idle';
    chrome.querySelector('b').textContent = connection.ready
      ? 'Chrome connected'
      : connection.state === 'connecting'
        ? 'Connecting to Chrome…'
        : 'Chrome connection';
    // With no task waiting for Chrome, the card asks whether the extension is
    // installed itself, so the setup help shows before anything needs Chrome.
    const idle = !connection.ready && (connection.state ?? 'idle') === 'idle',
      known = idle && extensionCheck.profile === profileKey(a) ? extensionCheck.installed : null,
      missing = (!connection.ready && connection.code === 'EXTENSION_MISSING') || known === false;
    chrome.querySelector('small').textContent = connection.ready
      ? (a.chromeProfile?.name ?? 'Selected Chrome session')
      : missing
        ? `${connection.message ?? extensionMissingText} AutoJob connects on its own once the extension is installed.`
        : known
          ? 'The AutoJob extension is installed. Chrome connects when a task needs it, or press Connect.'
          : (connection.message ??
            'The AutoJob extension must be installed in the selected Chrome profile. While it is connected, Chrome shows an "AutoJob" bar at the top.');
    chrome.querySelector('.chrome-extension-folder').hidden = !missing;
    // A failed handshake does not tell whether the extension is installed, so
    // point to it unless the message already does.
    chrome.querySelector('.chrome-tip').hidden =
      connection.ready ||
      connection.state === 'connecting' ||
      !connection.message ||
      connection.message.includes('extension');
    chrome.querySelector('.chrome-reconnect').hidden = Boolean(connection.ready);
    chrome.querySelector('.chrome-reconnect').textContent = idle ? 'Connect' : 'Reconnect';
    chrome.querySelector('.chrome-reconnect').disabled =
      locked || connection.state === 'connecting';
    chrome.querySelector('.chrome-profile-change').disabled = locked;
  }
  function renderShell() {
    if (!selected || !data) return;
    const locked = busy || isDeleting(),
      p = renderProgress(),
      a = data.automation,
      active = Boolean(data.activeRun) || a.status === 'enabled',
      ready = automationReady(a);
    setupSettings.update(selected, data);
    document.querySelector('#heading').textContent = a.title;
    const workspaces = document.querySelector('#candidates'),
      value = a.id;
    if (![...workspaces.options].some((o) => o.value === value))
      workspaces.add(new Option(a.title, value));
    workspaces.value = value;
    const state = document.querySelector('#agent-state');
    state.textContent = p.label;
    state.dataset.active = String(active);
    const start = document.querySelector('#start'),
      stop = document.querySelector('#stop'),
      restart = document.querySelector('#restart-agent');
    start.hidden = active || !p.primary;
    stop.hidden = !active;
    start.disabled = locked || hasUnsaved();
    stop.disabled = locked;
    restart.disabled = locked || hasUnsaved() || !ready;
    start.textContent = p.primary?.label ?? 'Running';
    stop.textContent = data.activeRun ? 'Stop round' : 'Pause tracking';
    restart.hidden = true;
    for (const id of ['candidates', 'new']) document.querySelector('#' + id).disabled = locked;
    document.querySelector('#rename-workspace').disabled = locked;
    document.querySelector('#delete-workspace').disabled = locked;
    find('#automation-delete').disabled = locked;
    answers.update(data);
    contactsView.update(data);
    const review = contactsToReview(data),
      {searching, sending} = contactsWorking(data),
      contactWork = [searching && `${searching} searching`, sending && `${sending} sending`]
        .filter(Boolean)
        .join(' · ');
    contactsWork.hidden = !contactWork;
    contactsWork.textContent = contactWork;
    contactsBadge.hidden = !review;
    contactsBadge.textContent = review ? String(review) : '';
    contactsNav.title = [
      contactWork,
      review && `${review} contact${review > 1 ? 's' : ''} to approve`,
    ]
      .filter(Boolean)
      .join(' · ');
    contactsNav.setAttribute(
      'aria-label',
      ['Contacts', contactsNav.title].filter(Boolean).join(' · '),
    );
    const helpCount = attention.update(selected, data),
      questionCount = (a.questions ?? []).filter((q) => q.recordId && q.answer == null).length,
      agentHelpCount = Math.max(0, helpCount - questionCount - attention.conversationCount),
      running = (data.activeRuns ?? (data.activeRun ? [data.activeRun] : [])).filter(
        (run) => run.kind !== 'interview',
      ).length;
    questionBadge.hidden = !questionCount;
    pinPending(
      questionCount,
      agentHelpCount,
      (a.questions ?? []).filter((q) => q.coverLetter?.state === 'review' && q.answer == null)
        .length,
    );
    questionBadge.textContent = questionCount ? String(questionCount) : '';
    answersNav.title = questionCount ? `${questionCount} awaiting an answer` : '';
    answersNav.setAttribute(
      'aria-label',
      ['Answers', answersNav.title].filter(Boolean).join(' · '),
    );
    const work = activeRecordOperations(data),
      workSummary = work.map(({count, label}) => `${count} ${label}`);
    recordWork.hidden = !work.length;
    recordWork.replaceChildren(
      ...work.map(({kind, count, label}) => {
        const badge = el('span', `${count} ${label}`, 'agent-nav-status');
        badge.dataset.tone = 'active';
        badge.dataset.operation = kind;
        return badge;
      }),
    );
    boardNav.title = workSummary.join(' · ');
    boardNav.setAttribute(
      'aria-label',
      ['Tracking table', boardNav.title].filter(Boolean).join(' · '),
    );
    attentionBadge.hidden = !agentHelpCount;
    attentionBadge.textContent = agentHelpCount ? String(agentHelpCount) : '';
    attentionEmpty.hidden = agentHelpCount > 0;
    attentionNav.title = agentHelpCount ? `${agentHelpCount} item(s) need attention` : '';
    attentionNav.setAttribute(
      'aria-label',
      ['Attention needed', attentionNav.title].filter(Boolean).join(' · '),
    );
    const status = document.querySelector('#agent-nav-status');
    status.textContent = running ? `${running} running` : '';
    status.hidden = !status.textContent;
    status.dataset.tone = 'active';
    agentNavLabel(p.fresh);
    const chatStatus = document.querySelector('#setup-agent-status'),
      chatRun = interviewRun(data);
    chatStatus.textContent = attention.conversationCount
      ? String(attention.conversationCount)
      : interviewBusy(data)
        ? ''
        : chatRun
          ? 'Open'
          : '';
    chatStatus.hidden = !attention.conversationCount && !chatRun;
    setupNav.title = attention.conversationCount
      ? `${attention.conversationCount} awaiting an answer`
      : interviewBusy(data)
        ? 'Preparing a reply'
        : chatRun
          ? 'Chat open'
          : 'Talk to the setup agent';
    chatStatus.dataset.tone = attention.conversationCount
      ? 'waiting'
      : interviewBusy(data)
        ? 'active'
        : 'idle';
    const scanning = new Set(
      (data.activeRuns ?? (data.activeRun ? [data.activeRun] : []))
        .map((slot) => data.runs.find((r) => r.id === slot.id) ?? slot)
        .filter(
          (r) =>
            r.status === 'running' &&
            ['run', 'trial'].includes(r.kind) &&
            !r.recordId &&
            !r.recordOperation,
        )
        .flatMap((r) => (r.sourceUrl ? [r.sourceUrl] : (r.sources ?? []))),
    );
    const sourcesNav = document.querySelector('[data-view=sources]'),
      sourceStatus = document.querySelector('#sources-nav-status');
    if (sourceStatus) {
      const names = [...scanning].map(
        (url) => data.sources.find((s) => s.url === url)?.name ?? new URL(url).hostname,
      );
      sourceStatus.hidden = !scanning.size;
      sourceStatus.textContent = scanning.size ? `${scanning.size} scanning` : '';
      sourcesNav.title = names.join(', ');
      sourcesNav.setAttribute(
        'aria-label',
        scanning.size
          ? `Sources · ${scanning.size} source(s) scanning: ${names.join(', ')}`
          : 'Sources',
      );
    }
    document.querySelector('[data-view=profile] span').textContent = 'Workspace profile';
    document.querySelector('[data-view=board] span').textContent = 'Tracking table';
    renderChromeCard(locked);
    const jev = document.querySelector('.jev-status'),
      issue = data.jevIssue;
    jev.hidden = !issue;
    if (issue) {
      const [title, detail] =
        issue.status === 402
          ? ['Jev credit ran out', 'Add TypeSafe credit to resume scanning.']
          : [401, 403].includes(issue.status)
            ? ['Jev key rejected', 'Check the key under Configuration → Jev.']
            : ['Jev is not responding', 'Jev tasks are not progressing.'];
      jev.querySelector('b').textContent = title;
      jev.querySelector('small').textContent =
        `TypeSafe HTTP ${issue.status} · ${new Date(issue.at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}. ${detail}`;
    }
    syncWorkspaceMenu();
  }
  async function performAction(id) {
    if (!data) return;
    if (id === 'message') return openConversation();
    if (id === 'questions') {
      attention.review();
      return;
    }
    if (id === 'setup') {
      await api.automationSetup(selected);
      await refresh();
      openConversation();
      return;
    }
    if (id === 'profile') {
      navigate('profile');
      find('#automation-plan-form').scrollIntoView({block: 'start'});
      return;
    }
    if (id === 'results') return navigate('board');
    if (id === 'sources') return navigate('sources');
    if (id === 'terminal') {
      const run = interviewRun(data);
      navigate(run ? 'setup-agent' : 'agent');
      if (run) showSetupView('terminal');
      else document.querySelector('#agent-tab-work')?.click();
      const worker = run?.workerId ?? 'main';
      focusAgent({view: 'terminal', worker});
      document
        .querySelector(`.worker-pane[data-worker-id="${worker}"]`)
        ?.scrollIntoView({block: 'center'});
      return;
    }
    if (id === 'browser') return api.automationBrowser(selected);
    if (id === 'stop') return stop();
    if (hasUnsaved()) {
      navigate('profile');
      notice('Save the profile changes first.');
      return;
    }
    if (id === 'enable') await api.workspaceStart(selected);
    else if (id === 'trial' || id === 'run') await api.automationRun(selected, id);
    await refresh();
    navigate('agent');
    document.querySelector('#now-panel').scrollIntoView({block: 'start', behavior: 'smooth'});
  }
  async function start() {
    if (!data || busy) return;
    const next = automationProgress(data, {dirty: hasUnsaved()}).primary;
    if (next) return attempt(() => performAction(next.id))();
  }
  function renderProgress() {
    if (!data) return;
    const p = automationProgress(data, {dirty: hasUnsaved()});
    const steps = document.querySelector('#automation-steps'),
      key = JSON.stringify(p.steps);
    // Once setup is done the workspace is simply running; the stepper has nothing left to guide.
    steps.hidden = p.steps.slice(0, -1).every((step) => step.state === 'done');
    if (steps.dataset.signature !== key) {
      steps.dataset.signature = key;
      steps.replaceChildren(
        ...p.steps.map((step, i) => {
          const li = el('li', null, step.state);
          li.append(
            el('span', step.state === 'done' ? '✓' : String(i + 1)),
            document.createTextNode(step.label),
          );
          if (step.state === 'current') li.setAttribute('aria-current', 'step');
          return li;
        }),
      );
    }
    const next = document.querySelector('#automation-next-step');
    next.textContent = p.next;
    next.hidden = p.primary?.id === 'message';
    const actions = document.querySelector('#automation-next-actions'),
      signature = JSON.stringify([p.primary, p.secondary, busy, Boolean(data.activeRun)]);
    if (signature !== progressSignature) {
      progressSignature = signature;
      actions.replaceChildren();
      for (const item of [p.primary, ...p.secondary].filter(
        (item) => item && item.id !== 'message',
      )) {
        const b = button(
          item.label,
          () => performAction(item.id),
          item === p.primary ? 'primary' : 'quiet',
        );
        b.dataset.progressAction = item.id;
        b.disabled = busy;
        actions.append(b);
      }
    }
    document.querySelector('#automation-agent-reply').hidden = true;
    const conversation = find('.automation-conversation');
    if (conversation) conversation.hidden = false;
    return p;
  }
  async function stop() {
    await api.workspaceStop(selected);
    await refresh();
  }
  async function restart() {
    await api.workspaceRestart(selected);
    await refresh();
  }
  function agentNavLabel() {
    const nav = document.querySelector('aside nav button[data-view=agent]');
    nav.querySelector('span').textContent = 'Agent';
  }
  function deselect() {
    recordWork.hidden = true;
    document.querySelector('.jev-status').hidden = true;
    recordWork.replaceChildren();
    boardNav.title = '';
    questionBadge.hidden = true;
    answersNav.title = '';
    answersNav.setAttribute('aria-label', 'Answers');
    attentionBadge.hidden = true;
    pinPending(0, 0);
    attentionNav.title = '';
    attentionNav.setAttribute('aria-label', 'Attention needed');
    document.querySelector('[data-view=board]').setAttribute('aria-label', 'Tracking table');
    const sourceStatus = document.querySelector('#sources-nav-status');
    if (sourceStatus) sourceStatus.hidden = true;
    const sourcesNav = document.querySelector('[data-view=sources]');
    if (sourcesNav) {
      sourcesNav.title = '';
      sourcesNav.setAttribute('aria-label', 'Sources');
    }
    resultsTable?.dispose();
    attention.update(null, null);
    answers.update(null);
    contactsView.update(null);
    resultsTable?.dispose();
    agentNavLabel(false);
    chatPanel?.dispose();
    chatPanel = null;
    agentConversation.replaceChildren();
    document.body.classList.remove('workspace-fresh');
    selected = null;
    data = null;
    localStorage.removeItem('selected-workspace');
    host.hidden = true;
    onSnapshot(null);
    document.body.classList.remove('automation-workspace');
    document.querySelector('[data-view=profile] span').textContent = 'Workspace profile';
    document.querySelector('[data-view=board] span').textContent = 'Tracking table';
  }
  function readForm() {
    const f = find('#automation-plan-form').elements,
      fields =
        data.definition?.fields ??
        templates.find((t) => t.id === data.automation.templateId).fields;
    return {
      title: f.title.value,
      goal: f.goal.value,
      criteria: Object.fromEntries(
        fields.map((field) => [
          field.id,
          field.id === 'save_score_threshold'
            ? (data.automation.criteria.save_score_threshold ?? '')
            : field.id === 'auto_contacts'
              ? autoContactsValue()
              : (f['criteria-' + field.id]?.value ?? ''),
        ]),
      ),
      instructions: f.instructions.value,
      facts: f.facts.value,
      mode: f.mode.value,
    };
  }
  // 'find' when checked; unchecked keeps a saved non-option value (such as
  // 'false'), so an untouched form is not an unsaved change.
  function autoContactsValue() {
    const saved = data.automation.criteria.auto_contacts ?? '',
      value = find('#automation-plan-form').querySelector('[name=auto-contacts]:checked')?.value;
    return value ?? (autoContactsMode({auto_contacts: saved}) ? '' : saved);
  }
  function profileNeedsSave() {
    const a = data.automation;
    return (
      Boolean(a.profileUpdate?.error) ||
      a.reviewedRevision !== a.revision ||
      profileChanged(readForm(), a)
    );
  }
  function fillForm() {
    const saved = data.automation,
      base = saved.profileUpdate ? {...saved, ...saved.profileUpdate.plan} : saved,
      a =
        saved.planDraft?.baseRevision === saved.revision
          ? {...base, ...saved.planDraft.plan}
          : base,
      key = JSON.stringify([a.id, a.revision, a.updatedAt, saved.planDraft, saved.profileUpdate]);
    if (hasUnsaved() || formRevision === key) return;
    formRevision = key;
    const form = find('#automation-plan-form'),
      f = form.elements,
      slot = form.querySelector('.authorization-score'),
      fields = data.definition?.fields ?? templates.find((t) => t.id === a.templateId).fields;
    form.dataset.revision = String(saved.revision);
    // Board settings (section 'board') stay off the profile. Fields that matter
    // only for automatic actions sit under Find and apply.
    for (const section of PROFILE_SECTION_IDS) {
      const box = form.querySelector(`[data-criteria-section=${section}]`),
        own = fields.filter((field) => fieldSection(field) === section);
      templateFields(
        box,
        own.filter((field) => !field.forMode),
        a.criteria,
      );
      if (section === 'actions' && slot)
        templateFields(
          slot,
          own.filter((field) => field.forMode === 'auto'),
          a.criteria,
        );
      const parts = box.parentElement;
      parts.closest('.profile-section').hidden =
        parts.children.length === 1 && !box.children.length;
    }
    for (const key of ['title', 'goal', 'instructions', 'facts', 'mode']) f[key].value = a[key];
    // Workspaces saved before elimination rules existed get them from the setup agent.
    const rules = f['criteria-hard_rules']?.closest('fieldset');
    if (rules && !a.criteria.hard_rules?.trim())
      rules.append(
        button('Ask the setup agent to propose rules', async () => {
          await sendMessage(
            'Propose elimination rules (criteria.hard_rules) for this workspace from my documents and saved criteria, move the hard conditions out of the other fields as Scoring step 5 says, and save it for my review.',
          );
          openConversation();
        }),
      );
    form.querySelector('[name=auto-contacts]').checked = Boolean(autoContactsMode(a.criteria));
    syncApplyScore();
    formBaseline = readForm();
  }
  // Find and apply only runs with an explicit minimum score; automatic contact
  // search uses the same score. Turning either on fills in the default.
  function syncApplyScore(event) {
    const form = find('#automation-plan-form'),
      input = form?.elements['criteria-score_threshold'],
      slot = form?.querySelector('.authorization-score');
    if (!input || !slot) return;
    const auto = form.elements.mode.value === 'auto',
      contacts = Boolean(form.querySelector('[name=auto-contacts]:checked'));
    Object.assign(input, {required: auto, min: '1', max: '100', step: '1'});
    input.placeholder = `1–100, default ${DEFAULT_SCORE_THRESHOLD}`;
    input.closest('label').firstChild.textContent =
      auto && contacts
        ? 'Minimum score to apply and find contacts'
        : contacts
          ? 'Minimum score to find contacts'
          : 'Minimum score to apply';
    slot.hidden = !auto && !contacts;
    if (event && event.target !== input && !slot.hidden && !input.value)
      input.value = String(DEFAULT_SCORE_THRESHOLD);
  }
  function renderControls() {
    if (!data || !find('#automation-controls')) return;
    const a = data.automation,
      controls = find('#automation-controls');
    controls.replaceChildren();
    const action = (label, fn, id, disabled) => {
      const b = button(label, fn);
      b.id = id;
      b.disabled = Boolean(disabled || busy || hasBlockingRun(data));
      controls.append(b);
    };
    action(
      'Open browser',
      () => api.automationBrowser(selected),
      'automation-browser',
      !a.sources.length || hasUnsaved(),
    );
    action(
      'Scan all now',
      () => performAction('run'),
      'automation-run',
      hasUnsaved() || !automationReady(a),
    );
    const p = automationProgress(data, {dirty: hasUnsaved()});
    if (p.primary && !['trial', 'run'].includes(p.primary.id))
      action(p.primary.label, () => performAction(p.primary.id), 'automation-next', hasUnsaved());
    renderShell();
    renderProfileState();
  }
  function renderProfileState() {
    if (!data) return;
    const form = find('#automation-plan-form');
    if (!form) return;
    const a = data.automation,
      pending = Boolean(a.profileUpdate),
      draft = Boolean(a.planDraft),
      working = (data.activeRuns ?? []).some((run) => run.kind !== 'interview');
    const changeNote = working
      ? ' When you save, you choose whether running agents restart. The chat stays open.'
      : '';
    const text = a.profileUpdate?.error
      ? 'The profile could not be applied: ' + a.profileUpdate.error + ' You can save again.'
      : pending
        ? 'Profile saved; applying. Scans are stopping and restarting with the new criteria.'
        : hasUnsaved()
          ? 'Unsaved changes.' + changeNote
          : draft && profileNeedsSave()
            ? 'The agent’s profile draft is ready. Review it and press Save profile.' + changeNote
            : a.reviewedRevision === a.revision
              ? 'Profile saved.'
              : data.missing.length
                ? 'Missing: ' + data.missing.join(', ')
                : 'Check and save the profile.';
    form.inert = busy;
    for (const status of [find('#automation-save-state'), find('#automation-profile-state')])
      if (status) {
        status.textContent = text;
        status.dataset.pending = String(pending || draft || hasUnsaved());
      }
    saveScoreSettings?.update(a, busy || isDeleting());
    if (formBaseline?.criteria)
      formBaseline.criteria.save_score_threshold = a.criteria.save_score_threshold ?? '';
    for (const button of [find('#automation-profile-save'), form.querySelector('[type=submit]')])
      if (button) {
        const applying = pending && !a.profileUpdate.error;
        button.disabled = busy || applying || !profileNeedsSave();
        button.textContent = applying
          ? 'Applying profile…'
          : busy
            ? 'Saving…'
            : a.profileUpdate?.error
              ? 'Save again'
              : 'Save profile';
      }
  }
  function renderDetail() {
    if (!data || host.hidden) return;
    const a = data.automation,
      $ = (id) => find('#' + id);
    const p = automationProgress(data, {dirty: hasUnsaved()});
    find('#automation-runtime-note').textContent = p.title + ' · ' + p.next;
    fillForm();
    renderControls();
    renderProfileState();

    const docs = $('automation-documents');
    docs.replaceChildren();
    const userDocuments = data.documents.filter((doc) => !doc.generated);
    for (const doc of userDocuments) {
      const b = button((doc.displayName ?? doc.name) + ' ↗', () =>
        api.openDocument(selected, doc.path),
      );
      docs.append(b);
    }
    if (!userDocuments.length)
      docs.append(el('small', 'No documents have been added to this automation yet.'));
    renderJevProfile($('automation-jev-profile'), data.jevProfile, async (text) => {
      await api.saveJevProfile(selected, text);
      await refresh();
    });
    renderResults();
    renderRuns();
    renderCurrentWork(find('#automation-current-work'), data, {stop: stopWork});
    renderWorkspacePages();
    renderIntro();
    setPane(pane ?? 'board');
    setBusy();
    onSnapshot(data);
  }
  function renderWorkspacePages() {
    const a = data.automation,
      counts = data.resultCounts;
    find('#automation-table-title').textContent = a.table?.title ?? 'Tracking flow';
    find('#automation-pipeline').dataset.status = data.activeRun ? 'running' : a.status;
    const metrics = find('.automation-metrics');
    metrics.replaceChildren();
    const bar = el('div', null, 'pipeline-bar'),
      legend = el('div', null, 'pipeline-legend');
    for (const [key, value, label] of [
      ['submitted', counts.completedCount, 'completed'],
      ['waiting', counts.pendingCount + counts.uncertainCount, 'waiting'],
      [
        'found',
        Math.max(
          0,
          counts.resultCount - counts.completedCount - counts.pendingCount - counts.uncertainCount,
        ),
        'found',
      ],
    ]) {
      if (value) {
        const segment = el('span');
        segment.dataset.key = key;
        segment.style.flex = String(value);
        bar.append(segment);
      }
      const entry = el('span');
      entry.dataset.key = key;
      entry.append(el('b', String(value)), document.createTextNode(' ' + label));
      legend.append(entry);
    }
    const samples = Math.max(0, counts.storedCount - counts.resultCount);
    if (samples) {
      const entry = el('span');
      entry.append(el('b', String(samples)), document.createTextNode(' research / trial samples'));
      legend.append(entry);
    }
    metrics.append(bar, legend);
    sourcePanel.update(data, selected);
    coverLetters.update(data);
    find('#cover-letter-auto-approve').checked = data.automation.coverLetterAutoApprove === true;
    // Agent generated files (generated/) are kept apart from the user's own
    // documents; agents never read them as profile documents.
    // A cover letter names the application it was written for.
    const letterState = {
      writing: 'being rewritten',
      review: 'waiting for your review',
      approved: 'approved',
      autoApproved: 'accepted automatically',
      failed: 'rewrite stopped',
    };
    const written = new Map();
    for (const q of data.automation.questions ?? [])
      if (q.coverLetter?.path) written.set(q.coverLetter.path, q);
    const fileDetail = (doc) => {
      const q = written.get(doc.path.split('\\').join('/'));
      if (!q) return null;
      const record = data.results.find((r) => r.id === q.recordId),
        site = record?.url ? new URL(record.url).hostname.replace(/^www\./, '') : null;
      return {
        text: [
          'Cover letter for ' + (record?.title ?? 'a removed record'),
          site,
          letterState[q.coverLetter.autoApproved ? 'autoApproved' : q.coverLetter.state],
        ]
          .filter(Boolean)
          .join(' · '),
        url: record?.url ?? null,
      };
    };
    // A user document is uploaded under its display name; Rename edits only
    // that name, never the stored file. A refresh while the form is open
    // rebuilds it with what was typed and where the cursor was.
    const renameForm = (row, doc, focus) => {
      const form = el('form', null, 'document-rename'),
        input = el('input');
      input.value = renaming.value;
      input.maxLength = 120;
      input.setAttribute('aria-label', 'File name employers receive');
      input.oninput = () => (renaming.value = input.value);
      const save = el('button', 'Save', 'primary');
      save.type = 'submit';
      const cancel = button('Cancel', () => {
        renaming = null;
        renderWorkspacePages();
      });
      form.onsubmit = attempt(async () => {
        await api.renameDocument(selected, doc.path, input.value);
        renaming = null;
        await refresh();
      });
      form.append(input, save, cancel);
      row.replaceChildren(form);
      if (focus) {
        input.focus();
        input.setSelectionRange(focus.start, Math.min(focus.end, input.value.length));
      }
    };
    // Newest first, each with the time it was created.
    const fileList = (target, docs, empty, {rename = false} = {}) => {
      const files = find(target),
        open = files.querySelector('.document-rename input'),
        focus =
          open && open === document.activeElement
            ? {start: open.selectionStart ?? 0, end: open.selectionEnd ?? 0}
            : null;
      files.replaceChildren();
      const newest = [...docs].sort((a, b) =>
        (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt),
      );
      for (const doc of newest) {
        const row = el('div', null, 'document-row'),
          name = el('div'),
          detail = fileDetail(doc);
        name.append(el('strong', doc.displayName ?? doc.name));
        if (rename && doc.displayName && doc.displayName !== doc.name)
          name.append(el('small', 'Stored as ' + doc.name));
        if (detail) name.append(el('small', detail.text));
        name.append(el('small', 'Created ' + time(doc.createdAt ?? doc.updatedAt)));
        const actions = el('div', null, 'document-actions');
        if (detail?.url) actions.append(button('Open listing ↗', () => api.openLink(detail.url)));
        if (rename)
          actions.append(
            button('Rename', () => {
              renaming = {path: doc.path, value: doc.displayName ?? doc.name};
              renderWorkspacePages();
              const input = find(target + ' .document-rename input');
              input?.focus();
              input?.select();
            }),
          );
        actions.append(button('Open ↗', () => api.openDocument(selected, doc.path)));
        row.append(name, actions);
        files.append(row);
        if (rename && renaming?.path === doc.path) renameForm(row, doc, focus);
      }
      if (!docs.length) files.append(el('p', empty, 'empty'));
    };
    fileList(
      '#automation-file-list',
      data.documents.filter((doc) => !doc.generated),
      'Documents you add to the workspace appear here.',
      {rename: true},
    );
    fileList(
      '#automation-generated-file-list',
      data.documents.filter((doc) => doc.generated),
      'Files the agents write, such as cover letters, appear here.',
    );
  }
  function renderResults() {
    resultsTable.update(data, busy);
  }
  async function sendMessage(text) {
    if (data?.activeRun && !data?.capabilities?.concurrentConversation)
      throw Error(
        'Independent chat needs an app update. Reopen the app after the running round finishes.',
      );
    const owner = selected,
      form = find('#automation-plan-form'),
      pending = prepareAutomationChat(
        text,
        hasUnsaved()
          ? {...readForm(), title: form.elements.title.value.trim() || data.automation.title}
          : null,
      );
    if (pending.draft) {
      if (hasBlockingRun(data) || data.automation.profileUpdate)
        pending.message +=
          '\n\nDraft I edited in the profile and have not confirmed yet (JSON):\n' +
          JSON.stringify(pending.draft);
      else {
        await api.automationSave(owner, pending.draft);
        if (owner === selected) {
          dirty = false;
          formRevision = '';
        }
      }
    }
    await api.automationMessage(owner, pending.message);
    if (owner === selected) await refresh();
  }
  function openConversation() {
    renderIntro();
    navigate('setup-agent');
    showSetupView('chat');
    const conversation = find('.automation-conversation');
    conversation.hidden = false;
    chatPanel?.focus();
    conversation.scrollIntoView({block: 'start', behavior: 'smooth'});
  }
  async function stopWork({sourceUrl, workerId}) {
    const owner = selected;
    try {
      await (sourceUrl
        ? api.automationSourceStop(owner, sourceUrl)
        : api.stopWorker(owner, workerId));
      if (owner === selected) await refresh();
    } catch (error) {
      if (owner === selected) notice(error.message);
    }
  }
  // One tab per source; runs without a single source go under Other.
  function runSourceUrl(run) {
    if (run.kind === 'interview') return null;
    return run.sourceUrl ?? (run.sources?.length === 1 ? run.sources[0] : null);
  }
  // Within a source, runs that prepare, send or verify an application are the
  // application phase; scans, trials and listing scoring are the search phase.
  function runPhaseOf(run) {
    return ['prepare', 'execute', 'verify'].includes(run.recordOperation)
      ? 'application'
      : 'search';
  }
  function tabButtons(tabs, current, choose) {
    return tabs.map(([key, label, count]) => {
      const button = el('button', `${label} (${count})`);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(key === current));
      button.onclick = () => {
        choose(key);
        renderRuns();
      };
      return button;
    });
  }
  function renderRunTabs() {
    const bar = find('#automation-run-tabs');
    if (!bar) return;
    if (runTabOwner !== selected) {
      runTabOwner = selected;
      runTab = 'all';
      runPhase = 'all';
    }
    const counts = new Map();
    for (const run of data.runs) {
      const key = runSourceUrl(run) ?? 'other';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const tabs = [['all', 'All', data.runs.length]];
    for (const source of data.sources)
      tabs.push([source.url, source.name, counts.get(source.url) ?? 0]);
    for (const [key, count] of counts)
      if (key !== 'other' && !data.sources.some((source) => source.url === key))
        tabs.push([key, new URL(key).hostname.replace(/^www\./, ''), count]);
    if (counts.has('other')) tabs.push(['other', 'Other', counts.get('other')]);
    if (!tabs.some(([key]) => key === runTab)) runTab = 'all';
    bar.hidden = tabs.length < 3;
    const buttons = tabButtons(tabs, runTab, (key) => (runTab = key));
    tabs.forEach(([key], index) => {
      if (key !== 'all' && key !== 'other') buttons[index].title = key;
    });
    bar.replaceChildren(...buttons);
  }
  function renderRunPhases(sourceRuns) {
    const bar = find('#automation-run-phases');
    if (!bar) return;
    bar.hidden = !sourceRuns.length;
    const count = (phase) => sourceRuns.filter((run) => runPhaseOf(run) === phase).length;
    bar.replaceChildren(
      ...tabButtons(
        [
          ['all', 'All', sourceRuns.length],
          ['search', 'Search', count('search')],
          ['application', 'Application', count('application')],
        ],
        runPhase,
        (key) => (runPhase = key),
      ),
    );
  }
  // Development builds: each run row opens what its agent received.
  let traceAvailable = false;
  void devToolsAvailable(api).then((available) => {
    traceAvailable = available;
    if (available && data?.runs && find('#automation-runs')) renderRuns();
  });
  function renderRuns() {
    renderRunTabs();
    const root = find('#automation-runs');
    root.replaceChildren();
    const sourceRuns =
      runTab === 'all'
        ? data.runs
        : data.runs.filter((run) => (runSourceUrl(run) ?? 'other') === runTab);
    renderRunPhases(sourceRuns);
    const runs =
      runPhase === 'all' ? sourceRuns : sourceRuns.filter((run) => runPhaseOf(run) === runPhase);
    for (const run of runs) {
      const row = el('div', null, 'run-row');
      row.dataset.status = run.status;
      row.dataset.runId = run.id;
      const head = el('div', null, 'run-head');
      head.append(
        el('b', runKindLabel(run.kind) + ' · ' + (statusNames[run.status] ?? run.status)),
        el('time', time(run.startedAt)),
      );
      if (traceAvailable) {
        const trace = el('button', 'Trace', 'quiet run-trace');
        trace.type = 'button';
        trace.title =
          'Everything this run’s agent received: instructions, tool calls and outputs, Jev requests.';
        trace.onclick = () => openAgentTrace(api, data.automation.id, run.id);
        head.append(trace);
      }
      row.append(head);
      if (
        run.kind === 'run' &&
        !run.recordId &&
        !run.recordOperation &&
        (run.sourceUrl || run.sources?.length)
      ) {
        const results = el('div', null, 'run-results'),
          sourceUrl = run.sourceUrl ?? (run.sources?.length === 1 ? run.sources[0] : null);
        if (sourceUrl) {
          const source = data.sources.find((item) => item.url === sourceUrl),
            name = el(
              'span',
              source?.name ?? new URL(sourceUrl).hostname.replace(/^www\./, ''),
              'run-source',
            );
          name.title = sourceUrl;
          results.append(name);
        }
        const count = el('span', `${run.foundCount ?? 0} new record(s) this round`, 'run-found');
        count.dataset.empty = String(!run.foundCount);
        count.title =
          'Results saved for the first time in this round. Records seen again and trial samples are not included.';
        results.append(count);
        row.append(results);
      }
      if (run.status !== 'running') {
        const usage = run.tokenUsage,
          known = Number.isSafeInteger(usage?.totalTokens) && usage.totalTokens >= 0;
        // Jev is billed per token; the cost is a list-price estimate, not the invoice.
        const jevCost = known ? (usage.jevTokens / 1e6) * JEV_USD_PER_MILLION_TOKENS : 0;
        const tokens = el(
          'span',
          known
            ? `${usage.totalTokens.toLocaleString('en-GB')} tokens in total · Jev ${usage.jevTokens.toLocaleString('en-GB')} (≈ $${jevCost.toFixed(jevCost > 0 && jevCost < 0.01 ? 4 : 2)})`
            : 'Token usage unknown',
          'run-tokens',
        );
        tokens.title = known
          ? `Agent: ${usage.agentTokens.toLocaleString('en-GB')} · Jev: ${usage.jevTokens.toLocaleString('en-GB')}. Jev cost estimated at $${JEV_USD_PER_MILLION_TOKENS} per million tokens; the TypeSafe account shows the billed amount.`
          : 'Total token usage for this round could not be recorded.';
        row.append(tokens);
      }
      row.append(
        el(
          'span',
          run.summary || {interview: 'Setup chat', trial: 'Trial', run: 'Run'}[run.kind],
          'run-summary',
        ),
      );
      root.append(row);
    }
    if (!runs.length) root.append(el('p', 'No runs yet.', 'run-history-empty'));
  }
  async function refresh() {
    if (isDeleting()) return;
    const id = selected,
      version = ++generation;
    const stale = () => isDeleting() || id !== selected || version !== generation;
    try {
      await catalog();
      if (stale()) return;
      if (!id) return loadList();
      const snapshot = await api.workspaceSnapshot(id);
      if (stale()) return;
      data = snapshot;
      // The Chrome card lives in the sidebar and stays visible on every page.
      renderChromeCard(busy || isDeleting());
      renderDetail();
    } catch (error) {
      if (!stale()) throw error;
    }
  }
  async function show() {
    host.hidden = false;
    questionBadge.hidden = true;
    document.querySelector('[data-view=board]').setAttribute('aria-label', 'Tracking table');
    resultsTable?.dispose();
    agentNavLabel(false);
    chatPanel?.dispose();
    chatPanel = null;
    agentConversation.replaceChildren();
    document.body.classList.remove('workspace-fresh');
    selected = null;
    data = null;
    dirty = false;
    renaming = null;
    formRevision = '';
    localStorage.removeItem('selected-workspace');
    navigate('start', {detail: true});
    await loadList();
  }
  api.onAutomationChange((event) => {
    if (!event.automationId) templates = [];
    if (!host.hidden && !selected) loadList().catch((e) => notice(e.message));
  });
  return {
    element: host,
    show,
    select,
    create: attempt(create),
    refresh,
    start,
    stop,
    restart,
    reconnectBrowser: async () => {
      await api.automationBrowser(selected);
      await refresh();
    },
    renderShell,
    deselect,
    showPane(name) {
      setPane(name);
    },
    sendMessage,
    get busy() {
      return busy;
    },
    get dirty() {
      return hasUnsaved();
    },
    get data() {
      return data;
    },
    hide() {
      host.hidden = true;
    },
    get selected() {
      return selected;
    },
  };
}
