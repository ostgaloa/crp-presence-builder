function assertOnlyKeys(value, allowedKeys, label) {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(`${label} contains unsupported fields.`)
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requireAccountId(value) {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) throw new Error('Invalid account ID.')
  return value
}

export function normalizeAppSettings(value) {
  const settings = isRecord(value) ? value : {}
  return {
    autoConnectAccounts: settings.autoConnectAccounts === true,
    closeToTray: settings.closeToTray !== false,
    privacyMode: settings.privacyMode === true,
    debugConsole: settings.debugConsole === true,
  }
}

function boundedString(value, label, maxLength, { optional = false, urlProtocol } = {}) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`Invalid ${label}.`)
  if (urlProtocol) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new Error(`Invalid ${label}.`)
    }
    if (!urlProtocol.includes(parsed.protocol) || !parsed.hostname) throw new Error(`Invalid ${label}.`)
  }
  return value
}

function sanitizeGatewayActivity(value) {
  const allowedKeys = new Set([
    'name', 'type', 'application_id', 'details', 'state', 'url', 'timestamps', 'assets', 'timer', 'assetUrls',
    'buttons', 'metadata', 'details_url', 'state_url', 'status_display_type', 'party', 'secrets', 'instance', 'emoji', 'platform',
  ])
  if (!isRecord(value)) throw new Error('Invalid activity.')
  assertOnlyKeys(value, allowedKeys, 'Activity')

  const activity = {
    name: boundedString(value.name, 'activity name', 128),
    type: value.type,
  }
  if (!Number.isInteger(activity.type) || ![0, 1, 2, 3, 4, 5].includes(activity.type)) throw new Error('Invalid activity type.')

  const stringFields = {
    application_id: [19], details: [128], state: [128], url: [2048, ['https:']],
    details_url: [2048, ['http:', 'https:']], state_url: [2048, ['http:', 'https:']],
  }
  for (const [field, [maxLength, protocols]] of Object.entries(stringFields)) {
    const sanitized = boundedString(value[field], field, maxLength, { optional: true, urlProtocol: protocols })
    if (sanitized !== undefined) activity[field] = sanitized
  }
  if (activity.application_id !== undefined && !/^\d{17,19}$/.test(activity.application_id)) throw new Error('Invalid application ID.')

  if (value.timestamps !== undefined) {
    if (!isRecord(value.timestamps)) throw new Error('Invalid activity timestamps.')
    assertOnlyKeys(value.timestamps, new Set(['start', 'end']), 'Activity timestamps')
    activity.timestamps = {}
    for (const field of ['start', 'end']) {
      const timestamp = value.timestamps[field]
      if (timestamp !== undefined) {
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid activity timestamp.')
        activity.timestamps[field] = timestamp
      }
    }
  }

  if (value.assets !== undefined) {
    if (!isRecord(value.assets)) throw new Error('Invalid activity assets.')
    assertOnlyKeys(value.assets, new Set(['large_text', 'small_text']), 'Activity assets')
    activity.assets = {}
    for (const field of ['large_text', 'small_text']) {
      const text = boundedString(value.assets[field], field, 128, { optional: true })
      if (text !== undefined) activity.assets[field] = text
    }
  }

  if (value.assetUrls !== undefined) {
    if (!isRecord(value.assetUrls)) throw new Error('Invalid external image URLs.')
    assertOnlyKeys(value.assetUrls, new Set(['largeImage', 'smallImage']), 'External image URLs')
    activity.assetUrls = {}
    for (const field of ['largeImage', 'smallImage']) {
      const url = boundedString(value.assetUrls[field], field, 2048, { optional: true, urlProtocol: ['https:'] })
      if (url) activity.assetUrls[field] = url
    }
  }

  if (value.buttons !== undefined) {
    if (!Array.isArray(value.buttons) || value.buttons.length > 2) throw new Error('Invalid activity buttons.')
    activity.buttons = value.buttons.map((button) => boundedString(button, 'button label', 32))
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw new Error('Invalid activity metadata.')
    assertOnlyKeys(value.metadata, new Set(['button_urls']), 'Activity metadata')
    if (!Array.isArray(value.metadata.button_urls) || value.metadata.button_urls.length > 2) throw new Error('Invalid button URLs.')
    activity.metadata = {
      button_urls: value.metadata.button_urls.map((url) => boundedString(url, 'button URL', 512, { urlProtocol: ['http:', 'https:'] })),
    }
  }

  if (value.status_display_type !== undefined) {
    if (![0, 1, 2].includes(value.status_display_type)) throw new Error('Invalid status display type.')
    activity.status_display_type = value.status_display_type
  }
  if (value.party !== undefined) {
    if (!isRecord(value.party)) throw new Error('Invalid activity party.')
    assertOnlyKeys(value.party, new Set(['id', 'size']), 'Activity party')
    const party = {}
    const id = boundedString(value.party.id, 'party ID', 128, { optional: true })
    if (id !== undefined) party.id = id
    if (!Array.isArray(value.party.size) || value.party.size.length !== 2
      || value.party.size.some((size) => !Number.isInteger(size) || size < 0 || size > 9999)) {
      throw new Error('Invalid party size.')
    }
    party.size = value.party.size
    activity.party = party
  }
  if (value.secrets !== undefined) {
    if (!isRecord(value.secrets)) throw new Error('Invalid activity secrets.')
    assertOnlyKeys(value.secrets, new Set(['join', 'spectate']), 'Activity secrets')
    activity.secrets = {}
    for (const field of ['join', 'spectate']) {
      const secret = boundedString(value.secrets[field], field, 128, { optional: true })
      if (secret !== undefined) activity.secrets[field] = secret
    }
  }
  if (value.instance !== undefined) {
    if (typeof value.instance !== 'boolean') throw new Error('Invalid activity instance flag.')
    activity.instance = value.instance
  }
  if (value.emoji !== undefined) {
    if (!isRecord(value.emoji)) throw new Error('Invalid activity emoji.')
    assertOnlyKeys(value.emoji, new Set(['name', 'id', 'animated']), 'Activity emoji')
    activity.emoji = { name: boundedString(value.emoji.name, 'emoji name', 64) }
    if (value.emoji.id !== undefined) {
      if (typeof value.emoji.id !== 'string' || !/^\d{17,20}$/.test(value.emoji.id)) throw new Error('Invalid emoji ID.')
      activity.emoji.id = value.emoji.id
    }
    if (value.emoji.animated !== undefined) {
      if (typeof value.emoji.animated !== 'boolean') throw new Error('Invalid emoji animation flag.')
      activity.emoji.animated = value.emoji.animated
    }
  }
  if (value.platform !== undefined) {
    if (!['desktop', 'samsung', 'xbox', 'ios', 'android', 'embedded', 'ps4', 'ps5'].includes(value.platform)) {
      throw new Error('Invalid activity platform.')
    }
    activity.platform = value.platform
  }
  if (value.timer !== undefined) {
    if (!isRecord(value.timer)) throw new Error('Invalid activity timer.')
    assertOnlyKeys(value.timer, new Set(['mode', 'elapsedSeconds', 'durationSeconds', 'countdownEnd']), 'Activity timer')
    if (!['elapsed', 'countdown', 'progress'].includes(value.timer.mode)
      || !Number.isSafeInteger(value.timer.elapsedSeconds) || value.timer.elapsedSeconds < 0
      || !Number.isSafeInteger(value.timer.durationSeconds) || value.timer.durationSeconds < 0
      || (value.timer.countdownEnd !== undefined && (!Number.isSafeInteger(value.timer.countdownEnd) || value.timer.countdownEnd < 0))) {
      throw new Error('Invalid activity timer.')
    }
    activity.timer = {
      mode: value.timer.mode,
      elapsedSeconds: value.timer.elapsedSeconds,
      durationSeconds: value.timer.durationSeconds,
      ...(value.timer.countdownEnd !== undefined ? { countdownEnd: value.timer.countdownEnd } : {}),
    }
  }
  return activity
}

export function sanitizePresenceGroups(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('Invalid presence groups.')
  let activityCount = 0
  const groups = value.map((group) => {
    if (!isRecord(group)) throw new Error('Invalid presence group.')
    assertOnlyKeys(group, new Set(['accountId', 'activities']), 'Presence group')
    const accountId = requireAccountId(group.accountId)
    if (!Array.isArray(group.activities) || group.activities.length === 0) throw new Error('Invalid presence activities.')
    activityCount += group.activities.length
    if (activityCount > 100) throw new Error('A maximum of 100 activities can be published at once.')
    return { accountId, activities: group.activities.map(sanitizeGatewayActivity) }
  })
  if (Buffer.byteLength(JSON.stringify(groups), 'utf8') > 1_000_000) throw new Error('Presence payload is too large.')
  return groups
}
