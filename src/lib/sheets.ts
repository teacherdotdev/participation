import {
  FAKE_GOOGLE,
  fakeAddBehavior,
  fakeAddStudents,
  fakeLoadGradebook,
  fakeRemoveBehavior,
  fakeRenameBehavior,
  fakeRenameSpreadsheet,
  fakeRestoreBehavior,
  fakeUpdateGrade,
} from './fake-google'
import {
  activeBehaviors,
  behaviorHeader,
  parseBehaviorHeader,
  type Behavior,
  type BehaviorDraft,
  type Gradebook,
  type Grades,
  type Student,
} from './types'

const API = 'https://sheets.googleapis.com/v4/spreadsheets'
const DAY_TAB = 'Day Records'
// Name and Date come first; every column after them up to Total is a behavior.
const FIRST_BEHAVIOR_COLUMN = 2
const FORMAT_ROWS = 1000 // the template formats and validates rows 2..1000

interface ValueRange {
  range?: string
  values?: unknown[][]
}

interface BatchValuesResponse {
  valueRanges?: ValueRange[]
}

interface SpreadsheetResponse {
  properties?: { title?: string; timeZone?: string }
  sheets?: {
    properties?: { sheetId?: number; title?: string }
    data?: { columnMetadata?: { hiddenByUser?: boolean }[] }[]
  }[]
}

interface AppendResponse {
  updates?: { updatedRange?: string }
}

class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GoogleApiError'
  }
}

async function googleFetch<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let message = `Google returned an error (${response.status}).`
    try {
      const body = await response.json()
      message = body?.error?.message || message
    } catch {
      // Keep the status-based message when Google returns no JSON body.
    }
    throw new GoogleApiError(message, response.status)
  }

  return response.json() as Promise<T>
}

function deriveInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 3)
}

/** 0 → A, 25 → Z, 26 → AA. */
function columnLetter(index: number): string {
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return letters
}

function cell(column: number, row: number): string {
  return `'${DAY_TAB}'!${columnLetter(column)}${row}`
}

/** A new day starts with Yes for every active behavior; archived columns are left blank. */
export function defaultGrades(behaviors: readonly Behavior[]): Grades {
  return behaviors.map((behavior) => !behavior.archived)
}

function isYes(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'yes'
}

function gradesFromRow(row: unknown[], count: number): Grades {
  return Array.from({ length: count }, (_, index) => isYes(row[index + FIRST_BEHAVIOR_COLUMN]))
}

/** Yes/No for every behavior column. Archived columns get null, which the Sheets API skips, so a
 *  grade recorded before the behavior was archived is never overwritten. */
function rowValues(name: string, serial: number, grades: Grades, behaviors: readonly Behavior[]): unknown[] {
  return [name, serial, ...behaviors.map((behavior, index) => (behavior.archived ? null : grades[index] ? 'Yes' : 'No'))]
}

/** The Total column formula: one N(...="Yes") term per behavior column, archived ones included so
 *  past days keep their totals. */
function totalFormula(behaviorCount: number): string {
  const terms = Array.from({ length: behaviorCount }, (_, index) => {
    const letter = columnLetter(index + FIRST_BEHAVIOR_COLUMN)
    return `N(${letter}2:${letter}="Yes")`
  })
  return `=ARRAYFORMULA(IF(A2:A="","",${terms.join('+')}))`
}

function dateParts(timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date())

  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)

  return { year: number('year'), month: number('month'), day: number('day') }
}

function dateSerial({ year, month, day }: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 25_569
}

function todayIn(timeZone: string) {
  const parts = dateParts(timeZone)
  const instant = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12))
  return {
    key: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    serial: dateSerial(parts),
    label: new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(instant),
  }
}

function headerMatches(actual: unknown[] | undefined, expected: readonly string[]): boolean {
  return expected.every((heading, index) => String(actual?.[index] ?? '').trim() === heading)
}

/** Checks the tabs and returns the Day Records header row with the index of its Total column. */
function validateTemplate(ranges: ValueRange[]): { headers: string[]; totalColumn: number } {
  const headers = (ranges[0]?.values?.[0] ?? []).map((value) => String(value ?? '').trim())
  const totalColumn = headers.indexOf('Total')
  if (!headerMatches(headers, ['Name', 'Date']) || totalColumn <= FIRST_BEHAVIOR_COLUMN) {
    throw new Error('This file does not have the expected “Day Records” columns.')
  }
  if (!headerMatches(ranges[1]?.values?.[0], ['Name', 'Initials'])) {
    throw new Error('This file does not have the expected “Class Roster” columns.')
  }
  if (!headerMatches(ranges[2]?.values?.[0], ['Week', 'Start Date', 'End Date'])) {
    throw new Error('This file does not have the expected “Week Ranges” columns.')
  }
  return { headers, totalColumn }
}

