import {questionForm} from './question-form.js';
import {automationAttention} from '../app/automation/attention.mjs';
import {groupWorkspaceTabs} from './workspace-tabs.js';
import {recordWaitsOnUser} from './record-operation-status.js';

const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export function attentionTabs(issue, tabs, sources) {
  const exact = tabs.find(
    (t) =>
      t.tabId === issue.tabId && (issue.kind === 'question' || !issue.url || t.url === issue.url),
  );
  if (exact) return [exact];
  const urlMatches = tabs.filter((t) => issue.url && t.url === issue.url);
  if (urlMatches.length) return urlMatches;
  if (!issue.sourceUrl) return [];
  return (
    groupWorkspaceTabs(
      tabs,
      sources.map((s) => ({id: s.url, url: s.url})),
    ).grouped.get(issue.sourceUrl) ?? []
  );
}

// Every record the table's "Needs you" filter shows appears on Answers (an open
// question) or here (a blocker the user must clear or an outcome to verify).
export function recordAttention(snapshot, issues) {
  const covered = new Set(
    issues.filter((i) => i.kind === 'repeated_tool_error').map((i) => i.recordId),
  );
  return (snapshot?.results ?? []).flatMap((record) => {
    const problem = !covered.has(record.id) && recordWaitsOnUser(record);
    return problem
      ? [
          {
            id: 'record-problem:' + record.id,
            kind: 'record_problem',
            recordId: record.id,
            name: record.title ?? 'Record',
            label: problem.label,
            message: problem.reason,
            next: problem.next,
            canDismissRecord: ['found', 'prepared', 'uncertain'].includes(record.status),
          },
        ]
      : [];
  });
}

