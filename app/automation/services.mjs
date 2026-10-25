import {batchScoring, taskHasRecord} from '../records/task-scope.mjs';
import {judgeTab, closableRecordIds} from '../browser/tab-audit.mjs';
import {tabLogFile} from '../browser/tab-log.mjs';
import {deleteRecords} from '../records/deletion.mjs';
import {listingDescription, readListingDescription} from '../records/description.mjs';
import {workspaceDirectory} from '../workspaces/paths.mjs';
import {withAgentDefaults} from '../agents/settings.mjs';
import path from 'node:path';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {WebTasks} from './web-template.mjs';
import {webUrl} from '../templates/catalog.mjs';
import {launchAutomationWorker} from './worker.mjs';
import {automationBrowser} from '../browser/automation-browser.mjs';
import {webWorkspaceView} from '../workspaces/view.mjs';
import {isConversation} from '../workspaces/conversation.mjs';
import {setupAgentSettings} from '../agents/setup-agent.mjs';
import {listDocuments} from './artifacts.mjs';
import {withUploadNames} from '../workspaces/document-names.mjs';
import {runSnapshot} from '../browser/automation-snapshot.mjs';
import {jevProvider} from '../jev/policy.mjs';
import {saveJevProfile, jevProfileView} from '../jev/qualification-profile.mjs';
import {loadScoringDocuments} from '../scoring/profile.mjs';
import {runSiteLane} from '../browser/site-access.mjs';
import {
  approveCoverLetter,
  reviseCoverLetter,
  setCoverLetterAutoApprove,
} from './cover-letters.mjs';
import {renderCoverLetterPdf} from './cover-letter-pdf.mjs';
import {
  findRecordContacts,
  editRecordContact,
  removeRecordContact,
  removeRecordContacts,
  sendRecordContacts,
} from './contacts.mjs';

