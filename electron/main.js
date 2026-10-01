import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, safeStorage, session, clipboard } from 'electron'
import { randomUUID } from 'node:crypto'
import { mapWithConcurrency } from './asyncUtils.js'
import { deletePreset, listPresets, loadPreset, savePreset } from './presetStorage.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isRecord, normalizeAppSettings, requireAccountId, sanitizePresenceGroups } from './security.js'
import {
  clearSelfbotPresences,
  connectSelfbot,
  disconnectSelfbot,
  getConnectedSelfbotAccounts,
  publishSelfbotPresence,
} from './selfbotPresence.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow = null
let debugWindow = null
let tray = null
let autoConnectPromise = null
let accountMutationQueue = Promise.resolve()
const MAX_DEBUG_LOG_ENTRIES = 1337
const DEBUG_LOG_LEVELS = new Set(['STATUS', 'SUCCESS', 'WARN', 'ERROR'])
const debugLogEntries = []
let nextDebugLogId = 1

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

const isDev = !app.isPackaged

function getAccountConnectConcurrency(accountCount) {
  if (accountCount <= 2) return Math.max(1, accountCount)
  if (accountCount <= 10) return 2
  return 1
}

function addDebugLog(level, message) {
  if (!DEBUG_LOG_LEVELS.has(level) || typeof message !== 'string') return null
  const safeMessage = message
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .slice(0, 240)
  const entry = {
    id: nextDebugLogId++,
    timestamp: new Date().toISOString(),
    level,
    message: safeMessage,
  }
  debugLogEntries.push(entry)
  if (debugLogEntries.length > MAX_DEBUG_LOG_ENTRIES) debugLogEntries.shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('crp:debugLog', entry)
  }
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send('crp:debugLog', entry)
  }
  return entry
}

function selfbotAccountsPath() {
  return path.join(app.getPath('userData'), 'selfbot-accounts.bin')
}

function appSettingsPath() {
  return path.join(app.getPath('userData'), 'app-settings.json')
}

function presetsDirectoryPath() {
  return path.join(app.getPath('userData'), 'presets')
}

function appIconPath() {
  const builtIconPath = path.join(__dirname, '../dist/crp-app-icon.png')
  return fs.existsSync(builtIconPath) ? builtIconPath : path.join(__dirname, '../public/crp-app-icon.png')
}

function writeFileAtomically(filePath, data, encoding) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, data, { encoding, flag: 'wx', mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
    }
  }
}

function readAppSettings() {
  try {
    const settingsPath = appSettingsPath()
    const fileInfo = fs.lstatSync(settingsPath)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 64 * 1024) throw new Error('Invalid settings file.')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (!isRecord(settings)) throw new Error('Invalid settings data.')
    return normalizeAppSettings(settings)
  } catch {
    return normalizeAppSettings()
  }
}

function saveAppSettings(value) {
  const settings = normalizeAppSettings({ ...readAppSettings(), ...(isRecord(value) ? value : {}) })
  fs.mkdirSync(path.dirname(appSettingsPath()), { recursive: true })
  writeFileAtomically(appSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  return settings
}

function readSavedSelfbotAccounts() {
  if (!fs.existsSync(selfbotAccountsPath()) || !safeStorage.isEncryptionAvailable()) return []
  try {
    const fileInfo = fs.lstatSync(selfbotAccountsPath())
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 1024 * 1024) return []
    const accounts = JSON.parse(safeStorage.decryptString(fs.readFileSync(selfbotAccountsPath())))
    return Array.isArray(accounts) ? accounts.filter((account) => (
      isRecord(account)
      && typeof account.accountId === 'string'
      && /^\d{17,20}$/.test(account.accountId)
      && typeof account.username === 'string'
      && account.username.length <= 128
      && typeof account.token === 'string'
      && account.token.length <= 4096
    )).slice(0, 100) : []
  } catch {
    return []
  }
}

function saveSelfbotAccounts(accounts) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure token storage is unavailable on this device.')
  }
  if (!Array.isArray(accounts) || accounts.length > 100 || accounts.some((account) => (
    !isRecord(account)
    || typeof account.accountId !== 'string'
    || !/^\d{17,20}$/.test(account.accountId)
    || typeof account.username !== 'string'
    || account.username.length > 128
    || typeof account.token !== 'string'
    || account.token.length > 4096
  ))) throw new Error('Invalid saved account data.')
  const accountsPath = selfbotAccountsPath()
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true })
  writeFileAtomically(accountsPath, safeStorage.encryptString(JSON.stringify(accounts)))
}

function getPublicSelfbotAccounts() {
  const connectedIds = new Set(getConnectedSelfbotAccounts().map(({ accountId }) => accountId))
  return readSavedSelfbotAccounts().map(({ accountId, username }) => ({
    accountId,
    username,
    connected: connectedIds.has(accountId),
  }))
}

