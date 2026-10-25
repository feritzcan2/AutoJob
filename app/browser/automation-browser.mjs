import {askJev} from '../jev/policy.mjs';
// Adapt the existing Jev engine to the scoped automation browser tools.
// Run ownership and step limits stay in automationWorkflow; the agent assesses authority.
export function automationBrowser(
  browser,
  {
    readTabKey,
    sourceUrl,
    sourceUrls = [],
    recordId,
    resumeContext,
    resumeSource = false,
    isolatedResearch = false,
    traceJev = null,
  } = {},
) {
  let tabId = recordId || resumeSource ? (resumeContext?.tabId ?? null) : null,
    activeSource = sourceUrl,
    restoreRecord = Boolean(recordId);
  const sourceFor = (url) => {
    if (sourceUrl) return sourceUrl;
    const parsed = new URL(url),
      host = parsed.hostname.replace(/^www\./, '');
    const candidates = sourceUrls.filter(
      (value) => new URL(value).hostname.replace(/^www\./, '') === host,
    );
    return (
      candidates.find((value) => value === url) ??
      (activeSource && candidates.includes(activeSource) ? activeSource : candidates[0]) ??
      parsed.origin
    );
  };
  const value = (response) => {
    if (response?.isError)
      throw Error(
        response.content
          ?.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n') || 'Jev step could not be completed',
      );
    for (const part of response?.content ?? []) {
      if (part.type !== 'text') continue;
      try {
        return JSON.parse(part.text);
      } catch {}
    }
    throw Error('Could not read the Jev page response');
  };
  const ready = async (id) => {
    const state = browser.prepare(id);
    if (state.ready) return;
    await browser.connections.pending.get(id);
    const current = browser.status(id);
    if (!current.ready)
      throw Error(
        current.message || 'Open the Chrome connection for Jev and allow the connection request.',
      );
  };
  const native = async (id, name, args, session, options) => {
    await ready(id);
    const response = await browser.call(id, name, args, session, {
        ...options,
        automationWorkspaceId: id,
        ...(readTabKey
          ? {automationTabKey: activeSource ? `source:${activeSource}` : readTabKey}
          : {}),
        ...(activeSource
          ? {
              automationSourceUrl: activeSource,
              automationSourceUrls: [...new Set([...sourceUrls, activeSource])],
            }
          : {}),
      }),
      page = value(response);
    if (page.status === 'browser_wait')
      throw Error(
        'Jev is waiting for the Chrome connection. Reconnect with the Open browser button.',
      );
    return {response, page};
  };
  const observed = ({response, page}) => ({
    jevPage: page,
    pageContext: {url: page.url, tabId: page.tabId},
    siteWait: page.siteWait,
    readiness: page.reading?.readiness,
    content: [
      {type: 'text', text: (page.url ? `Page URL: ${page.url}\n` : '') + JSON.stringify(page)},
      ...(response.content ?? []).filter((p) => p.type !== 'text'),
    ],
    action: {
      status: page.status,
      executed: page.executed,
      verified: page.verified,
      message: page.message,
      ...(page.openedTab ? {openedTab: page.openedTab} : {}),
      // An autocomplete result names the offered options and what was chosen.
      ...(page.suggestions ? {suggestions: page.suggestions} : {}),
      ...(page.selection ? {selection: page.selection} : {}),
      // The file name the employer receives for an upload.
      ...(page.uploadedFileName ? {uploadedFileName: page.uploadedFileName} : {}),
    },
  });
  const document = async (id, result, session) => {
    // Preserve the original transport error (and the owned tab) instead of
    // masking it with a second observation of Chrome's error document.
    if (result.page.navigationError) throw Error(result.page.navigationError);
    return result.page.siteWait
      ? observed(result)
      : observed(
          await native(
            id,
            'browser_observe',
            {tabId: result.page.tabId, scope: 'document', full: true, fullReason: 'context_loss'},
            session,
          ),
        );
  };
  return {
    hasPage: () => Boolean(tabId),
    waitForOperations: (id) => browser.waitForOperations(id),
    async evaluateJev(id, state, questions, signal) {
      const ask = async () => {
        // Classification of extension/API evidence needs model configuration only.
        const config = browser.options?.(id)?.config;
        if (config) return askJev(state, questions, {...(await config()), signal});
        await ready(id);
        const {client} = await browser.connect(id);
        return askJev(state, questions, {...(await client.config()), signal});
      };
      if (!traceJev) return ask();
      const started = Date.now();
      try {
        const result = await ask();
        traceJev({
          state,
          questions,
          answers: result.answers,
          usage: result.usage,
          ms: Date.now() - started,
        });
        return result;
      } catch (error) {
        traceJev({
          state,
          questions,
          error: String(error?.message ?? error),
          ms: Date.now() - started,
        });
        throw error;
      }
    },
    async currentUrl(id) {
      await ready(id);
      if (!tabId) throw Error('Open a page first');
      // Reading the URL must not invalidate Jev's one-use pending decision.
      return (await browser.connect(id)).client.tab(tabId).page.url();
    },
    async call(id, name, args, session, options) {
      if (name === 'browser_reopen_readonly') {
        if (!sourceUrl || !readTabKey)
          throw Error('A new control tab can only be opened during a source scan.');
        const result = await native(id, 'browser_open_page', {url: args.url}, session, {
          automationFreshTab: true,
        });
        tabId = result.page.tabId ?? tabId;
        return document(id, result, session);
      }
      if (name === 'browser_tabs') {
        const {page} = await native(id, name, {}, session, options);
        return {tabs: page.tabs ?? [], currentTabId: tabId};
      }
      if (name === 'browser_use_tab') {
        const result = await native(
          id,
          'browser_observe',
          {tabId: args.tabId, scope: 'document', full: true, fullReason: 'context_loss'},
          session,
          options,
        );
        tabId = result.page.tabId;
        restoreRecord = false;
        return observed(result);
      }
      if (name === 'browser_close_tab') {
        const {page} = await native(id, name, {tabId: args.tabId}, session, options);
        if (page.closed && tabId === args.tabId) tabId = null;
        return {...page, currentTabId: tabId};
      }
      if (name === 'browser_navigate') {
        if (readTabKey) {
          if (!recordId && !isolatedResearch) {
            const nextSource = sourceFor(args.url);
            if (nextSource !== activeSource) tabId = null;
            activeSource = nextSource;
          }
          const result = await native(id, 'browser_open_page', {url: args.url}, session, {
            automationPreferredTabId: tabId,
            automationResumeRecord: restoreRecord,
          });
          if (result.page.siteWait) {
            tabId = result.page.tabId ?? tabId;
            return observed(result);
          }
          tabId = result.page.tabId;
          restoreRecord = false;
          if (!tabId) throw Error('Could not open the Jev tab');
          return document(id, result, session);
        }
        const {page: tabs} = await native(id, 'browser_tabs', {}, session),
          existing = tabs.tabs?.find((t) => t.url === args.url);
        const result = await native(
          id,
          existing ? 'browser_observe' : 'browser_open_page',
          existing
            ? {tabId: existing.tabId, full: true, fullReason: 'context_loss'}
            : {url: args.url},
          session,
        );
        tabId = result.page.tabId;
        restoreRecord = false;
        if (!tabId) throw Error('Could not open the Jev tab');
        return document(id, result, session);
      }
      if (!tabId)
        throw Error(
          'First open a page for this turn with browser_open or research_automation_source',
        );
      if (
        [
          'browser_fill_fields',
          'browser_click_target',
          'browser_list_options',
          'browser_choose_option',
        ].includes(name)
      )
        return observed(await native(id, name, {...args, tabId}, session, options));
      if (name === 'browser_inspect_form')
        return (await native(id, name, {tabId}, session, options)).page;
      // A listing from the pane of the results page open in this source's tab.
      if (name === 'browser_read_pane')
        return (await native(id, name, {tabId, url: args.url}, session, options)).page;
      // A viewport image of the current tab; no page action, no Jev call.
      if (name === 'browser_screenshot') {
        const {response, page} = await native(
          id,
          'browser_page_screenshot',
          {tabId, format: 'jpeg'},
          session,
          options,
        );
        return {
          pageContext: {url: page.url, tabId: page.tabId},
          content: (response.content ?? []).filter((p) => p.type === 'image'),
        };
      }
      let tool,
        parameters = {tabId};
      if (name === 'browser_snapshot') {
        tool = 'browser_observe';
        Object.assign(parameters, {scope: 'document', full: true, fullReason: 'context_loss'});
      } else if (name === 'browser_click') {
        tool = 'browser_click_target';
        parameters.targetId = args.target;
      } else if (name === 'browser_type') {
        tool = 'browser_fill_fields';
        parameters.fields = [{fieldId: args.target, text: args.text}];
      } else if (name === 'browser_select_option') {
        tool = 'browser_choose_option';
        Object.assign(parameters, {controlId: args.target, option: args.values[0]});
      } else if (name === 'browser_upload_document') {
        tool = 'browser_upload';
        Object.assign(parameters, {uploadId: args.ref, filePath: args.filePath});
      } else if (name === 'browser_options') {
        tool = 'browser_list_options';
        parameters.controlId = args.ref;
      } else if (name === 'browser_scroll') {
        tool = name;
        Object.assign(parameters, {controlId: args.controlId, direction: args.direction});
      } else if (name === 'browser_reveal') {
        tool = name;
        parameters.controlId = args.controlId;
      } else if (name === 'browser_target_press') {
        tool = name;
        Object.assign(parameters, {ref: args.ref, key: args.key});
      } else if (['browser_list_suggestions', 'browser_autocomplete'].includes(name)) {
        tool = name;
        parameters.controlId = args.controlId;
        if (args.text !== undefined) parameters.text = args.text;
        if (args.option !== undefined) parameters.option = args.option;
      } else throw Error('Unsupported browser operation: ' + name);
      const result = await native(id, tool, parameters, session, options);
      tabId = result.page.tabId ?? tabId;
      restoreRecord = false;
      return observed(result);
    },
  };
}