export function registerAutomationServices({
  root,
  data,
  handle,
  emit,
  validateSettings,
  dialog,
  shell,
  window,
  db,
  browsers,
  agents,
  mcp,
  launch = launchAutomationWorker,
  trace = null,
}) {
  const outputs = new Map();
  browsers.siteAccess = db.siteAccess;
  browsers.workspaceFor = (id) => workspaceDirectory(data, db.store.workspaces.get(id));
  db.siteAccess.changed = () => {
    for (const a of db.list()) emit('automation-changed', {automationId: a.id});
  };
  jevProvider.changed = () => {
    for (const a of db.list()) emit('automation-changed', {automationId: a.id});
  };
  const changed = (id) => emit('automation-changed', {automationId: id});
  const runtime = new WebTasks(db, {
    changed,
    probeSource: (id, task) => browsers.probeAutomationSource(id, task),
    onRunFinished: (id, run, options) => browsers.finishAutomationRun(id, run, options),
    browserReady: (id) => {
      if (browsers.status(id).ready) return true;
      const a = db.get(id);
      if (
        a.status === 'enabled' ||
        db.store.workspaces.tasks.list(id, {states: ['pending']}).some((t) => t.request?.manual)
      )
        browsers.prepare(id);
      return browsers.status(id).ready;
    },
    launch: (run, automation, onEvent, signal) => {
      // Cover letter writers and contact tasks read in their own tab; the
      // application's form tab stays as the applicant left it.
      const coverLetter = run.recordOperation === 'cover_letter',
        contacts = run.recordOperation === 'contacts',
        ownTab = coverLetter || contacts;
      if (run.sourceUrl && run.taskId && !run.recordOperation)
        void browsers.closeSourceCheck(automation.id, run).catch(() => {});
      return launch({
        data,
        db,
        run,
        automation,
        onEvent,
        signal,
        agents,
        mcp,
        browser: automationBrowser(
          browsers.forWorker(
            run.workerId ?? 'main',
            () => !signal.aborted && db.run(run.id).status === 'running',
            {
              signal,
              siteLane: runSiteLane(run),
            },
          ),
          {
            isolatedResearch: isConversation(run) || batchScoring(run) || ownTab,
            resumeContext:
              batchScoring(run) || ownTab
                ? undefined
                : (run.continuation?.browserContext ?? run.resumeContext),
            resumeSource: ['site_access_response', 'site_access_retry'].includes(
              run.continuation?.reason,
            ),
            recordId:
              run.recordOperation && !batchScoring(run) && !ownTab ? run.recordId : undefined,
            sourceUrl: run.recordOperation ? undefined : run.sourceUrl,
            sourceUrls: automation.sources,
            // Development builds keep every Jev request of the run in the agent trace.
            ...(trace
              ? {
                  traceJev: (entry) =>
                    trace.jev(automation.id, run.id, {...entry, workerId: run.workerId}),
                }
              : {}),
            readTabKey: batchScoring(run)
              ? `score-batch:${run.taskId}`
              : coverLetter
                ? `cover-letter:${run.recordId}`
                : contacts
                  ? `contacts:${run.recordId}`
                  : run.recordOperation
                    ? `record:${run.recordId}`
                    : run.sourceUrl && !run.recordId
                      ? `source:${run.sourceUrl}`
                      : run.kind !== 'run'
                        ? `read:${run.sourceUrl ?? run.workerId ?? 'main'}`
                        : undefined,
          },
        ),
        report: (id, runId, status, summary, goalReached) =>
          runtime.report(id, runId, status, summary, goalReached),
        changed,
        onOutput: (bytes) => {
          outputs.set(
            run.id,
            Buffer.concat([outputs.get(run.id) ?? Buffer.alloc(0), Buffer.from(bytes)]).subarray(
              -150000,
            ),
          );
          while (outputs.size > 30) outputs.delete(outputs.keys().next().value);
          emit('automation-output', {automationId: run.automationId, runId: run.id, bytes});
        },
      });
    },
  });
  const workspace = (id) => {
    db.get(id);
    return workspaceDirectory(data, db.store.workspaces.get(id));
  };
  const conversationTranscript = (id) => {
    const cwd = workspace(id),
      row = db.db
        .prepare(
          "SELECT json_extract(data,'$.conversation') AS conversation FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.kind')='interview' AND json_extract(data,'$.conversation.nativeId') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(id);
    const identity = row ? JSON.parse(row.conversation) : null;
    return agents.transcript(
      id,
      'conversation',
      identity ? {provider: identity.provider, nativeId: identity.nativeId, cwd} : undefined,
    );
  };
  handle('automation-templates', () => db.catalog());
  const attempt = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  // What the tab close rules read about a workspace's runs, records and questions.
  const tabLookup = (id) => {
    const unanswered = (attempt(() => db.get(id))?.questions ?? []).filter((q) => q.answer == null),
      open =
        attempt(() =>
          db.store.workspaces.tasks.list(id, {
            states: ['pending', 'running', 'reported', 'paused'],
          }),
        ) ?? [];
    return {
      run: (runId) => attempt(() => db.run(runId)),
      record: (recordId) => attempt(() => db.result(id, recordId)),
      waiting: (runId, tabId) =>
        unanswered.some(
          (q) =>
            (q.runId ?? q.browserContext?.runId) === runId || q.browserContext?.tabId === tabId,
        ),
      openTask: (run) =>
        open.some(
          (task) => task.id === run.taskId || (run.recordId && taskHasRecord(task, run.recordId)),
        ),
      newerFinishedSourceRun: (run) =>
        attempt(() =>
          db.db
            .prepare(
              "SELECT id, json_extract(data,'$.status') AS status FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.recordId') IS NULL AND json_extract(data,'$.status')='completed' AND (json_extract(data,'$.kind')='trial' OR json_extract(data,'$.scan.complete')) AND rowid > (SELECT rowid FROM automation_runs WHERE id=?) LIMIT 1",
            )
            .get(id, run.sourceUrl, run.id),
        ),
    };
  };
  // Tabs of records whose work ended for good (skipped, marked applied,
  // deleted) also close when the close at that moment could not run: Chrome
  // was not connected, or the app restarted with those tabs restored. Tabs of
  // a stopped application nothing picked up again close after a few hours.
  const closeEndedRecordTabs = async (id) => {
    const [workspace] = await browsers.tabAudit(id);
    const recordIds = workspace?.connected ? closableRecordIds(workspace.tabs, tabLookup(id)) : [];
    if (recordIds.length)
      await browsers.finishAutomationRun(
        id,
        {id: null, workerId: 'main'},
        {closeTabs: true, keepForms: false, closeAll: true, runIds: [], recordIds},
      );
  };
  browsers.onConnected = closeEndedRecordTabs;
  // Diagnostics: every open Jev tab with the verdict of the close rules.
  handle('browser-tab-audit', async () => {
    const workspaces = await browsers.tabAudit();
    for (const workspace of workspaces) {
      const lookup = tabLookup(workspace.workspaceId);
      for (const tab of workspace.tabs) {
        const run = tab.runId ? lookup.run(tab.runId) : null;
        Object.assign(tab, judgeTab(tab, lookup), {
          ...(run
            ? {
                runKind: run.recordOperation ?? run.kind,
                runStatus: run.status,
                runFinishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
              }
            : {}),
        });
      }
    }
    return {log: tabLogFile(), workspaces};
  });
  const snapshot = async (id) => {
    const activeRuns = runtime.slots(id).map((s) => runSnapshot(s.run));
    return webWorkspaceView(
      {
        ...db.snapshot(id),
        setupAgent: {settings: setupAgentSettings(db, id)},
        activeRun: activeRuns[0] ?? null,
        activeRuns,
        documents: withUploadNames(
          await listDocuments(workspace(id)),
          db.store.workspaces.documentNames.all(id),
        ),
        browserStatus: browsers.status(id),
        jevIssue: jevProvider.issue,
        jevProfile: jevProfileView(
          db.get(id),
          await loadScoringDocuments(db, id).catch(() => null),
          db.template(db.get(id).templateId).fields,
        ),
      },
      agents,
    );
  };
  const save = async (id, input) => {
    if (input.agentSettings) {
      input = {...input, agentSettings: withAgentDefaults(input.agentSettings)};
      await validateSettings(input.agentSettings);
    }
    const before = db.get(id),
      browserChanged =
        input.chromeProfile !== undefined &&
        JSON.stringify(input.chromeProfile) !== JSON.stringify(before.chromeProfile);
    if (browserChanged) await runtime.pause(id);
    else if (!(Object.keys(input).length === 1 && input.agentSettings))
      db.assertIdle(id, {allowWaitingConversation: true});
    const a = db.save(id, input);
    if (browserChanged) await browsers.resetCandidate(id);
    changed(id);
    return a;
  };
  handle('automation-save', save);
  handle('automation-profile-save', (id, input, options) =>
    runtime.saveProfile(id, input, options),
  );
  handle('automation-save-score-threshold', (id, value, options) => {
    const a = db.setSaveScoreThreshold(id, value, options);
    changed(id);
    return a;
  });
  handle('automation-jev-profile-save', async (id, text) => {
    const result = saveJevProfile(
      db,
      id,
      text,
      'user',
      await loadScoringDocuments(db, id),
      db.template(db.get(id).templateId).fields,
    );
    changed(id);
    return result;
  });
  handle('workspace-answer', (id, question, value) => {
    if ((db.get(id).questions ?? []).some((q) => q.id === question && q.coverLetter))
      throw Error('Review this cover letter on the Files page');
    return runtime.answer(id, question, value);
  });
  handle('cover-letter-approve', (id, question, text) =>
    approveCoverLetter(runtime, id, question, {
      text,
      workspace: workspace(id),
      renderPdf: renderCoverLetterPdf,
    }),
  );
  handle('cover-letter-revise', (id, question, feedback) =>
    reviseCoverLetter(runtime, id, question, feedback),
  );
  handle('cover-letter-auto-approve', (id, value) => {
    const a = setCoverLetterAutoApprove(db, id, value);
    changed(id);
    return a.coverLetterAutoApprove;
  });
  handle('automation-setup', (id) => runtime.setup(id));
  handle('automation-onboarding', (id, input) => runtime.onboard(id, input));
  handle('setup-agent-settings', async (id, input) => {
    const settings = {...withAgentDefaults(input), contextRestartTokens: 0};
    await validateSettings(settings);
    return runtime.configureConversation(id, settings);
  });
  handle('setup-agent-restart', (id) => runtime.configureConversation(id, null, {restart: true}));
  handle('automation-source-save', (id, url, input) => runtime.saveSource(id, url, input));
  handle('automation-sources-interval', (id, intervalMinutes) =>
    runtime.saveSourcesInterval(id, intervalMinutes),
  );
  handle('automation-source-run', (id, url, options) =>
    runtime.runSource(id, url, {fresh: options?.fresh === true, force: options?.force === true}),
  );
  handle('automation-source-relearn', (id, url) => runtime.relearnSource(id, url));
  handle('automation-source-resume', (id, url, runId, response) =>
    runtime.sourceAccess.resume(id, url, runId, response),
  );
  handle('automation-source-stop', (id, url) => runtime.stopSource(id, url));
  handle('automation-retry-later', (id, key, cancel) =>
    runtime.retryLater(id, key, cancel === true),
  );
  handle('automation-attention-dismiss', (id, key, dismissKey) =>
    runtime.dismissAttention(id, key, dismissKey),
  );
  handle('automation-source-add', async (id, input) => {
    db.addSource(id, input);
    changed(id);
    await runtime.tick();
    return db.sources(id).find((source) => source.url === webUrl(input.url));
  });
  handle('automation-source-remove', async (id, url) => {
    db.removeSource(id, url);
    changed(id);
    await runtime.tick();
  });
  handle('automation-source-draft', async (id, draftId, accept) => {
    if (typeof accept !== 'boolean') throw Error('Invalid source action');
    db.resolveSourceDraft(id, draftId, accept);
    changed(id);
    await runtime.tick();
  });
  handle('automation-review', (id) => {
    const a = db.review(id);
    changed(id);
    return a;
  });
  handle('automation-skip-trial', (id) => {
    if (runtime.slots(id).length) throw Error('Stop the running automation first');
    const a = db.skipTrial(id);
    changed(id);
    return a;
  });
  handle('automation-message', (id, text) => runtime.message(id, text));
  handle('automation-run', async (id, kind) => {
    if (!['trial', 'run'].includes(kind)) throw Error('Invalid run');
    return runtime.runOnce(id);
  });
  handle('automation-records-score', (id, itemIds) => runtime.runRecords(id, itemIds));
  handle('automation-records-delete', (id, itemIds) => {
    const result = deleteRecords(db, id, itemIds);
    changed(id);
    void closeEndedRecordTabs(id).catch(() => {});
    return result;
  });
  handle('automation-record-run', (id, itemId, kind, input) =>
    runtime.runRecord(id, itemId, kind, input),
  );
  handle('automation-record-description', (id, itemId) => listingDescription(db, id, itemId));
  handle('record-contacts-find', (id, itemId, notes) =>
    findRecordContacts(runtime, id, itemId, {notes}),
  );
  handle('record-contacts-send', (id, itemId, contactIds, messages) =>
    sendRecordContacts(runtime, id, itemId, contactIds, messages),
  );
  handle('record-contact-edit', (id, itemId, contactId, message) => {
    const entry = editRecordContact(db, id, itemId, contactId, {message});
    changed(id);
    return entry;
  });
  handle('record-contacts-remove', (id, itemId) => {
    removeRecordContacts(db, id, itemId);
    changed(id);
  });
  handle('record-contact-remove', (id, itemId, contactId) => {
    const entry = removeRecordContact(db, id, itemId, contactId);
    changed(id);
    return entry;
  });
  handle('automation-record-description-read', (id, itemId) =>
    readListingDescription(db, id, itemId),
  );
  handle('automation-approve', (id, itemId) => {
    const item = db.approve(id, itemId);
    changed(id);
    return item;
  });
  handle('automation-dismiss', (id, itemId) => runtime.dismissRecord(id, itemId));
  handle('automation-restore', (id, itemId) => runtime.restoreRecord(id, itemId));
  handle('automation-mark-submitted', (id, itemId) => runtime.markRecordSubmitted(id, itemId));
  handle('automation-star', (id, itemId, starred) => {
    const item = db.star(id, itemId, starred);
    changed(id);
    return item;
  });
  const remove = async (id) => {
    const files = workspace(id);
    await runtime.pause(id);
    await browsers.resetCandidate(id, {closeTabs: true});
    const runs = db.db.prepare('SELECT id FROM automation_runs WHERE automation_id=?').all(id);
    db.remove(id);
    for (const run of runs) {
      outputs.delete(run.id);
      await rm(path.join(data, 'automations', 'runs', run.id), {recursive: true, force: true});
    }
    await rm(files, {recursive: true, force: true});
    for (const directory of ['workspaces', 'browsers', 'candidates'])
      await rm(path.join(data, 'automations', directory, id), {recursive: true, force: true});
    changed(id);
  };
  handle('automation-browser', async (id) => {
    db.get(id);
    browsers.prepare(id, {force: true});
    await browsers.connections.pending.get(id);
    const status = browsers.status(id);
    changed(id);
    if (!status.ready || runtime.slots(id).length > 0) return status;
    db.assertIdle(id);
    const a = db.get(id);
    if (!a.sources.length) throw Error('Save at least one source address first');
    return automationBrowser(browsers).call(id, 'browser_navigate', {url: a.sources[0]}, 'user');
  });
  handle('automation-terminal', async (id, runId) => {
    if (db.run(runId).automationId !== id)
      throw Error('The run does not belong to this automation');
    return [
      ...(outputs.get(runId) ??
        (await readFile(path.join(data, 'automations', 'runs', runId, 'terminal.log')).catch(() =>
          Buffer.alloc(0),
        ))),
    ];
  });
  handle('automation-export-results', async (id) => {
    const a = db.get(id),
      result = await dialog.showSaveDialog(window(), {
        defaultPath: a.title.replace(/[^\p{L}\p{N} _-]/gu, '') + '.json',
        filters: [{name: 'Results', extensions: ['json']}],
      });
    if (result.canceled) return;
    await writeFile(
      result.filePath,
      JSON.stringify(
        {
          title: a.title,
          templateId: a.templateId,
          table: a.table,
          exportedAt: new Date().toISOString(),
          results: db.results(id),
        },
        null,
        2,
      ) + '\n',
      {mode: 0o600},
    );
    return result.filePath;
  });
  return {
    db,
    runtime,
    browsers,
    outputs,
    save,
    snapshot,
    remove,
    workspace,
    conversationTranscript,
    closeEndedRecordTabs,
    async close() {
      await runtime.close();
    },
    clearOutputs() {
      outputs.clear();
    },
  };
}
