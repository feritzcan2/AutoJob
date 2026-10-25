import {captureVerificationTargets, clickVerificationCheckbox} from './verification-checkbox.mjs';
import {installNoTranslate} from './translation.mjs';
import {privateJevPage, retryJevRead} from './page.mjs';
import {jevChromium} from './driver.mjs';
import {acquireTabRendering} from './rendering.mjs';
import {humanClick, humanType, ROUTINE_NOTICE} from '../browser/human-input.mjs';
import {accessBarrier, SiteWaitError, siteKey} from '../browser/site-access.mjs';
import {observeFormFrame, actFormFrame, usableFormFrame} from './frame-actions.mjs';
import {captureCookieFrameTargets, clickCookieFrameTarget} from './cookie-frame.mjs';
import {documentObservation, waitForDocument} from './document.mjs';
import {readPane} from './pane.mjs';
import {
  uploadDetails,
  validateUploadPurpose,
  isUploadTrigger,
  receivedName,
  uploadFile,
  selectedFileMatches,
} from './upload.mjs';
import {capturePasswordFields, savedLoginState} from './credentials.mjs';
import {captureEmbeddedForms, embeddedFormTarget} from './frames.mjs';
import {takeUploadAttempt} from './upload-budget.mjs';
import {installFormSemantics} from './form-semantics.mjs';
import {verificationEvidence, updateVerification, verificationHandoff} from './verification.mjs';
import {readFile, mkdir} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import {actionSpace, chooseJev, jevConfig} from './policy.mjs';
import {
  activateChrome as activateChromeApp,
  openChromeUrl,
  extensionInstalledInProfile,
  extensionMissingError,
  resolveChromeProfile,
} from './chrome.mjs';
import {ExtensionRelay} from './extension.mjs';
import {acquireChromeConnection} from './connection-queue.mjs';
import {JevTabs, restoredTargets} from './tabs.mjs';
import {disposableResearchTab} from './tab-lifecycle.mjs';
import {selectAutocomplete, stale as staleControl} from './autocomplete.mjs';
import {selectChoice, verifyChoice, choiceKey} from './choice.mjs';
import {captureClickTargets, takeClickTarget} from './click.mjs';
import {
  captureFillFields,
  clearFillFields,
  fillKnownFields,
  inspectApplicationForm,
} from './form.mjs';
import {
  captureControls,
  navigateObserved,
  compactElements,
  presentObservation,
  observationPolicy,
  progressKey,
  blockedRepeat,
  rememberProgress,
  stalled,
  wheelScrollNode,
} from './navigation.mjs';
import {validateJevArgs} from './tools.mjs';
import {logTab, shortUrl} from '../browser/tab-log.mjs';
const urlHash = (url) => createHash('sha256').update(url).digest('hex');
// Playwright protocol calls such as evaluate have no timeout of their own. A
// tool call that outlives these bounds holds Jev and the workspace's browser
// queue, so the connection is dropped and the task waits for a reconnect.
export const TOOL_CALL_LIMIT_MS = 120000;
export const TOOL_CANCEL_GRACE_MS = 5000;
const UPLOAD_BUTTON =
  /upload|attach|browse|(?:add|select|choose) files?|resume|\bcv\b|lebenslauf|hochladen|anhängen|datei|yükle|dosya|document|unterlagen/i;
const MAX_SPARE_TABS = 2;
const CHALLENGE_GRACE_MS = 12000;
// Served by the extension relay on loopback: chrome.debugger cannot navigate a
// tab to a data: URL.
const homePage =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>AutoJob</title><h1>AutoJob</h1><p>Listings and application forms open as tabs in this window.</p>';
const isHomeUrl = (url) => /^http:\/\/127\.0\.0\.1:\d+\/jev\/[\w-]+\/home$/.test(url);
const checkedUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Only HTTP(S) URLs without credentials are supported');
  return url.toString();
};