export function automationAttentionPanel(
  api,
  {
    navigate,
    refresh,
    getConversation = () => null,
    showRecordQuestions = () => {},
    showRecord = () => navigate('board'),
    container,
  },
) {
  const banner = el('div', null, 'automation-attention-banner');
  banner.hidden = true;
  banner.dataset.webOnly = '';
  const bannerText = el('strong'),
    review = el('button', 'Show issues', 'quiet');
  review.type = 'button';
  banner.append(el('span', '!', 'attention-icon'), bannerText, review);
  // With its own page the sidebar badges carry the count, so no banner is shown.
  if (!container) document.querySelector('main>header').after(banner);
  const panel = el('section', null, 'automation-attention');
  panel.hidden = true;
  panel.dataset.webOnly = '';
  panel.setAttribute('aria-label', 'Sources that need attention');
  // The workspace UI gives the cards their own page; without one they sit above the agent's work.
  if (container) container.append(panel);
  else document.querySelector('#now-panel').before(panel);
  const announcement = el('p', null, 'attention-announcement');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  panel.append(announcement);
  const list = el('div', null, 'attention-list');
  panel.append(list);
  const scheduled = el('details', null, 'automation-retry-plans');
  scheduled.hidden = true;
  scheduled.dataset.webOnly = '';
  panel.after(scheduled);
  const chatAttention = document.querySelector('#setup-agent-attention');
  const isChatIssue = (issue) =>
    issue.conversation ||
    ['setup', 'conversation'].includes(issue.kind) ||
    issue.workerId === 'conversation' ||
    (issue.kind === 'usage_limit' &&
      snapshot?.runs?.some((run) => run.id === issue.runId && run.kind === 'interview'));
  const cards = new Map(),
    replyDrafts = new Map();
  let owner = null,
    snapshot = null,
    planSignature = '',
    conversationCount = 0;
  function questionTab(issue, workspace, feedback) {
    const open = el('button', 'Show tab ↗', 'primary'),
      choices = el('div', null, 'automation-help-tabs');
    open.type = 'button';
    choices.hidden = true;
    const focus = async (tab) => {
      open.disabled = true;
      feedback.textContent = '';
      try {
        await api.focusWorkspaceTab(workspace, tab.tabId);
        choices.hidden = true;
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        open.disabled = false;
      }
    };
    open.onclick = async () => {
      open.disabled = true;
      feedback.textContent = '';
      try {
        const tabs = attentionTabs(
          issue,
          await api.workspaceTabs(workspace),
          snapshot?.sources ?? [],
        );
        if (!tabs.length)
          throw Error(
            'The related open tab was not found. The tab may have been closed or the browser connection lost.',
          );
        if (tabs.length === 1) {
          await focus(tabs[0]);
          return;
        }
        choices.replaceChildren(el('p', 'Choose the related open tab:'));
        choices.hidden = false;
        for (const tab of tabs) {
          const pick = el('button', tab.url, 'quiet');
          pick.type = 'button';
          pick.onclick = () => focus(tab);
          choices.append(pick);
        }
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        open.disabled = false;
      }
    };
    return {open, choices};
  }
  review.onclick = () => {
    const issues = automationAttention(snapshot).filter((i) => !i.retryAt);
    if (issues.length && issues.every((i) => i.kind === 'question' && i.recordId)) {
      showRecordQuestions();
      return;
    }
    const chatIssue = issues.find(isChatIssue);
    navigate(chatIssue ? 'setup-agent' : container ? 'attention' : 'agent');
    if (chatIssue) {
      if (chatIssue.kind === 'question' && getConversation()?.showQuestion(chatIssue.id)) return;
      cards.get(chatIssue.id)?.card.scrollIntoView({block: 'start', behavior: 'smooth'});
      return;
    }
    if (!container) document.querySelector('#agent-tab-work')?.click();
    panel.scrollIntoView({block: 'start', behavior: 'smooth'});
    [...cards.values()]
      .find((item) => item.card.parentElement === list)
      ?.open.focus({preventScroll: true});
  };
  function create(issue) {
    if (issue.kind === 'question') return createQuestion(issue);
    if (['setup', 'conversation'].includes(issue.kind)) return createSetup(issue);
    if (issue.kind === 'usage_limit') return createLimit(issue);
    if (issue.kind === 'repeated_tool_error') return createToolFailure(issue);
    if (issue.kind === 'record_problem') return createRecordProblem(issue);
    const workspace = owner,
      card = el('article', null, 'automation-help-card');
    card.dataset.issueId = issue.id;
    card.dataset.kind = issue.kind ?? '';
    const technical = issue.kind === 'technical';
    // A shared site wait is a timer, not a request for the user: it gets its own look.
    const waiting = issue.kind === 'site_access' && !issue.accessExhausted;
    if (waiting) card.dataset.waiting = '';
    const clock = (at) =>
      at ? new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}) : null;
    const heading = el('div', null, 'automation-help-heading'),
      copy = el('div');
    copy.append(
      el(
        'span',
        technical
          ? 'Scan could not finish'
          : issue.kind === 'site_access'
            ? issue.captcha
              ? 'Captcha · waiting for you'
              : issue.accessExhausted
                ? 'Automatic retries stopped'
                : clock(issue.accessRetryAt)
                  ? `Waiting · continues automatically at ${clock(issue.accessRetryAt)}`
                  : 'Access check in progress'
            : 'Needs attention',
        'automation-help-label',
      ),
      el('h3', issue.name),
    );
    heading.append(el('span', waiting ? '⏱' : '!', 'attention-icon'), copy);
    // A captcha is solved by the user in Chrome: a large icon makes it recognisable at a glance.
    if (issue.captcha) {
      card.dataset.captcha = '';
      const badge = el('span', null, 'attention-captcha');
      badge.title = 'Captcha: solve it in Chrome';
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8.6 7.5 10 4.3-1.4 7.5-5.4 7.5-10v-6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg><span>Captcha</span>';
      heading.append(badge);
    }
    const summary = el(
      'p',
      issue.message.length > 300 ? issue.message.slice(0, 297) + '…' : issue.message,
      'automation-help-summary',
    );
    const instructions = el(
      'p',
      technical && issue.retry
        ? 'Saved results and the resume point are kept. You can retry the scan.'
        : issue.retry
          ? 'You can continue after clearing the block in the related tab.'
          : 'Check the related tab. If the outcome is unclear, tell the agent what happened; do not resend the action.',
      'automation-help-instructions',
    );
    if (issue.kind === 'site_access')
      instructions.textContent =
        issue.cleanupError ??
        (issue.captcha
          ? 'Solve the captcha in Chrome, then press “Resolved, continue”. The scan continues where it stopped. Other sources keep running.'
          : issue.accessExhausted
            ? 'Automatic retries stopped at the third access error. The resume point is kept. After clearing the block, restart with “Resolved, continue”. Other sources keep running.'
            : `The first error waits 5 minutes, the second 10. This scan will continue automatically where it stopped on ${new Date(issue.accessRetryAt).toLocaleString('en-GB', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}. It stops at the third error. Other sources keep running. If you close the card, ${issue.browserRequired === false ? '' : 'the tabs close now and '}the next attempt starts from scratch.`);
    const actions = el('div', null, 'automation-help-actions'),
      open = el('button', 'Show tab ↗', 'primary'),
      reply = el('button', 'Reply', 'quiet'),
      resume = issue.retry
        ? el('button', technical ? 'Continue scan' : 'Resolved, continue', 'quiet')
        : null;
    open.type = reply.type = 'button';
    actions.append(open, reply);
    // A captcha is solved in Chrome even when the scan itself reads without a tab.
    if (issue.browserRequired === false && !issue.captcha) {
      open.hidden = true;
      if (issue.kind !== 'site_access')
        instructions.textContent =
          'Saved results and pending addresses are kept. You can continue the scan where it stopped.';
    }
    if (resume) {
      resume.type = 'button';
      actions.append(resume);
    }
    const later =
      issue.retry && !issue.accessExhausted ? el('button', 'Try in 2 hours', 'quiet') : null;
    if (later) {
      later.type = 'button';
      later.disabled = Boolean(issue.closing);
      actions.append(later);
    }
    const close = el('button', 'Close', 'quiet');
    close.type = 'button';
    close.dataset.dismissAttention = issue.id;
    close.title = 'Close this notice';
    actions.append(close);
    if (issue.kind === 'site_access') {
      close.title =
        issue.browserRequired === false
          ? 'Start from scratch on the next attempt'
          : 'Close this source’s pending tabs; start from scratch on the next attempt';
      close.disabled = Boolean(issue.closing);
    }
    if (issue.closing && resume) {
      resume.disabled = true;
      resume.textContent = 'Session closing…';
    }
    const feedback = el('p', null, 'automation-help-feedback');
    feedback.hidden = true;
    feedback.setAttribute('role', 'status');
    const choices = el('div', null, 'automation-help-tabs');
    choices.hidden = true;
    const form = el('form', null, 'automation-help-reply'),
      label = el('label', 'Tell the agent what to do'),
      input = el('textarea'),
      send = el('button', 'Send', 'primary'),
      cancel = el('button', 'Cancel', 'quiet');
    input.required = true;
    input.maxLength = 10000;
    input.rows = 3;
    input.placeholder = 'For example: skip Indeed for now and continue with the other sources.';
    input.value = replyDrafts.get(issue.id) ?? '';
    form.hidden = !replyDrafts.has(issue.id);
    reply.setAttribute('aria-expanded', String(!form.hidden));
    label.append(input);
    send.type = 'submit';
    cancel.type = 'button';
    send.disabled = !input.value.trim() || Boolean(issue.closing);
    const replyActions = el('div', null, 'automation-help-actions');
    replyActions.append(send, cancel);
    form.append(
      label,
      el(
        'small',
        'Your reply is sent to the agent together with the description of this block. Other sources keep being tracked.',
        'automation-help-instructions',
      ),
      replyActions,
    );
    const toggleReply = (show) => {
      form.hidden = !show;
      reply.setAttribute('aria-expanded', String(show));
      if (show) {
        replyDrafts.set(issue.id, input.value);
        input.focus();
      } else {
        replyDrafts.delete(issue.id);
        input.value = '';
        send.disabled = true;
        reply.focus();
      }
    };
    reply.onclick = () => toggleReply(form.hidden);
    cancel.onclick = () => toggleReply(false);
    input.oninput = () => {
      replyDrafts.set(issue.id, input.value);
      send.disabled = !input.value.trim() || Boolean(issue.closing);
    };
    const run = async (action) => {
      if (card.dataset.busy === 'true') return;
      card.dataset.busy = 'true';
      open.disabled =
        reply.disabled =
        close.disabled =
        input.disabled =
        send.disabled =
        cancel.disabled =
          true;
      if (resume) resume.disabled = true;
      if (later) later.disabled = true;
      feedback.hidden = true;
      try {
        await action();
      } catch (error) {
        feedback.textContent = error.message;
        feedback.hidden = false;
      } finally {
        card.dataset.busy = 'false';
        open.disabled = reply.disabled = close.disabled = input.disabled = cancel.disabled = false;
        send.disabled = !input.value.trim() || Boolean(issue.closing);
        if (resume) resume.disabled = Boolean(issue.closing);
        if (later) later.disabled = Boolean(issue.closing);
      }
    };
    close.onclick = () =>
      run(async () => {
        await api.automationAttentionDismiss(workspace, issue.id, issue.dismissKey);
        if (owner !== workspace) return;
        replyDrafts.delete(issue.id);
        await refresh();
      });
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || issue.closing) return;
      void run(async () => {
        const context = [
          `Reply to attention request: ${issue.name}`,
          issue.sourceUrl && `Source: ${issue.sourceUrl}`,
          issue.url && `Tab: ${issue.url}`,
          `Agent’s description: ${issue.message}`,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1900);
        if (issue.kind === 'site_access')
          await api.automationSourceResume(workspace, issue.sourceUrl, issue.runId, text);
        else
          await api.terminalMessage(
            workspace,
            `${context}\n\nUser instruction:\n${text}`,
            issue.workerId ?? 'main',
          );
        if (owner !== workspace) return;
        toggleReply(false);
        feedback.textContent = 'Your reply was sent to the agent.';
        feedback.hidden = false;
        await refresh();
      });
    };
    const focus = (tab) =>
      run(async () => {
        await api.focusWorkspaceTab(workspace, tab.tabId);
        choices.hidden = true;
      });
    open.onclick = () =>
      run(async () => {
        const tabs = attentionTabs(
          issue,
          await api.workspaceTabs(workspace),
          snapshot?.sources ?? [],
        );
        if (!tabs.length && issue.captcha && issue.url) {
          await api.openWorkspaceUrl(workspace, issue.url);
          return;
        }
        if (!tabs.length)
          throw Error(
            'The related open tab was not found. The tab may have been closed or the browser connection lost. Check the Chrome connection.',
          );
        if (tabs.length === 1) {
          await api.focusWorkspaceTab(workspace, tabs[0].tabId);
          return;
        }
        choices.replaceChildren(el('p', 'Choose this source’s open tab:'));
        choices.hidden = false;
        for (const tab of tabs) {
          const button = el('button', tab.url, 'quiet');
          button.type = 'button';
          button.onclick = () => focus(tab);
          choices.append(button);
        }
      });
    if (resume)
      resume.onclick = () =>
        run(async () => {
          if (issue.kind === 'site_access')
            await api.automationSourceResume(workspace, issue.sourceUrl, issue.runId);
          else if (issue.retry === 'source')
            await api.automationSourceRun(workspace, issue.sourceUrl);
          else await api.automationRun(workspace, issue.retry);
          await refresh();
        });
    if (later)
      later.onclick = () =>
        run(async () => {
          await api.automationRetryLater(workspace, issue.id);
          await refresh();
        });
    card.append(heading, summary, instructions, actions, form, choices, feedback);
    if (issue.message.length > 300) {
      const details = el('details');
      details.append(el('summary', 'Agent’s full description'), el('p', issue.message));
      card.append(details);
    }
    list.append(card);
    return {card, open};
  }
  // Skips the card's record (as the table's Skip does) and closes the notice.
  function skipButton(issue, open, feedback) {
    const workspace = owner,
      skip = el('button', 'Skip', 'quiet');
    skip.type = 'button';
    skip.dataset.recordDismiss = issue.recordId;
    skip.title = 'Skip this record and close this notice';
    skip.onclick = async () => {
      open.disabled = skip.disabled = true;
      feedback.textContent = '';
      try {
        await api.automationDismiss(workspace, issue.recordId);
        if (owner === workspace) await refresh();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        open.disabled = skip.disabled = false;
      }
    };
    return skip;
  }
  function createToolFailure(issue) {
    const workspace = owner,
      card = el('article', null, 'automation-help-card');
    card.dataset.issueId = issue.id;
    const open = el('button', 'Show record', 'primary'),
      actions = el('div', null, 'automation-help-actions'),
      feedback = el('p');
    open.type = 'button';
    feedback.setAttribute('role', 'status');
    open.onclick = () => {
      navigate('board');
      document
        .querySelector(`[data-result-id="${CSS.escape(issue.recordId)}"]`)
        ?.scrollIntoView({block: 'center', behavior: 'smooth'});
    };
    actions.append(open);
    if (issue.canDismissRecord) actions.append(skipButton(issue, open, feedback));
    card.append(
      el('span', 'Repeated error · Task stopped', 'automation-help-label'),
      el('h3', issue.name),
      el('p', issue.message, 'automation-help-summary'),
      el(
        'p',
        issue.canDismissRecord
          ? 'Automatic retries stopped. After fixing the cause of the error, you can retry from the results table, or skip this record.'
          : 'Automatic retries stopped. After fixing the cause of the error, you can retry from the results table.',
        'automation-help-instructions',
      ),
      actions,
      feedback,
    );
    list.append(card);
    return {card, open};
  }
  // A record whose operation stopped or whose outcome is unclear: its actions live in the table.
  function createRecordProblem(issue) {
    const card = el('article', null, 'automation-help-card'),
      heading = el('div', null, 'automation-help-heading'),
      copy = el('div'),
      open = el('button', 'Show record', 'primary'),
      actions = el('div', null, 'automation-help-actions'),
      feedback = el('p');
    feedback.setAttribute('role', 'status');
    card.dataset.issueId = issue.id;
    card.dataset.kind = issue.kind;
    open.type = 'button';
    open.onclick = () => showRecord(issue.recordId);
    copy.append(el('span', issue.label, 'automation-help-label'), el('h3', issue.name));
    heading.append(el('span', '!', 'attention-icon'), copy);
    actions.append(open);
    if (issue.canDismissRecord) actions.append(skipButton(issue, open, feedback));
    card.append(
      heading,
      el('p', issue.message, 'automation-help-summary'),
      el(
        'p',
        issue.next ?? 'Open the record to retry, verify the outcome or skip it.',
        'automation-help-instructions',
      ),
      actions,
      feedback,
    );
    list.append(card);
    return {card, open};
  }
  function createSetup(issue) {
    const conversation = issue.kind === 'conversation',
      workspace = owner,
      card = el('article', null, 'automation-help-card'),
      open = el('button', conversation ? 'Continue chat' : 'Continue setup', 'primary'),
      feedback = el('p');
    card.dataset.issueId = issue.id;
    open.type = 'button';
    feedback.setAttribute('role', 'status');
    open.onclick = async () => {
      open.disabled = true;
      try {
        await api.automationSetup(workspace);
        if (owner === workspace) {
          await refresh();
          navigate('setup-agent');
        }
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        open.disabled = false;
      }
    };
    card.append(
      el('h3', conversation ? 'Chat was interrupted' : 'Setup was interrupted'),
      el('p', issue.message),
      el(
        'p',
        conversation
          ? 'Your messages are saved. You can retry the chat while other work continues.'
          : 'Your details and answers are saved. You can continue the same setup.',
      ),
      open,
      feedback,
    );
    list.append(card);
    return {card, open};
  }
  function createQuestion(issue) {
    const workspace = owner,
      card = el('article', null, 'automation-help-card');
    card.dataset.issueId = issue.id;
    const form = questionForm(
      workspace,
      {id: issue.id, question: issue.message, fields: issue.fields},
      async (value) => {
        await api.workspaceAnswer(workspace, issue.id, value);
        if (owner === workspace) await refresh();
      },
    );
    const attach = el('button', 'Add document', 'quiet'),
      feedback = el('p');
    attach.type = 'button';
    feedback.setAttribute('role', 'status');
    attach.onclick = async () => {
      attach.disabled = true;
      try {
        const added = await api.pickDocument(workspace);
        if (added) {
          feedback.textContent =
            'Document added. The agent will review it when you submit the form.';
          if (owner === workspace) await refresh();
        }
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        attach.disabled = false;
      }
    };
    const tab = issue.tabId || issue.url ? questionTab(issue, workspace, feedback) : null,
      actions = el('div', null, 'automation-help-actions');
    if (tab) actions.append(tab.open);
    actions.append(attach);
    if (issue.recordId && issue.canDismissRecord) {
      const dismiss = el(
        'button',
        snapshot.definition?.records?.dismissLabel ?? 'Dismiss record',
        'quiet',
      );
      dismiss.type = 'button';
      dismiss.dataset.dismissRecord = issue.recordId;
      dismiss.onclick = async () => {
        if (dismiss.disabled) return;
        const controls = [...card.querySelectorAll('button,input,textarea,select')],
          disabled = controls.map((control) => control.disabled);
        controls.forEach((control) => (control.disabled = true));
        feedback.textContent = '';
        try {
          await api.automationDismiss(workspace, issue.recordId);
          if (owner === workspace) await refresh();
        } catch (error) {
          feedback.textContent = error.message;
        } finally {
          controls.forEach((control, index) => (control.disabled = disabled[index]));
        }
      };
      actions.append(dismiss);
    }
    card.append(el('h3', issue.message), form, actions, ...(tab ? [tab.choices] : []), feedback);
    list.append(card);
    return {card, open: tab?.open ?? form.querySelector('textarea,input,select,button')};
  }
  function createLimit(issue) {
    const card = el('article', null, 'automation-help-card');
    card.dataset.issueId = issue.id;
    const heading = el('div', null, 'automation-help-heading'),
      copy = el('div');
    copy.append(el('span', 'Usage limit', 'automation-help-label'), el('h3', issue.name));
    heading.append(el('span', '!', 'attention-icon'), copy);
    const open = el('button', 'Show terminal', 'primary');
    open.type = 'button';
    open.onclick = () => {
      navigate(isChatIssue(issue) ? 'setup-agent' : 'agent');
      document
        .querySelector(isChatIssue(issue) ? '#setup-agent-tab-terminal' : '#agent-tab-work')
        ?.click();
      const pane = [...document.querySelectorAll('.worker-pane')].find(
        (node) => node.dataset.workerId === issue.workerId,
      );
      if (!pane) return;
      pane.querySelector('[role="tab"][data-view="terminal"]')?.click();
      pane.scrollIntoView({block: 'center', behavior: 'smooth'});
      pane.querySelector('.xterm-helper-textarea')?.focus({preventScroll: true});
    };
    const actions = el('div', null, 'automation-help-actions');
    actions.append(open);
    card.append(
      heading,
      el('p', issue.title, 'automation-help-summary'),
      el('p', issue.message, 'automation-help-summary'),
      el(
        'p',
        issue.sessionOpen
          ? 'The task and resume point are kept. Waiting in this session without opening a new agent.'
          : 'The session closed because of the provider limit. You can restart the task after the limit resets.',
        'automation-help-instructions',
      ),
      actions,
    );
    list.append(card);
    return {card, open};
  }
  return {
    review: () => review.click(),
    get conversationCount() {
      return conversationCount;
    },
    update(id, value) {
      if (owner !== id) {
        owner = id;
        planSignature = '';
        scheduled.open = false;
        for (const {card} of cards.values()) card.remove();
        cards.clear();
        replyDrafts.clear();
        list.replaceChildren();
      }
      snapshot = value;
      const all = id ? automationAttention(value) : [],
        issues = [
          ...all.filter((issue) => !issue.retryAt),
          ...(id ? recordAttention(value, all) : []),
        ],
        plans = all.filter((issue) => issue.retryAt),
        chat = getConversation();
      const panelIssues = issues.filter((i) => i.kind !== 'question' || !i.recordId);
      const inline = panelIssues.filter((i) => chat && i.kind === 'question' && i.conversation),
        chatIssues = panelIssues.filter(
          (i) => chatAttention && isChatIssue(i) && !inline.includes(i),
        ),
        outside = panelIssues.filter((i) => !inline.includes(i) && !chatIssues.includes(i));
      conversationCount = inline.length + chatIssues.length;
      if (chatAttention) chatAttention.hidden = !chatIssues.length;
      banner.hidden = !issues.length;
      panel.hidden = !outside.length;
      banner.toggleAttribute(
        'data-waiting',
        Boolean(
          issues.length && issues.every((i) => i.kind === 'site_access' && !i.accessExhausted),
        ),
      );
      const onlyRecordQuestions = issues.length && !panelIssues.length,
        onlyChatQuestions = issues.length && inline.length === issues.length;
      review.textContent = onlyRecordQuestions
        ? 'Show unanswered questions'
        : onlyChatQuestions
          ? 'Open form'
          : 'Show issues';
      bannerText.textContent = onlyChatQuestions
        ? `${inline.length} question(s) awaiting your answer`
        : issues.length && issues.every((i) => i.kind === 'usage_limit')
          ? `${issues.length} agent(s) waiting for the usage limit`
          : issues.length && issues.every((i) => i.kind === 'site_access' && !i.accessExhausted)
            ? `${issues.length} source(s) in an access wait · will continue automatically`
            : `${issues.length} item(s) need attention`;
      for (const [key, item] of cards)
        if (!panelIssues.some((i) => i.id === key)) {
          item.card.remove();
          cards.delete(key);
        }
      for (const issue of panelIssues) {
        const next = JSON.stringify(issue),
          old = cards.get(issue.id);
        if (old?.signature === next) continue;
        old?.card.remove();
        cards.set(issue.id, {...create(issue), signature: next});
      }
      chat?.setQuestions(inline.map((issue) => cards.get(issue.id).card));
      for (const issue of chatIssues) {
        const {card} = cards.get(issue.id);
        if (card.parentElement !== chatAttention) chatAttention.append(card);
      }
      for (const issue of outside) {
        const {card} = cards.get(issue.id);
        if (card.parentElement !== list) list.append(card);
      }
      announcement.textContent = outside.length
        ? 'Situations the agent is waiting on are shown below.'
        : '';
      scheduled.hidden = !plans.length;
      const nextPlans = JSON.stringify(plans);
      if (nextPlans !== planSignature) {
        planSignature = nextPlans;
        scheduled.replaceChildren(el('summary', `Scheduled retries (${plans.length})`));
        for (const issue of plans) {
          const workspace = id,
            row = el('div', null, 'automation-retry-plan'),
            cancel = el('button', 'Cancel postponement', 'quiet');
          cancel.type = 'button';
          const feedback = el('span');
          feedback.setAttribute('role', 'status');
          row.append(
            el(
              'span',
              `${issue.name} · ${new Date(issue.retryAt).toLocaleString('en-GB', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}`,
            ),
            cancel,
            feedback,
          );
          cancel.onclick = async () => {
            cancel.disabled = true;
            try {
              await api.automationRetryLater(workspace, issue.id, true);
              await refresh();
            } catch (error) {
              feedback.textContent = error.message;
            } finally {
              cancel.disabled = false;
            }
          };
          scheduled.append(row);
        }
      }
      return issues.length;
    },
  };
}
