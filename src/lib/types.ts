/** The behaviors every template copy starts with. The header is what old template copies have in
 *  their "Day Records" columns; new copies and renamed behaviors use the "emoji name" form. */
export const DEFAULT_BEHAVIORS = [
  { header: 'Timely-ness', name: 'On time', emoji: '⏰', description: 'Ready when class starts' },
  { header: 'Prepared-ness', name: 'Prepared', emoji: '✏️', description: 'Materials are ready' },
  { header: 'Attentive-ness', name: 'Focused', emoji: '👀', description: 'Listening and learning' },
  { header: 'Contribution-ness', name: 'Participated', emoji: '💬', description: 'Joined the discussion' },
  { header: 'Collaboration-ness', name: 'Teamwork', emoji: '🤝', description: 'Worked kindly with others' },
] as const

/** A teacher-defined Yes/No dimension of participation. Each one is a column of the "Day Records"
 *  tab, so the sheet stays the single source of truth across devices. */
export interface Behavior {
  name: string
  emoji: string
  /** Only the built-in behaviors have one; it appears under the name on the grading tile. */
  description: string
  /** Hidden column in the sheet: past grades stay, new days no longer grade it. */
  archived: boolean
  /** Graded on a day other than today. Removing such a behavior archives it rather than deleting. */
  hasHistory: boolean
}

export type BehaviorDraft = Pick<Behavior, 'name' | 'emoji'>

/** One Yes/No per behavior column, in sheet order, archived columns included. */
export type Grades = boolean[]

export interface Student {
  name: string
  initials: string
  row: number
  grades: Grades
}

export interface Gradebook {
  id: string
  title: string
  timeZone: string
  dayKey: string
  dayLabel: string
  /** Numeric id of the "Day Records" tab, needed for column edits. */
  sheetId: number
  behaviors: Behavior[]
  students: Student[]
}

export interface PickedSpreadsheet {
  id: string
  name: string
  url: string
}

/** Header cell text for a behavior: the emoji, a space, and the name. */
export function behaviorHeader({ name, emoji }: BehaviorDraft): string {
  return `${emoji} ${name}`.trim()
}

/** Reads one "Day Records" column header back into a behavior. Legacy template headers map to the
 *  built-ins; otherwise a leading token with no letters or digits is taken as the emoji. */
export function parseBehaviorHeader(header: string): BehaviorDraft & { description: string } {
  const text = header.trim().replace(/\s+/g, ' ')
  const legacy = DEFAULT_BEHAVIORS.find((entry) => entry.header === text)
  if (legacy) return { name: legacy.name, emoji: legacy.emoji, description: legacy.description }
  const [first = '', ...rest] = text.split(' ')
  const hasEmoji = rest.length > 0 && !/[\p{L}\p{N}]/u.test(first)
  const name = hasEmoji ? rest.join(' ') : text
  const emoji = hasEmoji ? first : ''
  const builtIn = DEFAULT_BEHAVIORS.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  return { name, emoji, description: builtIn?.description ?? '' }
}

export function activeBehaviors(behaviors: readonly Behavior[]): number[] {
  return behaviors.flatMap((behavior, index) => (behavior.archived ? [] : [index]))
}

export function totalFor(grades: Grades, behaviors: readonly Behavior[]): number {
  return activeBehaviors(behaviors).reduce((total, index) => total + Number(grades[index]), 0)
}
