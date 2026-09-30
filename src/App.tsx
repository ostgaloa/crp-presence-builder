import { type FormEvent, useEffect, useRef, useState } from 'react'
import './App.css'
import { buildSelfbotActivityGroups, getActivityTimerMode, type ActivityItem, type ActivityPlatform, type ActivityTimerMode, type ActivityType } from './core/activityEngine'
import { syncAppAccounts, updateAccount, type AppState, type GlobalSettings } from './core/accountState'
import { applyPreset, createPreset, createResetState, decodePreset, encodePreset, type PresetPresence } from './core/presetSystem'
import { applyPresenceClipboard, decodePresenceClipboard, encodePresenceClipboard } from './core/presenceClipboard'

const APP_NAMES_STORAGE_KEY = 'crp-app-names'
const APP_STATE_STORAGE_KEY = 'crp-app-state'
const LEGACY_PRESENCES_STORAGE_KEY = 'crp-presences'
const DEMO_ACCOUNT_ID_STORAGE_KEY = 'crp-demo-account-id'
const DEMO_ACCOUNT_HIDDEN_STORAGE_KEY = 'crp-demo-account-hidden'
const MAX_PRESENCES = 100
const MAX_PRESENCE_STORAGE_LENGTH = 4_000_000

type PresenceDraft = Omit<ActivityItem, 'accountId'> & { appId: string }
type ConnectionState = 'disconnected' | 'starting' | 'running'
type TimePart = 'hours' | 'minutes' | 'seconds'
type SelfbotAccount = { accountId: string; username: string; connected: boolean }
type PresetFile = { name: string; updatedAt: number }

function restorePresetPresence(value: PresetPresence, _accountId: string): PresenceDraft {
  return { ...makePresence(), ...value, id: `presence-${crypto.randomUUID()}` } as PresenceDraft
}

function connectedAccountsLabel(accounts: SelfbotAccount[]): string {
  const count = accounts.filter((account) => account.connected).length
  return `${count} account${count === 1 ? '' : 's'} connected.`
}

function readDemoAccountId(): string {
  const savedId = localStorage.getItem(DEMO_ACCOUNT_ID_STORAGE_KEY)
  if (savedId && /^\d{18}$/.test(savedId)) return savedId

  const randomDigits = crypto.getRandomValues(new Uint8Array(18))
  randomDigits[0] = (randomDigits[0] % 9) + 1
  const demoAccountId = Array.from(randomDigits, (digit) => String(digit % 10)).join('')
  localStorage.setItem(DEMO_ACCOUNT_ID_STORAGE_KEY, demoAccountId)
  return demoAccountId
}

declare global {
  interface Window {
    crpBridge?: {
      minimizeWindow: () => Promise<void>
      toggleMaximizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      selfbotStatus: () => Promise<{ ok: boolean; accounts?: SelfbotAccount[]; canStoreToken?: boolean; autoConnectAccounts?: boolean; closeToTray?: boolean; privacyMode?: boolean }>
      onSelfbotAccountsUpdated: (callback: (accounts: SelfbotAccount[]) => void) => () => void
      connectSelfbot: (token: string) => Promise<{ ok: boolean; accountId?: string; username?: string; message?: string; accounts?: SelfbotAccount[] }>
      reconnectSelfbot: (accountId: string) => Promise<{ ok: boolean; accountId?: string; username?: string; message?: string; accounts?: SelfbotAccount[] }>
      disconnectSelfbotAccount: (accountId: string) => Promise<{ ok: boolean; message?: string; accounts?: SelfbotAccount[] }>
      connectAllSelfbotAccounts: () => Promise<{ ok: boolean; message?: string; accounts?: SelfbotAccount[] }>
      disconnectAllSelfbotAccounts: () => Promise<{ ok: boolean; message?: string; accounts?: SelfbotAccount[] }>
      publishSelfbotPresence: (groups: Array<Record<string, unknown>>) => Promise<{ ok: boolean; message?: string; count?: number; resolvedImageCount?: number }>
      disconnectSelfbot: () => Promise<{ ok: boolean; message?: string }>
      forgetSelfbotAccount: (accountId: string) => Promise<{ ok: boolean; accounts?: SelfbotAccount[] }>
      saveAppSettings: (settings: { autoConnectAccounts: boolean; closeToTray: boolean; privacyMode: boolean }) => Promise<{ ok: boolean; message?: string }>
      listPresets: () => Promise<{ ok: boolean; presets?: PresetFile[]; message?: string }>
      savePreset: (name: string, content: string) => Promise<{ ok: boolean; name?: string; message?: string }>
      loadPreset: (name: string) => Promise<{ ok: boolean; content?: string; message?: string }>
      deletePreset: (name: string) => Promise<{ ok: boolean; name?: string; message?: string }>
      readClipboardText: () => Promise<string>
      writeClipboardText: (content: string) => Promise<{ ok: boolean }>
    }
  }
}

function makePresence(): PresenceDraft {
  return {
    id: `presence-${crypto.randomUUID()}`,
    appId: '',
    applicationName: '',
    type: 'Playing',
    timerMode: 'off',
    details: '',
    state: '',
    customElapsedEnabled: false,
    elapsedSeconds: 0,
    durationSeconds: 0,
    text: '',
    buttonText: '',
    enabled: true,
  }
}

function normalizeActivityType(type: unknown): ActivityType {
  return type === 'Streaming' || type === 'Listening' || type === 'Watching' || type === 'Competing' || type === 'Custom' ? type : 'Playing'
}

function TimeInputGroup({
  title,
  seconds,
  onChange,
}: {
  title: string
  seconds: number
  onChange: (part: TimePart, rawValue: string) => void
}) {
  const value = Math.max(0, Math.floor(seconds))
  const committedValues: Record<TimePart, string> = {
    hours: String(Math.floor(value / 3600)),
    minutes: String(Math.floor((value % 3600) / 60)),
    seconds: String(value % 60),
  }
  const [draftValues, setDraftValues] = useState(committedValues)
  const [focusedPart, setFocusedPart] = useState<TimePart | null>(null)

  const handleChange = (part: TimePart, rawValue: string) => {
    setDraftValues((current) => ({ ...current, [part]: rawValue }))
    onChange(part, rawValue)
  }

  const handleFocus = (part: TimePart) => {
    setDraftValues((current) => ({ ...current, [part]: committedValues[part] }))
    setFocusedPart(part)
  }

  const inputValue = (part: TimePart) => focusedPart === part ? draftValues[part] : committedValues[part]

  return (
    <div className="time-input-group">
      <p className="timebar-title">{title}</p>
      <div className="field-row elapsed-row">
        <label>
          Hours
          <input type="number" min="0" max="9999" step="1" value={inputValue('hours')} onFocus={() => handleFocus('hours')} onBlur={() => setFocusedPart(null)} onChange={(event) => handleChange('hours', event.target.value)} />
        </label>
        <label>
          Minutes
          <input type="number" min="0" max="59" step="1" value={inputValue('minutes')} onFocus={() => handleFocus('minutes')} onBlur={() => setFocusedPart(null)} onChange={(event) => handleChange('minutes', event.target.value)} />
        </label>
        <label>
          Seconds
          <input type="number" min="0" max="59" step="1" value={inputValue('seconds')} onFocus={() => handleFocus('seconds')} onBlur={() => setFocusedPart(null)} onChange={(event) => handleChange('seconds', event.target.value)} />
        </label>
      </div>
    </div>
  )
}

