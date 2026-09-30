import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client, RichPresence } = require('discord.js-selfbot-v13')

const clients = new Map()
const accountActivities = new Map()
let timerRefresh = null

const TIMER_REBASE_INTERVAL_MS = 60_000
const STATUS_UPDATE_OPCODE = 3

export function sendGatewayPresence(client, presence) {
  client.ws.broadcast({ op: STATUS_UPDATE_OPCODE, d: presence })
}

export async function connectSelfbot(token) {
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, message: 'Enter your Discord user token to connect.' }
  }

  const nextClient = new Client()
  let readyTimeout
  const ready = new Promise((resolve, reject) => {
    nextClient.once('ready', resolve)
    nextClient.once('error', reject)
    readyTimeout = setTimeout(() => reject(new Error('Discord connection timed out.')), 20000)
  })

  try {
    await Promise.all([nextClient.login(token.trim()), ready])
    clearTimeout(readyTimeout)
    const accountId = String(nextClient.user.id)
    const previousClient = clients.get(accountId)
    clients.set(accountId, nextClient)
    previousClient?.destroy()
    return {
      ok: true,
      accountId,
      username: nextClient.user?.tag ?? nextClient.user?.username ?? 'Connected',
    }
  } catch (error) {
    clearTimeout(readyTimeout)
    nextClient.destroy()
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Discord selfbot connection failed.',
    }
  }
}

export function getConnectedSelfbotAccounts() {
  return [...clients.entries()].map(([accountId, account]) => ({
    accountId,
    username: account.user?.tag ?? account.user?.username ?? 'Discord account',
  }))
}

export function resolveExternalActivityAssets(activity, externalAssets) {
  const { assetUrls, timer, ...payload } = activity
  const imageUrls = [assetUrls?.largeImage, assetUrls?.smallImage].filter(Boolean)
  if (imageUrls.length === 0) return { payload, timer, resolvedImageCount: 0 }
  if (!Array.isArray(externalAssets) || externalAssets.length !== imageUrls.length) {
    throw new Error('Discord did not resolve every external image. Check the application ID and image URL.')
  }
  const assetPaths = externalAssets.map((asset) => {
    const assetPath = asset?.external_asset_path
    if (typeof assetPath !== 'string' || !assetPath.trim() || assetPath.length > 2048) return null
    if (assetPath.startsWith('external/')) return `mp:${assetPath}`
    if (assetPath.startsWith('mp:external/')) return assetPath
    return null
  })
  if (assetPaths.some((assetPath) => assetPath === null)) {
    throw new Error('Discord could not resolve an external image. Check that the URL is public and the application ID is valid.')
  }

  const assets = { ...payload.assets }
  let externalIndex = 0
  if (assetUrls?.largeImage) {
    assets.large_image = assetPaths[externalIndex++]
  }
  if (assetUrls?.smallImage) {
    assets.small_image = assetPaths[externalIndex]
  }
  return { payload: { ...payload, assets }, timer, resolvedImageCount: imageUrls.length }
}

async function resolveActivityAssets(client, activity) {
  const imageUrls = [activity.assetUrls?.largeImage, activity.assetUrls?.smallImage].filter(Boolean)
  if (imageUrls.length === 0) {
    const { assetUrls: _assetUrls, timer, ...payload } = activity
    return { payload, timer }
  }
  const externalAssets = await RichPresence.getExternal(client, String(activity.application_id), ...imageUrls)
  return resolveExternalActivityAssets(activity, externalAssets)
}

export function buildGatewayActivities(entries, now = Date.now()) {
  return entries.map(({ payload, timer }) => {
    if (!timer) return payload
    if (timer.mode === 'countdown') {
      return {
        ...payload,
        timestamps: timer.countdownEnd
          ? { end: timer.countdownEnd }
          : timer.durationSeconds > 0 ? { end: now + timer.durationSeconds * 1000 } : undefined,
      }
    }
    const start = now - timer.elapsedSeconds * 1000
    return {
      ...payload,
      timestamps: {
        start,
        ...(timer.mode === 'progress' && timer.durationSeconds > 0
          ? { end: start + timer.durationSeconds * 1000 }
          : {}),
      },
    }
  })
}

function refreshAccountPresence(accountId) {
  const client = clients.get(accountId)
  const entries = accountActivities.get(accountId)
  if (!client?.user || !entries?.some(({ timer }) => timer && timer.mode !== 'countdown')) return
  sendGatewayPresence(client, {
    status: 'online',
    afk: false,
    since: null,
    activities: buildGatewayActivities(entries),
  })
}

function syncTimerRefresh() {
  const needsRefresh = [...accountActivities.values()].some((entries) => entries.some(({ timer }) => timer && timer.mode !== 'countdown'))
  if (needsRefresh && !timerRefresh) {
    timerRefresh = setInterval(() => {
      for (const accountId of accountActivities.keys()) {
        try {
          refreshAccountPresence(accountId)
        } catch {
          accountActivities.delete(accountId)
        }
      }
      syncTimerRefresh()
    }, TIMER_REBASE_INTERVAL_MS)
    timerRefresh.unref?.()
  } else if (!needsRefresh && timerRefresh) {
    clearInterval(timerRefresh)
    timerRefresh = null
  }
}

export async function publishSelfbotPresence(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { ok: false, message: 'Enable at least one presence.' }
  }

  const activeAccountIds = new Set()
  const errors = []
  let count = 0
  let resolvedImageCount = 0

  try {
    for (const group of groups) {
      const accountId = String(group.accountId ?? '')
      const client = clients.get(accountId)
      if (!client?.user) {
        errors.push(`Account ${accountId || '(unknown)'} is not connected.`)
        continue
      }
      if (!Array.isArray(group.activities) || group.activities.length === 0) continue

      const entries = await Promise.all(group.activities.map((activity) => resolveActivityAssets(client, activity)))
      resolvedImageCount += entries.reduce((total, entry) => total + entry.resolvedImageCount, 0)
      const now = Date.now()
      for (const entry of entries) {
        if (entry.timer?.mode === 'countdown' && entry.timer.durationSeconds > 0) {
          entry.timer.countdownEnd = now + entry.timer.durationSeconds * 1000
        }
      }
      sendGatewayPresence(client, {
        status: 'online',
        afk: false,
        since: null,
        activities: buildGatewayActivities(entries),
      })
      accountActivities.set(accountId, entries)
      activeAccountIds.add(accountId)
      count += entries.length
    }

    for (const accountId of accountActivities.keys()) {
      if (activeAccountIds.has(accountId)) continue
      const client = clients.get(accountId)
      if (client?.user) sendGatewayPresence(client, { status: 'online', afk: false, since: null, activities: [] })
      accountActivities.delete(accountId)
    }
    syncTimerRefresh()
    return { ok: errors.length === 0, count, resolvedImageCount, message: errors.join(' ') || undefined }
  } catch (error) {
    return {
      ok: false,
      resolvedImageCount,
      message: error instanceof Error ? error.message : 'Discord rejected the presence update.',
    }
  }
}

export function clearSelfbotPresences() {
  for (const client of clients.values()) {
    try {
      if (client.user) sendGatewayPresence(client, { status: 'online', afk: false, since: null, activities: [] })
    } catch {
      client.destroy()
    }
  }
  accountActivities.clear()
  syncTimerRefresh()
}

export function disconnectSelfbot(accountId) {
  const ids = accountId ? [String(accountId)] : [...clients.keys()]
  for (const id of ids) {
    const client = clients.get(id)
    if (!client) continue
    accountActivities.delete(id)
    client.destroy()
    clients.delete(id)
  }
  syncTimerRefresh()
}