async function batchGet(spreadsheetId: string, token: string): Promise<ValueRange[]> {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' })
  ;[`'${DAY_TAB}'!A1:ZZ`, "'Class Roster'!A1:B", "'Week Ranges'!A1:C"].forEach((range) =>
    params.append('ranges', range),
  )

  const response = await googleFetch<BatchValuesResponse>(
    `${API}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`,
    token,
  )
  return response.valueRanges ?? []
}

/** Appends to the table in A:<last behavior column>. Total is left out because its array formula
 *  already fills every row and would make Google think the table is longer than it is. */
async function appendRows(spreadsheetId: string, token: string, behaviorCount: number, values: unknown[][]): Promise<number | null> {
  const lastColumn = columnLetter(FIRST_BEHAVIOR_COLUMN + behaviorCount - 1)
  const range = encodeURIComponent(`'${DAY_TAB}'!A:${lastColumn}`)
  const response = await googleFetch<AppendResponse>(
    `${API}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values }) },
  )
  const match = response.updates?.updatedRange?.match(/!A(\d+):[A-Z]+\d+$/)
  return match ? Number(match[1]) : null
}

export async function loadGradebook(spreadsheetId: string, token: string): Promise<Gradebook> {
  if (FAKE_GOOGLE) return fakeLoadGradebook(spreadsheetId)
  const [metadata, ranges] = await Promise.all([
    googleFetch<SpreadsheetResponse>(
      `${API}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(
        'properties(title,timeZone),sheets(properties(sheetId,title),data(columnMetadata(hiddenByUser)))',
      )}`,
      token,
    ),
    batchGet(spreadsheetId, token),
  ])

  const { headers, totalColumn } = validateTemplate(ranges)
  const dayTab = metadata.sheets?.find((sheet) => sheet.properties?.title === DAY_TAB)
  if (dayTab?.properties?.sheetId === undefined) {
    throw new Error('This file does not have the expected “Day Records” tab.')
  }
  const hiddenColumns = dayTab.data?.[0]?.columnMetadata ?? []
  const timeZone = metadata.properties?.timeZone || 'America/New_York'
  const today = todayIn(timeZone)
  const behaviorCount = totalColumn - FIRST_BEHAVIOR_COLUMN
  const hasHistory = new Array<boolean>(behaviorCount).fill(false)
  const todayByName = new Map<string, { row: number; grades: Grades }>()

  ;(ranges[0]?.values?.slice(1) ?? []).forEach((row, index) => {
    const name = String(row[0] ?? '').trim()
    if (!name) return
    if (Number(row[1]) === today.serial) {
      todayByName.set(name, { row: index + 2, grades: gradesFromRow(row, behaviorCount) })
      return
    }
    for (let column = 0; column < behaviorCount; column++) {
      if (String(row[column + FIRST_BEHAVIOR_COLUMN] ?? '').trim()) hasHistory[column] = true
    }
  })

  const behaviors: Behavior[] = headers.slice(FIRST_BEHAVIOR_COLUMN, totalColumn).map((header, index) => ({
    ...parseBehaviorHeader(header),
    archived: hiddenColumns[index + FIRST_BEHAVIOR_COLUMN]?.hiddenByUser === true,
    hasHistory: hasHistory[index],
  }))

  const roster = (ranges[1]?.values?.slice(1) ?? [])
    .map((row) => {
      const name = String(row[0] ?? '').trim()
      return { name, initials: String(row[1] ?? '').trim() || deriveInitials(name) }
    })
    .filter(({ name }) => name)

  const missing = roster.filter(({ name }) => !todayByName.has(name))
  if (missing.length) {
    const startRow = await appendRows(
      spreadsheetId,
      token,
      behaviorCount,
      missing.map(({ name }) => rowValues(name, today.serial, defaultGrades(behaviors), behaviors)),
    )
    if (startRow === null) return loadGradebook(spreadsheetId, token)
    missing.forEach(({ name }, index) => {
      todayByName.set(name, { row: startRow + index, grades: defaultGrades(behaviors) })
    })
  }

  const students: Student[] = roster.map((entry) => {
    const todayEntry = todayByName.get(entry.name)
    return {
      ...entry,
      row: todayEntry?.row ?? 0,
      grades: todayEntry?.grades ?? defaultGrades(behaviors),
    }
  })

  return {
    id: spreadsheetId,
    title: metadata.properties?.title || 'Participation Grade Book',
    timeZone,
    dayKey: today.key,
    dayLabel: today.label,
    sheetId: dayTab.properties.sheetId,
    behaviors,
    students,
  }
}

async function writeGrade(gradebook: Gradebook, student: Student, token: string): Promise<number> {
  const [year, month, day] = gradebook.dayKey.split('-').map(Number)
  const values = rowValues(student.name, dateSerial({ year, month, day }), student.grades, gradebook.behaviors)

  if (!student.row) {
    const row = await appendRows(gradebook.id, token, gradebook.behaviors.length, [values])
    if (!row) throw new Error('The grade was saved, but its row could not be located. Refresh and try again.')
    return row
  }

  const lastColumn = FIRST_BEHAVIOR_COLUMN + gradebook.behaviors.length - 1
  const range = encodeURIComponent(`'${DAY_TAB}'!A${student.row}:${columnLetter(lastColumn)}${student.row}`)
  await googleFetch(
    `${API}/${encodeURIComponent(gradebook.id)}/values/${range}?valueInputOption=RAW`,
    token,
    { method: 'PUT', body: JSON.stringify({ majorDimension: 'ROWS', values: [values] }) },
  )
  return student.row
}

export function updateGrade(gradebook: Gradebook, student: Student, token: string): Promise<number> {
  if (FAKE_GOOGLE) return fakeUpdateGrade(student)
  if ('locks' in navigator) {
    return navigator.locks.request(`participation-gradebook:${gradebook.id}`, () =>
      writeGrade(gradebook, student, token),
    )
  }
  return writeGrade(gradebook, student, token)
}

/** Renames the spreadsheet. The Sheets title is the Drive file name, and drive.file covers metadata
 *  on files the teacher picked, so no Drive API call is needed. Returns the title Google stored. */
export async function renameSpreadsheet(spreadsheetId: string, title: string, token: string): Promise<string> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Give the grade book a name.')
  if (FAKE_GOOGLE) return fakeRenameSpreadsheet(spreadsheetId, trimmed)
  await googleFetch(`${API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ updateSpreadsheetProperties: { properties: { title: trimmed }, fields: 'title' } }],
    }),
  })
  return trimmed
}