function assertTrustedIpcSender(event, targetWindow = mainWindow) {
  // ipc nur aus dem hauptfenster und dessen hauptframe akzeptieren
  const contents = targetWindow?.webContents
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || event.senderFrame.url !== contents.getURL()) {
    throw new Error('Blocked IPC from an untrusted renderer.')
  }
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedIpcSender(event)
      return await handler(event, ...args)
    } catch (error) {
      addDebugLog('ERROR', `${channel} failed.`)
      throw error
    }
  })
}

function handleTrustedDebugIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedIpcSender(event, debugWindow)
      return await handler(event, ...args)
    } catch (error) {
      addDebugLog('ERROR', `${channel} failed.`)
      throw error
    }
  })
}

function queueAccountMutation(operation) {
  const result = accountMutationQueue.then(operation, operation)
  accountMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function forgetSelfbotAccount(accountId) {
  disconnectSelfbot(accountId)
  saveSelfbotAccounts(readSavedSelfbotAccounts().filter((account) => account.accountId !== accountId))
}

function addSelfbotAccount(suppliedToken) {
  return queueAccountMutation(() => addSelfbotAccountNow(suppliedToken))
}

async function addSelfbotAccountNow(suppliedToken) {
  if (typeof suppliedToken !== 'string' || suppliedToken.length > 4096) {
    return { ok: false, message: 'Invalid account token.' }
  }
  const token = suppliedToken.trim()
  if (!token) return { ok: false, message: 'Enter account token(s).' }

  addDebugLog('STATUS', 'Account connection started.')
  const result = await connectSelfbot(token)
  if (!result.ok) {
    addDebugLog('ERROR', 'Account connection failed.')
    return { ...result, message: 'Connection failed.' }
  }

  try {
    const accounts = readSavedSelfbotAccounts()
    if (accounts.length >= 100 && !accounts.some((account) => account.accountId === result.accountId)) {
      disconnectSelfbot(result.accountId)
      return { ok: false, message: '100 accounts max.' }
    }
    saveSelfbotAccounts([
      ...accounts.filter((account) => account.accountId !== result.accountId),
      { accountId: result.accountId, username: result.username, token },
    ])
  } catch (error) {
    disconnectSelfbot(result.accountId)
    addDebugLog('ERROR', 'Account could not be saved.')
    return {
      ok: false,
      message: error instanceof Error && error.message === 'Secure token storage is unavailable on this device.'
        ? 'Secure storage unavailable.'
        : 'Couldn’t save account.',
    }
  }

  addDebugLog('SUCCESS', 'Account connected and saved.')
  return { ...result, accounts: getPublicSelfbotAccounts() }
}

async function reconnectSelfbotAccount(accountId, includeAccounts = true) {
  const account = readSavedSelfbotAccounts().find((entry) => entry.accountId === accountId)
  if (!account) {
    addDebugLog('ERROR', 'Reconnect failed: saved account not found.')
    return { ok: false, message: 'Saved account not found.' }
  }
  addDebugLog('STATUS', 'Account reconnect started.')
  const result = await connectSelfbot(account.token)
  if (!result.ok) {
    addDebugLog('ERROR', 'Account reconnect failed.')
    return result
  }
  if (result.accountId !== accountId) {
    disconnectSelfbot(result.accountId)
    addDebugLog('ERROR', 'Reconnect stopped: account identity changed.')
    return { ok: false, message: 'The saved token now belongs to a different account. Add it again.' }
  }
  addDebugLog('SUCCESS', 'Account reconnected.')
  return {
    ...result,
    ...(includeAccounts ? { accounts: getPublicSelfbotAccounts() } : {}),
  }
}

async function connectAllSavedAccounts() {
  const connectedIds = new Set(getConnectedSelfbotAccounts().map(({ accountId }) => accountId))
  const pendingAccounts = readSavedSelfbotAccounts().filter((account) => !connectedIds.has(account.accountId))
  const failedAccounts = []
  await mapWithConcurrency(pendingAccounts, getAccountConnectConcurrency(pendingAccounts.length), async (account) => {
    try {
      const result = await reconnectSelfbotAccount(account.accountId, false)
      if (!result.ok) failedAccounts.push(account.username)
    } catch {
      failedAccounts.push(account.username)
    }
  })
  const accounts = getPublicSelfbotAccounts()
  return {
    ok: failedAccounts.length === 0,
    accounts,
    message: failedAccounts.length > 0
      ? `Failed to connect: ${failedAccounts.join(', ')}.`
      : 'All accounts connected.',
  }
}

async function autoConnectSavedAccounts() {
  if (!autoConnectPromise) {
    const connectedIds = new Set(getConnectedSelfbotAccounts().map(({ accountId }) => accountId))
    const pendingAccounts = readSavedSelfbotAccounts().filter((account) => !connectedIds.has(account.accountId))
    if (pendingAccounts.length === 0) return

    addDebugLog('STATUS', `Auto-connect started for ${pendingAccounts.length} account(s).`)
    autoConnectPromise = (async () => {
      let completed = 0
      let failed = 0
      const connectingAccountIds = new Set()
      const reportProgress = (message, active) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('crp:selfbotConnectionProgress', {
            message,
            active,
            connectingAccountIds: [...connectingAccountIds],
          })
        }
      }

      reportProgress(`Auto-connect: 0/${pendingAccounts.length}`, true)
      await mapWithConcurrency(pendingAccounts, getAccountConnectConcurrency(pendingAccounts.length), async (account) => {
        connectingAccountIds.add(account.accountId)
        reportProgress(`Auto-connect: ${completed}/${pendingAccounts.length}`, true)
        try {
          const result = await reconnectSelfbotAccount(account.accountId, false)
          if (!result.ok) failed += 1
        } catch {
          failed += 1
        } finally {
          connectingAccountIds.delete(account.accountId)
        }
        completed += 1
        reportProgress(
          `Auto-connect: ${completed}/${pendingAccounts.length}${failed > 0 ? ` · ${failed} failed` : ''}`,
          true,
        )
      })

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('crp:accountsUpdated', getPublicSelfbotAccounts())
      }
      const accounts = getPublicSelfbotAccounts()
      const connectedCount = accounts.filter((account) => account.connected).length
      addDebugLog(failed > 0 ? 'WARN' : 'SUCCESS', `Auto-connect complete: ${connectedCount}/${accounts.length} connected.`)
      reportProgress(
        `Auto-connect: Complete (${connectedCount}/${accounts.length}${failed > 0 ? `, ${failed} failed` : ''})`,
        false,
      )
    })()
  }
  await autoConnectPromise
}

