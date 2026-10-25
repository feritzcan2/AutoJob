import {workerPreviews} from './agents/worker-preview.mjs';
import {registerWorkspaceSupport} from './workspaces/support-services.mjs';
import {workspaceBrowserDirectory} from './workspaces/paths.mjs';
import {AgentProfiles} from './agents/profiles.mjs';
import {WEB_AGENTS, WEB_AGENT_ROLES} from './agents/automation-profiles.mjs';
import {InstructionLog} from './system/instruction-log.mjs';
import {webInstructionCatalog, instructionSnapshot} from './system/instruction-catalog.mjs';
import {app, BrowserWindow, Menu, ipcMain, dialog, shell, safeStorage} from 'electron';
import {mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Maintenance} from './system/maintenance.mjs';
import {startDevControl} from './system/dev-control.mjs';
import {configureTabLog} from './browser/tab-log.mjs';
import {registerExtensionBench} from './sources/extension-bench.mjs';
import {AgentTrace} from './system/agent-trace.mjs';
import {registerDevTools} from './system/dev-tools.mjs';
import {registerAutomationServices} from './automation/services.mjs';
import {AutomationStore} from './automation/store.mjs';
import {createScanFailureReporter} from './system/scan-failure-report.mjs';
import {createApplicationFailureReporter} from './system/application-failure-report.mjs';
import {diagnosticsSetting, sentryTransport} from './system/diagnostics.mjs';
import {startUsageReporting} from './system/usage-report.mjs';
import {registerSettingsServices} from './system/settings-services.mjs';
import {openedInBackground, startBackgroundMode} from './system/background.mjs';
import {JevSettings} from './jev/settings.mjs';
import {
  installedExtensionDirectory,
  prepareExtensionFolder,
  registerExternalExtension,
} from './jev/extension-folder.mjs';
import {EXTENSION_ID, WEB_STORE_URL} from './jev/extension.mjs';
import {openChromeUrl} from './jev/chrome.mjs';
import {
  applyPendingRestore,
  prepareDataUpgrade,
  completeDataUpgrade,
} from './system/data-management.mjs';
import {
  currentDataDirectory,
  resolveDataDirectory,
  cancelDataLocation,
} from './system/data-location.mjs';
import {AgentSessions} from './agents/sessions.mjs';
import {WorkspaceScheduler} from './workspaces/scheduler.mjs';
import {Workspaces} from './workspaces/workspaces.mjs';
import {WorkspaceDocuments} from './workspaces/documents.mjs';
import {WorkspaceDatabase} from './workspaces/database.mjs';
import {TemplateRegistry} from './templates/registry.mjs';
import {loadExtensions} from './templates/extensions.mjs';
import {startToolServer} from './agents/tool-server.mjs';
import {workerKey} from './automation/worker-key.mjs';
import {BrowserTools} from './browser/tools.mjs';
import {listChromeProfiles} from './browser/chrome-profiles.mjs';
import {browserDefinition} from './templates/browser-definition.mjs';
import {resolveLaunchEnvironment} from './agents/launch-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function boot() {
  // The internal name keeps the JobLoop data folder and keychain entry; users see AutoJob.
  app.setName('JobLoop');
  if (process.env.JOBLOOP_DATA_DIR) app.setPath('userData', process.env.JOBLOOP_DATA_DIR);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  if (process.platform !== 'win32') process.env.PATH = (await resolveLaunchEnvironment()).PATH;
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({applicationName: 'AutoJob'});
    if (!app.isPackaged) app.dock.setIcon(path.join(root, 'build/icon.png'));
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'AutoJob',
          submenu: [
            {role: 'about', label: 'About AutoJob'},
            {type: 'separator'},
            {role: 'services'},
            {type: 'separator'},
            {role: 'hide', label: 'Hide AutoJob'},
            {role: 'hideOthers'},
            {role: 'unhide'},
            {type: 'separator'},
            {role: 'quit', label: 'Quit AutoJob'},
          ],
        },
        {role: 'editMenu'},
        {role: 'viewMenu'},
        {role: 'windowMenu'},
      ]),
    );
  }
  const bootstrapDirectory = app.getPath('userData');
  await mkdir(bootstrapDirectory, {recursive: true, mode: 0o700});
  // The bootstrap folder never moves with the data folder, so the path the
  // user loaded into Chrome stays valid. A failed copy keeps the bundled one.
  await prepareExtensionFolder({target: path.join(bootstrapDirectory, 'chrome-extension')}).catch(
    (error) => console.error('Could not prepare the AutoJob extension folder', error),
  );
  if (WEB_STORE_URL)
    await registerExternalExtension({extensionId: EXTENSION_ID}).catch((error) =>
      console.error('Could not offer the AutoJob extension to Chrome', error),
    );
  let data = await currentDataDirectory(bootstrapDirectory);
  try {
    data = await resolveDataDirectory({bootstrapDirectory});
  } catch (error) {
    await cancelDataLocation(bootstrapDirectory);
    dialog.showErrorBox(
      'Could not change the data folder',
      `${error.message}\n\nContinuing with the previous data location: ${data}`,
    );
  }
  await mkdir(data, {recursive: true, mode: 0o700});
  await rm(path.join(data, 'mobile.json'), {force: true});
  await applyPendingRestore({dataDirectory: data});
  await prepareDataUpgrade({dataDirectory: data, appVersion: app.getVersion()});
  const extensions = await loadExtensions(),
    registry = new TemplateRegistry(extensions.map((extension) => extension.definition));
  const core = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite'), {registry});
  configureTabLog(path.join(data, 'logs', 'tabs.jsonl'));
  const encryptSecret = (value) => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw Error('Unlock the system keychain for secure storage.');
    return safeStorage.encryptString(value).toString('base64');
  };
  const decryptSecret = (value) => safeStorage.decryptString(Buffer.from(value, 'base64'));
  const jevSettings = new JevSettings(core.db, {encrypt: encryptSecret, decrypt: decryptSecret});
  // Site accounts and CapSolver were removed; drop their saved keys.
  core.db.exec('DROP TABLE IF EXISTS site_credentials');
  core.db.exec('DROP TABLE IF EXISTS captcha_settings; DROP TABLE IF EXISTS captcha_usage');
  let window,
    quitting = false;
  const emit = (channel, value) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, value);
  };
  const changed = (id) => {
    emit('changed', {candidateId: id});
    emit('automation-changed', {automationId: id});
  };
  const instructionLog = new InstructionLog(core.workspaces, {
    changed: (id) => emit('instructions-changed', {workspaceId: id}),
  });
  // Unpackaged builds only: everything each agent session received, in RAM.
  const trace = app.isPackaged
    ? null
    : new AgentTrace({changed: (id) => emit('agent-trace-changed', {workspaceId: id})});
  const sessionInstructions = trace
    ? Object.assign(Object.create(instructionLog), {
        record(event) {
          try {
            trace.session(event);
          } catch {}
          return instructionLog.record(event);
        },
      })
    : instructionLog;
  const agents = new AgentSessions({
      root,
      data,
      instructions: sessionInstructions,
      emit: (event) => emit('agent-event', event),
      changed,
    }),
    changing = new Set(),
    services = [];
  const ensureEngine = () => agents.ensure('catalog');
  // Jev makes the listing decisions only with a saved TypeSafe key.
  const validateSettings = async (settings) => {
    if (settings.decisions === 'jev' && !(await jevSettings.status()).configured)
      throw Error(
        'Save the TypeSafe API key under Configuration → Jev before choosing Jev for listing decisions.',
      );
    return ensureEngine().request('validate', settings);
  };
  const profiles = new AgentProfiles(core.workspaces, {
    validate: (library) => ensureEngine().request('validate-profile', {library}),
    changed: (id) => emit('instructions-changed', {workspaceId: id}),
  });
  profiles.register(WEB_AGENTS);
  agents.profiles = profiles;
  const workspaces = new Workspaces(core.workspaces, {
    templates: {},
    changing,
    changed,
    validateSettings,
    workerRemoved: (id, worker) => agents.clear(id, worker),
  });
  const documents = new WorkspaceDocuments(workspaces, {dialog, shell, window: () => window});
  const browser = new BrowserTools(data, (id, worker) =>
    workspaces.template(id).browserOptions(id, worker),
  );
  browser.directoryFor = (id) => workspaces.template(id).browserDirectory(id);
  browser.onStatus = (id, state) => {
    workspaces.template(id).onBrowserStatus?.(id, state);
    changed(id);
  };
  browser.onTabsClosed = (id, ids) => {
    workspaces.template(id).onTabsClosed?.(id, ids);
    changed(id);
  };
  const mcp = await startToolServer({
    onExchange: (grant, event) => {
      try {
        trace?.tool(grant, event);
      } catch {}
      return instructionLog.tool(
        {
          ...grant,
          agentProfileId: agents.sessions.get(workerKey(grant.workspaceId, grant.workerId))
            ?.agentProfile?.id,
        },
        event,
      );
    },
    assertOwner: (id) => core.workspaces.get(id),
    resolve(grant) {
      if (
        agents.sessions.get(workerKey(grant.workspaceId, grant.workerId))?.sessionId !==
        grant.sessionId
      )
        throw Error('The worker session closed.');
      return grant.workflow ?? workspaces.template(grant.workspaceId).protocol(grant);
    },
    onHook: (hook) => {
      const active = [...agents.sessions.values()].find(
        (a) => a.sessionId === hook.observation?.sessionId,
      );
      if (!active) throw Error('No agent');
      return agents.engines
        .get(workerKey(active.candidateId, active.workerId))
        .request('hook', {token: hook.token, observation: hook.observation});
    },
  });
  const scheduler = new WorkspaceScheduler({
    available: () => !maintenance.busy,
    onError: (error) => emit('agent-event', {event: 'error', error: error.message}),
  });
  const maintenance = new Maintenance({
    assertIdle() {
      if (agents.sessions.size || agents.starting.size || browser.operations.size || changing.size)
        throw Error('Stop the running agent and browser operations first.');
      for (const service of services) service.assertIdle?.();
    },
    stop: async () => {
      for (const service of services) await service.stop?.();
    },
    resume: async () => {
      if (!quitting) for (const service of services) await service.resume?.();
    },
  });
  const handlers = new Map();
  function handle(name, fn) {
    handlers.set(name, fn);
    ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw Error('Untrusted sender');
      return maintenance.invoke(name, () => fn(...args));
    });
  }
  const automationDb = new AutomationStore(core);
  // Anonymous diagnostics: failed scan reports, sessions and daily usage counts.
  const diagnostics = diagnosticsSetting(path.join(data, 'scan-reports.json'), {
      off: Boolean(process.env.CI) || process.env.JOBLOOP_DIAGNOSTICS === 'off',
    }),
    release = app.getVersion(),
    environment = app.isPackaged ? 'production' : 'development';
  const usage = startUsageReporting({
    db: core.db,
    setting: diagnostics,
    send: sentryTransport({release}),
    release,
    environment,
    system: {os: process.platform, arch: process.arch, os_version: os.release()},
  });
  const reportScan = createScanFailureReporter({
    release,
    environment,
    enabled: diagnostics.enabled,
    installId: diagnostics.installId,
  });
  automationDb.scanFailed = (run) => {
    usage.failure();
    return reportScan(run);
  };
  automationDb.applicationFailed = createApplicationFailureReporter({
    release,
    environment,
    enabled: diagnostics.enabled,
    installId: diagnostics.installId,
  });
  handle('scan-reports-status', () => diagnostics.status());
  handle('scan-reports-set', (value) => diagnostics.set(value === true));
  const web = registerAutomationServices({
    root,
    data,
    db: automationDb,
    browsers: browser,
    mcp,
    agents,
    handle,
    emit,
    validateSettings,
    dialog,
    shell,
    window: () => window,
    trace,
  });
  // Unpackaged builds only: agent trace and trial scores.
  registerDevTools({handle, trace, db: automationDb, runtime: web.runtime});
  // Unpackaged builds only: the Sources screen's extension test bench.
  registerExtensionBench({
    enabled: !app.isPackaged,
    handle,
    browser,
    db: automationDb,
    changed: (id) => emit('automation-changed', {automationId: id}),
  });
  workspaces.templates[browserDefinition.id] = {
    agentRoles: () => WEB_AGENT_ROLES,
    instructions: (id, role) => webInstructionCatalog(automationDb, id, role),
    create: (templateId, input) => automationDb.create(templateId, input),
    directory: web.workspace,
    documentPurposes: ['attachment'],
    beforeDocument: (id) => automationDb.assertIdle(id, {allowConversation: true}),
    documentAdded: (id, document) =>
      automationDb.message(
        id,
        'system',
        `The user added a document: ${document.relative} (${document.name}). Use it only within this automation.`,
        {document: document.relative, documentName: document.name},
      ),
    rename: (id, name) => automationDb.rename(id, name),
    remove: web.remove,
    browserDirectory: (id) => workspaceBrowserDirectory(data, core.workspaces.get(id)),
    browserOptions: (id) => ({
      config: () => jevSettings.config(),
      profile: core.workspaces.get(id).chromeProfile,
      lifecycle: {multiWorker: true},
      documentName: (relative) => documents.displayName(id, relative),
    }),
    workers: {
      add: (id, input) => web.runtime.add(id, input),
      start: (id, worker, state) => web.runtime.startWorker(id, worker, state),
      restartState: (id, worker) => web.runtime.restartState(id, worker),
      stop: (id, worker) => web.runtime.stopWorker(id, worker),
      remove: (id, worker) => web.runtime.remove(id, worker),
    },
    message: (id, text, worker) => web.runtime.message(id, text, worker),
    snapshot: (id) => web.snapshot(id),
    start: async (id) => {
      automationDb.enable(id);
      await web.runtime.tick();
    },
    stop: (id) => web.runtime.pause(id),
    restart: (id) => web.runtime.restart(id),
    settings: (id, input) => web.save(id, input),
  };
  services.push({
    ...web,
    assertIdle() {
      if (web.runtime.active.size) throw Error('Stop the running automations first.');
    },
    stop: () => {
      web.runtime.closed = true;
    },
    resume: () => {
      web.runtime.closed = false;
    },
    activeRunIds: () => [...web.runtime.active.values()].map((slot) => slot.run.id),
  });
  const support = await registerWorkspaceSupport({
    data,
    db: automationDb,
    runtime: web.runtime,
    handle,
    emit,
    encryptSecret,
    decryptSecret,
  });
  services.push(support);
  const removeWorkspace = workspaces.templates.browser.remove;
  workspaces.templates.browser.remove = async (id) => {
    await support.remove(id);
    return removeWorkspace(id);
  };
  for (const extension of extensions) {
    const service = await extension.register({
      root,
      data,
      core,
      handle,
      emit,
      agents,
      profiles,
      browser,
      mcp,
      scheduler,
      maintenance,
      documents,
      dialog,
      shell,
      getWindow: () => window,
      encryptSecret,
      decryptSecret,
      jevSettings,
      restartingAgents: changing,
      isQuitting: () => quitting,
    });
    workspaces.templates[extension.definition.id] = service.driver;
    services.push(service);
  }
  handle('instruction-snapshot', (id, options) =>
    instructionSnapshot({id, options, log: instructionLog, agents, workspaces, profiles}),
  );
  handle('agent-profile-save', async (id, role, input) => {
    if (!workspaces.template(id).agentRoles?.(id).includes(role))
      throw Error('No agent found in this workspace');
    return profiles.update(id, role, input);
  });
  handle('instruction-event', (id, seq) => instructionLog.detail(id, seq));
  handle('workspace-create', (templateId, input) => workspaces.create(templateId, input));
  handle('workspaces', () => workspaces.list());
  handle('workspace-snapshot', (id) => workspaces.snapshot(id));
  handle('workspace-tabs', (id) => {
    core.workspaces.get(id);
    return browser.workspaceTabs(id);
  });
  handle('browser-reconnect', (id) => {
    core.workspaces.get(id);
    return browser.prepare(id, {force: true});
  });
  handle('extension-setup', async (kind, profile) => {
    if (kind === 'folder') return shell.showItemInFolder(installedExtensionDirectory());
    if (kind === 'store' && WEB_STORE_URL) {
      if (profile && !/^[\w -]{1,100}$/.test(profile)) throw Error('Invalid Chrome profile.');
      return openChromeUrl(WEB_STORE_URL, profile ? {directory: profile} : undefined);
    }
    throw Error('Unknown extension setup step');
  });
  handle('focus-workspace-tab', (id, tabId) => {
    core.workspaces.get(id);
    return browser.focusWorkspaceTab(id, tabId);
  });
  // A verification the user solves by hand, when no related tab is still open:
  // the page opens in the workspace's own Chrome profile.
  handle('open-workspace-url', (id, url) => {
    core.workspaces.get(id);
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) throw Error('Invalid link');
    return openChromeUrl(u.toString(), browser.options(id).profile);
  });
  handle('close-workspace-tabs', (id, tabs) => {
    core.workspaces.get(id);
    return browser.closeWorkspaceTabs(id, tabs);
  });
  handle('workspace-start', (id, options) => workspaces.start(id, options));
  handle('workspace-stop', (id) => workspaces.stop(id));
  handle('workspace-restart', (id, options) => workspaces.restart(id, options));
  handle('workspace-settings', (id, input) => workspaces.settings(id, input));
  handle('workspace-transition', (id, itemId, action) => {
    const result = core.workspaces.transition(id, itemId, action);
    changed(id);
    return result;
  });
  handle('rename-workspace', (id, name) => workspaces.rename(id, name));
  handle('delete-workspace', (id) => workspaces.remove(id));
  handle('documents', (id) => documents.list(id));
  handle('pick-document', (id, options) => documents.pick(id, options));
  handle('rename-document', (id, file, name) => documents.rename(id, file, name));
  handle('read-document', (id, file) => documents.read(id, file));
  handle('open-document', (id, file) => documents.open(id, file));
  handle('worker-add', (id, input) => workspaces.addWorker(id, input));
  handle('worker-start', (id, worker) => workspaces.startWorker(id, worker));
  handle('worker-stop', (id, worker) => workspaces.stopWorker(id, worker));
  handle('worker-restart', (id, worker) => workspaces.restartWorker(id, worker));
  handle('worker-remove', (id, worker) => workspaces.removeWorker(id, worker));
  handle('terminal-output', (id, worker = 'main') => {
    workspaces.validateWorker(id, worker, {mutable: false});
    return agents.snapshot(id, worker);
  });
  handle('worker-transcript', (id, worker = 'main') => {
    workspaces.validateWorker(id, worker, {mutable: false});
    return worker === 'conversation'
      ? web.conversationTranscript(id)
      : agents.transcript(id, worker);
  });
  const preview = workerPreviews({
    browsers: browser,
    sessionFor: (id, worker) => agents.sessions.get(workerKey(id, worker)),
  });
  handle('worker-preview', (id, worker = 'main') => {
    workspaces.validateWorker(id, worker, {mutable: false});
    return preview(id, worker);
  });
  handle('terminal-input', (id, text, worker = 'main', session) => {
    workspaces.beforeInput(id, text, worker);
    return agents.input(id, text, worker, session);
  });
  handle('terminal-message', (id, text, worker = 'main') => workspaces.message(id, text, worker));
  handle('terminal-resize', (id, rows, cols, worker = 'main', session) => {
    workspaces.validateWorker(id, worker, {mutable: false});
    return agents.resize(id, rows, cols, worker, session);
  });
  handle('catalog', () => ensureEngine().request('catalog'));
  handle('chrome-profiles', () => listChromeProfiles());
  handle('open-link', async (url) => {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) throw Error('Invalid link');
    await shell.openExternal(u.toString());
  });
  // Windows: after a native confirm or alert, text fields take no clicks until the window refocuses.
  handle('refocus-window', () => {
    if (process.platform !== 'win32' || !window || window.isDestroyed()) return;
    window.blur();
    window.focus();
  });
  scheduler.register('agents', async () => {
    for (const session of agents.sessions.values())
      await agents.readContext(session.candidateId, session);
  });
  scheduler.register('browsers', () => {
    for (const workspace of workspaces.list())
      if (browser.status(workspace.id).state === 'waiting') browser.prepare(workspace.id);
  });
  scheduler.register('web-templates', () => web.runtime.tick());
  // A skipped or applied record's tabs close even when Chrome was away then.
  scheduler.register(
    'record-tabs',
    () => Promise.all(workspaces.list().map((w) => web.closeEndedRecordTabs(w.id).catch(() => {}))),
    {interval: 300000},
  );
  scheduler.register('usage-report', () => usage.tick(), {interval: 3600000});
  scheduler.start();
  const activeRunIds = () => services.flatMap((service) => service.activeRunIds?.() ?? []);
  const settingsServices = await registerSettingsServices({
    app,
    root,
    data,
    bootstrapDirectory,
    store: core,
    jevSettings,
    handle,
    window: () => window,
    maintenance,
    emit,
    clearTerminalOutputs: () => {
      agents.clearOutputs();
      for (const service of services) service.clearOutputs?.();
      emit('logs-cleared', {});
    },
    activeRunIds,
  });
  window = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 1040,
    minHeight: 720,
    title: 'AutoJob · Web automations',
    backgroundColor: '#11151b',
    show: !openedInBackground(),
    webPreferences: {
      preload: path.join(root, 'app/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const openQuestions = core.db.prepare(
    "SELECT id, json_extract(data,'$.questions') AS questions FROM automations",
  );
  const background = startBackgroundMode({
    root,
    window: () => window,
    quitting: () => quitting,
    activity: () => ({
      running: activeRunIds().length,
      questions: new Map(
        openQuestions.all().flatMap((row) =>
          JSON.parse(row.questions ?? '[]')
            .filter((question) => question.answer == null)
            .map((question) => [question.id, {workspaceId: row.id, question}]),
        ),
      ),
    }),
    workspaceTitle: (id) => automationDb.get(id).title,
    answer: (id, questionId, value) =>
      maintenance.invoke('workspace-answer', async () => {
        const result = await web.runtime.answer(id, questionId, value);
        changed(id);
        return result;
      }),
    openWorkspace: (id, view) => emit('open-workspace', {workspaceId: id, view}),
  });
  automationDb.questionAsked = (id, question) => background.questionAsked(id, question);
  // Scans that end failed, blocked or timed out: a notification, plus the report when enabled.
  const reportScanFailure = automationDb.scanFailed;
  automationDb.scanFailed = (run) => {
    background.scanFailed(run);
    return reportScanFailure?.(run);
  };
  handle('background-status', () => background.status());
  handle('background-open-at-login', (value) => background.setOpenAtLogin(value === true));
  await window.loadFile(path.join(root, 'dist/index.html'));
  await completeDataUpgrade({dataDirectory: data, appVersion: app.getVersion()});
  void usage.start();
  // Unpackaged builds only: lets a local development script drive the app.
  const devControl = app.isPackaged
    ? null
    : await startDevControl({
        directory: bootstrapDirectory,
        handlers,
        invoke: (name, fn) => maintenance.invoke(name, fn),
      }).catch((error) => {
        console.error('Dev control unavailable:', error.message);
        return null;
      });
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    background.dispose();
    settingsServices.dispose();
    scheduler.close();
    (async () => {
      await Promise.race([usage.stop(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      for (const service of services) await service.close?.();
      await agents.close();
      await browser.close({closeTabs: true});
      await mcp.close();
      await devControl?.close();
      // A downloaded update installs now, after a backup, while the database is still open.
      const install = await settingsServices.prepareQuitInstall().catch(() => null);
      core.close();
      if (install) await install().catch(() => app.quit());
      else {
        // Install now was chosen but could not run: reopen instead of staying closed.
        if (settingsServices.restartRequested()) app.relaunch();
        app.quit();
      }
    })();
  });
}
boot().catch((error) => {
  console.error(error);
  dialog.showErrorBox(
    'Loop could not open',
    String(error.message ?? error) +
      '\n\nDo not delete the data folder. Keep the backups and report the error through a secure support channel.',
  );
  app.exit(1);
});
