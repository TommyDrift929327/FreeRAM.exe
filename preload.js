'use strict';

/**
 * Pont sécurisé entre le renderer (sandboxé, sans Node.js) et le processus
 * principal. Aucune fonction générique n'est exposée : uniquement les actions
 * prévues par l'application.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld(
  'freeRAM',
  Object.freeze({
    bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
    refresh: () => ipcRenderer.invoke('app:refresh'),
    listProcesses: () => ipcRenderer.invoke('processes:list'),
    closeProcesses: (pids, options = {}) =>
      ipcRenderer.invoke('processes:close', {
        pids,
        force: options.force !== false
      }),
    trimMemory: (pids = []) => ipcRenderer.invoke('memory:trim', { pids }),
    createShortcut: () => ipcRenderer.invoke('app:create-shortcut'),
    openPath: (key) => ipcRenderer.invoke('app:open-path', { key }),
    relaunchAsAdmin: () => ipcRenderer.invoke('app:relaunch-admin'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    reloadUi: () => ipcRenderer.invoke('app:reload-ui'),
    sensorStatus: () => ipcRenderer.invoke('sensors:status'),
    getUpdateState: () => ipcRenderer.invoke('updates:get-state'),
    checkForUpdates: () => ipcRenderer.invoke('updates:check'),
    downloadUpdate: () => ipcRenderer.invoke('updates:download'),
    installUpdate: () => ipcRenderer.invoke('updates:install'),
    setUpdateChannel: (channel) => ipcRenderer.invoke('updates:set-channel', { channel }),
    openGithub: () => ipcRenderer.invoke('updates:open-github'),
    getBuildCapability: () => ipcRenderer.invoke('build:capability'),
    startBuild: (channel) => ipcRenderer.invoke('build:start', { channel }),
    getBuildStatus: () => ipcRenderer.invoke('build:status'),
    openBuildLog: () => ipcRenderer.invoke('build:open-log'),
    onUpdateStatus: (callback) => subscribe('updates:status', callback),
    onTelemetry: (callback) => subscribe('telemetry:update', callback),
    onProcesses: (callback) => subscribe('processes:update', callback),
    onProcessesError: (callback) => subscribe('processes:error', callback),
    onSensors: (callback) => subscribe('sensors:update', callback),
    onSensorStatus: (callback) => subscribe('sensor-status', callback),
    onCloseProgress: (callback) => subscribe('close:progress', callback),
    onMonitorPaused: (callback) => subscribe('monitor:paused', callback)
  })
);
