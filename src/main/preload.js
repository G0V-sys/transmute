'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('transmute', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // Drive operations
  scanDrives: () => ipcRenderer.invoke('scan-drives'),
  getDriveDetails: (device) => ipcRenderer.invoke('get-drive-details', device),
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),

  // Staging
  getStagingLocations: () => ipcRenderer.invoke('get-staging-locations'),
  validateStaging: (opts) => ipcRenderer.invoke('validate-staging', opts),
  scanRecoveryStaging: () => ipcRenderer.invoke('scan-recovery-staging'),
  validateRecoveryStaging: (path) => ipcRenderer.invoke('validate-recovery-staging', path),

  // Conversion
  startConversion: (opts) => ipcRenderer.invoke('start-conversion', opts),
  cancelConversion: (jobId) => ipcRenderer.invoke('cancel-conversion', jobId),
  getJobStatus: (jobId) => ipcRenderer.invoke('get-job-status', jobId),

  // Novel Recovery Archeology
  probeArcheology: (devicePath) => ipcRenderer.invoke('probe-archeology', devicePath),
  performArcheologyRecovery: (opts) => ipcRenderer.invoke('perform-archeology-recovery', opts),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  showSkippedFiles: (logPath) => ipcRenderer.invoke('show-skipped-files', logPath),

  // File dialog
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Events from main -> renderer
  on: (channel, callback) => {
    const allowed = [
      'conversion-progress',
      'conversion-log',
      'conversion-complete',
      'conversion-error',
      'conversion-cancelled'
    ];
    if (allowed.includes(channel)) {
      const sub = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  },
  off: (channel, callback) => ipcRenderer.removeListener(channel, callback)
});
