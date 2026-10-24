// This device's copy of each grade book: the roster as last seen, and grades saved here that have
// not reached the sheet yet. It keeps the roster on screen and grading working while the Google
// token has lapsed; only the teacher's Save click writes the pending grades to the sheet. Like the sheet itself, it never leaves this device.

import { defaultGrades, todayIn } from './sheets'
import type { Gradebook, Student } from './types'

const SNAPSHOT_PREFIX = 'participation-tracker.gradebook.'
const PENDING_PREFIX = 'participation-tracker.pending.'

/** A daily grade saved on this device but not yet in the sheet. Grades are keyed by behavior name,
 *  not column, so they still land in the right column if the behaviors change before syncing. */
export interface PendingGrade {
  name: string
  dayKey: string
  grades: Record<string, boolean>
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Without storage the app still works while Google is reachable; it just cannot hold grades.
  }
}

export function saveSnapshot(gradebook: Gradebook): void {
  writeJson(SNAPSHOT_PREFIX + gradebook.id, gradebook)
}

/** The grade book as this device last saw it, moved on to today if it was saved on an earlier day:
 *  today's grades start fresh, exactly as they would after loading from the sheet. */
export function loadSnapshot(id: string): Gradebook | null {
  const saved = readJson(SNAPSHOT_PREFIX + id) as Gradebook | null
  if (!saved || saved.id !== id || !Array.isArray(saved.students) || !Array.isArray(saved.behaviors)) return null
  const today = todayIn(saved.timeZone)
  if (saved.dayKey === today.key) return saved
  return {
    ...saved,
    dayKey: today.key,
    dayLabel: today.label,
    students: saved.students.map((student) => ({ ...student, row: 0, grades: defaultGrades(saved.behaviors) })),
  }
}

export function getPending(id: string): PendingGrade[] {
  const saved = readJson(PENDING_PREFIX + id)
  return Array.isArray(saved) ? saved : []
}

function setPending(id: string, entries: PendingGrade[]): PendingGrade[] {
  writeJson(PENDING_PREFIX + id, entries.length ? entries : null)
  return entries
}

export function pendingGrade(gradebook: Gradebook, student: Student): PendingGrade {
  const grades: Record<string, boolean> = {}
  gradebook.behaviors.forEach((behavior, index) => {
    if (!behavior.archived) grades[behavior.name] = student.grades[index]
  })
  return { name: student.name, dayKey: gradebook.dayKey, grades }
}

/** Queues a grade, replacing any unsynced grade for the same student and day. */
export function addPending(id: string, entry: PendingGrade): PendingGrade[] {
  const others = getPending(id).filter((other) => other.name !== entry.name || other.dayKey !== entry.dayKey)
  return setPending(id, [...others, entry])
}

/** Drops the grades that were just written. One changed again while the write was in flight
 *  no longer matches, so it stays queued. */
export function removePending(id: string, written: readonly PendingGrade[]): PendingGrade[] {
  const done = new Set(written.map((entry) => JSON.stringify(entry)))
  return setPending(id, getPending(id).filter((entry) => !done.has(JSON.stringify(entry))))
}

/** Follows a behavior rename, so queued grades still find their column when they are saved. */
export function renamePendingBehavior(id: string, from: string, to: string): PendingGrade[] {
  if (from === to) return getPending(id)
  return setPending(
    id,
    getPending(id).map((entry) => {
      if (!Object.hasOwn(entry.grades, from)) return entry
      const { [from]: grade, ...rest } = entry.grades
      return { ...entry, grades: { ...rest, [to]: grade } }
    }),
  )
}

/** Shows queued grades for the grade book's day on top of what the sheet (or snapshot) holds. */
export function applyPending(gradebook: Gradebook, entries: readonly PendingGrade[]): Gradebook {
  const byName = new Map(entries.filter((entry) => entry.dayKey === gradebook.dayKey).map((entry) => [entry.name, entry]))
  if (!byName.size) return gradebook
  return {
    ...gradebook,
    students: gradebook.students.map((student) => {
      const entry = byName.get(student.name)
      if (!entry) return student
      const grades = gradebook.behaviors.map((behavior, index) =>
        !behavior.archived && Object.hasOwn(entry.grades, behavior.name) ? entry.grades[behavior.name] : student.grades[index],
      )
      return { ...student, grades }
    }),
  }
}

/** Sign-out clears every grade book's copy, so the next teacher on this device sees none of it. */
export function forgetLocalCopies(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? '')
    keys.filter((key) => key.startsWith(SNAPSHOT_PREFIX) || key.startsWith(PENDING_PREFIX)).forEach((key) => localStorage.removeItem(key))
  } catch {
    // Nothing was stored.
  }
}