function getRendererUrl(route = '') {
  const localBundle = path.join(__dirname, '../dist/index.html')
  const rendererUrl = fs.existsSync(localBundle)
    ? pathToFileURL(localBundle).href
    : isDev
      ? 'http://127.0.0.1:5173/'
      : pathToFileURL(localBundle).href
  return route ? `${rendererUrl}#${route}` : rendererUrl
}

function createWindow() {
  const rendererUrl = getRendererUrl()

  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    title: 'CRP',
    icon: appIconPath(),
    backgroundColor: '#080B14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: isDev,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  mainWindow.loadURL(rendererUrl)

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      if (readAppSettings().closeToTray) {
        event.preventDefault()
        mainWindow.hide()
      } else {
        app.isQuitting = true
        app.quit()
      }
    }
  })
}

function createDebugConsoleWindow() {
  if (!readAppSettings().debugConsole) return { ok: false }
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show()
    debugWindow.focus()
    return { ok: true }
  }

  const rendererUrl = getRendererUrl('debug-console')
  debugWindow = new BrowserWindow({
    width: 820,
    height: 520,
    minWidth: 560,
    minHeight: 340,
    resizable: true,
    frame: false,
    title: 'CRP Debug Console',
    icon: appIconPath(),
    backgroundColor: '#080B14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: isDev,
    },
  })

  debugWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  debugWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault()
  })
  debugWindow.webContents.on('will-redirect', (event, navigationUrl) => {
    if (navigationUrl !== rendererUrl) event.preventDefault()
  })
  debugWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  debugWindow.on('closed', () => { debugWindow = null })
  void debugWindow.loadURL(rendererUrl)
  return { ok: true }
}

handleTrustedIpc('crp:windowMinimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
})
handleTrustedIpc('crp:windowToggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
handleTrustedIpc('crp:windowClose', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
})

function createTray() {
  const trayIcon = nativeImage.createFromPath(appIconPath()).resize({ width: 32, height: 32 })
  tray = new Tray(trayIcon)
  tray.setToolTip('CRP')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open CRP', click: () => mainWindow.show() },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ]),
  )
}

