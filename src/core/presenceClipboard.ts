import { MAX_PRESENCES_PER_ACCOUNT, type ActivityItem } from './activityEngine'
import { updateAccount, type AppState } from './accountState'
import { decodeBase64Utf8, encodeBase64Utf8 } from './presetSystem'

export type TransferablePresence = Omit<ActivityItem, 'id' | 'accountId'>

export type PresenceClipboardPayload = {
  app: 'CRP'
  format: 'presence-copy'
  version: 1
  data: { presences: TransferablePresence[] }
}

export const editablePresenceFields = [
  'presenceName', 'type', 'timerMode', 'appId', 'applicationName', 'details', 'state', 'text',
  'buttonText', 'buttonUrl', 'buttonText2', 'buttonUrl2', 'statusDisplayType', 'detailsUrl', 'stateUrl',
  'partyId', 'partyCurrent', 'partyMaximum', 'joinSecret', 'spectateSecret', 'instance', 'emojiName',
  'emojiId', 'emojiAnimated', 'platform', 'customElapsedEnabled', 'elapsedSeconds', 'durationSeconds',
  'streamingUrl', 'largeImageUrl', 'smallImageUrl', 'enabled', 'largeText', 'smallText', 'lastUpdated',
] as const satisfies readonly (keyof TransferablePresence)[]

type UncoveredPresenceField = Exclude<keyof TransferablePresence, typeof editablePresenceFields[number]>
const allPresenceFieldsCovered: UncoveredPresenceField extends never ? true : never = true
void allPresenceFieldsCovered

const stringFields = new Set([
  'presenceName', 'appId', 'applicationName', 'details', 'state', 'text', 'buttonText', 'buttonUrl',
  'buttonText2', 'buttonUrl2', 'detailsUrl', 'stateUrl', 'partyId', 'joinSecret', 'spectateSecret',
  'emojiName', 'emojiId', 'platform', 'timerMode', 'streamingUrl', 'largeImageUrl', 'smallImageUrl',
  'largeText', 'smallText',
])
const numberFields = new Set(['statusDisplayType', 'partyCurrent', 'partyMaximum', 'elapsedSeconds', 'durationSeconds', 'lastUpdated'])
const booleanFields = new Set(['enabled', 'instance', 'customElapsedEnabled', 'emojiAnimated'])
const validTypes = new Set(['Playing', 'Streaming', 'Listening', 'Watching', 'Competing', 'Custom'])
const maxPayloadLength = 4_000_000
const maxPresenceCount = MAX_PRESENCES_PER_ACCOUNT
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validatePresence(value: unknown): TransferablePresence {
  if (!isRecord(value) || Object.keys(value).some((field) => !(editablePresenceFields as readonly string[]).includes(field))
    || !validTypes.has(String(value.type)) || typeof value.enabled !== 'boolean'
    || typeof value.text !== 'string' || typeof value.buttonText !== 'string') {
    throw new Error('Invalid copied presence.')
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === 'type' || field === 'enabled') continue
    if (stringFields.has(field)) {
      if (typeof fieldValue !== 'string') throw new Error(`Invalid copied presence field "${field}": expected text.`)
    } else if (numberFields.has(field)) {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        throw new Error(`Invalid copied presence field "${field}": expected a finite number.`)
      }
    } else if (booleanFields.has(field) && typeof fieldValue !== 'boolean') {
      throw new Error(`Invalid copied presence field "${field}": expected true or false.`)
    }
  }
  return { ...value } as TransferablePresence
}

function validatePayload(value: unknown): PresenceClipboardPayload {
  if (!isRecord(value) || Object.keys(value).some((key) => !['app', 'format', 'version', 'data'].includes(key))
    || value.app !== 'CRP' || value.format !== 'presence-copy' || value.version !== 1
    || !isRecord(value.data) || Object.keys(value.data).some((key) => key !== 'presences')
    || !Array.isArray(value.data.presences) || value.data.presences.length > maxPresenceCount) {
    throw new Error('Invalid presence clipboard data.')
  }
  return {
    app: 'CRP',
    format: 'presence-copy',
    version: 1,
    data: { presences: value.data.presences.map(validatePresence) },
  }
}

export function createPresenceClipboardPayload(presences: readonly ActivityItem[]): PresenceClipboardPayload {
  return validatePayload({
    app: 'CRP',
    format: 'presence-copy',
    version: 1,
    data: {
      presences: presences.map((presence) => {
        const source = presence as unknown as Record<string, unknown>
        return Object.fromEntries(editablePresenceFields
          .filter((field) => source[field] !== undefined)
          .map((field) => [field, source[field]]))
      }),
    },
  })
}

export function encodePresenceClipboard(presences: readonly ActivityItem[]): string {
  const payload = createPresenceClipboardPayload(presences)
  const encoded = encodeBase64Utf8(JSON.stringify(payload))
  if (encoded.length > maxPayloadLength) throw new Error('Copied presence data is too large.')
  return encoded
}

export function decodePresenceClipboard(value: unknown): PresenceClipboardPayload {
  if (typeof value !== 'string' || value.length > maxPayloadLength) throw new Error('Invalid presence clipboard data.')
  let decoded: string
  try {
    decoded = decodeBase64Utf8(value.trim())
  } catch {
    throw new Error('Invalid presence clipboard encoding.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    throw new Error('Presence clipboard does not contain valid JSON.')
  }
  return validatePayload(parsed)
}

export function applyPresenceClipboard<Presence>(
  current: AppState<Presence>,
  targetAccountId: string,
  payload: PresenceClipboardPayload,
  createPresence: (value: TransferablePresence) => Presence,
): AppState<Presence> {
  if (!current.accounts.some((account) => account.accountId === targetAccountId)) {
    throw new Error('The selected account is no longer available.')
  }
  return updateAccount(current, targetAccountId, (account) => ({
    ...account,
    presences: payload.data.presences.map(createPresence),
  }))
}