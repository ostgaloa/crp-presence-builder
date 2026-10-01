const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('crpBridge', {
  appName: 'CRP',
  ready: true,
  minimizeWindow: () => ipcRenderer.invoke('crp:windowMinimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('crp:windowToggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('crp:windowClose'),
  selfbotStatus: () => ipcRenderer.invoke('crp:selfbotStatus'),
  onSelfbotAccountsUpdated: (callback) => {
    const listener = (_event, accounts) => callback(accounts)
    ipcRenderer.on('crp:accountsUpdated', listener)
    return () => ipcRenderer.removeListener('crp:accountsUpdated', listener)
  },
  onSelfbotConnectionProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('crp:selfbotConnectionProgress', listener)
    return () => ipcRenderer.removeListener('crp:selfbotConnectionProgress', listener)
  },
  getDebugLogs: () => ipcRenderer.invoke('crp:debugLogsGet'),
  clearDebugLogs: () => ipcRenderer.invoke('crp:debugLogsClear'),
  logDebugMessage: (level, message) => ipcRenderer.invoke('crp:debugLog', level, message),
  openDebugConsole: () => ipcRenderer.invoke('crp:debugConsoleOpen'),
  getDebugWindowLogs: () => ipcRenderer.invoke('crp:debugWindowLogsGet'),
  clearDebugWindowLogs: () => ipcRenderer.invoke('crp:debugWindowLogsClear'),
  writeDebugClipboardText: (content) => ipcRenderer.invoke('crp:debugClipboardWrite', content),
  minimizeDebugWindow: () => ipcRenderer.invoke('crp:debugWindowMinimize'),
  toggleMaximizeDebugWindow: () => ipcRenderer.invoke('crp:debugWindowToggleMaximize'),
  closeDebugWindow: () => ipcRenderer.invoke('crp:debugWindowClose'),
  onDebugLog: (callback) => {
    const listener = (_event, entry) => callback(entry)
    ipcRenderer.on('crp:debugLog', listener)
    return () => ipcRenderer.removeListener('crp:debugLog', listener)
  },
  onDebugLogsCleared: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('crp:debugLogsCleared', listener)
    return () => ipcRenderer.removeListener('crp:debugLogsCleared', listener)
  },
  connectSelfbot: (token) => ipcRenderer.invoke('crp:selfbotConnect', token),
  reconnectSelfbot: (accountId) => ipcRenderer.invoke('crp:selfbotReconnect', accountId),
  disconnectSelfbotAccount: (accountId) => ipcRenderer.invoke('crp:selfbotDisconnectAccount', accountId),
  connectAllSelfbotAccounts: () => ipcRenderer.invoke('crp:selfbotConnectAll'),
  disconnectAllSelfbotAccounts: () => ipcRenderer.invoke('crp:selfbotDisconnectAll'),
  publishSelfbotPresence: (activities) => ipcRenderer.invoke('crp:selfbotPresence', activities),
  disconnectSelfbot: () => ipcRenderer.invoke('crp:selfbotDisconnect'),
  forgetSelfbotAccount: (accountId) => ipcRenderer.invoke('crp:selfbotForgetAccount', accountId),
  saveAppSettings: (settings) => ipcRenderer.invoke('crp:saveAppSettings', settings),
  listPresets: () => ipcRenderer.invoke('crp:listPresets'),
  savePreset: (name, content) => ipcRenderer.invoke('crp:savePreset', name, content),
  loadPreset: (name) => ipcRenderer.invoke('crp:loadPreset', name),
  deletePreset: (name) => ipcRenderer.invoke('crp:deletePreset', name),
  readClipboardText: () => ipcRenderer.invoke('crp:clipboardRead'),
  writeClipboardText: (content) => ipcRenderer.invoke('crp:clipboardWrite', content),
})