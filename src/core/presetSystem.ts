import type { ActivityItem } from './activityEngine'
import type { AppState, GlobalSettings } from './accountState'

export type PresetPresence = Omit<ActivityItem, 'id' | 'accountId'>

export type PresetAccount = {
  slot: number
  settings: Record<string, boolean>
  presences: PresetPresence[]
}

export type Preset = {
  app: 'CRP'
  format: 'preset'
  version: 1
  data: {
    global: GlobalSettings
    accounts: PresetAccount[]
  }
}

const defaultGlobalSettings: GlobalSettings = {
  autoConnectAccounts: false,
  closeToTray: true,
  privacyMode: false,
}

const stringFields = new Set([
  'presenceName', 'appId', 'applicationName', 'details', 'state', 'text', 'buttonText', 'buttonUrl',
  'buttonText2', 'buttonUrl2', 'detailsUrl', 'stateUrl', 'partyId', 'joinSecret', 'spectateSecret',
  'emojiName', 'emojiId', 'platform', 'timerMode', 'streamingUrl', 'largeImageUrl', 'smallImageUrl',
  'largeText', 'smallText',
])
const numberFields = new Set(['statusDisplayType', 'partyCurrent', 'partyMaximum', 'elapsedSeconds', 'durationSeconds', 'lastUpdated'])
const booleanFields = new Set(['enabled', 'instance', 'customElapsedEnabled', 'emojiAnimated'])
const presenceFields = new Set([...stringFields, ...numberFields, ...booleanFields, 'type'])
const activityTypes = new Set(['Playing', 'Streaming', 'Listening', 'Watching', 'Competing', 'Custom'])
const timerModes = new Set(['off', 'elapsed', 'countdown', 'progress'])
const platforms = new Set(['desktop', 'samsung', 'xbox', 'ios', 'android', 'embedded', 'ps4', 'ps5'])
const maximumAccounts = 100
const maximumPresences = 100
const maximumPresetLength = 4_000_000
const encoder = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateSettings(value: unknown): Record<string, boolean> {
  if (!isRecord(value) || Object.keys(value).length > 100) throw new Error('Preset settings are invalid.')
  const settings: Record<string, boolean> = {}
  for (const [key, setting] of Object.entries(value)) {
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(key) || typeof setting !== 'boolean') {
      throw new Error('Preset settings are invalid.')
    }
    settings[key] = setting
  }
  return settings
}

function validateGlobalSettings(value: unknown): GlobalSettings {
  if (!isRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(defaultGlobalSettings, key))) {
    throw new Error('Preset global settings are invalid.')
  }
  const settings = validateSettings(value)
  return {
    autoConnectAccounts: settings.autoConnectAccounts ?? defaultGlobalSettings.autoConnectAccounts,
    closeToTray: settings.closeToTray ?? defaultGlobalSettings.closeToTray,
    privacyMode: settings.privacyMode ?? defaultGlobalSettings.privacyMode,
  }
}

function validatePresence(value: unknown): PresetPresence {
  if (!isRecord(value) || !activityTypes.has(String(value.type)) || typeof value.enabled !== 'boolean') {
    throw new Error('Preset contains an invalid presence.')
  }
  if (Object.keys(value).some((key) => !presenceFields.has(key))) {
    throw new Error('Preset presence contains an unsupported field.')
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === 'type' || key === 'enabled') continue
    if (stringFields.has(key)) {
      if (typeof fieldValue !== 'string' || fieldValue.length > 4096) throw new Error('Preset presence text is invalid.')
      if (key === 'timerMode' && !timerModes.has(fieldValue)) throw new Error('Preset timer mode is invalid.')
      if (key === 'platform' && !platforms.has(fieldValue)) throw new Error('Preset platform is invalid.')
    } else if (numberFields.has(key)) {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) throw new Error('Preset presence number is invalid.')
      if (key === 'statusDisplayType' && ![0, 1, 2].includes(fieldValue)) throw new Error('Preset status display type is invalid.')
    } else if (booleanFields.has(key) && typeof fieldValue !== 'boolean') {
      throw new Error('Preset presence boolean is invalid.')
    }
  }
  return { ...value } as PresetPresence
}

