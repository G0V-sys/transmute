'use strict';

const { ipcMain } = require('electron');
const { scanDrives, getDriveDetails, getAvailableSpace } = require('../backend/driveScanner');
const { checkDependencies } = require('../backend/depChecker');
const { getStagingLocations, validateStaging } = require('../backend/stagingValidator');
const { startConversion, cancelConversion, getJobStatus } = require('../backend/conversionEngine');
const { loadHistory, addEntry, clearHistory } = require('../backend/historyStore');
const { scanForStagingData, validateStagingCandidate, probePartitionArcheology, performArcheologicalRecovery } = require('../backend/recoveryEngine');

let mainWindowRef = null;

function setupIPC(win) {
  if (win) mainWindowRef = win;

  // ── Drive scanning ────────────────────────────────────────────────────────
  ipcMain.removeHandler('scan-drives');
  ipcMain.handle('scan-drives', async () => {
    try {
      return { ok: true, drives: await scanDrives() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('get-drive-details');
  ipcMain.handle('get-drive-details', async (_, devicePath) => {
    try {
      return { ok: true, details: await getDriveDetails(devicePath) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Dependency check ──────────────────────────────────────────────────────
  ipcMain.removeHandler('check-dependencies');
  ipcMain.handle('check-dependencies', async () => {
    try {
      return { ok: true, deps: await checkDependencies() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Staging ───────────────────────────────────────────────────────────────
  ipcMain.removeHandler('get-staging-locations');
  ipcMain.handle('get-staging-locations', async () => {
    try {
      return { ok: true, locations: await getStagingLocations() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('validate-staging');
  ipcMain.handle('validate-staging', async (_, opts) => {
    try {
      return { ok: true, result: await validateStaging(opts) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Recovery ──────────────────────────────────────────────────────────────
  ipcMain.removeHandler('scan-recovery-staging');
  ipcMain.handle('scan-recovery-staging', async () => {
    try {
      return { ok: true, candidates: await scanForStagingData() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('validate-recovery-staging');
  ipcMain.handle('validate-recovery-staging', async (_, path) => {
    try {
      return { ok: true, result: await validateStagingCandidate(path) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Novel Recovery Archeology ─────────────────────────────────────────────
  ipcMain.removeHandler('probe-archeology');
  ipcMain.handle('probe-archeology', async (_, devicePath) => {
    try {
      return { ok: true, findings: await probePartitionArcheology(devicePath) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('perform-archeology-recovery');
  ipcMain.handle('perform-archeology-recovery', async (_, { devicePath, targetFs, password }) => {
    try {
      return await performArcheologicalRecovery(devicePath, targetFs, password);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Conversion ────────────────────────────────────────────────────────────
  ipcMain.removeHandler('start-conversion');
  ipcMain.handle('start-conversion', async (_, opts) => {
    try {
      const { password, ...conversionOpts } = opts;
      const jobId = await startConversion(conversionOpts, {
        onProgress: (data) => {
          getWindow()?.webContents.send('conversion-progress', data);
        },
        onLog: (data) => {
          getWindow()?.webContents.send('conversion-log', data);
        },
        onComplete: (data) => {
          addEntry({
            jobId: data.jobId,
            sourcePath: data.sourcePath,
            sourceFs: data.sourceFs,
            targetFs: data.targetFs,
            newUuid: data.newUuid,
            duration: data.duration,
            stagingPath: conversionOpts.stagingPath,
            stagingType: conversionOpts.stagingType,
            skippedFilesLog: data.skippedFilesLog,
            date: new Date().toISOString(),
            status: 'success'
          });
          getWindow()?.webContents.send('conversion-complete', data);
        },
        onError: (data) => {
          if (!data.cancelled) {
            addEntry({
              jobId: data.jobId,
              sourcePath: conversionOpts.sourcePath,
              sourceFs: conversionOpts.sourceFs,
              targetFs: conversionOpts.targetFs,
              stagingPath: conversionOpts.stagingPath,
              stagingType: conversionOpts.stagingType,
              error: data.error,
              date: new Date().toISOString(),
              status: 'error'
            });
          }
          getWindow()?.webContents.send('conversion-error', data);
        }
      }, password);
      return { ok: true, jobId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('cancel-conversion');
  ipcMain.handle('cancel-conversion', async (_, jobId) => {
    const cancelled = cancelConversion(jobId);
    if (cancelled) {
      getWindow()?.webContents.send('conversion-cancelled', { jobId });
    }
    return { ok: true, cancelled };
  });

  ipcMain.removeHandler('get-job-status');
  ipcMain.handle('get-job-status', async (_, jobId) => {
    return { ok: true, status: getJobStatus(jobId) };
  });

  // ── History ───────────────────────────────────────────────────────────────
  ipcMain.removeHandler('get-history');
  ipcMain.handle('get-history', async () => {
    try {
      return { ok: true, history: loadHistory() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('clear-history');
  ipcMain.handle('clear-history', async () => {
    try {
      clearHistory();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.removeHandler('show-skipped-files');
  ipcMain.handle('show-skipped-files', async (_, logPath) => {
    try {
      const { shell } = require('electron');
      shell.showItemInFolder(logPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function getWindow() {
  return mainWindowRef;
}

module.exports = { setupIPC };
