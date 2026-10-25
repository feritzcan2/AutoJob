// The Contacts page as a messenger: threads on the left, grouped by listing,
// and the open conversation on the right. A person's thread shows what was
// sent to them and a composer with the agent's two drafted notes; a listing's
// "Contact search" thread shows the agent at work. Nothing is sent before the
// user presses Send.
const NOTE_CHARACTERS = 200,
  UPDATE_LIMIT = 12,
  UPDATE_CHARACTERS = 600,
  POLL_MS = 3000;
const relationLabels = {
  poster: 'Posted the listing',
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring manager',
  team: 'Team',
  hiring_team: 'Hiring team on the listing',
  suggested: 'Suggested on the listing',
};
const stateLabels = {
  proposed: 'Draft',
  listed: 'On the listing',
  queued: 'Sending…',
  invited: 'Invited',
  messaged: 'Messaged',
  uncertain: 'Check LinkedIn',
  failed: 'Not sent',
};
const sentLabels = {
  invited_with_note: 'Invitation with note',
  invited_without_note: 'Invitation without a note',
  messaged: 'Message',
};
const styleLabels = {
  direct: ['Direct', 'Strengths first, short'],
  personal: ['Personal', 'Warm, ends with a question'],
};
const resendable = new Set(['proposed', 'listed', 'invited', 'failed', 'uncertain']);
const FILTERS = [
  ['all', 'All'],
  ['review', 'To review'],
  ['working', 'In progress'],
  ['sent', 'Sent'],
];

const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, click, cls = 'quiet') => {
  const node = el('button', text, cls);
  node.type = 'button';
  node.onclick = click;
  return node;
};
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
// "14:05" today, "12 Oct" before.
const when = (at) => {
  if (!at) return '';
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
};
const count = (entry, ...states) => entry.contacts.filter((c) => states.includes(c.state)).length;
const avatar = (text, cls = '') => el('span', text, `contacts-avatar ${cls}`.trim());
// The contact agent's avatar: a magnifier.
const agentAvatar = (cls = '') => {
  const node = avatar(null, `agent ${cls}`);
  node.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  return node;
};

// Contact tasks at work, for the sidebar: "1 searching", "1 sending".
export function contactsWorking(data) {
  const entries = data?.automation.recordContacts ?? [];
  return {
    searching: entries.filter((e) => e.state === 'searching').length,
    sending: entries.filter((e) => e.contacts.some((c) => c.state === 'queued')).length,
  };
}
// Suggestions waiting for the user's approval, for the sidebar badge.
export const contactsToReview = (data) =>
  (data?.automation.recordContacts ?? []).reduce((n, e) => n + count(e, 'proposed'), 0);

// Which filter a listing falls under, most urgent first.
function listingGroup(entry) {
  if (entry.state === 'searching' || count(entry, 'queued')) return 'working';
  if (count(entry, 'proposed', 'uncertain', 'failed') || entry.state === 'failed') return 'review';
  if (count(entry, 'invited', 'messaged')) return 'sent';
  return 'other';
}
const isWorking = (entry) => listingGroup(entry) === 'working';
const searchKey = (recordId) => `search:${recordId}`;
const personKey = (recordId, contactId) => `person:${recordId}:${contactId}`;