function validatePreset(value: unknown): Preset {
  if (!isRecord(value) || Object.keys(value).some((key) => !['app', 'format', 'version', 'data'].includes(key))
    || value.app !== 'CRP' || value.format !== 'preset' || value.version !== 1 || !isRecord(value.data)) {
    throw new Error('Invalid CRP preset.')
  }
  const data = value.data
  if (Object.keys(data).some((key) => !['global', 'accounts'].includes(key))
    || !Array.isArray(data.accounts) || data.accounts.length > maximumAccounts) {
    throw new Error('Preset structure is invalid.')
  }
  const accounts = data.accounts.map((value, index): PresetAccount => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['slot', 'settings', 'presences'].includes(key))
      || value.slot !== index + 1 || !Array.isArray(value.presences) || value.presences.length > maximumPresences) {
      throw new Error('Preset account slot or data is invalid.')
    }
    return {
      slot: index + 1,
      settings: validateSettings(value.settings),
      presences: value.presences.map(validatePresence),
    }
  })
  if (accounts.reduce((total, account) => total + account.presences.length, 0) > maximumPresences) {
    throw new Error('Preset contains too many presences.')
  }
  return {
    app: 'CRP',
    format: 'preset',
    version: 1,
    data: { global: validateGlobalSettings(data.global), accounts },
  }
}

export function encodeBase64Utf8(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeBase64Utf8(value: string): string {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Preset clipboard data is not valid Base64.')
  }
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function createPreset<Presence extends object>(
  state: AppState<Presence>,
  accountIdsInSlotOrder: string[],
): Preset {
  if (accountIdsInSlotOrder.length > maximumAccounts) throw new Error('Too many accounts for a preset.')
  return validatePreset({
    app: 'CRP',
    format: 'preset',
    version: 1,
    data: {
      global: state.globalSettings,
      accounts: accountIdsInSlotOrder.map((accountId, index) => {
        const account = state.accounts.find((candidate) => candidate.accountId === accountId)
        return {
          slot: index + 1,
          settings: account?.settings ?? {},
          presences: (account?.presences ?? []).map((presence) => {
            const { id: _id, accountId: _accountId, ...editablePresence } = presence as Record<string, unknown>
            return editablePresence
          }),
        }
      }),
    },
  })
}

export function encodePreset(preset: Preset): string {
  const json = JSON.stringify(validatePreset(preset))
  const encoded = encodeBase64Utf8(json)
  if (encoded.length > maximumPresetLength) throw new Error('Preset is too large.')
  return encoded
}

export function decodePreset(encoded: unknown): Preset {
  if (typeof encoded !== 'string' || encoded.length > maximumPresetLength) throw new Error('Invalid preset data.')
  try {
    return validatePreset(JSON.parse(decodeBase64Utf8(encoded.trim())))
  } catch {
    throw new Error('Invalid preset data.')
  }
}

export function applyPreset<Presence>(
  preset: Preset,
  accountIdsInSlotOrder: string[],
  createPresence: (value: PresetPresence, accountId: string) => Presence,
): AppState<Presence> {
  if (preset.data.accounts.length > accountIdsInSlotOrder.length) {
    throw new Error(`Preset needs ${preset.data.accounts.length} accounts; ${accountIdsInSlotOrder.length} available.`)
  }
  return {
    globalSettings: preset.data.global,
    accounts: accountIdsInSlotOrder.map((accountId, index) => {
      const saved = preset.data.accounts[index]
      return {
        accountId,
        settings: saved?.settings ?? {},
        presences: saved?.presences.map((presence) => createPresence(presence, accountId)) ?? [],
      }
    }),
  }
}

export function createResetState<Presence>(accountIdsInSlotOrder: string[]): AppState<Presence> {
  return {
    globalSettings: { ...defaultGlobalSettings },
    accounts: accountIdsInSlotOrder.map((accountId) => ({ accountId, settings: {}, presences: [] })),
  }
}