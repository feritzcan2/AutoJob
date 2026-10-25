import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export const RELEASES_URL = 'https://api.github.com/repos/feritzcan2/AutoJob/releases?per_page=20';
const CHECK_INTERVAL = 10 * 60_000;
const versionParts = (value) =>
  String(value)
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number(part) || 0);
export function compareVersions(a, b) {
  const x = versionParts(a),
    y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
// Published releases newer than the installed version, newest first.
export async function newerReleases(version, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(RELEASES_URL, {
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'AutoJob'},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Error(`The releases list could not be read (HTTP ${response.status}).`);
  const list = await response.json();
  return (Array.isArray(list) ? list : [])
    .filter((release) => !release.draft && !release.prerelease && release.tag_name)
    .map((release) => ({
      version: String(release.tag_name).replace(/^v/, ''),
      name: String(release.name || release.tag_name).slice(0, 200),
      publishedAt: release.published_at ?? null,
      url: String(release.html_url ?? ''),
    }))
    .filter((release) => compareVersions(release.version, version) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
export function createUpdateManager({
  app,
  beforeInstall,
  onChange = () => {},
  updater,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  autoCheck = false,
  installTimeout = 5 * 60_000,
}) {
  const enabled = Boolean(app.isPackaged) && (platform !== 'linux' || Boolean(env.APPIMAGE));
  let state = {
    enabled,
    status: enabled ? 'idle' : 'unsupported',
    version: app.getVersion(),
    availableVersion: null,
    progress: null,
    error: null,
    releases: [],
    checkedAt: null,
  };
  let busy = false,
    disposed = false,
    restartAfterInstall = false,
    timers = [];
  const publish = (patch) => {
    if (disposed) return;
    state = {...state, ...patch};
    onChange({...state});
  };
  const readReleases = async () => {
    const releases = await newerReleases(state.version, fetchImpl);
    publish({releases, checkedAt: Date.now()});
    return releases;
  };
  // Checks run as soon as the app opens and then every 10 minutes, also in the background.
  const schedule = (check) => {
    if (!autoCheck) return;
    const run = () => check({quiet: true}).catch(() => {});
    timers = [setTimeout(run, 0), setInterval(run, CHECK_INTERVAL)];
    for (const timer of timers) timer.unref?.();
  };
  const stopTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  if (!enabled) {
    let checking = false;
    // Without an in-app updater the releases list is the check.
    const check = async ({quiet = false} = {}) => {
      if (checking) return {...state};
      checking = true;
      const previous = state.status;
      if (!quiet) publish({status: 'checking', error: null});
      try {
        const [latest] = await readReleases();
        publish({
          status: latest ? 'available' : 'current',
          availableVersion: latest?.version ?? null,
          error: null,
        });
      } catch (error) {
        if (quiet) publish({status: previous});
        else publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)});
        if (!quiet) throw error;
      } finally {
        checking = false;
      }
      return {...state};
    };
    schedule(check);
    return {
      snapshot: () => ({...state}),
      check: () => check(),
      download: async () => {
        throw Error('Automatic updates are not supported in this installation.');
      },
      install: async () => {
        throw Error('Automatic updates are not supported in this installation.');
      },
      restartRequested: () => false,
      prepareQuitInstall: async () => null,
      dispose: () => {
        disposed = true;
        stopTimers();
      },
    };
  }
  const client = updater ?? require('electron-updater').autoUpdater;
  client.autoDownload = false;
  client.autoInstallOnAppQuit = false;
  client.allowDowngrade = false;
  client.allowPrerelease = false;
  const listeners = {
    'checking-for-update': () => publish({status: 'checking', error: null}),
    'update-available': (info) =>
      publish({status: 'available', availableVersion: info.version, progress: null, error: null}),
    'update-not-available': () =>
      publish({status: 'current', availableVersion: null, progress: null, error: null}),
    'download-progress': (info) =>
      publish({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, Number(info.percent) || 0)),
      }),
    'update-downloaded': (info) =>
      publish({status: 'downloaded', availableVersion: info.version, progress: 100, error: null}),
    error: (error) =>
      publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)}),
  };
  for (const [event, listener] of Object.entries(listeners)) client.on(event, listener);
  async function action(fn) {
    if (busy) throw Error('An update is in progress.');
    busy = true;
    try {
      await fn();
      return {...state};
    } catch (error) {
      publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)});
      throw error;
    } finally {
      busy = false;
    }
  }
  const check = async ({quiet = false} = {}) => {
    if (quiet && busy) return {...state};
    if (quiet && ['available', 'downloading', 'downloaded', 'installing'].includes(state.status))
      return readReleases().then(() => ({...state}));
    const result = action(async () => {
      await Promise.all([client.checkForUpdates(), readReleases().catch(() => {})]);
    }).then((next) => {
      // A found update downloads in the background; it installs when the app quits.
      if (autoCheck && state.status === 'available') download().catch(() => {});
      return next;
    });
    return quiet ? result.catch(() => ({...state})) : result;
  };
  const download = () =>
    action(async () => {
      if (state.status !== 'available') throw Error('No update available to download.');
      publish({status: 'downloading', progress: 0, error: null});
      await client.downloadUpdate();
    });
  schedule(check);
  return {
    snapshot: () => ({...state}),
    check: () => check(),
    download,
    // Installing now quits the app: quitting stops all running work, then
    // prepareQuitInstall backs up the data and installs, reopening the app.
    // A release published after the download replaces it first, so the newest
    // version installs; when the check fails the downloaded version installs.
    install: async () => {
      if (state.status !== 'downloaded') throw Error('Download the update first.');
      const downloaded = state.availableVersion;
      await action(async () => {
        publish({status: 'checking', error: null});
        const newest = await Promise.resolve()
          .then(() => client.checkForUpdates())
          .then((result) => result?.updateInfo?.version ?? null)
          .catch(() => null);
        if (newest && compareVersions(newest, downloaded) > 0) {
          publish({status: 'downloading', availableVersion: newest, progress: 0, error: null});
          await client.downloadUpdate();
        } else
          publish({status: 'downloaded', availableVersion: downloaded, progress: 100, error: null});
      });
      restartAfterInstall = true;
      publish({status: 'installing', error: null});
      setImmediate(() => app.quit());
      return {...state};
    },
    // True when the user asked to install now, so the app reopens afterwards
    // even if the install could not run.
    restartRequested: () => restartAfterInstall,
    // Called while the app quits, after running work stopped: backs up the data,
    // then returns the step that installs the downloaded update (reopening the app
    // only when the user asked to install now). Null when there is nothing to
    // install or the backup failed; the download stays for the next start.
    // onFailure runs when the installer reports an error or never quits the app:
    // on macOS Squirrel unpacks and verifies the update only now, and when that
    // fails nothing quits the app, which stays open with its database closed.
    prepareQuitInstall: async ({onFailure} = {}) => {
      if (!['downloaded', 'installing'].includes(state.status)) return null;
      if (typeof beforeInstall !== 'function') return null;
      try {
        const release = await beforeInstall();
        return async () => {
          await release?.();
          client.autoRunAppAfterInstall = restartAfterInstall;
          if (onFailure) {
            const fail = (error) => {
              clearTimeout(timer);
              client.removeListener('error', fail);
              onFailure(error);
            };
            const timer = setTimeout(
              () => fail(Error('The update did not install in time.')),
              installTimeout,
            );
            timer.unref?.();
            client.once('error', fail);
          }
          client.quitAndInstall(true, restartAfterInstall);
        };
      } catch {
        return null;
      }
    },
    dispose: () => {
      disposed = true;
      stopTimers();
      for (const [event, listener] of Object.entries(listeners))
        client.removeListener(event, listener);
    },
  };
}