/** Turns pasted text into a clean list of names: one per line (or comma-separated on a single
 *  line), trimmed, with blanks and repeats dropped. Case-insensitive so "ava" and "Ava" are one. */
export function parseRosterNames(text: string, existing: readonly string[] = []): string[] {
  let lines = text.split(/\r?\n|\t/)
  if (lines.filter((line) => line.trim()).length === 1 && lines[0].includes(',')) lines = lines[0].split(',')
  const seen = new Set(existing.map((name) => name.toLowerCase()))
  const names: string[] = []
  for (const line of lines) {
    const name = line.trim().replace(/\s+/g, ' ')
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    names.push(name)
  }
  return names
}

/** Appends names to the "Class Roster" tab. Initials are left blank so the app derives them. The
 *  caller reloads the grade book afterwards, which creates today's rows for the new students. */
export async function addStudents(spreadsheetId: string, names: string[], token: string): Promise<void> {
  if (!names.length) return
  if (FAKE_GOOGLE) return fakeAddStudents(spreadsheetId, names)
  const range = encodeURIComponent("'Class Roster'!A:B")
  await googleFetch(
    `${API}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: names.map((name) => [name]) }) },
  )
}

// ---- Behaviors -------------------------------------------------------------------------------
// Each behavior is a "Day Records" column, so these edit the sheet's structure. The caller reloads
// the grade book afterwards; nothing here guesses at the result.

function batchUpdate(spreadsheetId: string, token: string, requests: unknown[]): Promise<unknown> {
  return googleFetch(`${API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  })
}

function columnRange(sheetId: number, column: number) {
  return { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 }
}

function setCellRequest(sheetId: number, column: number, row: number, value: { stringValue: string } | { formulaValue: string }) {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: column },
      rows: [{ values: [{ userEnteredValue: value }] }],
      fields: 'userEnteredValue',
    },
  }
}

function hideColumnRequest(sheetId: number, column: number, hidden: boolean) {
  return {
    updateDimensionProperties: { range: columnRange(sheetId, column), properties: { hiddenByUser: hidden }, fields: 'hiddenByUser' },
  }
}

