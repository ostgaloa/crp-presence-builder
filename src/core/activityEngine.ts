export type ActivityType = 'Playing' | 'Streaming' | 'Listening' | 'Watching' | 'Competing' | 'Custom'
export type ActivityTimerMode = 'off' | 'elapsed' | 'countdown' | 'progress'
export type ActivityPlatform = 'desktop' | 'samsung' | 'xbox' | 'ios' | 'android' | 'embedded' | 'ps4' | 'ps5'

export interface ActivityItem {
  id: string
  presenceName?: string
  type: ActivityType
  timerMode?: ActivityTimerMode
  accountId?: string
  appId?: string
  applicationName?: string
  details?: string
  state?: string
  text: string
  buttonText: string
  buttonUrl?: string
  buttonText2?: string
  buttonUrl2?: string
  statusDisplayType?: 0 | 1 | 2
  detailsUrl?: string
  stateUrl?: string
  partyId?: string
  partyCurrent?: number
  partyMaximum?: number
  joinSecret?: string
  spectateSecret?: string
  instance?: boolean
  emojiName?: string
  emojiId?: string
  emojiAnimated?: boolean
  platform?: ActivityPlatform
  customElapsedEnabled?: boolean
  elapsedSeconds?: number
  durationSeconds?: number
  streamingUrl?: string
  largeImageUrl?: string
  smallImageUrl?: string
  enabled: boolean
  largeText?: string
  smallText?: string
  lastUpdated?: number
}

export function createActivityStartTimestamp(elapsedSeconds: number, now = Date.now()): number {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.floor(elapsedSeconds)) : 0
  return now - elapsed * 1000
}

export function getActivityTimerMode(activity: Partial<ActivityItem>): ActivityTimerMode {
  if (activity.timerMode) return activity.timerMode
  if (activity.type === 'Listening' || activity.type === 'Watching') return 'progress'
  return activity.customElapsedEnabled ? 'elapsed' : 'off'
}

export function buildSentenceFromActivities(activities: Partial<ActivityItem>[]): string {
  const combined = activities
    .filter((activity) => activity.enabled)
    .flatMap((activity) => {
      const text = activity.text?.trim() ?? ''
      const buttonText = activity.buttonText?.trim() ?? ''
      return [text, buttonText].filter(Boolean)
    })

  return combined.join(' ').replace(/\s+/g, ' ').trim()
}

export function reorderActivities<T extends { id: string }>(items: T[], fromId: string, toId: string): T[] {
  const current = [...items]
  const fromIndex = current.findIndex((item) => item.id === fromId)
  const toIndex = current.findIndex((item) => item.id === toId)

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return current
  }

  const [moved] = current.splice(fromIndex, 1)
  const insertionIndex = fromIndex < toIndex ? Math.max(0, toIndex - 1) : toIndex
  current.splice(insertionIndex, 0, moved)
  return current
}

export type SelfbotActivity = {
  name: string
  type: number
  application_id?: string
  details?: string
  state?: string
  url?: string
  timestamps?: { start?: number; end?: number }
  assets?: { large_text?: string; small_text?: string }
  timer?: { mode: ActivityTimerMode; elapsedSeconds: number; durationSeconds: number; countdownEnd?: number }
  assetUrls?: { largeImage?: string; smallImage?: string }
  buttons?: string[]
  metadata?: { button_urls: string[] }
  details_url?: string
  state_url?: string
  status_display_type?: number
  party?: { id?: string; size: [number, number] }
  secrets?: { join?: string; spectate?: string }
  instance?: boolean
  emoji?: { name: string; id?: string }
  platform?: ActivityPlatform
}