function readInitialAppState(): AppState<PresenceDraft> {
  // gespeicherte daten und alte presence-listen beim start übernehmen
  const savedState = localStorage.getItem(APP_STATE_STORAGE_KEY)
  if (savedState && savedState.length <= MAX_PRESENCE_STORAGE_LENGTH) {
    try {
      const parsed: unknown = JSON.parse(savedState)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>
        const globalSettings = readGlobalSettings(value.globalSettings)
        const accounts = Array.isArray(value.accounts) ? value.accounts.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
          const account = entry as Record<string, unknown>
          if (typeof account.accountId !== 'string' || !Array.isArray(account.presences)) return []
          return [{
            accountId: account.accountId,
            settings: readBooleanSettings(account.settings),
            presences: account.presences.slice(0, MAX_PRESENCES).flatMap((presence) => {
              if (!presence || typeof presence !== 'object' || Array.isArray(presence)) return []
              const source = { ...(presence as Record<string, unknown>) }
              delete source.accountId
              const type = normalizeActivityType(source.type)
              return [{
                ...makePresence(),
                ...source,
                id: typeof source.id === 'string' ? source.id : `presence-${crypto.randomUUID()}`,
                appId: typeof source.appId === 'string' ? source.appId : '',
                applicationName: typeof source.applicationName === 'string' ? source.applicationName : '',
                type,
                timerMode: source.timerMode ?? getActivityTimerMode({ ...source, type }),
              } as PresenceDraft]
            }),
          }]
        }) : []
        return { globalSettings, accounts }
      }
    } catch {
      localStorage.removeItem(APP_STATE_STORAGE_KEY)
    }
  } else if (savedState) {
    localStorage.removeItem(APP_STATE_STORAGE_KEY)
  }

  const legacyPresences = localStorage.getItem(LEGACY_PRESENCES_STORAGE_KEY)
  const oldApplicationNames = readApplicationNames()
  if (legacyPresences && legacyPresences.length <= MAX_PRESENCE_STORAGE_LENGTH) {
    try {
      const parsed: unknown = JSON.parse(legacyPresences)
      if (Array.isArray(parsed)) {
        const grouped = new Map<string, PresenceDraft[]>()
        for (const entry of parsed.slice(0, MAX_PRESENCES)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          const source = { ...(entry as Record<string, unknown>) }
          const accountId = typeof source.accountId === 'string' ? source.accountId : ''
          delete source.accountId
          const type = normalizeActivityType(source.type)
          const presence = {
            ...makePresence(),
            ...source,
            id: typeof source.id === 'string' ? source.id : `presence-${crypto.randomUUID()}`,
            appId: typeof source.appId === 'string' ? source.appId : '',
            applicationName: typeof source.applicationName === 'string'
              ? source.applicationName
              : oldApplicationNames[String(source.appId ?? '')] ?? '',
            type,
            timerMode: source.timerMode ?? getActivityTimerMode({ ...source, type }),
          } as PresenceDraft
          grouped.set(accountId, [...(grouped.get(accountId) ?? []), presence])
        }
        localStorage.removeItem(LEGACY_PRESENCES_STORAGE_KEY)
        return {
          globalSettings: readGlobalSettings(undefined),
          accounts: [...grouped].map(([accountId, presences]) => ({ accountId, settings: {}, presences })),
        }
      }
    } catch {
      localStorage.removeItem(LEGACY_PRESENCES_STORAGE_KEY)
    }
  }
  return { globalSettings: readGlobalSettings(undefined), accounts: [] }
}

function readBooleanSettings(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

function readGlobalSettings(value: unknown): GlobalSettings {
  const settings = readBooleanSettings(value)
  return {
    autoConnectAccounts: settings.autoConnectAccounts ?? false,
    closeToTray: settings.closeToTray ?? true,
    privacyMode: settings.privacyMode ?? false,
  }
}

function readApplicationNames(): Record<string, string> {
  try {
    const saved = localStorage.getItem(APP_NAMES_STORAGE_KEY)
    const parsed: unknown = saved ? JSON.parse(saved) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    }
  } catch {
    localStorage.removeItem(APP_NAMES_STORAGE_KEY)
  }
  return {}
}