/** Trims and checks a name, and rejects anything the sheet would misread. */
export function cleanBehaviorDraft(draft: BehaviorDraft, behaviors: readonly Behavior[], skipIndex = -1): BehaviorDraft {
  const name = draft.name.trim().replace(/\s+/g, ' ')
  const emoji = draft.emoji.trim()
  if (!name) throw new Error('Give the behavior a name.')
  if (/^[=+\-@']/.test(name) || /^[=+\-@']/.test(emoji)) throw new Error('A behavior cannot start with a formula character.')
  if (['total', 'name', 'date'].includes(name.toLowerCase())) throw new Error(`“${name}” is a column the sheet already uses.`)
  const clash = behaviors.findIndex((entry, index) => index !== skipIndex && entry.name.toLowerCase() === name.toLowerCase())
  if (clash >= 0) {
    throw new Error(behaviors[clash].archived ? `“${name}” is archived. Restore it instead.` : `“${name}” already exists.`)
  }
  return { name, emoji }
}

export async function renameBehavior(gradebook: Gradebook, index: number, draft: BehaviorDraft, token: string): Promise<void> {
  const clean = cleanBehaviorDraft(draft, gradebook.behaviors, index)
  if (FAKE_GOOGLE) return fakeRenameBehavior(index, clean)
  const range = encodeURIComponent(cell(index + FIRST_BEHAVIOR_COLUMN, 1))
  await googleFetch(`${API}/${encodeURIComponent(gradebook.id)}/values/${range}?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: JSON.stringify({ majorDimension: 'ROWS', values: [[behaviorHeader(clean)]] }),
  })
}

/** Inserts a column just before Total, formatted like the first behavior column, and marks today's
 *  existing rows Yes so the new behavior starts the way every day does. */
export async function addBehavior(gradebook: Gradebook, draft: BehaviorDraft, token: string): Promise<void> {
  const clean = cleanBehaviorDraft(draft, gradebook.behaviors)
  if (FAKE_GOOGLE) return fakeAddBehavior(clean)
  const { sheetId } = gradebook
  const column = FIRST_BEHAVIOR_COLUMN + gradebook.behaviors.length // where Total is now
  const grid = (columnIndex: number) => ({ sheetId, startRowIndex: 0, endRowIndex: FORMAT_ROWS, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 })
  await batchUpdate(gradebook.id, token, [
    { insertDimension: { range: columnRange(sheetId, column), inheritFromBefore: true } },
    { copyPaste: { source: grid(FIRST_BEHAVIOR_COLUMN), destination: grid(column), pasteType: 'PASTE_FORMAT', pasteOrientation: 'NORMAL' } },
    hideColumnRequest(sheetId, column, false), // inheritFromBefore copies "hidden" from an archived neighbour
    setCellRequest(sheetId, column, 0, { stringValue: behaviorHeader(clean) }),
    setCellRequest(sheetId, column + 1, 1, { formulaValue: totalFormula(gradebook.behaviors.length + 1) }),
  ])

  const todayRows = gradebook.students.filter((student) => student.row)
  if (!todayRows.length) return
  await googleFetch(`${API}/${encodeURIComponent(gradebook.id)}/values:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: todayRows.map((student) => ({ range: cell(column, student.row), values: [['Yes']] })),
    }),
  })
}

/** Archives a behavior that has past grades by hiding its column, so history and old totals stay
 *  intact. One that has only ever been graded today is simply deleted. */
export async function removeBehavior(gradebook: Gradebook, index: number, token: string): Promise<void> {
  if (activeBehaviors(gradebook.behaviors).length <= 1) throw new Error('Keep at least one behavior.')
  const behavior = gradebook.behaviors[index]
  if (FAKE_GOOGLE) return fakeRemoveBehavior(index)
  const { sheetId } = gradebook
  const column = index + FIRST_BEHAVIOR_COLUMN
  if (behavior.hasHistory) {
    await batchUpdate(gradebook.id, token, [hideColumnRequest(sheetId, column, true)])
    return
  }
  const totalColumnAfter = FIRST_BEHAVIOR_COLUMN + gradebook.behaviors.length - 1
  await batchUpdate(gradebook.id, token, [
    { deleteDimension: { range: columnRange(sheetId, column) } },
    setCellRequest(sheetId, totalColumnAfter, 1, { formulaValue: totalFormula(gradebook.behaviors.length - 1) }),
  ])
}

export async function restoreBehavior(gradebook: Gradebook, index: number, token: string): Promise<void> {
  if (FAKE_GOOGLE) return fakeRestoreBehavior(index)
  await batchUpdate(gradebook.id, token, [hideColumnRequest(gradebook.sheetId, index + FIRST_BEHAVIOR_COLUMN, false)])
}

/** `drive.file` only reaches files picked through this OAuth client; Google reports any other
 *  file (including one picked under an earlier client, or trashed) as 404. */
export function isUnreachableSheetError(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 404
}

export function isAuthorizationError(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 401
}