handleTrustedIpc('crp:selfbotStatus', async () => {
  const settings = readAppSettings()
  if (settings.autoConnectAccounts) void autoConnectSavedAccounts()
  return {
    ok: true,
    accounts: getPublicSelfbotAccounts(),
    canStoreToken: safeStorage.isEncryptionAvailable(),
    autoConnectAccounts: settings.autoConnectAccounts,
    closeToTray: settings.closeToTray,
    privacyMode: settings.privacyMode,
    debugConsole: settings.debugConsole,
  }
})
handleTrustedIpc('crp:debugLogsGet', () => [...debugLogEntries])
handleTrustedIpc('crp:debugLogsClear', () => {
  debugLogEntries.length = 0
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('crp:debugLogsCleared')
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.webContents.send('crp:debugLogsCleared')
  return { ok: true }
})
handleTrustedIpc('crp:debugLog', (_event, level, message) => {
  if (!DEBUG_LOG_LEVELS.has(level) || typeof message !== 'string') return { ok: false }
  addDebugLog(level, message)
  return { ok: true }
})
handleTrustedIpc('crp:debugConsoleOpen', () => createDebugConsoleWindow())
handleTrustedDebugIpc('crp:debugWindowLogsGet', () => [...debugLogEntries])
handleTrustedDebugIpc('crp:debugWindowLogsClear', () => {
  debugLogEntries.length = 0
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('crp:debugLogsCleared')
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.webContents.send('crp:debugLogsCleared')
  return { ok: true }
})
handleTrustedDebugIpc('crp:debugClipboardWrite', async (_event, content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 4_000_000) return { ok: false }
  try {
    clipboard.writeText(content)
    return { ok: true }
  } catch {
    return { ok: false }
  }
})
handleTrustedDebugIpc('crp:debugWindowMinimize', () => {
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.minimize()
})
handleTrustedDebugIpc('crp:debugWindowToggleMaximize', () => {
  if (!debugWindow || debugWindow.isDestroyed()) return
  if (debugWindow.isMaximized()) debugWindow.unmaximize()
  else debugWindow.maximize()
})
handleTrustedDebugIpc('crp:debugWindowClose', () => {
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.close()
})
handleTrustedIpc('crp:saveAppSettings', async (_event, settings) => {
  try {
    const currentSettings = readAppSettings()
    const nextSettings = saveAppSettings(settings)
    if (currentSettings.debugConsole && !nextSettings.debugConsole && debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.close()
    }
    return { ok: true, ...nextSettings }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not save settings.' }
  }
})
handleTrustedIpc('crp:listPresets', async () => {
  try {
    return { ok: true, presets: listPresets(presetsDirectoryPath()) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not list presets.' }
  }
})
handleTrustedIpc('crp:savePreset', async (_event, name, content) => {
  try {
    const savedName = savePreset(presetsDirectoryPath(), name, content)
    clipboard.writeText(content)
    return { ok: true, name: savedName }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not save preset.' }
  }
})
handleTrustedIpc('crp:loadPreset', async (_event, name) => {
  try {
    return { ok: true, content: loadPreset(presetsDirectoryPath(), name) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not load preset.' }
  }
})
handleTrustedIpc('crp:deletePreset', async (_event, name) => {
  try {
    return { ok: true, name: deletePreset(presetsDirectoryPath(), name) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not delete preset.' }
  }
})
handleTrustedIpc('crp:clipboardRead', async () => {
  try {
    const content = String((await clipboard.readText()) ?? '')
    return Buffer.byteLength(content, 'utf8') <= 4_000_000 ? content : ''
  } catch {
    return ''
  }
})
handleTrustedIpc('crp:clipboardWrite', async (_event, content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 4_000_000) return { ok: false }
  try {
    clipboard.writeText(content)
    return { ok: true }
  } catch {
    return { ok: false }
  }
})
handleTrustedIpc('crp:selfbotConnect', async (_event, token) => addSelfbotAccount(token))
handleTrustedIpc('crp:selfbotReconnect', async (_event, accountId) => reconnectSelfbotAccount(requireAccountId(accountId)))
handleTrustedIpc('crp:selfbotDisconnectAccount', async (_event, accountId) => {
  disconnectSelfbot(requireAccountId(accountId))
  return { ok: true, message: 'Account disconnected.', accounts: getPublicSelfbotAccounts() }
})
handleTrustedIpc('crp:selfbotConnectAll', async () => connectAllSavedAccounts())
handleTrustedIpc('crp:selfbotDisconnectAll', async () => {
  disconnectSelfbot()
  return { ok: true, message: 'All accounts disconnected.', accounts: getPublicSelfbotAccounts() }
})
handleTrustedIpc('crp:selfbotPresence', async (_event, activities) => publishSelfbotPresence(sanitizePresenceGroups(activities)))
handleTrustedIpc('crp:selfbotDisconnect', async () => {
  clearSelfbotPresences()
  return { ok: true, message: 'All selfbot presences stopped.' }
})
handleTrustedIpc('crp:selfbotForgetAccount', async (_event, accountId) => queueAccountMutation(() => {
  forgetSelfbotAccount(requireAccountId(accountId))
  return { ok: true, accounts: getPublicSelfbotAccounts() }
}))
if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    addDebugLog('STATUS', 'Application ready.')
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    Menu.setApplicationMenu(null)
    createWindow()
    createTray()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      } else {
        mainWindow.show()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    disconnectSelfbot()
    app.quit()
  }
})

app.on('before-quit', () => disconnectSelfbot())