export function buildSelfbotActivities(
  activities: Partial<ActivityItem>[],
): SelfbotActivity[] {
  const typeValues: Record<ActivityType, number> = {
    Playing: 0,
    Streaming: 1,
    Listening: 2,
    Watching: 3,
    Competing: 5,
    Custom: 4,
  }

  return activities
    .filter((activity) => activity.enabled)
    .map((activity) => {
      const appId = activity.appId ?? ''
      const type = activity.type ?? 'Playing'
      const timerMode = getActivityTimerMode(activity)
      const elapsedSeconds = Number.isFinite(activity.elapsedSeconds)
        ? Math.max(0, Math.floor(activity.elapsedSeconds ?? 0))
        : 0
      const durationSeconds = Number.isFinite(activity.durationSeconds)
        ? Math.max(0, Math.floor(activity.durationSeconds ?? 0))
        : 0
      const start = createActivityStartTimestamp(timerMode === 'elapsed' || timerMode === 'progress' ? elapsedSeconds : 0)
      const buttonLabel = activity.buttonText?.trim()
      const buttonUrl = activity.buttonUrl?.trim()
      const buttons = [
        { label: buttonLabel, url: buttonUrl },
        { label: activity.buttonText2?.trim(), url: activity.buttonUrl2?.trim() },
      ].filter((button): button is { label: string; url: string } => Boolean(button.label && button.url))
      const assetUrls = {
        largeImage: activity.largeImageUrl?.trim() || undefined,
        smallImage: activity.smallImageUrl?.trim() || undefined,
      }
      const assets = {
        large_text: activity.largeText?.trim() || undefined,
        small_text: activity.smallText?.trim() || undefined,
      }
      const usesTimer = timerMode !== 'off'
      const partyCurrent = Math.max(0, Math.floor(activity.partyCurrent ?? 0))
      const partyMaximum = Math.max(0, Math.floor(activity.partyMaximum ?? 0))

      return {
        name: type === 'Custom' ? 'Custom Status' : activity.applicationName?.trim() || appId || 'Custom Activity',
        type: typeValues[type],
        ...(type !== 'Custom' && appId ? { application_id: appId } : {}),
        details: type === 'Custom' ? undefined : activity.details?.trim() || activity.text?.trim() || undefined,
        state: type === 'Custom'
          ? activity.state?.trim() || activity.details?.trim() || activity.text?.trim() || undefined
          : activity.state?.trim() || undefined,
        ...(type === 'Custom' && activity.emojiName?.trim()
          ? {
              emoji: {
                name: activity.emojiName.trim(),
                ...(activity.emojiId?.trim() ? { id: activity.emojiId.trim() } : {}),
                ...(activity.emojiAnimated ? { animated: true } : {}),
              },
            }
          : {}),
        ...(activity.platform ? { platform: activity.platform } : {}),
        url: type === 'Streaming' ? activity.streamingUrl?.trim() || undefined : undefined,
        details_url: activity.detailsUrl?.trim() || undefined,
        state_url: activity.stateUrl?.trim() || undefined,
        status_display_type: activity.statusDisplayType,
        ...(type !== 'Custom' && partyMaximum > 0 ? {
          party: {
            ...(activity.partyId?.trim() ? { id: activity.partyId.trim() } : {}),
            size: [Math.min(partyCurrent, partyMaximum), partyMaximum] as [number, number],
          },
        } : {}),
        ...(type !== 'Custom' && (activity.joinSecret?.trim() || activity.spectateSecret?.trim()) ? {
          secrets: {
            join: activity.joinSecret?.trim() || undefined,
            spectate: activity.spectateSecret?.trim() || undefined,
          },
        } : {}),
        ...(type !== 'Custom' && activity.instance !== undefined ? { instance: activity.instance } : {}),
        ...(usesTimer
          ? {
              timestamps: {
                ...(timerMode === 'elapsed' || timerMode === 'progress' ? { start } : {}),
                ...(timerMode === 'progress' && durationSeconds > 0
                  ? { end: start + durationSeconds * 1000 }
                  : timerMode === 'countdown' && durationSeconds > 0
                    ? { end: Date.now() + durationSeconds * 1000 }
                    : {}),
              },
            }
          : {}),
        ...(usesTimer ? { timer: { mode: timerMode, elapsedSeconds, durationSeconds } } : {}),
        ...(type !== 'Custom' && Object.values(assets).some(Boolean) ? { assets } : {}),
        ...(type !== 'Custom' && Object.values(assetUrls).some((value) => value !== undefined) ? { assetUrls } : {}),
        ...(type !== 'Custom' && buttons.length > 0
          ? { buttons: buttons.map(({ label }) => label), metadata: { button_urls: buttons.map(({ url }) => url) } }
          : {}),
      }
    })
}

export type SelfbotActivityGroup = {
  accountId: string
  activities: SelfbotActivity[]
}

export function buildSelfbotActivityGroups(activities: Partial<ActivityItem>[]): SelfbotActivityGroup[] {
  const grouped = new Map<string, Partial<ActivityItem>[]>()
  for (const activity of activities) {
    if (!activity.enabled || !activity.accountId) continue
    grouped.set(activity.accountId, [...(grouped.get(activity.accountId) ?? []), activity])
  }
  return [...grouped].map(([accountId, accountActivities]) => {
    return {
      accountId,
      activities: buildSelfbotActivities(accountActivities),
    }
  })
}
