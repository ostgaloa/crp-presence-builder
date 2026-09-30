export type GlobalSettings = {
  autoConnectAccounts: boolean
  closeToTray: boolean
  privacyMode: boolean
}

export type AccountSettings = Record<string, boolean>

export type AppAccount<Presence> = {
  accountId: string
  settings: AccountSettings
  presences: Presence[]
}

export type AppState<Presence> = {
  globalSettings: GlobalSettings
  accounts: AppAccount<Presence>[]
}

export function syncAppAccounts<Presence>(state: AppState<Presence>, localAccountIds: string[]): AppState<Presence> {
  const existing = new Map(state.accounts.map((account) => [account.accountId, account]))
  return {
    ...state,
    accounts: localAccountIds.map((accountId) => existing.get(accountId) ?? ({ accountId, settings: {}, presences: [] })),
  }
}

export function getSelectedAccount<Presence>(state: AppState<Presence>, selectedAccountId: string): AppAccount<Presence> | undefined {
  return state.accounts.find((account) => account.accountId === selectedAccountId)
}

export function updateAccount<Presence>(
  state: AppState<Presence>,
  accountId: string,
  update: (account: AppAccount<Presence>) => AppAccount<Presence>,
): AppState<Presence> {
  return {
    ...state,
    accounts: state.accounts.map((account) => account.accountId === accountId ? update(account) : account),
  }
}