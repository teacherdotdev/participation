// In-memory stand-ins for the Google sign-in popup, Google Picker and the Sheets API, used only when
// VITE_FAKE_GOOGLE=true (local click-through). Vite replaces the env check at build time, so none of
// this ships when the flag is unset.

import { DEFAULT_BEHAVIORS, type Behavior, type BehaviorDraft, type Gradebook, type PickedSpreadsheet, type Student } from './types'
import { defaultGrades } from './sheets'
import type { PendingGrade } from './local-copy'

export const FAKE_GOOGLE = import.meta.env.VITE_FAKE_GOOGLE === 'true'

// Open http://localhost:5173/?emptyRoster to start with no students and click through the
// add-roster flow. The fake roster lives in memory, so a plain reload brings the six back.
const EMPTY_ROSTER = new URLSearchParams(window.location.search).has('emptyRoster')
const ROSTER = EMPTY_ROSTER
  ? []
  : ['Ava Martinez', 'Ben Okafor', 'Chloe Nguyen', 'Diego Rossi', 'Emma Fischer', 'Farah Haddad']
const SHEET: PickedSpreadsheet = { id: 'fake-sheet-id', name: 'Period 3 Participation', url: '#' }

let students: Student[] | null = null
// The fake sheet pretends the built-in behaviors have been graded on earlier days, so removing
// one archives it; anything added during the session has no history and deletes outright.
let behaviors: Behavior[] = DEFAULT_BEHAVIORS.map(({ name, emoji, description }) => ({
  name,
  emoji,
  description,
  archived: false,
  hasHistory: true,
}))

const FAKE_EMAIL = 'teacher@example.com'

/** Stands in for the Google popup. Resolves `null` when the teacher "presses Cancel". */
export function fakeAuthorize(): Promise<{ accessToken: string; expiresAt: number; email: string } | null> {
  const ok = window.confirm(`[Fake Google sign-in]\n\nAllow access to files you pick as ${FAKE_EMAIL}?\n\nCancel simulates closing the Google window.`)
  // A short life so the re-authorization popup comes up during a click-through.
  return Promise.resolve(ok ? { accessToken: 'fake-token', expiresAt: Date.now() + 5 * 60_000, email: FAKE_EMAIL } : null)
}

export function fakePickSpreadsheet(): Promise<PickedSpreadsheet | null> {
  const ok = window.confirm(`[Fake Google Picker]\n\nPick “${SHEET.name}”?\n\nCancel simulates closing the picker.`)
  return Promise.resolve(ok ? SHEET : null)
}

function todayLabel(): { key: string; label: string } {
  const now = new Date()
  return {
    key: now.toISOString().slice(0, 10),
    label: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(now),
  }
}

export async function fakeLoadGradebook(spreadsheetId: string): Promise<Gradebook> {
  await new Promise((resolve) => setTimeout(resolve, 400))
  if (spreadsheetId !== SHEET.id) throw new Error('This file does not have the expected “Day Records” columns.')
  students ??= ROSTER.map((name, index) => ({
    name,
    initials: name.split(' ').map((part) => part[0]).join(''),
    row: index + 2,
    grades: defaultGrades(behaviors),
  }))
  const today = todayLabel()
  return {
    id: SHEET.id,
    title: SHEET.name,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayKey: today.key,
    dayLabel: today.label,
    sheetId: 0,
    behaviors: behaviors.map((behavior) => ({ ...behavior })),
    students: students.map((student) => ({ ...student, grades: [...student.grades] })),
  }
}

export async function fakeAddStudents(spreadsheetId: string, names: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (spreadsheetId !== SHEET.id) throw new Error('No such spreadsheet in the fake Drive.')
  students ??= []
  names.forEach((name) => {
    students!.push({
      name,
      initials: name.split(' ').map((part) => part[0]).join(''),
      row: students!.length + 2,
      grades: defaultGrades(behaviors),
    })
  })
}

export async function fakeRenameSpreadsheet(spreadsheetId: string, title: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (spreadsheetId !== SHEET.id) throw new Error('No such spreadsheet in the fake Drive.')
  SHEET.name = title
  return title
}

export async function fakeSaveGrades(entries: readonly PendingGrade[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  const today = todayLabel().key
  for (const entry of entries) {
    const student = entry.dayKey === today ? students?.find((other) => other.name === entry.name) : undefined
    if (!student) continue
    student.grades = behaviors.map((behavior, index) =>
      !behavior.archived && Object.hasOwn(entry.grades, behavior.name) ? entry.grades[behavior.name] : student.grades[index],
    )
  }
}

export async function fakeRenameBehavior(index: number, draft: BehaviorDraft): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  behaviors[index] = { ...behaviors[index], ...draft }
}

export async function fakeAddBehavior(draft: BehaviorDraft): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  behaviors = [...behaviors, { ...draft, description: '', archived: false, hasHistory: false }]
  students?.forEach((student) => student.grades.push(true))
}

export async function fakeRemoveBehavior(index: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (behaviors[index].hasHistory) {
    behaviors[index] = { ...behaviors[index], archived: true }
    return
  }
  behaviors = behaviors.filter((_, entry) => entry !== index)
  students?.forEach((student) => student.grades.splice(index, 1))
}

export async function fakeRestoreBehavior(index: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  behaviors[index] = { ...behaviors[index], archived: false }
}
