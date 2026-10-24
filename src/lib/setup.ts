// What this device remembers about onboarding: the connected Google account's email (used as a
// login hint so the popup skips the account chooser), spreadsheet IDs and names, and whether the
// teacher has been through the "make a copy" step. No tokens.

const SHEET_ID_KEY = 'participation-tracker.sheet-id'
const SHEET_NAME_KEY = 'participation-tracker.sheet-name'
const RECENT_SHEETS_KEY = 'participation-tracker.recent-sheets'
const TEMPLATE_COPIED_KEY = 'participation-tracker.template-copied'
const ACCOUNT_KEY = 'participation-tracker.google-account'
const SEEN_TIPS_KEY = 'participation-tracker.seen-tips'
const RECENT_LIMIT = 8

export interface RememberedSpreadsheet {
  id: string
  name: string
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Without storage every visit starts from step 1, which is at least honest.
  }
}

export function getRememberedSpreadsheet(): RememberedSpreadsheet | null {
  const id = read(SHEET_ID_KEY)
  return id ? { id, name: read(SHEET_NAME_KEY) } : null
}

/** Makes `sheet` the current grade book and moves it to the front of the recent list. */
export function rememberSpreadsheet(sheet: RememberedSpreadsheet): void {
  write(SHEET_ID_KEY, sheet.id)
  write(SHEET_NAME_KEY, sheet.name)
  const others = getRecentSpreadsheets().filter((entry) => entry.id !== sheet.id)
  write(RECENT_SHEETS_KEY, JSON.stringify([sheet, ...others].slice(0, RECENT_LIMIT)))
}

/** Every grade book opened on this device, most recent first. Lets a teacher with several classes
 *  switch without going back through the Drive picker. */
export function getRecentSpreadsheets(): RememberedSpreadsheet[] {
  try {
    const parsed: unknown = JSON.parse(read(RECENT_SHEETS_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is RememberedSpreadsheet => !!entry && typeof entry.id === 'string' && !!entry.id)
      .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : '' }))
  } catch {
    return []
  }
}

/** Email of the Google account last connected on this device, or '' before the first connect. */
export function getRememberedAccount(): string {
  return read(ACCOUNT_KEY)
}

export function rememberAccount(email: string): void {
  write(ACCOUNT_KEY, email)
}

/** Drops a spreadsheet this app can no longer open, so it is picked again rather than retried. */
export function forgetSpreadsheet(id: string): void {
  if (read(SHEET_ID_KEY) === id) {
    write(SHEET_ID_KEY, null)
    write(SHEET_NAME_KEY, null)
  }
  const others = getRecentSpreadsheets().filter((entry) => entry.id !== id)
  write(RECENT_SHEETS_KEY, JSON.stringify(others))
}

export function hasCopiedTemplate(): boolean {
  return read(TEMPLATE_COPIED_KEY) === 'true'
}

export function markTemplateCopied(): void {
  write(TEMPLATE_COPIED_KEY, 'true')
}

/** Ids of the first-visit tips this device has already shown. */
export function getSeenTips(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(SEEN_TIPS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function markTipsSeen(ids: string[]): void {
  write(SEEN_TIPS_KEY, JSON.stringify([...new Set([...getSeenTips(), ...ids])]))
}

/** Signing out wipes what this device remembers, so the next teacher starts at step 1. */
export function forgetEverything(): void {
  for (const key of [SHEET_ID_KEY, SHEET_NAME_KEY, RECENT_SHEETS_KEY, TEMPLATE_COPIED_KEY, ACCOUNT_KEY, SEEN_TIPS_KEY]) write(key, null)
}