export function contactsPage(root, api, {refresh}) {
  let data = null,
    selected = null,
    focusId = null,
    filter = 'all',
    polling = false,
    paneKey = null,
    listKey = null;
  // Unsaved notes and choices survive re-renders.
  const drafts = new Map(),
    styles = new Map(),
    searchNotes = new Map(),
    errors = new Map(),
    updates = new Map(),
    busy = new Set();
  const filters = el('div', null, 'record-filter-chips contacts-chat-filters'),
    threads = el('div', null, 'contacts-chat-threads'),
    side = el('div', null, 'contacts-chat-side'),
    pane = el('section', null, 'contacts-chat-pane'),
    shell = el('div', null, 'contacts-chat');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter listings');
  threads.setAttribute('role', 'navigation');
  threads.setAttribute('aria-label', 'Conversations');
  side.append(filters, threads);
  shell.append(side, pane);
  root.className = 'contacts-page';
  root.innerHTML =
    '<div class="section-title"><h2>Contacts</h2><span>LinkedIn people to write to about your listings · nothing is sent until you press Send</span></div>';
  root.append(shell);

  const entryAt = (entry) => Math.max(entry.requestedAt ?? 0, entry.searchedAt ?? 0);
  const listings = () =>
    (data?.automation.recordContacts ?? [])
      .map((entry) => ({entry, result: data.results.find((r) => r.id === entry.recordId)}))
      .filter(({result}) => result)
      .sort((x, y) => entryAt(y.entry) - entryAt(x.entry));
  const liveTask = (entry) =>
    (data?.tasks ?? []).find(
      (t) => t.id === entry.taskId && ['running', 'reported'].includes(t.state),
    );
  // A note that already went out is not offered again as a follow-up message.
  const draft = (contact) =>
    drafts.get(contact.id) ??
    (contact.state === 'invited' && contact.sentAs === 'invited_with_note' ? '' : contact.message);

  async function act(key, work) {
    if (busy.has(key)) return;
    busy.add(key);
    errors.delete(key);
    render();
    try {
      await work();
      await refresh();
    } catch (error) {
      errors.set(key, error.message);
    } finally {
      busy.delete(key);
      render();
    }
  }

  // Reads the transcripts of the running contact tasks while this page shows.
  async function poll() {
    if (polling || !data || root.hidden || !root.isConnected) return;
    polling = true;
    try {
      const workspace = data.automation.id;
      let changed = false;
      const live = new Set();
      for (const entry of data.automation.recordContacts ?? []) {
        const task = liveTask(entry);
        if (!task) continue;
        live.add(entry.recordId);
        const {messages = []} = await api.workerTranscript(workspace, task.workerId ?? 'main');
        if (data?.automation.id !== workspace) return;
        const since = (task.startedAt ?? 0) - 1000,
          lines = messages
            .filter((m) => m.role === 'agent' && (!m.at || Date.parse(m.at) >= since))
            .slice(-UPDATE_LIMIT)
            .map((m) => ({text: m.text.slice(0, UPDATE_CHARACTERS), at: m.at}));
        if (JSON.stringify(lines) !== JSON.stringify(updates.get(entry.recordId) ?? [])) {
          updates.set(entry.recordId, lines);
          changed = true;
        }
      }
      for (const recordId of updates.keys())
        if (!live.has(recordId)) {
          updates.delete(recordId);
          changed = true;
        }
      if (changed) render();
    } catch {
      // A transcript that cannot be read leaves the last updates in place.
    } finally {
      polling = false;
    }
  }
  setInterval(poll, POLL_MS);

  // ---- Thread list ----

  function searchPreview(entry) {
    const lines = updates.get(entry.recordId) ?? [];
    if (entry.state === 'searching') return lines.at(-1)?.text ?? 'Searching LinkedIn…';
    if (entry.state === 'failed') return `Stopped: ${entry.error || 'no reason given'}`;
    if (!entry.contacts.length) return entry.noneReason || 'No contact found';
    if (!entry.searchedAt) return `On the listing: ${entry.contacts.map((c) => c.name).join(', ')}`;
    return `Found ${entry.contacts.map((c) => c.name).join(', ')}`;
  }
  function personPreview(contact) {
    const last = contact.history?.at(-1);
    if (contact.state === 'queued') return `Sending: ${contact.message}`;
    if (contact.state === 'failed') return contact.error || 'Not sent';
    if (contact.state === 'uncertain') return 'Not confirmed; check LinkedIn';
    if (last) return `You: ${last.text || sentLabels[last.as]}`;
    return contact.message || contact.headline;
  }
  function threadRow(key, {icon, name, preview, at, tone, badge}) {
    const row = el('button', null, 'contacts-thread'),
      text = el('span', null, 'contacts-thread-text'),
      top = el('span', null, 'contacts-thread-top');
    row.type = 'button';
    row.dataset.thread = key;
    row.setAttribute('aria-current', String(key === selected));
    if (tone) row.dataset.tone = tone;
    top.append(el('b', name), el('time', when(at)));
    text.append(top, el('span', preview, 'contacts-thread-preview'));
    row.append(icon, text);
    if (badge) row.append(el('span', badge, 'contacts-thread-badge'));
    row.onclick = () => {
      selected = key;
      render();
    };
    return row;
  }
  function listingThreads(entry, result) {
    const group = el('section', null, 'contacts-listing'),
      head = el('div', null, 'contacts-listing-head'),
      title = el('div', null, 'contacts-listing-title');
    group.dataset.recordId = entry.recordId;
    title.append(
      el('b', result.title),
      el('small', [result.cells?.company, host(result.url)].filter(Boolean).join(' · ')),
    );
    // × removes the listing from this page; a running search or send keeps it.
    const working = isWorking(entry),
      remove = button(
        '×',
        () => {
          if (
            !confirm(
              `Remove the contacts of “${result.title}”? Invitations already sent stay on LinkedIn.`,
            )
          )
            return;
          act(searchKey(entry.recordId), async () => {
            await api.recordContactsRemove(data.automation.id, entry.recordId);
            if (selected?.includes(`:${entry.recordId}`)) selected = null;
          });
        },
        'quiet contacts-listing-remove',
      );
    remove.disabled = working;
    remove.title = working ? 'A contact task is running for this listing' : 'Remove from Contacts';
    remove.setAttribute('aria-label', `Remove ${result.title} from Contacts`);
    head.append(title, remove);
    group.append(head);
    const searching = entry.state === 'searching';
    group.append(
      threadRow(searchKey(entry.recordId), {
        icon: agentAvatar(),
        name: 'Contact search',
        preview: searchPreview(entry),
        at: entryAt(entry),
        tone: searching ? 'active' : entry.state === 'failed' ? 'blocked' : null,
        badge: searching ? 'Searching' : null,
      }),
    );
    for (const contact of entry.contacts)
      group.append(
        threadRow(personKey(entry.recordId, contact.id), {
          icon: avatar(initials(contact.name)),
          name: contact.name,
          preview: personPreview(contact),
          at: contact.history?.at(-1)?.at ?? contact.foundAt,
          tone:
            contact.state === 'proposed'
              ? 'waiting'
              : contact.state === 'listed'
                ? null
                : contact.state === 'queued'
                  ? 'active'
                  : ['uncertain', 'failed'].includes(contact.state)
                    ? 'blocked'
                    : 'done',
          badge:
            contact.state === 'proposed' ? 'Draft' : contact.state === 'queued' ? 'Sending' : null,
        }),
      );
    return group;
  }

  // ---- Conversation ----

  const system = (text, tone) => {
    const node = el('p', text, 'contacts-system');
    if (tone) node.dataset.tone = tone;
    return node;
  };
  function bubble(side, text, meta, tone) {
    const node = el('div', null, `contacts-bubble ${side}`);
    if (tone) node.dataset.tone = tone;
    node.append(el('p', text));
    if (meta) node.append(el('small', meta));
    return node;
  }
  function paneHead(icon, name, sub, actions) {
    const head = el('header', null, 'contacts-pane-head'),
      who = el('div', null, 'contacts-pane-who');
    who.append(name, el('small', sub));
    const tools = el('div', null, 'contacts-pane-tools');
    tools.append(...actions);
    head.append(icon, who, tools);
    return head;
  }
  const listingLink = (result) => {
    const link = button(`${result.title} ↗`, () => api.openLink(result.url), 'quiet contacts-pill');
    link.title = result.url;
    return link;
  };
  // A banner under the header while the agent works on this thread.
  const working = (text) => {
    const node = el('p', text, 'contacts-working');
    node.setAttribute('role', 'status');
    return node;
  };
  const errorLine = (key) => {
    if (!errors.has(key)) return null;
    const node = el('p', errors.get(key), 'contacts-error');
    node.setAttribute('role', 'alert');
    return node;
  };

  function personLog(contact) {
    const log = [
      system(
        `Suggested by the contact agent${when(contact.foundAt) ? ' · ' + when(contact.foundAt) : ''}`,
      ),
    ];
    if (contact.reason) {
      const why = el('div', null, 'contacts-why');
      why.append(el('b', 'Why this person'), el('span', contact.reason));
      log.push(why);
    }
    for (const sent of contact.history ?? [])
      log.push(
        sent.text
          ? bubble('out', sent.text, `${sentLabels[sent.as]} · ${when(sent.at)}`)
          : system(`${sentLabels[sent.as]} · ${when(sent.at)}`),
      );
    // Sent before the conversation kept a history: the note itself is all there is.
    if (!contact.history?.length && contact.sentAt)
      log.push(
        contact.sentAs === 'invited_without_note'
          ? system(`${sentLabels[contact.sentAs]} · ${when(contact.sentAt)}`)
          : bubble(
              'out',
              contact.message,
              `${sentLabels[contact.sentAs] ?? 'Sent'} · ${when(contact.sentAt)}`,
            ),
      );
    if (contact.state === 'invited' && contact.outcome === 'invited_without_note')
      log.push(
        system('LinkedIn took no note. Send it as a message once they accept the invitation.'),
      );
    if (contact.state === 'queued')
      log.push(
        bubble('out', contact.message, 'Sending… the agent is working on LinkedIn', 'pending'),
      );
    if (contact.state === 'uncertain')
      log.push(
        system(
          `The send may have gone out but was not confirmed${contact.evidence ? `: ${contact.evidence}` : ''}. Check LinkedIn before trying again.`,
          'blocked',
        ),
      );
    if (contact.state === 'failed')
      log.push(system(`Not sent: ${contact.error || 'no reason given'}`, 'blocked'));
    return log;
  }

  // The agent's two notes as suggested replies; a click loads one into the box.
  function suggestions(contact, note, sync) {
    const box = el('div', null, 'contacts-suggestions'),
      current = draft(contact),
      active =
        styles.get(contact.id) ?? contact.notes.find((o) => o.text === current)?.style ?? null;
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', `Suggested notes for ${contact.name}`);
    for (const option of contact.notes) {
      const [label, hint] = styleLabels[option.style] ?? [option.style, ''],
        tile = el('button', null, 'contacts-suggestion'),
        top = el('span', null, 'contacts-suggestion-top');
      tile.type = 'button';
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(option.style === active));
      top.append(el('b', label), el('small', hint));
      tile.append(top, el('span', option.text, 'contacts-suggestion-text'));
      tile.onclick = () => {
        styles.set(contact.id, option.style);
        drafts.set(contact.id, option.text);
        note.value = option.text;
        for (const other of box.children)
          other.setAttribute('aria-checked', String(other === tile));
        sync();
        note.focus();
      };
      box.append(tile);
    }
    return box;
  }

  function composer(workspace, entry, contact) {
    const key = personKey(entry.recordId, contact.id),
      form = el('form', null, 'contacts-composer'),
      note = el('textarea'),
      foot = el('div', null, 'contacts-composer-foot'),
      edited = el('small', 'Edited', 'contacts-edited'),
      counter = el('small', null, 'contacts-counter'),
      followUp = contact.state === 'invited',
      send = el(
        'button',
        busy.has(key)
          ? 'Sending…'
          : followUp
            ? 'Send message'
            : ['proposed', 'listed'].includes(contact.state)
              ? 'Send invitation'
              : 'Try again',
        'primary',
      );
    send.type = 'submit';
    note.maxLength = NOTE_CHARACTERS;
    note.rows = 3;
    note.value = draft(contact);
    note.placeholder = followUp
      ? 'A message for after they accept the invitation'
      : 'Your invitation note';
    note.setAttribute('aria-label', `Note to ${contact.name}`);
    const sync = () => {
      counter.textContent = `${note.value.length}/${NOTE_CHARACTERS}`;
      edited.hidden =
        !contact.notes?.length || !note.value || contact.notes.some((o) => o.text === note.value);
      send.disabled = busy.has(key) || !note.value.trim();
    };
    note.oninput = () => {
      drafts.set(contact.id, note.value);
      sync();
    };
    // Kept on leaving the box, so an edit survives without sending.
    note.onchange = () => {
      const text = note.value;
      if (text.trim() && text !== contact.message)
        api
          .recordContactEdit(workspace, entry.recordId, contact.id, text)
          .then(refresh)
          .catch((error) => {
            errors.set(key, error.message);
            render();
          });
    };
    note.onkeydown = (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = note.value;
      act(key, async () => {
        await api.recordContactsSend(workspace, entry.recordId, [contact.id], {
          [contact.id]: text,
        });
        drafts.delete(contact.id);
        styles.delete(contact.id);
      });
    };
    const hint = el(
      'small',
      followUp ? 'Sent only if they accepted · ⌘↵' : 'Goes out on LinkedIn · ⌘↵',
      'contacts-composer-hint',
    );
    foot.append(edited, counter, hint, send);
    if (contact.notes?.length > 1) form.append(suggestions(contact, note, sync));
    form.append(note, foot);
    sync();
    return form;
  }

  function personPane(entry, result, contact) {
    const workspace = data.automation.id,
      key = personKey(entry.recordId, contact.id),
      locked = isWorking(entry),
      name = button(
        `${contact.name} ↗`,
        () => api.openLink(contact.profileUrl),
        'quiet contacts-pane-name',
      ),
      state = el('span', stateLabels[contact.state] ?? contact.state, 'contacts-pill');
    name.title = contact.profileUrl;
    state.dataset.state = contact.state;
    const actions = [listingLink(result), state];
    if (resendable.has(contact.state) && !locked)
      actions.push(
        button(
          'Remove',
          () => act(key, () => api.recordContactRemove(workspace, entry.recordId, contact.id)),
          'quiet contacts-pane-remove',
        ),
      );
    const log = el('div', null, 'contacts-log');
    log.append(...personLog(contact));
    const parts = [
      paneHead(
        avatar(initials(contact.name), 'large'),
        name,
        [relationLabels[contact.relation], contact.headline].filter(Boolean).join(' · '),
        actions,
      ),
    ];
    if (contact.state === 'queued')
      parts.push(working(`The agent is sending this to ${contact.name} on LinkedIn…`));
    else if (locked)
      parts.push(
        working(
          entry.state === 'searching'
            ? 'The contact search for this listing is running; you can send when it ends.'
            : 'Another send for this listing is running; you can send when it ends.',
        ),
      );
    parts.push(log);
    if (resendable.has(contact.state) && !locked) parts.push(composer(workspace, entry, contact));
    const error = errorLine(key);
    if (error) parts.push(error);
    return parts;
  }

  function searchPane(entry, result) {
    const workspace = data.automation.id,
      key = searchKey(entry.recordId),
      searching = entry.state === 'searching',
      log = el('div', null, 'contacts-log');
    if (entry.requestedAt) log.append(system(`Search started · ${when(entry.requestedAt)}`));
    for (const line of updates.get(entry.recordId) ?? [])
      log.append(bubble('in', line.text, when(line.at)));
    if (searching) {
      const typing = el('div', null, 'contacts-bubble in contacts-typing');
      typing.setAttribute('aria-label', 'The agent is working');
      typing.append(el('span'), el('span'), el('span'));
      log.append(typing);
    } else if (entry.state === 'failed')
      log.append(system(`The search stopped: ${entry.error || 'no reason given'}`, 'blocked'));
    else if (!entry.searchedAt && entry.contacts.length)
      log.append(
        system(
          `The listing shows ${entry.contacts.length === 1 ? 'one person' : `${entry.contacts.length} people`}: ${entry.contacts.map((c) => c.name).join(', ')}. Open a name to write your own note, or find contacts to get drafted notes.`,
        ),
      );
    else if (entry.searchedAt)
      log.append(
        bubble(
          'in',
          entry.contacts.length
            ? `I found ${entry.contacts.length === 1 ? 'one person' : `${entry.contacts.length} people`}: ${entry.contacts.map((c) => c.name).join(', ')}. Open a name on the left to review the notes.`
            : `No suitable contact: ${entry.noneReason || 'no reason given'}`,
          when(entry.searchedAt),
        ),
      );
    const form = el('form', null, 'contacts-composer search'),
      notes = el('input'),
      start = el(
        'button',
        busy.has(key) ? 'Starting…' : entry.searchedAt ? 'Find again' : 'Find contacts',
        'primary',
      );
    notes.placeholder = 'Notes for the search (optional), e.g. "the data team lead"';
    notes.maxLength = 1000;
    notes.value = searchNotes.get(entry.recordId) ?? '';
    notes.oninput = () => searchNotes.set(entry.recordId, notes.value);
    start.type = 'submit';
    notes.disabled = start.disabled = isWorking(entry) || busy.has(key);
    form.onsubmit = (event) => {
      event.preventDefault();
      act(key, async () => {
        await api.recordContactsFind(
          workspace,
          entry.recordId,
          searchNotes.get(entry.recordId) ?? '',
        );
        searchNotes.delete(entry.recordId);
      });
    };
    form.append(notes, start);
    const parts = [
      paneHead(
        agentAvatar('large'),
        el('b', 'Contact search', 'contacts-pane-name'),
        [result.cells?.company, host(result.url)].filter(Boolean).join(' · '),
        [listingLink(result)],
      ),
    ];
    if (searching) parts.push(working('The agent is searching LinkedIn for people to contact…'));
    else if (isWorking(entry))
      parts.push(working('The agent is sending on LinkedIn; you can search again when it ends.'));
    parts.push(log, form);
    const error = errorLine(key);
    if (error) parts.push(error);
    return parts;
  }

  // ---- Page ----

  function renderFilters(counts) {
    filters.replaceChildren(
      ...FILTERS.map(([key, label]) => {
        const chip = button(`${label} ${counts[key] ?? 0}`, () => {
          filter = key;
          render();
        });
        chip.setAttribute('aria-pressed', String(filter === key));
        if (key === 'working' && counts.working) chip.dataset.tone = 'active';
        return chip;
      }),
    );
  }
  // The thread to open when none is chosen: a draft to review, else the newest listing.
  function firstThread(shown) {
    for (const {entry} of shown) {
      const draft = entry.contacts.find((c) => c.state === 'proposed');
      if (draft) return personKey(entry.recordId, draft.id);
    }
    return shown[0] ? searchKey(shown[0].entry.recordId) : null;
  }
  function threadOf(shown, key) {
    for (const {entry, result} of shown) {
      if (key === searchKey(entry.recordId)) return {entry, result, contact: null};
      const contact = entry.contacts.find((c) => key === personKey(entry.recordId, c.id));
      if (contact) return {entry, result, contact};
    }
    return null;
  }

  function render() {
    if (!data) return;
    const all = listings(),
      counts = {all: all.length};
    for (const {entry} of all) {
      const group = listingGroup(entry);
      counts[group] = (counts[group] ?? 0) + 1;
    }
    renderFilters(counts);
    const shown = all.filter(({entry}) => filter === 'all' || listingGroup(entry) === filter);
    if (focusId) {
      const entry = shown.find((x) => x.entry.recordId === focusId)?.entry;
      if (entry) {
        const draft = entry.contacts.find((c) => c.state === 'proposed');
        selected =
          entry.state !== 'searching' && draft ? personKey(focusId, draft.id) : searchKey(focusId);
        focusId = null;
      }
    }
    if (!threadOf(shown, selected)) selected = firstThread(shown);
    // The list is rebuilt only when it changes, so a click never lands on a replaced row.
    const nextListKey = JSON.stringify([
      selected,
      busy.size,
      shown.map(({entry, result}) => [
        entry,
        result.title,
        result.url,
        result.cells?.company,
        updates.get(entry.recordId)?.at(-1) ?? null,
      ]),
    ]);
    if (nextListKey !== listKey) {
      listKey = nextListKey;
      const scroll = threads.scrollTop;
      threads.replaceChildren(...shown.map(({entry, result}) => listingThreads(entry, result)));
      threads.scrollTop = scroll;
      threads.querySelector('[aria-current="true"]')?.scrollIntoView({block: 'nearest'});
    }
    const open = threadOf(shown, selected),
      key = JSON.stringify([
        selected,
        open?.entry,
        open?.result.title,
        open?.result.url,
        updates.get(open?.entry.recordId) ?? null,
        errors.get(selected) ?? null,
        busy.has(selected),
      ]);
    if (key === paneKey) return;
    paneKey = key;
    if (!open) {
      const empty = el('div', null, 'contacts-chat-empty');
      empty.append(
        el('b', all.length ? 'No listing matches this filter' : 'No contacts yet'),
        el(
          'p',
          all.length
            ? 'Choose another filter on the left.'
            : 'Choose Find contacts on a listing in the Tracking table. The agent looks for up to two people on LinkedIn and drafts two notes for each.',
        ),
      );
      pane.replaceChildren(empty);
      return;
    }
    pane.replaceChildren(
      ...(open.contact
        ? personPane(open.entry, open.result, open.contact)
        : searchPane(open.entry, open.result)),
    );
    const log = pane.querySelector('.contacts-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  return {
    update(next) {
      if (next?.automation.id !== data?.automation.id) {
        selected = null;
        paneKey = listKey = null;
        updates.clear();
      }
      data = next;
      if (!data) {
        threads.replaceChildren();
        pane.replaceChildren();
        paneKey = listKey = null;
        return;
      }
      render();
      void poll();
    },
    // From a listing's "Find contacts": open its thread, whatever the filter.
    focus(recordId) {
      focusId = recordId;
      filter = 'all';
      if (data) render();
    },
  };
}