export class JevBrowser {
  constructor(
    directory,
    {
      config = jevConfig,
      choose = chooseJev,
      launch,
      headless = false,
      workspace,
      workspaceId = null,
      siteAccess,
      connection = 'existing',
      profile,
      openUrl = openChromeUrl,
      activateChrome = activateChromeApp,
      extensionInstalled = extensionInstalledInProfile,
      relay = null,
      challengeGraceMs = CHALLENGE_GRACE_MS,
      checkpoints = [],
      accountVault = null,
      documentName = async () => null,
      onDisconnect = () => {},
      onTabsClosed = () => {},
    } = {},
  ) {
    this.sharedSiteAccess = siteAccess;
    this.accountVault = accountVault;
    this.directory = directory;
    this.config = config;
    this.choose = choose;
    this.launch = launch;
    this.headless = headless;
    this.workspace = workspace;
    this.workspaceId = workspaceId;
    this.documentName = documentName;
    this.onDisconnect = onDisconnect;
    this.onTabsClosed = onTabsClosed;
    this.checkpoints = checkpoints;
    this.connection = connection;
    this.profile = profile;
    this.openUrl = openUrl;
    this.activateChrome = activateChrome;
    this.extensionInstalled = extensionInstalled;
    this.relay = relay;
    this.challengeGraceMs = challengeGraceMs;
    this.tabs = new Map();
    this.automationTabs = new Map();
    this.automationRuns = new Map();
    this.automationWorkspaces = new Map();
    this.automationSources = new Map();
    this.urlHashes = new Map();
    // Finished task tabs kept blank in the Jev window for the next task.
    this.spareTabs = new Set();
    this.busy = false;
    this.closed = false;
    this.abort = new AbortController();
  }
  async context() {
    if (this.closed) throw Error('Jev browser is closed');
    if (!this.opening)
      this.opening = (async () => {
        const snapshot = await readFile(
          new URL('../../vendor/jev-ultrafast/snapshot.js', import.meta.url),
          'utf8',
        );
        this.reader = `(() => { (${installFormSemantics.toString()})(); return ${snapshot}; })()`;
        if (this.connection === 'existing') {
          this.profileDirectory ??= await resolveChromeProfile(this.profile);
          this.registry ??= new JevTabs(this.directory, this.profileDirectory);
          let transport, browser, release;
          try {
            release = await acquireChromeConnection({signal: this.abort.signal});
            transport = await this.connectExtension();
            this.transport = transport;
            transport.onTargetDestroyed = (id) => {
              this.forgetTab(id);
              this.persistTabs().catch(() => {});
            };
            transport.onWindowRemoved = (windowId) => {
              if (this.windowId === windowId) this.windowId = null;
            };
            this.abort.signal.throwIfAborted();
            const saved = await this.registry.read(),
              instanceId = transport.instanceId;
            // The extension resolves a target id only for a tab it opened in
            // this Chrome run, so saved ownership can never land on another
            // tab. Saved window metadata is trusted for the same run only.
            const sameRun = saved?.instanceId === instanceId;
            const restored = [];
            for (const id of restoredTargets(sameRun ? saved : null, this.checkpoints)) {
              const tabId = await transport.resolve(id);
              if (tabId === null) continue;
              try {
                await transport.adopt(id, tabId);
                restored.push(id);
              } catch {}
            }
            this.homeId = sameRun && restored.includes(saved.homeId) ? saved.homeId : null;
            this.windowId =
              sameRun &&
              Number.isInteger(saved.windowId) &&
              (await transport.windowExists(saved.windowId))
                ? saved.windowId
                : null;
            this.automationTabs = new Map(
              restored
                .filter((id) => typeof saved?.automationTabs?.[id] === 'string')
                .map((id) => [id, saved.automationTabs[id]]),
            );
            this.automationRuns = new Map(
              restored
                .filter((id) => typeof saved?.automationRuns?.[id] === 'string')
                .map((id) => [id, saved.automationRuns[id]]),
            );
            this.automationWorkspaces = new Map(
              restored
                .filter((id) => typeof saved?.automationWorkspaces?.[id] === 'string')
                .map((id) => [id, saved.automationWorkspaces[id]]),
            );
            this.automationSources = new Map(
              restored
                .filter((id) => typeof saved?.automationSources?.[id] === 'string')
                .map((id) => [id, saved.automationSources[id]]),
            );
            this.urlHashes = new Map(
              restored
                .filter((id) => typeof saved?.urlHashes?.[id] === 'string')
                .map((id) => [id, saved.urlHashes[id]]),
            );
            this.spareTabs = new Set(restored.filter((id) => saved?.spareTabs?.includes(id)));
            this.instanceId = instanceId;
            browser = await jevChromium().connectOverCDP(transport, {
              timeout: 30000,
              noDefaults: true,
            });
            this.abort.signal.throwIfAborted();
            this.browser = browser;
            this.tracking = new WeakMap();
            this.tabs.clear();
            const context = browser.contexts()[0];
            if (!context) throw Error('The Chrome browser context was not found.');
            browser.on('disconnected', () => {
              if (this.browser !== browser) return;
              logTab('disconnected', {workspace: this.workspaceId, tabs: this.tabs.size});
              this.browser = null;
              this.transport = null;
              this.opening = null;
              this.tabs.clear();
              this.tracking = new WeakMap();
              if (!this.closed) this.onDisconnect(transport.cancelled ? {manual: true} : {});
            });
            for (const page of context.pages()) await this.track(context, page).catch(() => {});
            context.on('page', (page) => this.track(context, page).catch(() => {}));
            await this.home();
            await this.persistTabs();
            return context;
          } catch (error) {
            await browser?.close().catch(() => {});
            transport?.close();
            if (this.transport === transport) this.transport = null;
            if (this.browser === browser) {
              this.browser = null;
              this.tabs.clear();
            }
            // The setup screens and the install watch need to know this one.
            if (error.code === 'EXTENSION_MISSING') throw error;
            throw Object.assign(
              Error(`Could not connect to Chrome: ${error.message.split('\n')[0]}`),
              {code: 'BROWSER_DISCONNECTED'},
            );
          } finally {
            release?.();
          }
        }
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        const launch =
          this.launch ?? ((dir, options) => jevChromium().launchPersistentContext(dir, options));
        const context = await launch(this.directory, {
          channel: 'chrome',
          headless: this.headless,
          viewport: {width: 1120, height: 780},
        });
        for (const page of context.pages()) await this.track(context, page).catch(() => {});
        context.on('page', (page) => this.track(context, page).catch(() => {}));
        return context;
      })().catch((error) => {
        this.opening = null;
        throw error;
      });
    return this.opening;
  }
  // The selected profile must hold the AutoJob extension. The relay reuses a
  // connection the extension already made; otherwise it opens the extension's
  // connect page in that profile once and waits for the extension to call back.
  async connectExtension() {
    this.abort.signal.throwIfAborted();
    if (!(await this.extensionInstalled(this.profileDirectory))) throw extensionMissingError();
    this.relay ??= await ExtensionRelay.listen({homePage});
    return this.relay.connect({
      open: (url) =>
        this.openUrl(url, {directory: this.profileDirectory}, {signal: this.abort.signal}),
      signal: this.abort.signal,
    });
  }
  async findOwnedPage(id) {
    for (let i = 0; i < 100; i++) {
      if (!this.browser) throw Error('The Chrome connection closed.');
      for (const context of this.browser.contexts())
        for (const page of context.pages()) {
          // Another tab that cannot be tracked right now must not hide this one.
          const slot = await this.track(context, page).catch(() => null);
          if (slot?.id === id) return page;
        }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error('Could not add the new Jev window to the connection; existing forms are kept.');
  }
  async track(context, page) {
    if (this.tracking?.has(page)) return this.tracking.get(page);
    this.tracking ??= new WeakMap();
    const pending = (async () => {
      const cdp = await context.newCDPSession(page),
        {targetInfo} = await cdp.send('Target.getTargetInfo');
      const slot = {
        page: privateJevPage(page),
        cdp,
        id: targetInfo.targetId,
        openerId: targetInfo.openerId,
        history: [],
        pending: null,
        uploads: new Map(),
      };
      slot.bringToFront = () => this.bringToFront(slot);
      // A tab that rejects init scripts still works; its labels may then be translated.
      await installNoTranslate(slot).catch(() => {});
      if (this.connection === 'existing') await this.persistTabs();
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
          slot.http = {
            url: response.url(),
            status: response.status(),
            retryAfter: response.headers()['retry-after'],
          };
      });
      this.tabs.set(slot.id, slot);
      if (!this.automationTabs.has(slot.id) && this.automationTabs.has(slot.openerId))
        this.automationTabs.set(slot.id, this.automationTabs.get(slot.openerId));
      if (!this.automationRuns.has(slot.id) && this.automationRuns.has(slot.openerId))
        this.automationRuns.set(slot.id, this.automationRuns.get(slot.openerId));
      if (this.automationWorkspaces.has(slot.openerId))
        this.automationWorkspaces.set(slot.id, this.automationWorkspaces.get(slot.openerId));
      if (this.automationSources.has(slot.openerId))
        this.automationSources.set(slot.id, this.automationSources.get(slot.openerId));
      this.noteTab('open', slot, {opener: slot.openerId || undefined});
      page.on('close', () => {
        if (this.tabs.get(slot.id) === slot) {
          this.tabs.delete(slot.id);
          if (this.connection === 'existing' && !this.transport?.connected) return;
          // A close without a reason was the user, the site or Chrome.
          this.noteTab('closed', slot, {reason: slot.closeReason ?? 'outside'});
          this.forgetTab(slot.id);
          this.persistTabs().catch(() => {});
        }
      });
      await this.persistTabs();
      return slot;
    })();
    // A failed setup (for example a page navigating mid-install) must not stay
    // cached: the next call tracks that page again.
    this.tracking.set(page, pending);
    pending.catch(() => {
      if (this.tracking?.get(page) === pending) this.tracking.delete(page);
    });
    return pending;
  }
  async claimAutomationTab(slot, owner, state) {
    if (!state.automationWorkspaceId) return;
    if (
      this.automationRuns.get(slot.id) === owner &&
      this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
      (!state.automationTabKey || this.automationTabs.get(slot.id) === state.automationTabKey)
    )
      return;
    this.automationRuns.set(slot.id, owner);
    if (state.automationTabKey) this.automationTabs.set(slot.id, state.automationTabKey);
    this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
    this.noteTab('claim', slot, {source: state.automationSourceUrl});
    await this.persistTabs();
  }
  noteTab(event, slot, fields = {}) {
    logTab(event, {
      workspace: this.workspaceId,
      tab: slot.id,
      run: this.automationRuns.get(slot.id),
      key: this.automationTabs.get(slot.id),
      url: shortUrl(slot.page.url?.() ?? ''),
      ...fields,
    });
  }
  async persistTabs() {
    if (this.connection === 'existing' && this.transport && this.instanceId)
      await this.registry.save(
        this.instanceId,
        this.transport.owned,
        this.transport.tabIdsByTarget(),
        {
          homeId: this.homeId ?? null,
          windowId: this.windowId ?? null,
          automationTabs: Object.fromEntries(this.automationTabs),
          automationRuns: Object.fromEntries(this.automationRuns),
          automationWorkspaces: Object.fromEntries(this.automationWorkspaces),
          automationSources: Object.fromEntries(this.automationSources),
          urlHashes: Object.fromEntries(this.urlHashes),
          spareTabs: [...this.spareTabs],
        },
      );
  }
  forgetTab(id) {
    this.tabs.delete(id);
    this.automationTabs.delete(id);
    this.automationRuns.delete(id);
    this.automationWorkspaces.delete(id);
    this.automationSources.delete(id);
    this.urlHashes.delete(id);
    this.spareTabs.delete(id);
    this.transport?.forget(id);
    for (const slot of this.tabs.values())
      for (const [url, child] of slot.openedFrames ?? [])
        if (child === id) slot.openedFrames.delete(url);
  }
  async openTabFrom(slot) {
    // The new tab opens in the owned page's window and inherits its task
    // through the opener relation.
    const windowId = await this.transport.windowOf(slot.id);
    const id = await this.transport.createTab({windowId, openerTargetId: slot.id});
    return this.findOwnedPage(id);
  }
  async home() {
    let home = this.tabs.get(this.homeId);
    if (home && !home.page.isClosed() && isHomeUrl(home.page.url())) {
      // A restored home tab still shows the previous app run's page.
      if (home.page.url() !== this.relay.homeUrl) await home.page.goto(this.relay.homeUrl);
      return home;
    }
    this.homeId = null;
    // Prefer the remembered AutoJob window, then any window holding an owned
    // tab; otherwise open a new window in the selected profile.
    let windowId =
      Number.isInteger(this.windowId) && (await this.transport.windowExists(this.windowId))
        ? this.windowId
        : null;
    if (windowId === null)
      for (const slot of this.tabs.values()) {
        if (slot.page.isClosed()) continue;
        windowId = await this.transport.windowOf(slot.id).catch(() => null);
        if (windowId !== null) break;
      }
    let targetId;
    if (windowId !== null) targetId = await this.transport.createTab({windowId});
    else ({windowId, targetId} = await this.transport.createWindow('about:blank'));
    const page = await this.findOwnedPage(targetId);
    home = await this.track(page.context(), page);
    this.homeId = home.id;
    this.windowId = windowId;
    await page.goto(this.relay.homeUrl);
    await this.persistTabs();
    return home;
  }
  // Sites rewrite their own URL after an observation (selected listing,
  // tracking parameters). Only a different origin counts as navigating away.
  leftObservedPage(slot) {
    const url = slot.page.url();
    if (this.urlHashes.get(slot.id) === urlHash(url)) return false;
    try {
      return new URL(slot.observed.url).origin !== new URL(url).origin;
    } catch {
      return true;
    }
  }
  // runIds are the finished runs whose tabs belong to the completed work.
  // closeAll is the user ending that work (skip, marked applied): every tab of
  // those runs closes, also one that moved to another site or awaits a check.
  // recordIds also match tabs by their record label, whichever run opened them.
  async closeFinishedAutomationRunTabs(
    runIds,
    workspaceId,
    {
      keepForms = false,
      pendingTabIds = [],
      resetSource = null,
      closeAll = false,
      recordIds = [],
    } = {},
  ) {
    if (
      this.closed ||
      this.busy ||
      !this.opening ||
      (this.connection === 'existing' && !this.browser?.isConnected())
    ) {
      logTab('finish_deferred', {workspace: workspaceId, runs: runIds, records: recordIds});
      return {deferred: true};
    }
    return this.exclusive('closeFinishedAutomationRunTabs', this.abort.signal, async () => {
      const closed = [],
        retained = [],
        reasons = {},
        pending = new Set(pendingTabIds);
      for (const slot of [...this.tabs.values()]) {
        if (
          slot.id === this.homeId ||
          slot.page.isClosed() ||
          this.automationWorkspaces.get(slot.id) !== workspaceId ||
          !(
            runIds.includes(this.automationRuns.get(slot.id)) ||
            recordIds.some((id) => this.automationTabs.get(slot.id) === `record:${id}`)
          )
        )
          continue;
        if (
          resetSource &&
          (this.automationSources.get(slot.id) !== resetSource ||
            this.automationTabs.get(slot.id)?.startsWith('record:'))
        )
          continue;
        const keep =
          resetSource || closeAll
            ? null
            : pending.has(slot.id)
              ? 'pending_question'
              : slot.verification
                ? 'verification'
                : this.leftObservedPage(slot)
                  ? 'left_page'
                  : keepForms && !(await disposableResearchTab(slot))
                    ? 'form'
                    : null;
        if (keep) {
          retained.push(slot.id);
          reasons[slot.id] = keep;
          continue;
        }
        try {
          await this.retireTab(
            slot,
            resetSource ? 'source_reset' : closeAll ? 'record_closed' : 'run_finished',
          );
          closed.push(slot.id);
        } catch {
          retained.push(slot.id);
          reasons[slot.id] = 'close_failed';
        }
      }
      logTab('finish', {workspace: workspaceId, runs: runIds, closed, retained: reasons});
      if (closed.length) await this.onTabsClosed(closed);
      await this.persistTabs();
      return {closed, retained};
    });
  }
  // Chrome restores a minimized window whenever a tab is added to it, and only
  // window.open from an owned page reaches the exact Jev window. A finished
  // task tab therefore stays open as a blank spare; the next task navigates it,
  // which leaves a minimized window minimized. Other tabs are closed.
  async retireTab(slot, reason) {
    if (this.connection === 'existing' && this.spareTabs.size < MAX_SPARE_TABS)
      try {
        await slot.page.goto('about:blank', {timeout: 5000});
        if (slot.page.url() === 'about:blank') {
          this.noteTab('spare', slot, {reason});
          for (const map of [
            this.automationTabs,
            this.automationRuns,
            this.automationWorkspaces,
            this.automationSources,
            this.urlHashes,
          ])
            map.delete(slot.id);
          for (const [, child] of this.tabs)
            for (const [url, id] of child.openedFrames ?? [])
              if (id === slot.id) child.openedFrames.delete(url);
          for (const key of Object.keys(slot))
            if (!['page', 'cdp', 'id', 'bringToFront'].includes(key)) delete slot[key];
          Object.assign(slot, {history: [], pending: null, uploads: new Map()});
          this.spareTabs.add(slot.id);
          return;
        }
      } catch {
        // A page that refuses to leave (beforeunload, hung load) is closed.
      }
    slot.closeReason = reason;
    await slot.page.close({runBeforeUnload: false});
    this.forgetTab(slot.id);
  }
  takeSpareTab() {
    for (const id of this.spareTabs) {
      this.spareTabs.delete(id);
      const slot = this.tabs.get(id);
      if (slot && !slot.page.isClosed() && slot.page.url() === 'about:blank') return slot;
    }
    return null;
  }
  // Site waits of the lane of the current call (scan or application), and
  // the verifications this Chrome profile met.
  get siteAccess() {
    return this.siteAccessFor(this.siteLane);
  }
  siteAccessFor(lane) {
    return this.sharedSiteAccess
      ?.forLane(lane)
      .forProfile(this.connection === 'existing' ? this.profile : null);
  }
  set siteAccess(value) {
    this.sharedSiteAccess = value;
  }
  tab(id) {
    if (/^\d+$/.test(id))
      throw Object.assign(
        Error(
          'This numeric tab id belongs to the existing Chrome tool, not a Jev CDP id. Continue the saved draft with the original Chrome tool; do not refresh the Jev connection or open a new tab.',
        ),
        {code: 'TAB_BACKEND_MISMATCH'},
      );
    const slot = this.tabs.get(id);
    if (!slot || slot.page.isClosed())
      throw Object.assign(
        Error(
          'Jev tab not found: the saved tab was closed or no longer exists in the selected Chrome session, and this tab id will not work again. Use a tab id from browser_tabs, or open the address again with browser_open. In an application, verify the saved result before reopening the record; do not resubmit an action whose submission is uncertain.',
        ),
        {code: 'TAB_MISSING'},
      );
    return slot;
  }
  // The name the page receives for a workspace file: the user's name for the
  // document, else the stored file name. Both are checked against the field's
  // purpose.
  async uploadName(file, workspace, size, label) {
    let name = null;
    try {
      name = await this.documentName(path.relative(workspace, file));
    } catch {}
    name = receivedName(file, name, size);
    validateUploadPurpose(label, path.basename(file));
    validateUploadPurpose(label, name);
    return name;
  }
  // Some forms create their file input only when the upload button is
  // clicked. Click that observed button while catching the file chooser it
  // opens and hand the workspace file to it; no native dialog is shown.
  async uploadThroughChooser(slot, args, owner) {
    if (!path.isAbsolute(args.filePath)) throw Error('The file path must be absolute.');
    const label = slot.clickTargets.get(args.uploadId)?.action?.label ?? '';
    if (!UPLOAD_BUTTON.test(label))
      throw Error(
        'This target is not a file upload button. Use an uploads[].uploadId or the targetId of the upload button.',
      );
    const {realpath, stat} = await import('node:fs/promises');
    const file = await realpath(args.filePath),
      workspace = await realpath(this.workspace ?? this.directory);
    if (!file.startsWith(workspace + path.sep) || !(await stat(file)).isFile())
      throw Error('Only files in the workspace of this candidate can be uploaded.');
    const info = await stat(file),
      name = await this.uploadName(file, workspace, info.size, label);
    if (
      !takeUploadAttempt(
        slot,
        JSON.stringify([slot.page.url(), label, file, info.size, info.mtimeMs]),
      )
    )
      return {
        tabId: slot.id,
        status: 'no_progress',
        executed: false,
        message:
          'The limit of two attempts or 60 seconds for the same file/button was reached. Report the actual technical blocker.',
      };
    const target = takeClickTarget(slot, args.uploadId, owner);
    const chooser = slot.page.waitForEvent('filechooser', {timeout: 8000}).catch(() => null);
    const clicked = await this.execute(slot, target);
    const opened = await chooser;
    if (!opened)
      return {
        ...clicked,
        status: 'no_progress',
        executed: false,
        message:
          'The button did not open a file chooser. If a menu or option opened, use browser_upload_document with the targetId of its upload option; otherwise report the actual technical blocker.',
      };
    await opened.setFiles(await uploadFile(file, name), {timeout: 10000});
    return {
      ...(await this.observe(slot)),
      status: 'ready',
      executed: true,
      uploadedFileName: name,
      message: `The file was given to the file chooser the button opened as "${name}". Check that the file name or upload status appears on the page.`,
    };
  }
  // A click that opens a new tab (target=_blank, window.open) leaves the
  // clicked page unchanged; report the child tab so the caller can continue
  // there. Bounded: tabs announce themselves within a few hundred ms.
  async withOpenedTab(slot, before, value) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const child = [...this.tabs.values()].find(
        (t) => !before.has(t.id) && t.openerId === slot.id && !t.page.isClosed(),
      );
      if (child)
        return {
          ...value,
          openedTab: {tabId: child.id, url: child.page.url()},
          message: 'This click opened a new tab; use that tab to continue.',
        };
      if (value?.status !== 'uncertain' && value?.status !== 'no_progress') return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return value;
  }
  async navigate(slot, url) {
    // Paced sites wait their turn before the request leaves; cancellable.
    const gap = this.siteAccess?.pace?.(url) ?? 0;
    if (gap > 0) await pause(gap, undefined, {signal: this.abort.signal});
    const token = this.siteAccess?.begin(url);
    slot.accessProbe = {url, token};
    slot.http = null;
    // Sites can rewrite their address after load; extensions page from this one.
    slot.openedUrl = url;
    try {
      return await slot.page.goto(url, {waitUntil: 'domcontentloaded', timeout: 20000});
    } catch (error) {
      // A 429 answered before its document loaded may still be an interactive
      // verification page; the observation decides.
      if (slot.http?.status === 429 && this.siteAccess) throw error;
      const wait =
        this.siteAccess?.complete(url, token, {
          ...slot.http,
          reason: slot.http?.status === 429 ? 'rate_limit' : null,
        }) ?? this.siteAccess?.unreachable(url, error);
      slot.accessProbe = null;
      if (wait) throw Object.assign(new SiteWaitError(wait), {url, tabId: slot.id});
      throw error;
    }
  }
  async observe(slot) {
    return retryJevRead(slot.page, async () => {
      const release = await acquireTabRendering(slot, {
        signal: this.readSignal ?? this.abort.signal,
      });
      try {
        return await this.observeOnce(slot);
      } finally {
        await release();
      }
    });
  }
  // Many challenge pages ("Just a moment…") pass on their own within seconds
  // and reload the requested page. Give each response one bounded, cancellable
  // grace period before the page counts as a verification barrier.
  async awaitSelfClearingChallenge(slot, observed) {
    if (
      slot.challengeGrace === slot.http ||
      accessBarrier({title: observed.title, text: observed.text}) !== 'verification'
    )
      return observed;
    slot.challengeGrace = slot.http;
    const signal = this.readSignal ?? this.abort.signal,
      step = Math.min(1000, this.challengeGraceMs);
    for (let waited = 0; waited < this.challengeGraceMs; waited += step) {
      await pause(step, undefined, {signal});
      const current = await slot.page.evaluate(this.reader).catch(() => null);
      if (current && accessBarrier({title: current.title, text: current.text}) !== 'verification') {
        await waitForDocument(slot, {signal});
        return (await slot.page.evaluate(this.reader)) ?? current;
      }
    }
    return observed;
  }
  async observeOnce(slot) {
    // HTTP 429 can accompany a real interactive verification page. The loaded
    // document decides below: a challenge is handed to the user, an ordinary
    // rate limit starts the shared wait.
    await waitForDocument(slot, {signal: this.readSignal ?? this.abort.signal});
    const previousFields = slot.fillFields;
    await clearFillFields(slot);
    slot.pending = null;
    const previousUploads = slot.uploads;
    slot.uploads = new Map();
    let observed = await slot.page.evaluate(this.reader);
    if (!observed) throw Error('The page is loading; observe again.');
    if (this.siteAccess && /^https?:/.test(observed.url)) {
      // The app never clicks a verification checkbox on a full-page barrier;
      // one that does not pass on its own is the user's to complete.
      observed = await this.awaitSelfClearingChallenge(slot, observed);
      const verificationPage =
        accessBarrier({title: observed.title, text: observed.text}) === 'verification';
      // A verification document behind HTTP 429 is the same interactive barrier.
      const reason = verificationPage
          ? 'verification'
          : accessBarrier({...slot.http, title: observed.title, text: observed.text}),
        probe = slot.accessProbe;
      const wait =
        (reason && slot.accessChecked === slot.http && this.siteAccess.status(observed.url)) ||
        this.siteAccess.complete(probe?.url ?? observed.url, probe?.token, {...slot.http, reason});
      slot.accessProbe = null;
      slot.accessChecked = slot.http;
      if (
        !wait &&
        !reason &&
        slot.accessBlocked &&
        slot.http &&
        slot.http !== slot.accessBlocked.http &&
        slot.http.status >= 200 &&
        slot.http.status < 400 &&
        siteKey(observed.url) === slot.accessBlocked.site
      ) {
        this.siteAccess.recoverVerification(observed.url, slot.accessBlocked.blockedAt);
        delete slot.accessBlocked;
      }
      if (wait) {
        if (wait.reason === 'verification' && siteKey(observed.url) === wait.site)
          slot.accessBlocked = {site: wait.site, blockedAt: wait.blockedAt, http: slot.http};
        throw Object.assign(new SiteWaitError(wait), {url: observed.url, tabId: slot.id});
      }
    }
    const verification = updateVerification(slot, await verificationEvidence(slot.page, slot));
    slot.observed = observed;
    this.urlHashes.set(slot.id, urlHash(observed.url));
    await this.persistTabs();
    const fillFields = await captureFillFields(slot, slot.owner, previousFields);
    const uploadFrames = [slot.page.mainFrame()];
    for (const frame of slot.page.frames())
      if (await usableFormFrame(frame, slot.page).catch(() => false)) uploadFrames.push(frame);
    const uploads = [];
    try {
      for (const frame of uploadFrames)
        for (const locator of await frame.locator('input[type=file]').all()) {
          const input = await locator.elementHandle();
          if (!input) continue;
          const details = await input.evaluate(uploadDetails);
          if (!details) {
            await input.dispose();
            continue;
          }
          let uploadId;
          for (const [id, old] of previousUploads) {
            if (
              old.owner === slot.owner &&
              old.url === slot.page.url() &&
              JSON.stringify(old.details) === JSON.stringify(details) &&
              (await old.input.evaluate((e, current) => e === current, input).catch(() => false))
            ) {
              uploadId = id;
              break;
            }
          }
          uploadId ??= randomUUID();
          slot.uploads.set(uploadId, {
            input,
            frame,
            frameUrl: frame.url(),
            owner: slot.owner,
            url: slot.page.url(),
            details,
          });
          uploads.push({uploadId, ...details});
        }
    } finally {
      await Promise.all(
        [...previousUploads.values()].map(({input}) => input.dispose().catch(() => {})),
      );
    }
    const links = await slot.page.locator('a[href]').evaluateAll((nodes) =>
      nodes
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            /^https?:/.test(e.href) &&
            e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < innerHeight
          );
        })
        .slice(0, 100)
        .map((e) => ({
          text: (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 500),
          url: e.href,
        })),
    );
    // Chrome's page translation rewrites labels between runs and away from the
    // page's own wording; the model must act on ids, not remembered labels.
    const translated = await slot.page
      .evaluate(() => /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement.className))
      .catch(() => false);
    return {
      savedLogin: await slot.page.evaluate(savedLoginState),
      passwordFields: await capturePasswordFields(slot, slot.owner),
      ...(translated
        ? {
            translated: true,
            translationNotice:
              'Chrome translated this page. Labels differ from the original wording and from earlier runs; act on the ids and roles in this observation, never on a remembered label. A control with visible:false may be a translated duplicate; prefer the visible clickTargets entry.',
          }
        : {}),
      accountCredentials: this.accountVault?.status() ?? {configured: false},
      browser: 'Jev Chrome',
      tabId: slot.id,
      url: observed.url,
      title: observed.title,
      text: observed.text,
      verification,
      embeddedForms: await captureEmbeddedForms(slot),
      links,
      elements: compactElements(actionSpace(observed.actions).elements),
      clickTargets: [
        ...captureClickTargets(slot, slot.owner),
        ...(await captureCookieFrameTargets(slot)),
        ...(await captureVerificationTargets(slot)),
      ],
      ...captureControls(slot, slot.owner),
      fillFields,
      uploads,
      verificationDiagnostics: slot.verificationDiagnostics?.length
        ? slot.verificationDiagnostics
        : undefined,
      history: slot.history.slice(-4),
      omittedActions: observed.omitted_actions,
    };
  }
  async fresh(slot, page, action) {
    if (action?.kind === 'scroll') {
      const current = await slot.page.evaluate(this.reader);
      return (
        JSON.stringify(current?.scroll_guards?.[action.node]) ===
          JSON.stringify(page.scroll_guards?.[action.node]) &&
        JSON.stringify(current?.page_key) === JSON.stringify(page.page_key)
      );
    }
    if (action && ['click', 'select'].includes(action.kind)) {
      const current = await slot.page.evaluate(
        ({node, expected}) => {
          const c = window.__jevFast;
          if (!c) return null;
          // The page may have re-rendered the control as an identical element.
          if (!c.nodes.get(node)?.isConnected) c.rebind?.(node, expected);
          return [c.pageKey(), c.guard(c.nodes.get(node))];
        },
        {node: action.node, expected: page.guards[action.node]},
      );
      return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[action.node]]);
    }
    return (
      JSON.stringify((await slot.page.evaluate(this.reader))?.marker) ===
      JSON.stringify(page.marker)
    );
  }
  async observeAfterAction(slot) {
    return this.observe(slot);
  }
  async execute(slot, pending, text) {
    const {action, observed, operation} = pending;
    if (
      slot.verification &&
      slot.verification.state !== 'answer_applied' &&
      !(slot.verification.formFirst && !slot.verification.checkbox) &&
      action?.kind === 'click' &&
      /submit|send application|apply now|başvur|gönder/i.test(action.label ?? '')
    )
      return slot.verification.formFirst
        ? {
            ...verificationHandoff(slot),
            nextAction: 'try_supported_visible_control',
            message:
              'The form verification checkbox is still unchecked. Click it once with its clickTargets ref, read the page, then submit.',
          }
        : {
            ...verificationHandoff(slot),
            message:
              'The site verification was not resolved. Do not resubmit the application; handle the current verification step or the uncertain result.',
          };
    if (!(await this.fresh(slot, observed, action)))
      return {
        ...(await this.observe(slot)),
        status: 'stale',
        executed: false,
        message: 'The page changed. Get a new Jev decision.',
      };
    if (!action)
      return {
        ...(await this.observe(slot)),
        status: operation.toLowerCase(),
        executed: false,
        verified: false,
      };
    if (action.kind === 'click')
      for (const upload of slot.uploads?.values() ?? []) {
        if (
          upload.owner === slot.owner &&
          (await slot.page
            .evaluate(isUploadTrigger, {input: upload.input, node: action.node})
            .catch(() => false))
        )
          return {
            ...(await this.observe(slot)),
            status: 'upload_required',
            executed: false,
            message:
              'No file chooser opened. Use browser_upload_document (direct Jev: browser_upload) with the uploadId from the current uploads list and the document path in the workspace. Do not repeat the normal click.',
          };
      }
    if (action.kind === 'click') {
      // Chrome hands an email or phone link to another app; the page never changes.
      const external = await slot.page
        .evaluate((node) => {
          const href = window.__jevFast?.nodes.get(node)?.closest('a[href]')?.href ?? '';
          return /^(mailto|tel):/i.test(href) ? href : null;
        }, action.node)
        .catch(() => null);
      if (external)
        return {
          ...(await this.observe(slot)),
          status: 'unsupported',
          executed: false,
          external,
          message: `This link opens ${external} in the computer's email or phone app; no web page or form opens. If it is the apply control, the site takes applications by email to that address: report that as the blocker with the address. Do not click it again.`,
        };
    }
    const repeatKey = JSON.stringify([action.kind, action.node, action.value, action.delta, text]),
      before = progressKey(observed);
    if (action.kind !== 'wait' && blockedRepeat(slot, repeatKey, before))
      return {...(await this.observe(slot)), ...stalled};
    if (action.choice && blockedRepeat(slot, choiceKey(action.node), before))
      return {...(await this.observe(slot)), ...stalled};
    let began = false;
    try {
      if (action.kind === 'wait') await new Promise((resolve) => setTimeout(resolve, 100));
      else if (action.kind === 'scroll') {
        began = true;
        await wheelScrollNode(slot, action, this.readSignal ?? this.abort.signal);
      } else {
        // Resolve only a node observed by Jev; model output never becomes code or selectors.
        const target = await slot.page.evaluate((a) => {
          const e = window.__jevFast?.nodes.get(a.node);
          if (
            !e?.isConnected ||
            e.matches(':disabled') ||
            e.closest('[aria-disabled="true"],[inert]')
          )
            return null;
          if (a.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true'))
            return null;
          return window.__jevFast.clickPoint(e);
        }, action);
        if (!target)
          return {
            ...(await this.observe(slot)),
            status: 'stale',
            executed: false,
            message: 'The target changed or became covered. Get a new decision.',
          };
        began = true;
        if (action.kind === 'select')
          await slot.page.evaluate((a) => {
            const e = window.__jevFast?.nodes.get(a.node);
            if (
              e?.tagName !== 'SELECT' ||
              ![...e.options].some(
                (o) => o.value === a.value && !o.disabled && !o.closest('optgroup[disabled]'),
              )
            )
              throw Error('Invalid option');
            e.value = a.value;
            e.dispatchEvent(new Event('input', {bubbles: true}));
            e.dispatchEvent(new Event('change', {bubbles: true}));
          }, action);
        else {
          // The pointer travels to the target first; right before the press
          // the target must still sit under the same point.
          began = false;
          await humanClick(
            slot.page,
            target.x,
            target.y,
            async () => {
              const now = await slot.page.evaluate(
                (node) => window.__jevFast?.clickPoint(window.__jevFast.nodes.get(node)),
                action.node,
              );
              if (!now || Math.hypot(now.x - target.x, now.y - target.y) > 4)
                throw Object.assign(Error('The target moved.'), {code: 'TARGET_MOVED'});
            },
            {notice: ROUTINE_NOTICE, signal: this.readSignal ?? this.abort.signal},
          ).catch((error) => {
            // The press itself was sent unless the check stopped it.
            if (error.code !== 'TARGET_MOVED') began = true;
            throw error;
          });
          began = true;
          if (action.kind === 'fill') {
            await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 140));
            await slot.page.keyboard.press('ControlOrMeta+a');
            if (text)
              await humanType(slot.page, text, {signal: this.readSignal ?? this.abort.signal});
            else await slot.page.keyboard.press('Backspace');
          }
        }
      }
      slot.history.push({
        action: action.label,
        kind: action.kind,
        operation,
        text: action.kind === 'fill' ? text : undefined,
      });
      if (slot.history.length > 60) slot.history.shift();
      // Allow rendering/navigation to settle. Record execution first; never retry a mutation.
      await new Promise((resolve) => setTimeout(resolve, 100));
      let controlState;
      if (action.kind === 'click' && action.choice) {
        const expected =
          action.role === 'radio'
            ? true
            : action.choice.selected === null
              ? null
              : !action.choice.selected;
        controlState =
          expected === null
            ? {expected: null, actual: null, verified: false}
            : await verifyChoice(slot, action.node, action.choice, expected);
      } else if (
        action.kind === 'click' &&
        ['checkbox', 'radio', 'switch'].includes(action.role) &&
        action.checked !== undefined
      ) {
        const expected = action.role === 'radio' ? true : action.checked !== 'true';
        const actual = await slot.page.evaluate((node) => {
          const e = window.__jevFast?.nodes.get(node);
          if (!e?.isConnected) return null;
          return e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type)
            ? e.checked
            : e.getAttribute('aria-checked');
        }, action.node);
        controlState = {
          expected,
          actual,
          verified: actual === expected || actual === String(expected),
        };
      }
      const result = await this.observeAfterAction(slot),
        progress = rememberProgress(slot, repeatKey, before, progressKey(slot.observed));
      if (controlState && !controlState.verified) {
        const state = progressKey(slot.observed);
        rememberProgress(slot, repeatKey, state, state);
        if (action.choice) rememberProgress(slot, choiceKey(action.node), state, state);
      }
      const noChange = !progress && action.kind !== 'wait' && !controlState?.verified;
      return {
        ...result,
        status:
          controlState && !controlState.verified
            ? 'uncertain'
            : noChange
              ? action.kind === 'scroll'
                ? 'no_progress'
                : 'uncertain'
              : 'ready',
        executed: true,
        progress,
        ...(noChange || (controlState && !controlState.verified)
          ? {
              retryBlocked: true,
              message:
                action.kind === 'scroll'
                  ? stalled.message
                  : 'The action was sent, but its effect could not be verified. Do not repeat the same action; especially after a submission, check the current result evidence.',
            }
          : {}),
        ...(controlState ? {controlState} : {}),
      };
    } catch (error) {
      if (error.code === 'TARGET_MOVED')
        return {
          ...(await this.observe(slot)),
          status: 'stale',
          executed: false,
          message: 'The target changed or became covered. Get a new decision.',
        };
      if (error.code === 'SITE_WAIT') {
        error.executed = began ? 'unknown' : false;
        throw error;
      }
      return {
        browser: 'Jev Chrome',
        tabId: slot.id,
        url: slot.page.url(),
        status: began ? 'uncertain' : 'error',
        executed: began ? 'unknown' : false,
        message:
          'Could not verify the state after the action. Call browser_observe first; in particular, do not repeat a submission.',
      };
    }
  }
  async callTool({name, arguments: args}, owner = 'local', state = {}) {
    validateJevArgs(name, args);
    if (this.busy) throw Error('Jev is busy; wait for the result of the current call.');
    const signal = state.signal
      ? AbortSignal.any([this.abort.signal, state.signal])
      : this.abort.signal;
    return this.exclusive(name, signal, () =>
      this.runTool({name, arguments: args}, owner, state, signal),
    );
  }
  // Holds Jev for one operation. Playwright protocol calls such as evaluate
  // have no timeout of their own, so an operation that outlives its bound (or
  // its cancellation) drops the connection instead of holding Jev forever.
  async exclusive(name, signal, operation) {
    const call = {name};
    this.busy = call;
    let timer, onAbort;
    const running = Promise.resolve().then(operation);
    const stuck = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.toolCallLimitMs ?? TOOL_CALL_LIMIT_MS);
      onAbort = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => resolve('cancelled'),
          this.toolCancelGraceMs ?? TOOL_CANCEL_GRACE_MS,
        );
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, {once: true});
    });
    try {
      const outcome = await Promise.race([
        running.then(
          () => null,
          () => null,
        ),
        stuck,
      ]);
      if (!outcome) return await running;
      running.catch(() => {});
      console.warn(`Jev ${name} did not finish (${outcome}); dropping the Chrome connection.`);
      this.dropConnection();
      if (outcome === 'cancelled') throw signal.reason;
      throw Object.assign(
        Error(`Chrome did not answer ${name} in time; the connection is reset.`),
        {code: 'BROWSER_DISCONNECTED'},
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.busy === call) this.busy = false;
    }
  }
  // Ends a connection whose protocol calls stopped answering. The pending call
  // may never settle; Jev forgets it and connects again on the next call.
  dropConnection() {
    if (this.connection === 'existing') {
      this.transport?.close();
      return;
    }
    const opening = this.opening;
    this.opening = null;
    this.tabs.clear();
    this.tracking = new WeakMap();
    opening?.then((context) => context.close()).catch(() => {});
  }
  async runTool({name, arguments: args}, owner, state, signal) {
    let releaseRendering;
    try {
      this.readSignal = signal;
      this.readSignal.throwIfAborted();
      this.siteLane = state.siteLane;
      if (name === 'browser_open_page') {
        checkedUrl(args.url);
        const wait = this.siteAccess?.status(args.url);
        if (wait?.waiting) throw Object.assign(new SiteWaitError(wait), {url: args.url});
      } else if (
        args.tabId &&
        !['browser_observe', 'browser_page_screenshot', 'browser_close_tab'].includes(name)
      ) {
        const slot = this.tab(args.tabId),
          url = slot.page.url();
        const token = /^https?:/.test(url) ? this.siteAccess?.assertAction(url) : null;
        if (token) slot.accessProbe = {url, token};
      }
      const context = await this.context();
      let value;
      const sourceScope = Boolean(
        state.automationWorkspaceId && state.automationSourceUrl && state.automationTabKey,
      );
      if (sourceScope) {
        // Recover old, app-owned tabs before source labels existed. Never infer
        // ownership from the URL: require our persisted target and last URL.
        const hostname = (url) => {
          try {
            return new URL(url).hostname.replace(/^www\./, '');
          } catch {
            return '';
          }
        };
        let migrated = false;
        for (const slot of this.tabs.values()) {
          if (
            slot.id === this.homeId ||
            this.spareTabs.has(slot.id) ||
            slot.page.isClosed() ||
            this.automationSources.has(slot.id)
          )
            continue;
          const workspace = this.automationWorkspaces.get(slot.id);
          if (
            (workspace && workspace !== state.automationWorkspaceId) ||
            (slot.owner && slot.owner !== owner)
          )
            continue;
          if (
            this.connection === 'existing'
              ? !this.transport?.owned.has(slot.id)
              : !this.automationTabs.has(slot.id)
          )
            continue;
          if (this.urlHashes.get(slot.id) !== urlHash(slot.page.url())) continue;
          const matches = (state.automationSourceUrls ?? []).filter(
            (url) => hostname(url) === hostname(slot.page.url()),
          );
          if (matches.length !== 1 || matches[0] !== state.automationSourceUrl) continue;
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          this.automationSources.set(slot.id, state.automationSourceUrl);
          migrated = true;
        }
        if (migrated) await this.persistTabs();
      }
      const recordScope = Boolean(
        state.automationWorkspaceId && state.automationTabKey?.startsWith('record:'),
      );
      const accessible = (slot) => {
        if (this.spareTabs.has(slot.id)) return false;
        if (recordScope)
          return (
            slot.id !== this.homeId &&
            !slot.page.isClosed() &&
            this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
            this.automationTabs.get(slot.id) === state.automationTabKey
          );
        if (sourceScope)
          return (
            slot.id !== this.homeId &&
            !slot.page.isClosed() &&
            this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
            this.automationSources.get(slot.id) === state.automationSourceUrl
          );
        return !state.multiWorker || slot.owner === owner;
      };
      if (name === 'browser_tabs')
        value = {
          browser: 'Jev Chrome',
          tabs: [...this.tabs.values()]
            .filter((s) => s.id !== this.homeId && !s.page.isClosed() && accessible(s))
            .map((s) => ({
              tabId: s.id,
              url: s.page.url(),
              title: s.observed?.title ?? '',
              changedSinceLastObservation: this.urlHashes.get(s.id) !== urlHash(s.page.url()),
              ...(this.automationTabs.get(s.id)?.startsWith('record:')
                ? {recordId: this.automationTabs.get(s.id).slice(7)}
                : {}),
            })),
        };
      else if (name === 'browser_close_tab') {
        const slot = this.tab(args.tabId);
        if (!sourceScope || !accessible(slot))
          throw Error('Only the scan tab of the source you took over can be closed.');
        if (this.urlHashes.get(slot.id) !== urlHash(slot.page.url()))
          throw Error('The tab changed. Observe the current page before closing it.');
        slot.closeReason = 'agent';
        await slot.page.close();
        this.forgetTab(slot.id);
        await this.persistTabs();
        value = {closed: true, closedTabId: slot.id};
      } else if (name === 'browser_open_page' && state.automationTabKey) {
        // Internal read-only automation scope, never a model-selected target.
        const reusable = [...this.tabs.values()].filter(
          (s) =>
            (sourceScope || this.automationTabs.get(s.id) === state.automationTabKey) &&
            accessible(s) &&
            !s.page.isClosed() &&
            (recordScope ||
              this.urlHashes.get(s.id) === urlHash(s.page.url()) ||
              (sourceScope && s.navigationFailed && s.page.url().startsWith('chrome-error://'))),
        );
        const retained =
          recordScope &&
          state.automationResumeRecord &&
          (reusable.find((s) => s.id === state.automationPreferredTabId) ?? reusable.at(-1));
        let slot =
          retained ||
          (state.automationFreshTab
            ? null
            : (reusable.find((s) => s.page.url() === args.url) ??
              reusable.find((s) => s.id === state.automationPreferredTabId) ??
              reusable.find((s) => this.automationTabs.get(s.id) === state.automationTabKey) ??
              reusable[0]));
        if (!slot) {
          // Each detail can require a fresh transport retry. Retire this run's
          // failed Chrome error tabs before allocating another, including an
          // error document committed after goto rejected. Keep real pages,
          // drafts, user navigation and other task owners untouched.
          const closed = [];
          if (sourceScope && !recordScope)
            for (const failed of [...this.tabs.values()]) {
              if (
                !accessible(failed) ||
                this.automationRuns.get(failed.id) !== owner ||
                this.automationTabs.get(failed.id) !== state.automationTabKey ||
                failed.verification ||
                !failed.navigationFailed ||
                !failed.page.url().startsWith('chrome-error://')
              )
                continue;
              try {
                failed.closeReason = 'error_tab';
                await failed.page.close({runBeforeUnload: false});
              } catch {
                throw Error(
                  'Could not close the previous error tab; no new control tab was opened.',
                );
              }
              this.forgetTab(failed.id);
              closed.push(failed.id);
            }
          if (closed.length) {
            await this.onTabsClosed(closed);
            await this.persistTabs();
          }
          slot = this.takeSpareTab();
          if (!slot) {
            const page =
              this.connection === 'existing'
                ? await this.openTabFrom(await this.home())
                : await context.newPage();
            slot = await this.track(page.context(), page);
          }
          this.automationTabs.set(slot.id, state.automationTabKey);
          if (state.automationWorkspaceId)
            this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          if (state.automationSourceUrl)
            this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId && !this.automationWorkspaces.has(slot.id)) {
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          await this.persistTabs();
        }
        if (
          state.automationSourceUrl &&
          this.automationSources.get(slot.id) !== state.automationSourceUrl
        ) {
          this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        try {
          if (!retained && (slot.page.url() !== args.url || this.siteAccess?.status(args.url)))
            await this.navigate(slot, checkedUrl(args.url));
          value = await this.observe(slot);
          slot.navigationFailed = false;
        } catch (error) {
          if (error.code === 'SITE_WAIT') throw error;
          // Chrome may commit its error document after goto rejects. Keep
          // that owned source tab reusable without accepting unrelated URLs.
          slot.navigationFailed = sourceScope && !recordScope;
          this.urlHashes.set(slot.id, urlHash(slot.page.url()));
          await this.persistTabs();
          value = {
            browser: 'Jev Chrome',
            tabId: slot.id,
            url: slot.page.url(),
            status: 'loading',
            message: 'Navigation did not complete; observe the same tab.',
            ...(sourceScope && !recordScope
              ? {navigationError: String(error.message ?? error), requestedUrl: args.url}
              : {}),
          };
        }
      } else if (name === 'browser_open_page') {
        let slot = this.takeSpareTab();
        if (!slot) {
          const page =
            this.connection === 'existing'
              ? await this.openTabFrom(await this.home())
              : await context.newPage();
          slot = await this.track(page.context(), page);
        }
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId)
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
        if (state.automationSourceUrl)
          this.automationSources.set(slot.id, state.automationSourceUrl);
        await this.persistTabs();
        try {
          await this.navigate(slot, checkedUrl(args.url));
          value = await this.observe(slot);
        } catch (error) {
          if (error.code === 'SITE_WAIT') throw error;
          value = {
            browser: 'Jev Chrome',
            tabId: slot.id,
            url: slot.page.url(),
            status: 'loading',
            message: 'Navigation did not complete; observe the same tab.',
          };
        }
      } else {
        const slot = this.tab(args.tabId);
        if (!accessible(slot))
          throw Error('The tab belongs to the task of another worker. Use your own task tab.');
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId && !this.automationWorkspaces.has(slot.id)) {
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          await this.persistTabs();
        }
        if (
          state.automationSourceUrl &&
          this.automationSources.get(slot.id) !== state.automationSourceUrl
        ) {
          this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        releaseRendering = await acquireTabRendering(slot, {signal: this.readSignal});
        if (slot.verification) {
          updateVerification(slot, await verificationEvidence(slot.page, slot));
          if (
            slot.verification &&
            !slot.verification.formFirst &&
            [
              'browser_act',
              'browser_click_target',
              'browser_select_choice',
              'browser_fill_fields',
              'browser_choose_option',
              'browser_autocomplete',
              'browser_list_suggestions',
              'browser_upload',
            ].includes(name)
          ) {
            if (slot.verification.handoff)
              return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
            slot.verification.attempts++;
          }
        }
        if (name === 'browser_page_screenshot') {
          if (slot.verification?.screenshots >= 1)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...verificationHandoff(slot),
                    message:
                      'A screenshot was already taken for this verification step. Do not request the same screen again; proceed according to the known tool limitation or end the turn with a single technical question.',
                  }),
                },
              ],
            };
          if (slot.verification) slot.verification.screenshots++;
          slot.pending = null;
          await clearFillFields(slot);
          const jpeg = args.format === 'jpeg';
          const screenshot = await slot.page.screenshot({
            type: jpeg ? 'jpeg' : 'png',
            ...(jpeg ? {quality: 60} : {}),
            fullPage: false,
            timeout: 10000,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  browser: 'Jev Chrome',
                  tabId: slot.id,
                  url: slot.page.url(),
                  ...(slot.verification ? {verification: slot.verification} : {}),
                }),
              },
              {
                type: 'image',
                mimeType: jpeg ? 'image/jpeg' : 'image/png',
                data: screenshot.toString('base64'),
              },
            ],
          };
        }
        if (name === 'browser_frame_observe' || name === 'browser_frame_act') {
          let result = {};
          if (name === 'browser_frame_act') {
            if (slot.verification)
              throw Error(
                'Complete the current verification step first; do not resubmit the form.',
              );
            const frame = slot.embeddedFrames?.get(args.frameId),
              target = slot.frameActionTargets?.get(args.targetId);
            if (!frame || !target || target.frame !== frame.frame)
              throw Error('The target does not belong to this frameId.');
            result = await actFormFrame(slot, args, owner);
          }
          let observed;
          try {
            observed = await observeFormFrame(slot, args.frameId, owner);
          } catch {
            observed = {
              ...(await this.observe(slot)),
              message: 'The embedded form closed or redirected; check the returned page state.',
            };
          }
          return {content: [{type: 'text', text: JSON.stringify({...observed, ...result})}]};
        }
        if (name === 'browser_open_frame') {
          if (slot.verification)
            throw Error(
              'The embedded form cannot be reopened while a verification/submission is pending.',
            );
          const url = await embeddedFormTarget(slot, args.frameId, owner);
          const openedId = slot.openedFrames?.get(url),
            opened = openedId ? this.tabs.get(openedId) : null;
          if (opened && !opened.page.isClosed()) {
            opened.owner = owner;
            await this.claimAutomationTab(opened, owner, state);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...presentObservation(opened, await this.observe(opened), {full: true}),
                    parentTabId: slot.id,
                    reused: true,
                  }),
                },
              ],
            };
          }
          const page =
            this.connection === 'existing' ? await this.openTabFrom(slot) : await context.newPage();
          const child = await this.track(page.context(), page);
          child.owner = owner;
          await this.claimAutomationTab(child, owner, state);
          // A background tab has no opener, so it does not inherit from slot in track().
          child.openerId ??= slot.id;
          for (const owners of [this.automationTabs, this.automationRuns])
            if (!owners.has(child.id) && owners.has(slot.id))
              owners.set(child.id, owners.get(slot.id));
          slot.openedFrames ??= new Map();
          slot.openedFrames.set(url, child.id);
          if (this.automationWorkspaces.has(slot.id))
            this.automationWorkspaces.set(child.id, this.automationWorkspaces.get(slot.id));
          if (this.automationSources.has(slot.id))
            this.automationSources.set(child.id, this.automationSources.get(slot.id));
          await this.persistTabs();
          try {
            await this.navigate(child, checkedUrl(url));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...presentObservation(child, await this.observe(child), {full: true}),
                    parentTabId: slot.id,
                  }),
                },
              ],
            };
          } catch (error) {
            if (error.code === 'SITE_WAIT') throw error;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'loading',
                    tabId: child.id,
                    parentTabId: slot.id,
                    message:
                      'The embedded page is opening; observe the same new tab, do not open it again.',
                  }),
                },
              ],
            };
          }
        }
        if (name === 'browser_read_pane') {
          if (!sourceScope || recordScope)
            throw Error('A results pane is read only in a source scan tab.');
          value = await readPane(slot, checkedUrl(args.url), {signal: this.readSignal});
          // The click changes the address (the shown listing); it is our own change.
          this.urlHashes.set(slot.id, urlHash(slot.page.url()));
          await this.persistTabs();
        }
        if (name === 'browser_observe') {
          // Only an assigned read-only source tab may probe an expired gate.
          // Reuse that tab once; record drafts and other workers stay untouched.
          if (sourceScope && !recordScope && /^https?:/.test(slot.page.url())) {
            const wait = this.siteAccess?.status(slot.page.url());
            if (
              (wait && !wait.waiting) ||
              (!wait && slot.http?.status === 429 && slot.accessChecked === slot.http)
            )
              await this.navigate(slot, checkedUrl(slot.page.url()));
          }
          value = await this.observe(slot);
        }
        if (name === 'browser_click_target') {
          const cookie =
            (await clickVerificationCheckbox(slot, args.targetId, owner)) ??
            (await clickCookieFrameTarget(slot, args.targetId, owner));
          if (cookie) value = {...(await this.observe(slot)), ...cookie};
          else {
            const target = takeClickTarget(slot, args.targetId, owner),
              tabsBefore = new Set(this.tabs.keys());
            // A radio/checkbox controlId from inspect_form selects that answer.
            const choice =
              !target && slot.controls?.get(args.targetId)?.kind === 'control'
                ? await selectChoice(slot, {controlId: args.targetId}, owner, this.reader)
                : null;
            value = target
              ? await this.withOpenedTab(slot, tabsBefore, await this.execute(slot, target))
              : choice
                ? {...(await this.observe(slot)), ...choice}
                : {
                    ...(await this.observe(slot)),
                    status: 'stale',
                    executed: false,
                    message: 'The click target is stale; use the current clickTargets list.',
                  };
          }
        }
        if (name === 'browser_inspect_form' && slot.verification?.handoff)
          return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
        if (name === 'browser_inspect_form') {
          const observation = await this.observe(slot);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  browser: 'Jev Chrome',
                  tabId: slot.id,
                  url: slot.page.url(),
                  uploads: observation.uploads,
                  ...(await inspectApplicationForm(slot.page, slot)),
                }),
              },
            ],
          };
        }
        if (
          [
            'browser_reveal',
            'browser_scroll',
            'browser_choose_option',
            'browser_list_options',
          ].includes(name)
        ) {
          // A custom dropdown (no native SELECT) lists and selects through its popup.
          const saved = slot.controls?.get(args.controlId),
            dropdown =
              ['browser_choose_option', 'browser_list_options'].includes(name) &&
              saved?.kind === 'control' &&
              slot.observed?.controls?.some(
                (c) => c.node === saved.node && c.autocomplete && !c.nativeSelect,
              );
          const result = dropdown
            ? await selectAutocomplete(
                slot,
                {
                  controlId: args.controlId,
                  ...(args.option !== undefined ? {option: args.option} : {}),
                },
                owner,
                this.reader,
              )
            : await navigateObserved(slot, name, args, owner, this.reader);
          value = {...(await this.observe(slot)), ...result};
        }
        if (['browser_autocomplete', 'browser_list_suggestions'].includes(name)) {
          slot.rejectedControlIds ??= new Set();
          const repeated = slot.rejectedControlIds.has(args.controlId);
          const result = repeated
            ? {
                status: 'no_progress',
                executed: false,
                retryable: false,
                message:
                  'The same invalid controlId was sent again; nothing was done. Drop this id. Choose the current target for the right question from availableTargets; if there is none, make it visible or report the unsupported control as a technical blocker.',
              }
            : await selectAutocomplete(slot, args, owner, this.reader);
          // Only an id that no longer matches its control is refused again; a
          // missed option click leaves the control and its id valid.
          if (result === staleControl) {
            slot.rejectedControlIds.add(args.controlId);
            if (slot.rejectedControlIds.size > 100)
              slot.rejectedControlIds.delete(slot.rejectedControlIds.values().next().value);
          }
          const observation = await this.observe(slot);
          value = {
            ...observation,
            ...result,
            ...(['stale', 'no_progress', 'unsupported'].includes(result.status)
              ? {
                  rejectedControlId: args.controlId,
                  availableTargets: observation.controls
                    .filter((c) => c.autocomplete || c.nativeSelect)
                    .map(({controlId, label, recommendedTool}) => ({
                      controlId,
                      label,
                      recommendedTool,
                    })),
                }
              : {}),
          };
        }
        if (name === 'browser_select_choice') {
          const result = await selectChoice(slot, args, owner, this.reader);
          value = {...(await this.observe(slot)), ...result};
        }
        if (name === 'browser_fill_fields') {
          const result = await fillKnownFields(slot, args.fields, owner, this.reader);
          const observed = await this.observe(slot).catch(() => ({
            browser: 'Jev Chrome',
            tabId: slot.id,
            observationUnavailable: true,
          }));
          value = {...observed, ...result};
        }
        if (name === 'browser_next') {
          const page = await this.observe(slot);
          if (slot.verification?.handoff)
            return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
          const decision = await this.choose(slot.observed, args.goal, slot.history, {
            ...(await this.config()),
            signal: this.abort.signal,
          });
          const action = decision.action,
            key =
              action &&
              JSON.stringify([action.kind, action.node, action.value, action.delta, undefined]);
          const repeated =
            action &&
            action.kind !== 'fill' &&
            action.kind !== 'wait' &&
            (blockedRepeat(slot, key, progressKey(slot.observed)) ||
              (action.choice &&
                blockedRepeat(slot, choiceKey(action.node), progressKey(slot.observed))));
          const decisionId = repeated ? undefined : randomUUID();
          slot.pending = repeated
            ? null
            : {...decision, decisionId, observed: slot.observed, owner};
          value = {
            browser: page.browser,
            tabId: slot.id,
            url: page.url,
            title: page.title,
            textExcerpt: page.text.slice(0, 2000),
            observationMode: 'decision',
            status: 'proposed',
            ...(slot.verification ? {verification: slot.verification} : {}),
            decisionId,
            operation: decision.operation,
            action: decision.action
              ? {
                  label: decision.action.label,
                  kind: decision.action.kind,
                  role: decision.action.role,
                  value: decision.action.value,
                  checked: decision.action.checked,
                  pressed: decision.action.pressed,
                  choice: decision.action.choice,
                }
              : null,
            needsText: decision.operation === 'TYPE_TEXT',
            confidence: decision.confidence,
            latency_ms: decision.latency_ms,
          };
          if (repeated)
            value = {...value, ...stalled, operation: 'BLOCKED', action: null, needsText: false};
          if (value.operation === 'BLOCKED')
            value = {
              ...value,
              clickTargets: page.clickTargets,
              controls: page.controls,
              scrollTargets: page.scrollTargets,
              recovery:
                'Inspect current targets and any overlay before reporting a blocker. Use browser_interact click for an authorized observed target, reveal an offscreen control, or screenshot to diagnose occlusion. Verify the resulting form; never repeat an uncertain submission.',
            };
        }
        if (name === 'browser_act') {
          const pending = slot.pending;
          if (!pending || pending.owner !== owner || pending.decisionId !== args.decisionId)
            throw Error(
              'There is no valid Jev decision for this session. Call browser_next first.',
            );
          if (pending.operation === 'TYPE_TEXT' && typeof args.text !== 'string')
            throw Error(
              'The AutoJob agent must supply the text value to type. No separate API key is needed.',
            );
          if (pending.operation !== 'TYPE_TEXT' && args.text !== undefined)
            throw Error('This action does not accept text.');
          slot.pending = null;
          value = await this.execute(slot, pending, args.text);
        }
        if (
          name === 'browser_upload' &&
          !slot.uploads.has(args.uploadId) &&
          slot.clickTargets?.has(args.uploadId)
        )
          value = await this.uploadThroughChooser(slot, args, owner);
        else if (name === 'browser_upload') {
          if (!path.isAbsolute(args.filePath)) throw Error('The file path must be absolute.');
          const upload = slot.uploads.get(args.uploadId);
          if (!upload)
            throw Error(
              'This id is not a file upload on the current page. Use an uploads[].uploadId, or the targetId (from clickTargets) of the upload button.',
            );
          if (upload.owner !== owner || upload.url !== slot.page.url())
            throw Error('The file field changed; observe the page again.');
          if (
            upload.frame &&
            (upload.frame.url() !== upload.frameUrl ||
              (upload.frame !== slot.page.mainFrame() &&
                !(await usableFormFrame(upload.frame, slot.page))))
          )
            throw Error('The frame of the file field changed; observe again.');
          const current = await upload.input.evaluate(uploadDetails);
          if (JSON.stringify(current) !== JSON.stringify(upload.details))
            throw Error('The file field changed; observe the page again.');
          const {realpath, stat} = await import('node:fs/promises');
          const file = await realpath(args.filePath),
            workspace = await realpath(this.workspace ?? this.directory);
          if (!file.startsWith(workspace + path.sep) || !(await stat(file)).isFile())
            throw Error('Only files in the workspace of this candidate can be uploaded.');
          const info = await stat(file),
            name = await this.uploadName(file, workspace, info.size, upload.details.label);
          slot.pending = null;
          slot.uploads.delete(args.uploadId);
          try {
            const selected = await upload.input.evaluate((e) =>
              [...e.files].map((f) => ({
                name: f.name,
                size: f.size,
                lastModified: f.lastModified,
              })),
            );
            const alreadySelected =
              selected.length === 1 &&
              selected[0].name === name &&
              selected[0].size === info.size &&
              (name === path.basename(file)
                ? selected[0].lastModified === Math.trunc(info.mtimeMs)
                : await selectedFileMatches(upload.input, file));
            const key = JSON.stringify([upload.url, upload.details, file, info.size, info.mtimeMs]);
            if (alreadySelected)
              value = {
                ...(await this.observe(slot)),
                status: 'ready',
                executed: false,
                message:
                  'The file is already selected; it was not uploaded again. This is not proof that the server accepted the file; check the current upload status on the site.',
              };
            else if (!takeUploadAttempt(slot, key))
              value = {
                tabId: slot.id,
                status: 'no_progress',
                executed: false,
                message:
                  'The limit of two attempts or 60 seconds for the same file/field was reached. Keep the draft and report the actual technical blocker; do not open the file chooser again.',
              };
            else {
              await upload.input.setInputFiles(await uploadFile(file, name), {timeout: 10000});
              value = {
                ...(await this.observe(slot)),
                status: 'ready',
                executed: true,
                uploadedFileName: name,
              };
            }
          } catch {
            value = {
              tabId: slot.id,
              status: 'uncertain',
              message:
                'Could not verify the upload; observe the page before retrying. At most two attempts and 60 seconds for the same file/field.',
            };
          } finally {
            await upload.input.dispose().catch(() => {});
          }
        }
      }
      const slot = this.tabs.get(value?.tabId);
      if (slot) {
        value = presentObservation(
          slot,
          value,
          args.scope === 'document'
            ? {full: true, standalone: true}
            : observationPolicy(name, args, value.status),
        );
        if (name === 'browser_observe' && args.scope === 'document')
          value = await retryJevRead(slot.page, async (attempt) => {
            const observed = attempt
              ? presentObservation(slot, await this.observe(slot), {full: true, standalone: true})
              : value;
            return documentObservation(slot, observed);
          });
        if (
          name === 'browser_observe' &&
          args.full === true &&
          !args.fullReason &&
          value.observationMode === 'compact'
        )
          value.observationHint =
            'Current control maps are complete replacements; no baseline is needed to act. Reuse these IDs. Only lost page prose requires fullReason:context_loss.';
      }
      return {content: [{type: 'text', text: JSON.stringify(value)}]};
    } catch (error) {
      if (error.code !== 'SITE_WAIT') throw error;
      const url = error.url ?? args.url ?? this.tabs.get(args.tabId)?.page.url();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              browser: 'Jev Chrome',
              status: 'site_wait',
              url,
              tabId: error.tabId ?? args.tabId,
              siteWait: error.wait,
              ...(error.captcha ? {captcha: error.captcha} : {}),
              text: error.message,
              message: error.message,
              executed: error.executed ?? false,
            }),
          },
        ],
      };
    } finally {
      await releaseRendering?.();
      if (this.readSignal === signal) this.readSignal = null;
      this.siteLane = undefined;
    }
  }
  async focus(id) {
    await this.context();
    await this.bringToFront(this.tab(id));
    return {focused: true};
  }
  // Selects the tab and raises its window. Through the extension this uses the
  // tabs and windows APIs; Page.bringToFront does neither reliably there.
  async bringToFront(slot) {
    if (this.connection === 'existing' && this.transport?.activate) {
      await this.transport.activate(slot.id);
      await this.activateChrome().catch(() => {});
    } else await slot.page.bringToFront();
  }
  async close({closeTabs = false} = {}) {
    this.closed = true;
    this.abort.abort();
    const closed = [],
      failed = [];
    if (closeTabs && this.connection === 'existing' && this.transport) {
      // The ownership set includes restored tabs and tabs opened by pages.
      // Never close other tabs in the user's Chrome profile.
      const ids = [...this.transport.owned].sort(
        (a, b) => (a === this.homeId) - (b === this.homeId),
      );
      for (const id of ids) {
        try {
          if (!(await this.transport.closeTarget(id))) throw Error('Chrome did not close the tab');
          this.forgetTab(id);
          closed.push(id);
        } catch {
          failed.push(id);
        }
      }
      logTab('quit', {workspace: this.workspaceId, closed: closed.length, failed});
      if (closed.length)
        try {
          await this.persistTabs();
        } catch (error) {
          console.warn('Could not save the closed Chrome tabs:', error);
        }
    }
    this.transport?.close();
    const context = await this.opening?.catch(() => null);
    if (this.connection === 'existing') await this.browser?.close();
    else await context?.close();
    this.relay?.close();
    this.relay = null;
    this.tabs.clear();
    return {closed, failed};
  }
}