function App() {
  const [runtimeAccounts, setRuntimeAccounts] = useState<SelfbotAccount[]>([])
  const [demoAccountId] = useState(readDemoAccountId)
  const [demoAccountVisible, setDemoAccountVisible] = useState(
    () => localStorage.getItem(DEMO_ACCOUNT_HIDDEN_STORAGE_KEY) !== 'true',
  )
  const [appState, setAppState] = useState(() => readInitialAppState())
  const [editingPresenceId, setEditingPresenceId] = useState('')
  const [presenceNameDraft, setPresenceNameDraft] = useState('')
  const [newPresenceId, setNewPresenceId] = useState('')
  const [presenceAddFeedback, setPresenceAddFeedback] = useState(0)
  const [presenceClipboardBusy, setPresenceClipboardBusy] = useState(false)
  const [presenceClipboardFeedback, setPresenceClipboardFeedback] = useState<'copied' | 'pasted' | ''>('')
  const [activeAccountId, setActiveAccountId] = useState('')
  const [selfbotToken, setSelfbotToken] = useState('')
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [uploadedPresenceCount, setUploadedPresenceCount] = useState(0)
  const [selfbotBusy, setSelfbotBusy] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState('')
  const [forgetAccountId, setForgetAccountId] = useState('')
  const [forgetBusy, setForgetBusy] = useState(false)
  const [bulkAccountsBusy, setBulkAccountsBusy] = useState(false)
  const [canStoreToken, setCanStoreToken] = useState(false)
  const [autoConnectDraft, setAutoConnectDraft] = useState(appState.globalSettings.autoConnectAccounts)
  const [closeToTrayDraft, setCloseToTrayDraft] = useState(appState.globalSettings.closeToTray)
  const [privacyModeDraft, setPrivacyModeDraft] = useState(appState.globalSettings.privacyMode)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetFiles, setPresetFiles] = useState<PresetFile[]>([])
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false)
  const [presetBusy, setPresetBusy] = useState(false)
  const presetSelectorRef = useRef<HTMLDivElement>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const accounts = runtimeAccounts
  const { autoConnectAccounts, closeToTray, privacyMode } = appState.globalSettings
  const selectedAccountId = accounts.some((account) => account.accountId === activeAccountId)
    ? activeAccountId
    : accounts[0]?.accountId ?? ''
  const selectedAccountIndex = appState.accounts.findIndex((account) => account.accountId === selectedAccountId)
  const selectedAccount = selectedAccountIndex >= 0 ? appState.accounts[selectedAccountIndex] : undefined
  const forgetAccount = accounts.find((account) => account.accountId === forgetAccountId)
  const selectedPresences = selectedAccount?.presences ?? []
  const totalPresenceCount = appState.accounts.reduce((count, account) => count + account.presences.length, 0)
  const selectedPresetExists = presetFiles.some((preset) => preset.name === presetName.trim())

  const syncRuntimeAccounts = (nextAccounts: SelfbotAccount[]) => {
    setRuntimeAccounts(nextAccounts)
    setAppState((current) => syncAppAccounts(current, nextAccounts.map((account) => account.accountId)))
  }

  const updateGlobalSettings = (globalSettings: GlobalSettings) => {
    setAppState((current) => ({ ...current, globalSettings }))
  }

  const refreshPresets = async () => {
    const result = await window.crpBridge?.listPresets()
    if (result?.ok) setPresetFiles(result.presets ?? [])
  }

  const dismissDemoAccount = () => {
    localStorage.setItem(DEMO_ACCOUNT_HIDDEN_STORAGE_KEY, 'true')
    setDemoAccountVisible(false)
    setStatusMessage('૮ ҂ ‸ ๑')
  }

  useEffect(() => {
    const persist = () => {
      try {
        const serialized = JSON.stringify(appState)
        if (serialized.length <= MAX_PRESENCE_STORAGE_LENGTH) {
          localStorage.setItem(APP_STATE_STORAGE_KEY, serialized)
        }
      } catch {
      }
    }
    const timeout = window.setTimeout(persist, 250)
    window.addEventListener('pagehide', persist)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('pagehide', persist)
    }
  }, [appState])

  useEffect(() => {
    const root = document.documentElement
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
        root.classList.add('keyboard-nav')
      }
    }
    const handlePointerDown = () => root.classList.remove('keyboard-nav')
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
      root.classList.remove('keyboard-nav')
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.crpBridge?.listPresets().then((result) => {
      if (active && result.ok) setPresetFiles(result.presets ?? [])
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!presetDropdownOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !presetSelectorRef.current?.contains(event.target)) {
        setPresetDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [presetDropdownOpen])

  useEffect(() => {
    if (!newPresenceId) return
    const timeout = window.setTimeout(() => setNewPresenceId(''), 1700)
    return () => window.clearTimeout(timeout)
  }, [newPresenceId])

  useEffect(() => {
    if (!presenceAddFeedback) return
    const timeout = window.setTimeout(() => setPresenceAddFeedback(0), 1300)
    return () => window.clearTimeout(timeout)
  }, [presenceAddFeedback])

  useEffect(() => {
    if (!presenceClipboardFeedback) return
    const timeout = window.setTimeout(() => setPresenceClipboardFeedback(''), 1300)
    return () => window.clearTimeout(timeout)
  }, [presenceClipboardFeedback])

  useEffect(() => {
    localStorage.removeItem('crp-app-ids')
    localStorage.removeItem('crp-app-id')
    localStorage.removeItem(APP_NAMES_STORAGE_KEY)
    localStorage.removeItem('crp-account-settings')
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = window.crpBridge?.onSelfbotAccountsUpdated((nextAccounts) => {
      if (!active) return
      syncRuntimeAccounts(nextAccounts)
      setStatusMessage(connectedAccountsLabel(nextAccounts))
    })
    void window.crpBridge?.selfbotStatus().then((result) => {
      if (!active) return
      const nextAccounts = result.accounts ?? []
      syncRuntimeAccounts(nextAccounts)
      setCanStoreToken(result.canStoreToken ?? false)
      const globalSettings = {
        autoConnectAccounts: result.autoConnectAccounts ?? false,
        closeToTray: result.closeToTray ?? true,
        privacyMode: result.privacyMode ?? false,
      }
      updateGlobalSettings(globalSettings)
      setAutoConnectDraft(globalSettings.autoConnectAccounts)
      setCloseToTrayDraft(globalSettings.closeToTray)
      setPrivacyModeDraft(globalSettings.privacyMode)
      if (!result.canStoreToken) setStatusMessage('Secure storage unavailable.')
      else setStatusMessage(connectedAccountsLabel(nextAccounts))
    }).catch(() => setStatusMessage('Couldn’t load accounts.'))
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const reconnectSelfbotAccount = async (accountId: string) => {
    const bridge = window.crpBridge
    if (!bridge) return
    setBusyAccountId(accountId)
    const result = await bridge.reconnectSelfbot(accountId)
    if (result.accounts) syncRuntimeAccounts(result.accounts)
    if (result.ok) {
      setActiveAccountId(accountId)
    }
    setStatusMessage(result.ok
      ? connectedAccountsLabel(result.accounts ?? [])
      : 'Reconnect failed.')
    setBusyAccountId('')
  }

  const disconnectSelfbotAccount = async (accountId: string) => {
    const bridge = window.crpBridge
    if (!bridge) return
    setBusyAccountId(accountId)
    try {
      const result = await bridge.disconnectSelfbotAccount(accountId)
      if (result.accounts) syncRuntimeAccounts(result.accounts)
      setStatusMessage(result.message ?? 'Account disconnected.')
    } catch {
      setStatusMessage('Disconnect failed.')
    } finally {
      setBusyAccountId('')
    }
  }

  const connectAllAccounts = async () => {
    const bridge = window.crpBridge
    if (!bridge) return
    setBulkAccountsBusy(true)
    try {
      const result = await bridge.connectAllSelfbotAccounts()
      if (result.accounts) syncRuntimeAccounts(result.accounts)
      setStatusMessage(result.message ?? connectedAccountsLabel(result.accounts ?? []))
    } catch {
      setStatusMessage('Failed to connect accounts.')
    } finally {
      setBulkAccountsBusy(false)
    }
  }

  const disconnectAllAccounts = async () => {
    const bridge = window.crpBridge
    if (!bridge) return
    setBulkAccountsBusy(true)
    try {
      const result = await bridge.disconnectAllSelfbotAccounts()
      if (result.accounts) syncRuntimeAccounts(result.accounts)
      setConnectionState('disconnected')
      setUploadedPresenceCount(0)
      setStatusMessage(result.message ?? 'All accounts disconnected.')
    } catch {
      setStatusMessage('Disconnect all failed.')
    } finally {
      setBulkAccountsBusy(false)
    }
  }

  const forgetSelfbotAccount = async (accountId: string) => {
    const result = await window.crpBridge?.forgetSelfbotAccount(accountId)
    if (!result?.ok) {
      setStatusMessage('Failed to forget account.')
      return
    }
    const remainingAccounts = result?.accounts ?? []
    const fallbackAccount = remainingAccounts.find((account) => account.connected) ?? remainingAccounts[0]
    syncRuntimeAccounts(remainingAccounts)
    if (activeAccountId === accountId) setActiveAccountId(fallbackAccount?.accountId ?? '')
    setConnectionState('disconnected')
    setUploadedPresenceCount(0)
    setForgetAccountId('')
    setStatusMessage('Account forgotten.')
  }

  const confirmForgetAccount = async () => {
    if (!forgetAccountId) return
    setForgetBusy(true)
    try {
      await forgetSelfbotAccount(forgetAccountId)
    } catch {
      setStatusMessage('Failed to forget account.')
    } finally {
      setForgetBusy(false)
    }
  }

  const addSelfbotAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canStoreToken) {
      setStatusMessage('Secure storage unavailable.')
      return
    }
    const bridge = window.crpBridge
    const tokens = [...new Set(selfbotToken.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean))]
    if (!bridge || tokens.length === 0) {
      setStatusMessage('Enter account token(s).')
      return
    }

    setSelfbotBusy(true)
    void (async () => {
      let addedCount = 0
      let latestAccounts = accounts
      const failures: string[] = []

      for (const [index, token] of tokens.entries()) {
        try {
          const result = await bridge.connectSelfbot(token)
          if (result.accounts) {
            latestAccounts = result.accounts
            syncRuntimeAccounts(result.accounts)
          }
          if (result.ok && result.accountId) {
            addedCount += 1
            setActiveAccountId(result.accountId)
          } else {
            failures.push(result.message === 'Connection failed.'
              ? `Token ${index + 1} failed to connect.`
              : result.message ?? `Token ${index + 1} failed to connect.`)
          }
        } catch {
          failures.push(`Token ${index + 1} failed to connect.`)
        }
      }

      setSelfbotToken('')
      const summary = addedCount > 0
        ? `Added ${addedCount} account${addedCount === 1 ? '' : 's'}. ${latestAccounts.filter((account) => account.connected).length} connected.`
        : 'No accounts added.'
      setStatusMessage(failures.length > 0 ? `${summary} ${failures.join('; ')}` : summary)
    })().finally(() => setSelfbotBusy(false))
  }

  const addPresence = () => {
    if (!selectedAccountId) {
      setStatusMessage('Connect an account first.')
      return
    }
    if (totalPresenceCount >= MAX_PRESENCES) {
      setStatusMessage(`${MAX_PRESENCES} presences max.`)
      return
    }
    const presence = makePresence()
    setAppState((current) => updateAccount(current, selectedAccountId, (account) => ({
      ...account,
      presences: [...account.presences, presence],
    })))
    setNewPresenceId(presence.id)
    setPresenceAddFeedback((current) => current + 1)
  }

  const copySelectedAccountPresences = async () => {
    const account = selectedAccount
    if (!account) return
    try {
      const bridge = window.crpBridge
      if (!bridge || typeof bridge.writeClipboardText !== 'function') {
        throw new Error('System clipboard bridge is unavailable. Restart the desktop app and try again.')
      }
      const encoded = encodePresenceClipboard(account.presences)
      const result = await bridge.writeClipboardText(encoded)
      if (!result?.ok) throw new Error('Could not write presence data to the clipboard.')
      setPresenceClipboardFeedback('copied')
      setStatusMessage(`Copied ${account.presences.length} presences.`)
    } catch {
      setStatusMessage('Couldn’t copy presences.')
    }
  }

  const pastePresencesIntoSelectedAccount = async () => {
    const targetAccount = selectedAccount
    if (!targetAccount) return
    const targetAccountId = targetAccount.accountId
    setPresenceClipboardBusy(true)
    try {
      const bridge = window.crpBridge
      if (!bridge || typeof bridge.readClipboardText !== 'function') {
        throw new Error('System clipboard bridge is unavailable. Restart the desktop app and try again.')
      }
      const clipboardText = await bridge.readClipboardText()
      const payload = decodePresenceClipboard(clipboardText)
      const otherPresenceCount = appState.accounts.reduce((count, account) => (
        account.accountId === targetAccountId ? count : count + account.presences.length
      ), 0)
      if (otherPresenceCount + payload.data.presences.length > MAX_PRESENCES) {
        throw new Error(`${MAX_PRESENCES} presences max.`)
      }
      const nextState = applyPresenceClipboard(
        appState,
        targetAccountId,
        payload,
        (presence) => restorePresetPresence(presence, targetAccountId),
      )
      setAppState(nextState)
      setPresenceClipboardFeedback('pasted')
      setStatusMessage(`Pasted ${payload.data.presences.length} presences.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setStatusMessage(message === `${MAX_PRESENCES} presences max.`
        ? message
        : message === 'The selected account is no longer available.'
          ? 'Account unavailable.'
          : 'Couldn’t paste presences.')
    } finally {
      setPresenceClipboardBusy(false)
    }
  }

  const updatePresence = (id: string, patch: Partial<PresenceDraft>) => {
    setAppState((current) => {
      const owner = current.accounts.find((account) => account.presences.some((presence) => presence.id === id))
      return owner
        ? updateAccount(current, owner.accountId, (account) => ({
            ...account,
            presences: account.presences.map((presence) => presence.id === id ? { ...presence, ...patch } : presence),
          }))
        : current
    })
  }

  const movePresenceToAccount = (presenceId: string, targetAccountId: string) => {
    if (!targetAccountId) return
    setAppState((current) => {
      const source = current.accounts.find((account) => account.presences.some((item) => item.id === presenceId))
      const target = current.accounts.find((account) => account.accountId === targetAccountId)
      const presence = source?.presences.find((item) => item.id === presenceId)
      if (!source || !target || !presence || source.accountId === target.accountId) return current
      return {
        ...current,
        accounts: current.accounts.map((account) => account.accountId === source.accountId
          ? { ...account, presences: account.presences.filter((item) => item.id !== presenceId) }
          : account.accountId === target.accountId
            ? { ...account, presences: [...account.presences, presence] }
            : account),
      }
    })
  }

  const beginPresenceRename = (presence: PresenceDraft) => {
    setEditingPresenceId(presence.id)
    setPresenceNameDraft(presence.presenceName ?? '')
  }

  const commitPresenceRename = (presenceId: string) => {
    updatePresence(presenceId, { presenceName: presenceNameDraft.trim() })
    setEditingPresenceId('')
  }

  const updateElapsedPart = (presence: PresenceDraft, part: TimePart, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10)
    const value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0
    const elapsed = Math.max(0, Math.floor(presence.elapsedSeconds ?? 0))
    const hours = part === 'hours' ? Math.min(value, 9999) : Math.floor(elapsed / 3600)
    const minutes = part === 'minutes' ? Math.min(value, 59) : Math.floor((elapsed % 3600) / 60)
    const seconds = part === 'seconds' ? Math.min(value, 59) : elapsed % 60
    updatePresence(presence.id, { elapsedSeconds: hours * 3600 + minutes * 60 + seconds })
  }

  const updateDurationPart = (presence: PresenceDraft, part: TimePart, rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10)
    const value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0
    const duration = Math.max(0, Math.floor(presence.durationSeconds ?? 0))
    const hours = part === 'hours' ? Math.min(value, 9999) : Math.floor(duration / 3600)
    const minutes = part === 'minutes' ? Math.min(value, 59) : Math.floor((duration % 3600) / 60)
    const seconds = part === 'seconds' ? Math.min(value, 59) : duration % 60
    updatePresence(presence.id, { durationSeconds: hours * 3600 + minutes * 60 + seconds })
  }

  const removePresence = (id: string) => {
    setAppState((current) => {
      const owner = current.accounts.find((account) => account.presences.some((presence) => presence.id === id))
      return owner
        ? updateAccount(current, owner.accountId, (account) => ({
            ...account,
            presences: account.presences.filter((presence) => presence.id !== id),
          }))
        : current
    })
  }

  const movePresence = (id: string, direction: -1 | 1) => {
    setAppState((current) => {
      const owner = current.accounts.find((account) => account.presences.some((presence) => presence.id === id))
      if (!owner) return current
      return updateAccount(current, owner.accountId, (account) => {
      const position = account.presences.findIndex((presence) => presence.id === id)
      const targetPosition = position + direction
      if (position < 0 || targetPosition < 0 || targetPosition >= account.presences.length) return account
      const presences = [...account.presences]
      ;[presences[position], presences[targetPosition]] = [presences[targetPosition], presences[position]]
      return { ...account, presences }
      })
    })
  }

  const startPresences = async () => {
    const bridge = window.crpBridge
    if (!bridge) {
      setStatusMessage('Desktop app unavailable.')
      return
    }
    const connectedAccountIds = new Set(accounts.filter((account) => account.connected).map((account) => account.accountId))
    if (connectedAccountIds.size === 0) {
      setStatusMessage('Connect a Discord account first.')
      return
    }
    const active = appState.accounts.flatMap((account) => account.presences
      .filter((presence) => presence.enabled)
      .map((presence) => ({ ...presence, accountId: account.accountId })))
    if (active.length === 0) {
      setStatusMessage('Enable a presence first.')
      return
    }
    const publishable = active.filter((presence) => presence.accountId && connectedAccountIds.has(presence.accountId))
    if (publishable.length === 0) {
      setStatusMessage('Connect the assigned account first.')
      return
    }
    const invalidButton = publishable.find((presence) => (
      Boolean(presence.buttonText.trim()) !== Boolean(presence.buttonUrl?.trim())
      || Boolean(presence.buttonText2?.trim()) !== Boolean(presence.buttonUrl2?.trim())
    ))
    if (invalidButton) {
      setStatusMessage('Each button needs a label and URL.')
      return
    }
    if (publishable.some((presence) => (
      presence.buttonText.trim().length > 32
      || (presence.buttonUrl?.length ?? 0) > 512
      || (presence.buttonText2?.length ?? 0) > 32
      || (presence.buttonUrl2?.length ?? 0) > 512
    ))) {
      setStatusMessage('Button labels: 32 max. URLs: 512 max.')
      return
    }
    if (publishable.some((presence) => [presence.buttonUrl, presence.buttonUrl2].some((url) => url && !/^https?:\/\//i.test(url.trim())))) {
      setStatusMessage('Button URLs must use HTTP or HTTPS.')
      return
    }
    if (publishable.some((presence) => (
      presence.type === 'Streaming'
      && !/^https:\/\/(www\.)?(twitch\.tv|youtube\.com)\//i.test(presence.streamingUrl?.trim() ?? '')
    ))) {
      setStatusMessage('Streaming needs a Twitch or YouTube URL.')
      return
    }
    if (publishable.some((presence) => (
      (presence.largeImageUrl?.trim() || presence.smallImageUrl?.trim())
      && !/^\d{17,19}$/.test(presence.appId?.trim() ?? '')
    ))) {
      setStatusMessage('External images need a valid app ID.')
      return
    }
    setConnectionState('starting')
    setStatusMessage('Uploading...')
    const result = await bridge.publishSelfbotPresence(buildSelfbotActivityGroups(publishable))
    setConnectionState(result.ok ? 'running' : 'disconnected')
    setUploadedPresenceCount(result.count ?? 0)
    setStatusMessage(result.ok ? 'Uploaded' : 'Upload failed')
  }

  const stopPresences = async () => {
    await window.crpBridge?.disconnectSelfbot()
    setConnectionState('disconnected')
    setUploadedPresenceCount(0)
    setStatusMessage('Stopped')
  }

  const openSettings = () => {
    setAutoConnectDraft(autoConnectAccounts)
    setCloseToTrayDraft(closeToTray)
    setPrivacyModeDraft(privacyMode)
    setSettingsOpen(true)
  }

  const saveSettings = async () => {
    setSettingsBusy(true)
    try {
      const result = await window.crpBridge?.saveAppSettings({ autoConnectAccounts: autoConnectDraft, closeToTray: closeToTrayDraft, privacyMode: privacyModeDraft })
      if (!result?.ok) {
        setStatusMessage('Couldn’t save settings.')
        return
      }
      updateGlobalSettings({
        autoConnectAccounts: autoConnectDraft,
        closeToTray: closeToTrayDraft,
        privacyMode: privacyModeDraft,
      })
      setSettingsOpen(false)
      setStatusMessage('Settings saved.')
    } catch {
      setStatusMessage('Couldn’t save settings.')
    } finally {
      setSettingsBusy(false)
    }
  }

  const resetSettings = async () => {
    setSettingsBusy(true)
    try {
      const result = await window.crpBridge?.saveAppSettings({ autoConnectAccounts: false, closeToTray: true, privacyMode: false })
      if (!result?.ok) {
        setStatusMessage('Couldn’t reset settings.')
        return
      }
      updateGlobalSettings({ autoConnectAccounts: false, closeToTray: true, privacyMode: false })
      setAutoConnectDraft(false)
      setCloseToTrayDraft(true)
      setPrivacyModeDraft(false)
      setStatusMessage('Settings reset.')
    } catch {
      setStatusMessage('Couldn’t reset settings.')
    } finally {
      setSettingsBusy(false)
    }
  }

  const savePresetNow = async () => {
    const name = presetName.trim()
    if (!name) {
      setStatusMessage('Enter a preset name.')
      return
    }
    setPresetBusy(true)
    try {
      const preset = createPreset(appState, accounts.map((account) => account.accountId))
      const encoded = encodePreset(preset)
      const result = await window.crpBridge?.savePreset(name, encoded)
      if (!result?.ok) throw new Error('Couldn’t save preset.')
      setPresetName(result.name ?? name)
      await refreshPresets()
      setStatusMessage('Preset saved and copied.')
    } catch {
      setStatusMessage('Couldn’t save preset.')
    } finally {
      setPresetBusy(false)
    }
  }

  const loadPresetNow = async () => {
    setPresetBusy(true)
    try {
      let preset
      const clipboardText = await window.crpBridge?.readClipboardText().catch(() => '') ?? ''
      if (clipboardText) {
        try {
          preset = decodePreset(clipboardText)
        } catch {
          preset = undefined
        }
      }
      if (!preset) {
        const name = presetName.trim()
        if (!name) throw new Error('Clipboard has no valid preset and no local preset is selected.')
        const result = await window.crpBridge?.loadPreset(name)
        if (!result?.ok || typeof result.content !== 'string') {
          throw new Error('Couldn’t load preset.')
        }
        preset = decodePreset(result.content)
      }

      const nextState = applyPreset(preset, accounts.map((account) => account.accountId), restorePresetPresence)
      const settingsResult = await window.crpBridge?.saveAppSettings(nextState.globalSettings)
      if (!settingsResult?.ok) throw new Error('Couldn’t load preset.')
      setAppState(nextState)
      setAutoConnectDraft(nextState.globalSettings.autoConnectAccounts)
      setCloseToTrayDraft(nextState.globalSettings.closeToTray)
      setPrivacyModeDraft(nextState.globalSettings.privacyMode)
      setStatusMessage('Preset loaded.')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setStatusMessage(message.startsWith('Preset needs ') ? message : 'Couldn’t load preset.')
    } finally {
      setPresetBusy(false)
    }
  }

  const resetPresetState = async () => {
    setPresetBusy(true)
    try {
      const nextState = createResetState<PresenceDraft>(accounts.map((account) => account.accountId))
      const stopped = await window.crpBridge?.disconnectSelfbot()
      if (!stopped?.ok) throw new Error('Couldn’t reset app.')
      const settingsResult = await window.crpBridge?.saveAppSettings(nextState.globalSettings)
      if (!settingsResult?.ok) throw new Error('Couldn’t reset app.')
      localStorage.removeItem(LEGACY_PRESENCES_STORAGE_KEY)
      setAppState(nextState)
      setConnectionState('disconnected')
      setAutoConnectDraft(nextState.globalSettings.autoConnectAccounts)
      setCloseToTrayDraft(nextState.globalSettings.closeToTray)
      setPrivacyModeDraft(nextState.globalSettings.privacyMode)
      setStatusMessage('Reset complete.')
    } catch {
      setStatusMessage('Couldn’t reset app.')
    } finally {
      setPresetBusy(false)
    }
  }

  const deleteSelectedPreset = async () => {
    const name = presetName.trim()
    if (!presetFiles.some((preset) => preset.name === name)) return
    setPresetBusy(true)
    try {
      const result = await window.crpBridge?.deletePreset(name)
      if (!result?.ok) throw new Error('Couldn’t delete preset.')
      setPresetFiles((current) => current.filter((preset) => preset.name !== name))
      setStatusMessage('Preset deleted.')
    } catch {
      setStatusMessage('Couldn’t delete preset.')
    } finally {
      setPresetBusy(false)
    }
  }

  return (
    <main className="app-shell" spellCheck={false}>
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><img src="./crp-logo.png" alt="" /></div>
          <div>
            <p className="eyebrow">Custom Rich Presence</p>
            <h1>Presence Builder</h1>
          </div>
        </div>
        <div className="header-controls">
          {statusMessage && (
            <div className={`runtime-status ${connectionState}`} role="status">
              <span className="status-light" />
              <span>{statusMessage}</span>
            </div>
          )}
          <button className="button button-secondary settings-button" type="button" onClick={openSettings}>Settings</button>
          {connectionState === 'running' ? (
            <button className="button button-stop" type="button" onClick={() => void stopPresences()}>Stop</button>
          ) : (
            <button
              className="button button-upload"
              type="button"
              aria-label={connectionState === 'starting' ? 'Uploading' : 'Upload'}
              disabled={connectionState === 'starting' || !accounts.some((account) => account.connected)}
              onClick={() => void startPresences()}
            >
              {connectionState === 'starting' ? <span className="upload-spinner" aria-hidden="true" /> : 'Upload'}
            </button>
          )}
        </div>
        <div className="window-controls" aria-label="Window controls">
          <button className="window-control" type="button" aria-label="Minimize window" title="Minimize" onClick={() => void window.crpBridge?.minimizeWindow()}>−</button>
          <button className="window-control" type="button" aria-label="Maximize or restore window" title="Maximize or restore" onClick={() => void window.crpBridge?.toggleMaximizeWindow()}>□</button>
          <button className="window-control window-control-close" type="button" aria-label="Close window" title="Close" onClick={() => void window.crpBridge?.closeWindow()}>×</button>
        </div>
      </header>

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <h2 id="settings-title">Settings</h2>
              <button className="icon-button" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button>
            </header>
            <label className="settings-toggle">
              <span>
                <strong>Auto-connect saved accounts</strong>
                <small>Reconnect them when CRP opens.</small>
              </span>
              <input
                type="checkbox"
                checked={autoConnectDraft}
                onChange={(event) => setAutoConnectDraft(event.target.checked)}
              />
            </label>
            <label className="settings-toggle">
              <span>
                <strong>Keep running in tray on close</strong>
              </span>
              <input
                type="checkbox"
                checked={closeToTrayDraft}
                onChange={(event) => setCloseToTrayDraft(event.target.checked)}
              />
            </label>
            <label className="settings-toggle">
              <span>
                <strong>Privacy mode</strong>
                <small>Hide account names and IDs.</small>
              </span>
              <input
                type="checkbox"
                checked={privacyModeDraft}
                onChange={(event) => setPrivacyModeDraft(event.target.checked)}
              />
            </label>
            <footer className="settings-actions">
              <button className="button button-secondary settings-reset" type="button" disabled={settingsBusy} onClick={() => void resetSettings()}>Reset</button>
              <button className="button button-secondary" type="button" onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button className="button button-start" type="button" disabled={settingsBusy} onClick={() => void saveSettings()}>
                {settingsBusy ? 'Saving...' : 'Save settings'}
              </button>
            </footer>
          </section>
        </div>
      )}

      {forgetAccountId && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !forgetBusy) setForgetAccountId('')
          }}
        >
          <section className="settings-dialog forget-dialog" role="alertdialog" aria-modal="true" aria-labelledby="forget-title" aria-describedby="forget-description">
            <header className="settings-header">
              <h2 id="forget-title">Forget account?</h2>
              <button className="icon-button" type="button" aria-label="Cancel" disabled={forgetBusy} onClick={() => setForgetAccountId('')}>×</button>
            </header>
            <p className="forget-confirmation" id="forget-description">
              {privacyMode ? 'This account' : forgetAccount?.username ?? 'This account'} and its saved token will be removed.
            </p>
            <footer className="settings-actions">
              <button className="button button-secondary" type="button" disabled={forgetBusy} onClick={() => setForgetAccountId('')}>Cancel</button>
              <button className="button button-forget" type="button" disabled={forgetBusy} onClick={() => void confirmForgetAccount()}>
                {forgetBusy ? 'Deleting...' : 'Forget account'}
              </button>
            </footer>
          </section>
        </div>
      )}

      <div className="workspace">
        <aside className="apps-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Selfbot gateway</p>
              <h2>Accounts: <span className="account-count-value">{accounts.length + (demoAccountVisible ? 1 : 0)}</span></h2>
              <h2 className="uploaded-presence-heading">Presences: <span>{uploadedPresenceCount}</span></h2>
            </div>
          </div>

          <form className="add-app-form" onSubmit={addSelfbotAccount}>
            <label htmlFor="selfbot-token">Add Discord account(s)</label>
            <input
              id="selfbot-token"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={selfbotToken}
              onChange={(event) => setSelfbotToken(event.target.value)}
              placeholder="Paste tokens, comma-separated"
            />
            <button className="button button-add" type="submit" disabled={selfbotBusy || !canStoreToken}>
              {selfbotBusy ? 'Connecting...' : 'Add account(s)'}
            </button>
          </form>

          <div className="account-bulk-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={bulkAccountsBusy || accounts.length === 0 || accounts.every((account) => account.connected)}
              onClick={() => void connectAllAccounts()}
            >
              {bulkAccountsBusy ? 'Working...' : 'Connect all'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={bulkAccountsBusy || !accounts.some((account) => account.connected)}
              onClick={() => void disconnectAllAccounts()}
            >
              Disconnect all
            </button>
          </div>

          <ul className="account-list">
            {demoAccountVisible && (
              <li className="account-entry">
                <div className="account-main-row">
                  <button className="account-select" type="button" onClick={() => setStatusMessage('૮ ҂ ‸ ๑')}>
                    <span className="account-index">01</span>
                    <span className="account-identity">
                      <strong>{privacyMode ? 'Account 01' : 'ostgaloa'}</strong>
                      <code>{privacyMode ? '••••••••••••' : demoAccountId}</code>
                    </span>
                    <span className="account-state is-connected">Connected</span>
                  </button>
                </div>
                <div className="account-actions">
                  <button className="text-action disconnect-account" type="button" onClick={() => setStatusMessage('૮ ҂ ‸ ๑')}>
                    Disconnect
                  </button>
                  <button className="text-action forget-account" type="button" onClick={dismissDemoAccount}>
                    Forget
                  </button>
                </div>
              </li>
            )}
            {accounts.map((account, index) => (
              <li className="account-entry" key={account.accountId}>
                <div className="account-main-row">
                  <button
                    className={`account-select${selectedAccountId === account.accountId ? ' is-active' : ''}`}
                    type="button"
                    onClick={() => setActiveAccountId(account.accountId)}
                  >
                    <span className="account-index">{String(index + (demoAccountVisible ? 2 : 1)).padStart(2, '0')}</span>
                    <span className="account-identity">
                      <strong>{privacyMode ? `Account ${String(index + (demoAccountVisible ? 2 : 1)).padStart(2, '0')}` : account.username}</strong>
                      <code>{privacyMode ? '••••••••••••' : account.accountId}</code>
                    </span>
                    <span className={`account-state${account.connected ? ' is-connected' : ''}`}>
                      {account.connected ? 'Connected' : 'Offline'}
                    </span>
                  </button>
                </div>
                <div className="account-actions">
                  {account.connected ? (
                    <button className="text-action disconnect-account" type="button" disabled={busyAccountId === account.accountId} onClick={() => void disconnectSelfbotAccount(account.accountId)}>
                      {busyAccountId === account.accountId ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  ) : (
                    <button className="text-action" type="button" disabled={busyAccountId === account.accountId} onClick={() => void reconnectSelfbotAccount(account.accountId)}>
                      {busyAccountId === account.accountId ? 'Connecting...' : 'Reconnect'}
                    </button>
                  )}
                  <button className="text-action forget-account" type="button" disabled={busyAccountId === account.accountId} onClick={() => setForgetAccountId(account.accountId)}>
                    Forget
                  </button>
                </div>
              </li>
            ))}
            {accounts.length === 0 && !demoAccountVisible && <li className="empty-state">Add an account to publish activities.</li>}
          </ul>
        </aside>

        <section className="builder-panel">
          <div className="builder-heading">
            <div>
              <p className="eyebrow">Activities grouped by account</p>
              <h2>Presences <span>{selectedPresences.length}</span></h2>
            </div>
          </div>

          <section className="preset-panel" aria-label="Presets">
            <div className="preset-selector" ref={presetSelectorRef}>
              <div className={`preset-combobox${presetDropdownOpen ? ' is-open' : ''}`}>
                <input
                  className="preset-name-input"
                  type="text"
                  role="combobox"
                  aria-label="Search presets or enter preset name"
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-expanded={presetDropdownOpen}
                  aria-controls="preset-options"
                  placeholder="Search or name a preset"
                  value={presetName}
                  maxLength={64}
                  onFocus={() => setPresetDropdownOpen(true)}
                  onChange={(event) => {
                    setPresetName(event.target.value)
                    setPresetDropdownOpen(true)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setPresetDropdownOpen(false)
                    if (event.key === 'ArrowDown') setPresetDropdownOpen(true)
                  }}
                />
                <button
                  className={`preset-dropdown-toggle${presetDropdownOpen ? ' is-open' : ''}`}
                  type="button"
                  aria-label={presetDropdownOpen ? 'Hide presets' : 'Show presets'}
                  aria-expanded={presetDropdownOpen}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setPresetDropdownOpen((open) => !open)}
                >
                  <span aria-hidden="true">▾</span>
                </button>
              </div>
              {presetDropdownOpen && (
                <div className="preset-list" id="preset-options" role="listbox" aria-label="Saved presets">
                  {presetFiles
                    .filter((preset) => preset.name.toLowerCase().includes(presetName.trim().toLowerCase()))
                    .map((preset) => (
                      <button
                        className={`preset-list-item${presetName === preset.name ? ' is-selected' : ''}`}
                        type="button"
                        role="option"
                        aria-selected={presetName === preset.name}
                        key={preset.name}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setPresetName(preset.name)
                          setPresetDropdownOpen(false)
                        }}
                      >
                        {preset.name}
                      </button>
                    ))}
                  {presetFiles.filter((preset) => preset.name.toLowerCase().includes(presetName.trim().toLowerCase())).length === 0
                    && <p className="preset-empty">No matching presets</p>}
                </div>
              )}
            </div>
            <div className="preset-actions">
              <button className="button button-secondary" type="button" disabled={presetBusy} onClick={() => void loadPresetNow()}>
                {presetBusy ? 'Loading...' : 'Load'}
              </button>
              <button className="button button-secondary" type="button" disabled={presetBusy || !presetName.trim()} onClick={() => void savePresetNow()}>
                {presetBusy ? 'Saving...' : 'Save'}
              </button>
              <button className="button button-secondary" type="button" disabled={presetBusy} onClick={() => void resetPresetState()}>
                Reset
              </button>
              <button
                className="button button-secondary preset-delete-button"
                type="button"
                disabled={presetBusy || !selectedPresetExists}
                onClick={() => void deleteSelectedPreset()}
              >
                Delete
              </button>
            </div>
          </section>

          <nav className="account-tabs" role="tablist" aria-label="Account presence tabs">
            {accounts.map((account, index) => (
              <button
                className={`account-tab${selectedAccountId === account.accountId ? ' is-active' : ''}`}
                type="button"
                role="tab"
                aria-selected={selectedAccountId === account.accountId}
                key={account.accountId}
                onClick={() => setActiveAccountId(account.accountId)}
              >
                {privacyMode ? `Account ${String(index + 1).padStart(2, '0')}` : account.username}
              </button>
            ))}
          </nav>

          <div className="presence-section-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={!selectedAccountId || presenceClipboardBusy}
              onClick={() => void copySelectedAccountPresences()}
            >
              {presenceClipboardFeedback === 'copied' ? '✓ Copied' : 'Copy'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={!selectedAccountId || presenceClipboardBusy}
              onClick={() => void pastePresencesIntoSelectedAccount()}
            >
              {presenceClipboardFeedback === 'pasted' ? '✓ Pasted' : 'Paste'}
            </button>
            <button
              className={`button button-add presence-add-button${presenceAddFeedback ? ' is-added' : ''}`}
              type="button"
              disabled={!selectedAccountId || totalPresenceCount >= MAX_PRESENCES}
              aria-live="polite"
              onClick={addPresence}
            >
              <span key={presenceAddFeedback} className={`presence-add-label${presenceAddFeedback ? ' is-added' : ''}`}>
                {presenceAddFeedback ? `✓ Added ${presenceAddFeedback}` : '+ Add presence'}
              </span>
            </button>
          </div>

          {selectedPresences.length === 0 ? (
            <div className="empty-builder">
              <span className="empty-mark">+</span>
              <h3>No presences yet</h3>
            </div>
          ) : (
            <div className="presence-list">
              {selectedPresences.map((presence, index) => (
                <article
                  id={presence.id}
                  className={`presence-card${presence.enabled ? '' : ' is-disabled'}${newPresenceId === presence.id ? ' is-new' : ''}`}
                  key={presence.id}
                >
                  <header className="presence-card-header">
                    <div className="card-title" data-tooltip={editingPresenceId === presence.id ? undefined : 'Rename presence'}>
                      <span className="card-order">{String(index + 1).padStart(2, '0')}</span>
                      {editingPresenceId === presence.id ? (
                        <input
                          className="presence-name-input"
                          aria-label="Presence name"
                          autoFocus
                          maxLength={64}
                          value={presenceNameDraft}
                          onChange={(event) => setPresenceNameDraft(event.target.value)}
                          onBlur={() => commitPresenceRename(presence.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              event.currentTarget.blur()
                            }
                          }}
                        />
                      ) : (
                        <button className="presence-name-trigger" type="button" onClick={() => beginPresenceRename(presence)}>
                          <h3>{presence.presenceName?.trim() || 'Untitled presence'}</h3>
                          <span className="presence-name-edit" aria-hidden="true">✎</span>
                        </button>
                      )}
                    </div>
                    <div className="card-actions">
                      <label className="enable-control" data-tooltip="Enable this presence">
                        <input type="checkbox" checked={presence.enabled} onChange={(event) => updatePresence(presence.id, { enabled: event.target.checked })} />
                        <span>On</span>
                      </label>
                      <button className="icon-button" type="button" data-tooltip="Move up" aria-label="Move up" disabled={index === 0} onClick={() => movePresence(presence.id, -1)}>↑</button>
                      <button className="icon-button" type="button" data-tooltip="Move down" aria-label="Move down" disabled={index === selectedPresences.length - 1} onClick={() => movePresence(presence.id, 1)}>↓</button>
                      <button className="icon-button remove-button" type="button" data-tooltip="Remove presence" aria-label="Remove presence" onClick={() => removePresence(presence.id)}>×</button>
                    </div>
                  </header>

                  <div className="field-row field-row-selects">
                    <label>
                      Discord account
                      <select value={selectedAccountId} onChange={(event) => movePresenceToAccount(presence.id, event.target.value)}>
                        <option value="">Select account</option>
                        {accounts.map((account, accountIndex) => (
                          <option value={account.accountId} key={account.accountId}>
                            {privacyMode ? `Account ${String(accountIndex + 1).padStart(2, '0')}` : account.username}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Activity type
                      <select value={presence.type} onChange={(event) => {
                        const type = event.target.value as ActivityType
                        const currentMode = getActivityTimerMode(presence)
                        updatePresence(presence.id, {
                          type,
                          timerMode: currentMode === 'off' && (type === 'Listening' || type === 'Watching')
                            ? 'progress'
                            : currentMode,
                        })
                      }}>
                        <option value="Playing">Playing</option>
                        <option value="Streaming">Streaming</option>
                        <option value="Listening">Listening</option>
                        <option value="Watching">Watching</option>
                        <option value="Competing">Competing</option>
                        <option value="Custom">Custom Status</option>
                      </select>
                    </label>
                  </div>

                  {presence.type === 'Custom' ? (
                    <div className="field-row">
                      <label>
                        Status text
                        <input value={presence.state ?? presence.details ?? ''} maxLength={128} onChange={(event) => updatePresence(presence.id, { state: event.target.value })} />
                      </label>
                      <label>
                        Emoji (optional)
                        <input value={presence.emojiName ?? ''} maxLength={64} placeholder="Unicode or custom emoji name" onChange={(event) => updatePresence(presence.id, { emojiName: event.target.value })} />
                      </label>
                    </div>
                  ) : (
                    <>
                      <div className="field-row">
                        <label>
                          Activity name
                          <input value={presence.applicationName ?? ''} maxLength={128} placeholder="Name shown in Discord" onChange={(event) => updatePresence(presence.id, { applicationName: event.target.value })} />
                        </label>
                        <label>
                          Discord application ID
                          <input type={privacyMode ? 'password' : 'text'} autoComplete="off" inputMode="numeric" value={presence.appId ?? ''} placeholder="Required for external images" onChange={(event) => updatePresence(presence.id, { appId: event.target.value.trim() })} />
                        </label>
                      </div>

                      {presence.type === 'Streaming' && (
                        <div className="field-row">
                          <label>
                            Stream URL
                            <input type="url" required value={presence.streamingUrl ?? ''} placeholder="https://twitch.tv/..." onChange={(event) => updatePresence(presence.id, { streamingUrl: event.target.value })} />
                          </label>
                        </div>
                      )}

                      <div className="field-row">
                        <label>
                          Details
                          <input value={presence.details ?? ''} maxLength={128} placeholder="What are you doing?" onChange={(event) => updatePresence(presence.id, { details: event.target.value, text: event.target.value })} />
                        </label>
                        <label>
                          State
                          <input value={presence.state ?? ''} maxLength={128} placeholder="A second line" onChange={(event) => updatePresence(presence.id, { state: event.target.value })} />
                        </label>
                      </div>
                    </>
                  )}

                  {presence.type !== 'Custom' && <div className="timebar-settings timer-settings">
                    <label className="timer-mode-control">
                      Timer display
                      <select
                        value={getActivityTimerMode(presence)}
                        onChange={(event) => updatePresence(presence.id, {
                          timerMode: event.target.value as ActivityTimerMode,
                          customElapsedEnabled: false,
                        })}
                      >
                        <option value="off">Off</option>
                        <option value="elapsed">Elapsed</option>
                        <option value="countdown">Countdown</option>
                        <option value="progress">Progress bar</option>
                      </select>
                    </label>
                    {getActivityTimerMode(presence) !== 'off' && (
                      <div className="timebar-values">
                        {(getActivityTimerMode(presence) === 'elapsed' || getActivityTimerMode(presence) === 'progress') && (
                          <TimeInputGroup title={getActivityTimerMode(presence) === 'progress' ? 'Current position' : 'Elapsed time'} seconds={presence.elapsedSeconds ?? 0} onChange={(part, value) => updateElapsedPart(presence, part, value)} />
                        )}
                        {(getActivityTimerMode(presence) === 'countdown' || getActivityTimerMode(presence) === 'progress') && (
                          <TimeInputGroup title={getActivityTimerMode(presence) === 'countdown' ? 'Countdown duration' : 'Total duration'} seconds={presence.durationSeconds ?? 0} onChange={(part, value) => updateDurationPart(presence, part, value)} />
                        )}
                      </div>
                    )}
                  </div>}

                  {presence.type !== 'Custom' && <details className="optional-fields">
                    <summary>Images</summary>
                    <div className="field-row">
                      <label>
                        Large image URL
                        <input value={presence.largeImageUrl ?? ''} type="url" placeholder="https://example.com/image.png" onChange={(event) => updatePresence(presence.id, { largeImageUrl: event.target.value })} />
                      </label>
                      <label>
                        Large image hover text
                        <input value={presence.largeText ?? ''} maxLength={128} placeholder="Optional" onChange={(event) => updatePresence(presence.id, { largeText: event.target.value })} />
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        Small image URL
                        <input value={presence.smallImageUrl ?? ''} type="url" placeholder="https://example.com/second.png" onChange={(event) => updatePresence(presence.id, { smallImageUrl: event.target.value })} />
                      </label>
                      <label>
                        Small image hover text
                        <input value={presence.smallText ?? ''} maxLength={128} placeholder="Optional" onChange={(event) => updatePresence(presence.id, { smallText: event.target.value })} />
                      </label>
                    </div>
                    <p className="asset-note">Use a public HTTPS image URL and matching 17–19 digit app ID.</p>
                  </details>}

                  {presence.type !== 'Custom' && <details className="optional-fields">
                    <summary>Buttons</summary>
                    <div className="field-row">
                      <label>
                        Button 1 label
                        <input value={presence.buttonText} maxLength={32} placeholder="Open website" onChange={(event) => updatePresence(presence.id, { buttonText: event.target.value })} />
                      </label>
                      <label>
                        Button 1 URL
                        <input value={presence.buttonUrl ?? ''} type="url" placeholder="https://example.com" onChange={(event) => updatePresence(presence.id, { buttonUrl: event.target.value })} />
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        Button 2 label
                        <input value={presence.buttonText2 ?? ''} maxLength={32} placeholder="Optional" onChange={(event) => updatePresence(presence.id, { buttonText2: event.target.value })} />
                      </label>
                      <label>
                        Button 2 URL
                        <input value={presence.buttonUrl2 ?? ''} type="url" placeholder="https://example.com" onChange={(event) => updatePresence(presence.id, { buttonUrl2: event.target.value })} />
                      </label>
                    </div>
                    <p className="asset-note">Each button needs a label and URL. Max 2.</p>
                  </details>}

                  {presence.type !== 'Custom' && <details className="optional-fields">
                    <summary>Advanced activity</summary>
                    <div className="field-row field-row-selects">
                      <label>
                        Display in Discord
                        <select
                          value={presence.statusDisplayType ?? 0}
                          onChange={(event) => updatePresence(presence.id, { statusDisplayType: Number(event.target.value) as 0 | 1 | 2 })}
                        >
                          <option value={0}>Activity name</option>
                          <option value={1}>State</option>
                          <option value={2}>Details</option>
                        </select>
                      </label>
                      <label>
                        Platform
                        <select value={presence.platform ?? ''} onChange={(event) => updatePresence(presence.id, { platform: (event.target.value || undefined) as ActivityPlatform | undefined })}>
                          <option value="">Default</option>
                          <option value="desktop">Desktop</option>
                          <option value="ios">iOS</option>
                          <option value="android">Android</option>
                          <option value="xbox">Xbox</option>
                          <option value="ps4">PlayStation 4</option>
                          <option value="ps5">PlayStation 5</option>
                          <option value="samsung">Samsung</option>
                          <option value="embedded">Embedded</option>
                        </select>
                      </label>
                      <label className="enable-control">
                        <input type="checkbox" checked={presence.instance ?? false} onChange={(event) => updatePresence(presence.id, { instance: event.target.checked })} />
                        Game instance
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        Details link
                        <input type="url" value={presence.detailsUrl ?? ''} placeholder="https://example.com" onChange={(event) => updatePresence(presence.id, { detailsUrl: event.target.value })} />
                      </label>
                      <label>
                        State link
                        <input type="url" value={presence.stateUrl ?? ''} placeholder="https://example.com" onChange={(event) => updatePresence(presence.id, { stateUrl: event.target.value })} />
                      </label>
                    </div>
                    <div className="field-row elapsed-row">
                      <label>
                        Party size
                        <input type="number" min="0" max="9999" value={presence.partyCurrent ?? 0} onChange={(event) => updatePresence(presence.id, { partyCurrent: Number(event.target.value) })} />
                      </label>
                      <label>
                        Party maximum
                        <input type="number" min="0" max="9999" value={presence.partyMaximum ?? 0} onChange={(event) => updatePresence(presence.id, { partyMaximum: Number(event.target.value) })} />
                      </label>
                      <label>
                        Party ID
                        <input value={presence.partyId ?? ''} maxLength={128} onChange={(event) => updatePresence(presence.id, { partyId: event.target.value })} />
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        Join secret
                        <input value={presence.joinSecret ?? ''} maxLength={128} onChange={(event) => updatePresence(presence.id, { joinSecret: event.target.value })} />
                      </label>
                      <label>
                        Spectate secret
                        <input value={presence.spectateSecret ?? ''} maxLength={128} onChange={(event) => updatePresence(presence.id, { spectateSecret: event.target.value })} />
                      </label>
                    </div>
                  </details>}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default App