import {dialog, shell} from 'electron';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectReadiness} from './readiness.mjs';
import {extensionInstalledInProfile, resolveChromeProfile} from '../jev/chrome.mjs';
import {engineBinaryPath} from './runtime-paths.mjs';
import {createUpdateManager} from './update-manager.mjs';
import {
  createBackup,
  inspectBackup,
  stageRestore,
  pruneLogs,
  dataManagementStatus,
} from './data-management.mjs';
import {requestDataLocation, requestExistingDataLocation} from './data-location.mjs';

export async function registerSettingsServices({
  app,
  root,
  data,
  bootstrapDirectory = data,
  store,
  jevSettings,
  handle,
  window,
  maintenance,
  emit,
  clearTerminalOutputs,
  activeRunIds,
}) {
  const params = {dataDirectory: data, db: store.db, appVersion: app.getVersion()};
  handle('readiness', (input) =>
    collectReadiness(input, {
      enginePath: engineBinaryPath({root}),
      jevStatus: () => jevSettings.status(),
    }),
  );
  handle('extension-installed', async (profile) => {
    if (profile !== undefined && (typeof profile !== 'string' || !/^[\w -]{1,100}$/.test(profile)))
      throw Error('Invalid Chrome profile.');
    try {
      return await extensionInstalledInProfile(
        await resolveChromeProfile(profile ? {directory: profile} : undefined),
      );
    } catch {
      return false;
    }
  });
  handle('jev-settings-status', () => jevSettings.status());
  handle('jev-settings-save', (input) => jevSettings.save(input));
  handle('jev-settings-remove', () => jevSettings.remove());
  handle('jev-settings-test', () => jevSettings.testConnection());
  handle('data-status', async () => ({...(await dataManagementStatus(params)), directory: data}));
  handle('data-open-directory', async () => {
    const error = await shell.openPath(data);
    if (error) throw Error(error);
    return {opened: true};
  });
  let choosingDirectory = false;
  handle('data-use-directory', async () => {
    if (choosingDirectory) throw Error('A data folder chooser is already open.');
    choosingDirectory = true;
    try {
      const selected = await dialog.showOpenDialog(window(), {
        title: 'Choose an existing AutoJob data folder',
        buttonLabel: 'Open and restart',
        properties: ['openDirectory'],
      });
      if (selected.canceled) return null;
      const result = await requestExistingDataLocation({
        bootstrapDirectory,
        dataDirectory: data,
        destination: selected.filePaths[0],
      });
      if (result.restartRequired) {
        app.relaunch();
        app.quit();
      }
      return result;
    } finally {
      choosingDirectory = false;
    }
  });
  handle('data-change-directory', async () => {
    if (choosingDirectory) throw Error('A data folder chooser is already open.');
    choosingDirectory = true;
    try {
      const selected = await dialog.showOpenDialog(window(), {
        title: 'Choose an empty folder to move the data to',
        buttonLabel: 'Move and restart',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selected.canceled) return null;
      const result = await requestDataLocation({
        bootstrapDirectory,
        dataDirectory: data,
        destination: selected.filePaths[0],
      });
      if (result.restartRequired) {
        app.relaunch();
        app.quit();
      }
      return result;
    } finally {
      choosingDirectory = false;
    }
  });
  handle('data-backup', () =>
    maintenance.run(async () => {
      const selected = await dialog.showOpenDialog(window(), {
        title: 'Choose a folder to save the backup in',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selected.canceled) return null;
      return createBackup({
        ...params,
        destination: path.join(
          selected.filePaths[0],
          `AutoJob-backup-${Date.now()}-${randomUUID().slice(0, 8)}`,
        ),
        kind: 'manual',
      });
    }),
  );
  handle('data-restore', async () => {
    // Keep the maintenance lock only once a validated restore is staged.
    let restart = false;
    const result = await maintenance.run(
      async () => {
        const selected = await dialog.showOpenDialog(window(), {
          title: 'Choose an AutoJob backup folder',
          properties: ['openDirectory'],
        });
        if (selected.canceled) return null;
        const directory = selected.filePaths[0],
          preview = await inspectBackup(directory);
        const answer = await dialog.showMessageBox(window(), {
          type: 'warning',
          buttons: ['Cancel', 'Restore and restart'],
          defaultId: 0,
          cancelId: 0,
          title: 'Restore backup',
          message:
            'Current automations, templates, candidates and result records will be replaced by this backup.',
          detail: `A recovery backup of the current data is taken first. Active tasks open paused. An older backup may not include later operations; check the results before continuing. Retry the automations; with portable backups, portal passwords, Telegram and the Jev key must be entered again.\n\nBackup: ${directory}\n${preview.candidates ?? preview.summary?.candidates ?? '?'} candidates · ${preview.jobs ?? preview.summary?.jobs ?? '?'} listings`,
        });
        if (answer.response !== 1) return null;
        const staged = await stageRestore({...params, directory});
        restart = true;
        return staged;
      },
      {hold: () => restart},
    );
    if (restart) {
      app.relaunch();
      app.quit();
    }
    return result;
  });
  handle('data-clear-logs', async () => {
    const result = await maintenance.run(async () => {
      const result = await pruneLogs({...params, clear: true});
      clearTerminalOutputs();
      return result;
    });
    emit('changed', {});
    return result;
  });
  handle('data-open-backups', async () => {
    const directory = path.join(data, 'backups');
    await mkdir(directory, {recursive: true, mode: 0o700});
    const error = await shell.openPath(directory);
    if (error) throw Error(error);
    return {opened: true};
  });
  const updates = createUpdateManager({
    app,
    autoCheck: process.env.JOBLOOP_UPDATE_CHECK !== 'off',
    onChange: (state) => emit('update-status', state),
    // Runs while the app quits, after every agent, scan and browser task stopped,
    // so it backs up directly instead of waiting for idle work.
    beforeInstall: async () => {
      const directory = path.join(data, 'backups');
      await mkdir(directory, {recursive: true, mode: 0o700});
      await createBackup({
        ...params,
        destination: path.join(
          directory,
          `before-update-${Date.now()}-${randomUUID().slice(0, 8)}`,
        ),
        kind: 'upgrade',
      });
    },
  });
  handle('update-status', () => updates.snapshot());
  handle('update-check', () => updates.check());
  handle('update-download', () => updates.download());
  handle('update-install', () => updates.install());
  const prune = () => pruneLogs({...params, activeBackgroundRunIds: activeRunIds()});
  await prune();
  let pruning = false;
  const timer = setInterval(
    async () => {
      if (maintenance.busy || pruning) return;
      pruning = true;
      try {
        await maintenance.invoke('log-retention', prune);
      } catch (error) {
        emit('agent-event', {event: 'error', error: error.message});
      } finally {
        pruning = false;
      }
    },
    60 * 60 * 1000,
  );
  timer.unref();
  return {
    dispose() {
      clearInterval(timer);
      updates.dispose();
    },
    // The downloaded update's version, while it waits to install.
    downloadedUpdate: () =>
      updates.snapshot().status === 'downloaded' ? updates.snapshot().availableVersion : null,
    updateVersion: () => updates.snapshot().availableVersion,
    installUpdate: () => updates.install(),
    prepareQuitInstall: (options) => updates.prepareQuitInstall(options),
    restartRequested: () => updates.restartRequested(),
  };
}
