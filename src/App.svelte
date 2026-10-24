<script lang="ts">
  import { onMount, tick } from 'svelte'
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Check from '@lucide/svelte/icons/check'
  import CloudCheck from '@lucide/svelte/icons/cloud-check'
  import CloudUpload from '@lucide/svelte/icons/cloud-upload'
  import ListChecks from '@lucide/svelte/icons/list-checks'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import CopyPlus from '@lucide/svelte/icons/copy-plus'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Lock from '@lucide/svelte/icons/lock'
  import LogOut from '@lucide/svelte/icons/log-out'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minimize from '@lucide/svelte/icons/minimize'
  import Pencil from '@lucide/svelte/icons/pencil'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import X from '@lucide/svelte/icons/x'
  import BehaviorsEditor from './BehaviorsEditor.svelte'
  import Tips from './Tips.svelte'
  import {
    authorize,
    clearAuthorization,
    GoogleAuthError,
    missingGoogleConfig,
    missingTemplateConfig,
    pickSpreadsheet,
    prepareAuthorization,
    templateCopyUrl,
  } from './lib/google'
  import {
    getRecentSpreadsheets,
    getRememberedAccount,
    getRememberedSpreadsheet,
    hasCopiedTemplate,
    markTemplateCopied,
    forgetEverything,
    forgetSpreadsheet,
    rememberSpreadsheet,
    type RememberedSpreadsheet,
  } from './lib/setup'
  import {
    addBehavior,
    addStudents,
    isAuthorizationError,
    isUnreachableSheetError,
    loadGradebook,
    parseRosterNames,
    removeBehavior,
    renameBehavior,
    renameSpreadsheet,
    restoreBehavior,
    saveGrades,
  } from './lib/sheets'
  import {
    addPending,
    applyPending,
    forgetLocalCopies,
    getPending,
    loadSnapshot,
    pendingGrade,
    removePending,
    renamePendingBehavior,
    saveSnapshot,
    type PendingGrade,
  } from './lib/local-copy'
  import { activeBehaviors, totalFor, type BehaviorDraft, type Gradebook, type Grades, type Student } from './lib/types'

  // Email of the Google account connected on this device. There is no server session: a token is
  // fetched from Google (by popup) on the first click that needs one, and again about hourly.
  let account = ''
  let gradebook: Gradebook | null = null
  let pendingGradebook: Gradebook | null = null // loaded at pick time on the first run, shown by step 5
  let spreadsheet: RememberedSpreadsheet | null = null
  let recent: RememberedSpreadsheet[] = [] // grade books opened on this device, for the switcher menu
  let switcherOpen = false
  let switcher: HTMLElement | undefined
  let fullscreen = false
  let renaming = false
  let draftTitle = ''
  let titleInput: HTMLInputElement | undefined
  // iPadOS Safari before 16.4 only has the webkit-prefixed API; iPhones have none, so the button hides.
  const fullscreenSupported =
    typeof document !== 'undefined' && !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled)
  let templateCopied = false
  let selectedStudent: Student | null = null
  let draftGrades: Grades | null = null
  let loading = false
  let saving = false
  // Grades saved on this device that the sheet does not have yet; the Save button writes them.
  let pending: PendingGrade[] = []
  let syncing = false
  let confirmingSignOut = false
  let notice = ''
  let error = ''
  let justSaved = '' // student name whose card is pulsing after a save
  let justSavedTimer: ReturnType<typeof setTimeout> | undefined
  let modal: HTMLDialogElement
  let rosterModal: HTMLDialogElement
  let rosterText = ''
  let rosterOpen = false
  let rosterTextarea: HTMLTextAreaElement | undefined
  let behaviorsModal: HTMLDialogElement
  let behaviorsOpen = false

  onMount(() => {
    spreadsheet = getRememberedSpreadsheet()
    templateCopied = hasCopiedTemplate()
    account = getRememberedAccount()
    // The roster this device last saw opens without Google, so grading never waits on a popup.
    const cached = spreadsheet && loadSnapshot(spreadsheet.id)
    if (cached) show(cached)
    prepareAuthorization()
    syncFullscreen()
    document.addEventListener('webkitfullscreenchange', syncFullscreen)
    return () => document.removeEventListener('webkitfullscreenchange', syncFullscreen)
  })

  function syncFullscreen() {
    fullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement)
  }

  async function toggleFullscreen() {
    const root = document.documentElement as any
    try {
      if (fullscreen) await (document.exitFullscreen?.() ?? (document as any).webkitExitFullscreen?.())
      else await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.())
    } catch {
      // The browser refused (no user gesture, embedded, etc.); the button just stays as it is.
    }
    syncFullscreen()
  }

  // Indexes into gradebook.behaviors (and each student's grades) of the behaviors graded today.
  $: active = gradebook ? activeBehaviors(gradebook.behaviors) : []
  $: classPoints = gradebook?.students.reduce((sum, student) => sum + totalFor(student.grades, gradebook!.behaviors), 0) ?? 0
  $: possiblePoints = (gradebook?.students.length ?? 0) * active.length
  $: unsaved = new Set(pending.filter((entry) => entry.dayKey === gradebook?.dayKey).map((entry) => entry.name))
  $: if (gradebook) saveSnapshot(gradebook)
  $: rosterNames = parseRosterNames(rosterText, gradebook?.students.map((student) => student.name) ?? [])
  // Onboarding is a strict ladder: a step is only actionable once every step above it is done.
  $: connected = !!account
  $: stepsDone = [connected, templateCopied || !!spreadsheet, !!spreadsheet, false]
  $: currentStep = stepsDone.indexOf(false) + 1
  $: stepState = (step: number) =>
    stepsDone[step - 1] ? 'done' : step === currentStep ? 'current' : 'locked'

  function resetMessages() {
    notice = ''
    error = ''
    confirmingSignOut = false
  }

  function showError(caught: unknown) {
    error = caught instanceof Error ? caught.message : 'Something went wrong. Please try again.'
  }

  // Wraps authorize() so the header and copy link follow whichever account Google handed back.
  // Like authorize(), call it before any await in a click handler, or the popup is blocked.
  async function getToken(): Promise<string> {
    const current = await authorize()
    account = getRememberedAccount()
    return current
  }

  // A closed popup is the teacher's choice, not an error; Google 401s mean the token is dead.
  function handleFailure(caught: unknown) {
    if (caught instanceof GoogleAuthError && caught.cancelled) {
      notice = caught.message
      return
    }
    if (isAuthorizationError(caught)) {
      clearAuthorization()
      error = 'Your Google sign-in expired. Try again to reconnect.'
      return
    }
    showError(caught)
  }

  // A remembered sheet Google will not open is forgotten, which puts "Pick your copy" back in
  // front of the teacher; picking it again grants this app access to it.
  function forgetUnreachable(id: string, name: string) {
    forgetSpreadsheet(id)
    recent = getRecentSpreadsheets()
    if (spreadsheet?.id === id) spreadsheet = null
    // Close this device's copy too, so the picker step is on screen. Unsaved grades stay stored
    // and come back if the teacher picks the same sheet again.
    if (gradebook?.id === id) {
      gradebook = null
      pending = []
    }
    error = `Google won’t let this app open “${name || 'that grade book'}”. Choose it again in Google’s file picker to give the app access.`
  }

  // Puts a grade book on screen with this device's unsaved grades on top.
  function show(next: Gradebook) {
    pending = getPending(next.id)
    gradebook = applyPending(next, pending)
  }

  // Writes this device's pending grades for `id` to the sheet and shows the sheet as it now stands.
  // Returns the freshly loaded grade book, so a caller about to change the sheet's columns works
  // from the sheet's current layout.
  async function flushPending(id: string, token: string): Promise<Gradebook> {
    const batch = getPending(id)
    const fresh = await loadGradebook(id, token)
    await saveGrades(fresh, batch, token)
    const remaining = removePending(id, batch)
    const latest = applyPending(fresh, [...batch, ...remaining])
    if (gradebook?.id === id) {
      pending = remaining
      gradebook = latest
    }
    return latest
  }

  // The Save button: the only way grades reach the sheet. With an expired token this opens
  // Google's popup, so it has to start inside the click.
  async function syncPending() {
    if (!gradebook || syncing) return
    const id = gradebook.id
    syncing = true
    resetMessages()
    try {
      const token = await getToken()
      await flushPending(id, token)
    } catch (caught) {
      if (isUnreachableSheetError(caught)) forgetUnreachable(id, gradebook?.title ?? '')
      else handleFailure(caught)
    } finally {
      syncing = false
    }
  }

  async function connectGoogle() {
    resetMessages()
    loading = true
    try {
      await getToken()
    } catch (caught) {
      handleFailure(caught)
      return
    } finally {
      loading = false
    }
    // The token is in hand, so this needs no popup: a teacher whose grade book is already
    // remembered on this device goes straight to it.
    if (spreadsheet) await openGradebook(spreadsheet.id)
  }

  // Forgets the token and this device's setup. The Drive grant stays with Google, so coming back
  // is one click; revoking it is done from the Google Account page.
  function endSession() {
    if (pending.length && !confirmingSignOut) {
      error = `${pending.length} ${pending.length === 1 ? 'grade has' : 'grades have'} not been saved to your sheet. Save first, or press Sign out again to discard ${pending.length === 1 ? 'it' : 'them'}.`
      confirmingSignOut = true
      return
    }
    resetMessages()
    clearAuthorization()
    forgetEverything()
    forgetLocalCopies()
    pending = []
    gradebook = null
    pendingGradebook = null
    selectedStudent = null
    spreadsheet = null
    recent = []
    templateCopied = false
    account = ''
  }

  async function openGradebook(id: string) {
    resetMessages()
    loading = true
    try {
      const token = await getToken()
      const loaded = await loadGradebook(id, token)
      show(loaded)
      // The title is the Drive file name, so a rename in Google Sheets shows up here on the next
      // load; keep the switcher's recent list in step with it.
      if (loaded.title && loaded.title !== spreadsheet?.name) {
        spreadsheet = { id, name: loaded.title }
        rememberSpreadsheet(spreadsheet)
      }
    } catch (caught) {
      if (isUnreachableSheetError(caught)) forgetUnreachable(id, spreadsheet?.id === id ? spreadsheet.name : '')
      else handleFailure(caught)
    } finally {
      loading = false
    }
  }

  function copyTemplate() {
    markTemplateCopied()
    templateCopied = true
  }

  async function chooseSpreadsheet() {
    resetMessages()
    loading = true
    try {
      const picked = await pickSpreadsheet()
      if (!picked) return
      // Check the tabs now so a wrong file is caught on this step. The roster waits behind step 5
      // on this first run; every later visit skips the list and opens it directly.
      const token = await getToken()
      pendingGradebook = await loadGradebook(picked.id, token)
      spreadsheet = { id: picked.id, name: pendingGradebook.title || picked.name }
      rememberSpreadsheet(spreadsheet)
      templateCopied = true
    } catch (caught) {
      handleFailure(caught)
    } finally {
      loading = false
    }
  }

  function startGrading() {
    if (!spreadsheet) return
    if (pendingGradebook) {
      resetMessages()
      show(pendingGradebook)
      pendingGradebook = null
      return
    }
    // A returning visit, or a retry: the roster loads now, inside this click, so Google's popup can open.
    return openGradebook(spreadsheet.id)
  }

  async function startRename() {
    if (!gradebook) return
    draftTitle = gradebook.title
    renaming = true
    await tick()
    titleInput?.select()
  }

  function cancelRename() {
    renaming = false
  }

  async function saveRename() {
    if (!gradebook || saving) return
    const next = draftTitle.trim()
    if (!next || next === gradebook.title) return cancelRename()
    saving = true
    resetMessages()
    try {
      const token = await getToken()
      const title = await renameSpreadsheet(gradebook.id, next, token)
      gradebook = { ...gradebook, title }
      spreadsheet = { id: gradebook.id, name: title }
      rememberSpreadsheet(spreadsheet)
      renaming = false
    } catch (caught) {
      handleFailure(caught)
    } finally {
      saving = false
    }
  }

  async function openRosterEditor() {
    rosterText = ''
    resetMessages()
    rosterOpen = true
    rosterModal.showModal()
    await tick()
    rosterTextarea?.focus()
  }

  // Names are appended to the "Class Roster" tab, then the grade book is reloaded so today's rows
  // exist for everyone. The text stays in the box if the write fails, so nothing has to be retyped.
  async function saveRoster() {
    if (!gradebook || !rosterNames.length) return
    saving = true
    resetMessages()
    const id = gradebook.id
    try {
      const token = await getToken()
      await addStudents(id, rosterNames, token)
      show(await loadGradebook(id, token))
      rosterModal.close()
    } catch (caught) {
      handleFailure(caught)
      if (!gradebook) rosterModal.close()
    } finally {
      saving = false
    }
  }

  function openBehaviorsEditor() {
    resetMessages()
    behaviorsOpen = true
    behaviorsModal.showModal()
  }

  // Every behavior edit changes the sheet's columns, so it works from a fresh load and the grade
  // book is reloaded afterwards rather than guessed at. Queued grades are keyed by behavior name,
  // so they wait for the Save button. Returns whether the edit went through, so the row can settle.
  async function editBehaviors(change: (current: Gradebook, token: string) => Promise<void>): Promise<boolean> {
    if (!gradebook || saving) return false
    saving = true
    resetMessages()
    const current = gradebook
    try {
      const token = await getToken()
      await change(await loadGradebook(current.id, token), token)
      show(await loadGradebook(current.id, token))
      return true
    } catch (caught) {
      handleFailure(caught)
      if (!gradebook) behaviorsModal.close()
      return false
    } finally {
      saving = false
    }
  }

  const onAddBehavior = (draft: BehaviorDraft) => editBehaviors((current, token) => addBehavior(current, draft, token))
  const onRenameBehavior = (index: number, draft: BehaviorDraft) =>
    editBehaviors(async (current, token) => {
      const from = current.behaviors[index].name
      await renameBehavior(current, index, draft, token)
      pending = renamePendingBehavior(current.id, from, draft.name.trim().replace(/\s+/g, ' '))
    })
  const onRemoveBehavior = (index: number) => editBehaviors((current, token) => removeBehavior(current, index, token))
  const onRestoreBehavior = (index: number) => editBehaviors((current, token) => restoreBehavior(current, index, token))

  function flashSaved(name: string) {
    clearTimeout(justSavedTimer)
    justSaved = name
    justSavedTimer = setTimeout(() => (justSaved = ''), 1400)
  }

  function editStudent(student: Student) {
    selectedStudent = student
    draftGrades = [...student.grades]
    resetMessages()
    modal.showModal()
  }

  function toggleBehavior(index: number) {
    if (draftGrades) draftGrades = draftGrades.map((grade, other) => (other === index ? !grade : grade))
  }

  // Grades are kept on this device until the teacher presses Save, so a lapsed Google sign-in never
  // blocks grading. The first-visit tips tell the teacher so.
  function saveGrade() {
    if (!gradebook || !selectedStudent || !draftGrades) return
    resetMessages()
    const original = selectedStudent
    const updated: Student = { ...original, grades: [...draftGrades] }
    pending = addPending(gradebook.id, pendingGrade(gradebook, updated))
    gradebook = {
      ...gradebook,
      students: gradebook.students.map((student) => (student.name === original.name ? updated : student)),
    }
    modal.close()
    flashSaved(updated.name)
  }

  function toggleSwitcher() {
    if (!switcherOpen) recent = getRecentSpreadsheets()
    switcherOpen = !switcherOpen
  }

  function closeSwitcherOnOutsideClick(event: PointerEvent) {
    if (switcherOpen && switcher && !switcher.contains(event.target as Node)) switcherOpen = false
  }

  function closeSwitcherOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && switcherOpen) switcherOpen = false
  }

  // Switching classes never goes back through onboarding. The current roster stays on screen until
  // the new one has loaded, so a cancelled picker or a wrong file changes nothing.
  async function switchTo(id: string, name: string) {
    switcherOpen = false
    if (id === gradebook?.id) return
    resetMessages()
    // Switch to this device's copy rather than stopping for Google; Refresh reloads the sheet.
    const cached = loadSnapshot(id)
    if (cached) {
      spreadsheet = { id, name: cached.title || name }
      rememberSpreadsheet(spreadsheet)
      show(cached)
      return
    }
    loading = true
    try {
      const token = await getToken()
      const next = await loadGradebook(id, token)
      spreadsheet = { id, name: next.title || name }
      rememberSpreadsheet(spreadsheet)
      show(next)
    } catch (caught) {
      if (isUnreachableSheetError(caught)) forgetUnreachable(id, name)
      else handleFailure(caught)
    } finally {
      loading = false
    }
  }

  async function switchViaPicker() {
    switcherOpen = false
    resetMessages()
    loading = true
    try {
      const picked = await pickSpreadsheet()
      if (picked) await switchTo(picked.id, picked.name)
    } catch (caught) {
      handleFailure(caught)
    } finally {
      loading = false
    }
  }

  function sheetUrl(id: string) {
    return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit'
  }
</script>

<svelte:window onpointerdown={closeSwitcherOnOutsideClick} onkeydown={closeSwitcherOnEscape} />
<svelte:document onfullscreenchange={syncFullscreen} />

<svelte:head>
  <title>Participation Grade Book</title>
  <meta name="description" content="Record daily participation directly in your own Google Sheet." />
</svelte:head>

<div class="app-shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </span>
      <span>Participation Grade Book</span>
    </div>

    {#if gradebook}
      <nav class="topbar-actions" aria-label="Grade book actions">
        <button
          class="nav-button save-button"
          data-tip="tip-save"
          class:unsaved={pending.length}
          onclick={syncPending}
          disabled={syncing || !pending.length}
          title={pending.length ? 'Save to your Google Sheet' : 'Everything is saved to your Google Sheet'}
        >
          {#if syncing}
            <RefreshCw size={18} class="spin" aria-hidden="true" /><span>Saving…</span>
          {:else if pending.length}
            <CloudUpload size={18} aria-hidden="true" /><span>Save to sheet</span>
            <b class="save-count" aria-label={pending.length + ' unsaved'}>{pending.length}</b>
          {:else}
            <CloudCheck size={18} aria-hidden="true" /><span>Saved</span>
          {/if}
        </button>
        <a class="nav-button" href={sheetUrl(gradebook.id)} target="_blank" rel="noreferrer" title="Open sheet in Google Sheets">
          <span>Open sheet</span><ArrowUpRight size={18} aria-hidden="true" />
        </a>
        <button
          class="nav-button icon-only"
          onclick={() => openGradebook(gradebook!.id)}
          disabled={loading}
          aria-label={loading ? 'Refreshing' : 'Refresh'}
          title="Refresh"
        >
          <RefreshCw size={20} class={loading ? 'spin' : ''} aria-hidden="true" />
        </button>
        <button class="nav-button" onclick={openBehaviorsEditor} disabled={loading} title="Edit behaviors">
          <ListChecks size={18} aria-hidden="true" /><span>Behaviors</span>
        </button>
        <div class="switcher" bind:this={switcher}>
          <button
            class="nav-button"
            onclick={toggleSwitcher}
            disabled={loading}
            title="Switch grade book"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
          >
            <ArrowLeftRight size={18} aria-hidden="true" /><span>Switch grade book</span>
            <ChevronDown size={16} class="switcher-caret" aria-hidden="true" />
          </button>
          {#if switcherOpen}
            <div class="menu" role="menu" aria-label="Switch grade book">
              {#if recent.length}
                <p class="menu-label" aria-hidden="true">Recent</p>
                {#each recent as sheet (sheet.id)}
                  <button
                    class="menu-item"
                    role="menuitemradio"
                    aria-checked={sheet.id === gradebook.id}
                    onclick={() => switchTo(sheet.id, sheet.name)}
                  >
                    <span class="menu-check" aria-hidden="true"><Check size={18} strokeWidth={2.5} /></span>
                    <span class="menu-text">{sheet.name || 'Untitled grade book'}</span>
                  </button>
                {/each}
                <hr class="menu-divider" />
              {/if}
              <button class="menu-item" role="menuitem" onclick={switchViaPicker}>
                <span class="menu-icon" aria-hidden="true"><FolderOpen size={18} /></span>
                <span class="menu-text">Choose another sheet…</span>
              </button>
              <a
                class="menu-item"
                class:disabled={missingTemplateConfig}
                role="menuitem"
                href={templateCopyUrl(account)}
                target="_blank"
                rel="noreferrer"
                aria-disabled={missingTemplateConfig}
                onclick={(event) => {
                  if (missingTemplateConfig) return event.preventDefault()
                  switcherOpen = false
                }}
              >
                <span class="menu-icon" aria-hidden="true"><CopyPlus size={18} /></span>
                <span class="menu-text">
                  New class from the template
                  <small>Make a copy in Google Sheets, then choose it here.</small>
                </span>
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            </div>
          {/if}
        </div>
        {#if fullscreenSupported}
          <button
            class="nav-button icon-only"
            onclick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {#if fullscreen}<Minimize size={20} aria-hidden="true" />{:else}<Maximize size={20} aria-hidden="true" />{/if}
          </button>
        {/if}
        <button class="nav-button" onclick={endSession} disabled={loading} title={confirmingSignOut ? 'Discard unsaved grades and sign out' : 'Sign out'}>
          <LogOut size={18} aria-hidden="true" /><span>{confirmingSignOut ? 'Discard and sign out' : 'Sign out'}</span>
        </button>
      </nav>
    {:else if account}
      <nav class="topbar-actions" aria-label="Account">
        <span class="privacy-note">{account}</span>
        <button class="text-button" onclick={endSession} disabled={loading}>Sign out</button>
      </nav>
    {:else}
      <span class="privacy-note">🔒 Your data stays in Google Drive</span>
    {/if}
  </header>

  {#if gradebook}
    <main class="gradebook-view">
      <section class="page-heading" aria-labelledby="roster-heading">
        <div class="heading-text">
          {#if renaming}
            <!-- The title is the Drive file name, so saving here renames the file in Google Drive. -->
            <form class="rename-form" onsubmit={(event) => { event.preventDefault(); void saveRename() }}>
              <input
                bind:this={titleInput}
                bind:value={draftTitle}
                class="rename-input"
                type="text"
                aria-label="Grade book name"
                maxlength="200"
                required
                disabled={saving}
                onkeydown={(event) => event.key === 'Escape' && cancelRename()}
              />
              <button class="button primary rename-save" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button class="button secondary rename-cancel" type="button" onclick={cancelRename} disabled={saving} aria-label="Cancel rename">
                <X size={20} aria-hidden="true" />
              </button>
            </form>
          {:else}
            <div class="heading-title">
              <h1 id="roster-heading">{gradebook.title}</h1>
              <button class="rename-link" type="button" onclick={startRename} disabled={loading} title="Rename grade book">
                <Pencil size={16} aria-hidden="true" /><span>Rename</span>
              </button>
            </div>
          {/if}
          <p class="subtext">{gradebook.dayLabel} · {gradebook.students.length} students</p>
        </div>
        <div class="class-total" aria-label={classPoints + ' out of ' + possiblePoints + ' class points'}>
          <strong>{classPoints}</strong><span> / {possiblePoints}</span>
          <small>class points</small>
        </div>
      </section>

      {#if gradebook.students.length}
        <section class="student-grid" aria-label="Student participation">
          {#each gradebook.students as student, index (student.name)}
            <button
              class="student-card"
              class:just-saved={justSaved === student.name}
              class:unsaved={unsaved.has(student.name)}
              data-tip={index === 0 ? 'tip-grade' : undefined}
              title={unsaved.has(student.name) ? student.name + ' (not saved to the sheet yet)' : student.name}
              onclick={() => editStudent(student)}
            >
              <span class={'initials color-' + ((index % 5) + 1)}>{student.initials}</span>
              <span class="student-details">
                <span class="student-name">{student.name}</span>
                <span class="bubbles" aria-label={totalFor(student.grades, gradebook.behaviors) + ' of ' + active.length}>
                  {#each active as index}
                    <span class:on={student.grades[index]} title={gradebook.behaviors[index].name}>
                      {gradebook.behaviors[index].emoji || gradebook.behaviors[index].name.charAt(0)}
                    </span>
                  {/each}
                </span>
              </span>
              <span class:perfect={totalFor(student.grades, gradebook.behaviors) === active.length} class="score">
                {totalFor(student.grades, gradebook.behaviors)}<small>/{active.length}</small>
              </span>
              <span class="chevron" aria-hidden="true">›</span>
              {#if unsaved.has(student.name)}<span class="sr-only">Not saved to the sheet yet</span>{/if}
            </button>
          {/each}
        </section>
      {:else}
        <section class="empty-state">
          <div class="empty-icon" aria-hidden="true">👋</div>
          <h2>No students on the roster yet</h2>
          <p>Paste your class list once and you’re ready to grade.</p>
          <div class="empty-actions">
            <button class="button primary" onclick={openRosterEditor} disabled={loading}>Add your roster</button>
            <a class="button secondary" href={sheetUrl(gradebook.id)} target="_blank" rel="noreferrer">
              <span>Edit in Google Sheets</span><ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
        </section>
      {/if}
    </main>
    <Tips />
    {#if error && !selectedStudent && !rosterOpen && !behaviorsOpen}
      <div class="toast" role="alert">
        <span class="toast-icon" aria-hidden="true">!</span>
        <span class="toast-text">{error}</span>
        <button class="toast-dismiss" onclick={() => (error = '')} aria-label="Dismiss">×</button>
      </div>
    {/if}
  {:else}
    <main class="setup-view">
      <section class="setup-intro">
        <h1>{currentStep === 4 && !pendingGradebook ? 'Welcome back' : 'Set up your grade book'}</h1>
      </section>

      {#if error}
        <div class="banner error-banner setup-banner" role="alert"><span>!</span>{error}</div>
      {/if}
      {#if notice}
        <div class="banner success-banner setup-banner" role="status"><span>✓</span>{notice}</div>
      {/if}
      {#if missingGoogleConfig}
        <div class="banner error-banner setup-banner" role="alert">
          <span>!</span>Google sign-in is not configured yet. Follow the README before connecting.
        </div>
      {/if}
      {#if missingTemplateConfig}
        <div class="banner error-banner setup-banner" role="alert">
          <span>!</span>The template spreadsheet is not configured yet. Follow the README before connecting.
        </div>
      {/if}

      <ol class="steps" aria-label="Setup steps">
        <!-- 1. Connect Google -->
        <li class={'step ' + stepState(1)} aria-current={stepState(1) === 'current' ? 'step' : undefined}>
          <span class="step-mark" aria-hidden="true">{connected ? '✓' : '1'}</span>
          <div class="step-text">
            <strong>{connected ? 'Google connected' : 'Connect Google'}</strong>
            <span>
              {#if connected}
                {account}
              {:else}
                Google asks permission for files you pick — nothing else in your Drive.
              {/if}
            </span>
          </div>
          <button class="button primary step-action" onclick={connectGoogle} disabled={loading || missingGoogleConfig || stepState(1) !== 'current'}>
            {connected ? 'Connected' : loading && currentStep === 1 ? 'Opening Google…' : 'Connect Google'}
          </button>
        </li>

        <!-- 2. Make a copy -->
        <li class={'step ' + stepState(2)} aria-current={stepState(2) === 'current' ? 'step' : undefined}>
          <span class="step-mark" aria-hidden="true">{stepsDone[1] ? '✓' : '2'}</span>
          <div class="step-text">
            <strong>{stepsDone[1] ? 'Template copied' : 'Make your copy of the template'}</strong>
            <span>
              {#if stepsDone[1]}
                Your copy is in your Google Drive.
              {:else}
                Press <em>Make a copy</em> in the tab that opens, then come back.
                {#if stepState(2) === 'current'}
                  <button type="button" class="link-button" onclick={copyTemplate}>I already have a copy</button>
                {/if}
              {/if}
            </span>
          </div>
          <a
            class="button primary step-action"
            class:disabled={stepState(2) !== 'current' || missingTemplateConfig}
            href={templateCopyUrl(account)}
            target="_blank"
            rel="noreferrer"
            aria-disabled={stepState(2) !== 'current' || missingTemplateConfig}
            tabindex={stepState(2) === 'current' && !missingTemplateConfig ? 0 : -1}
            onclick={(event) => {
              if (stepState(2) !== 'current' || missingTemplateConfig) return event.preventDefault()
              copyTemplate()
            }}
          >{stepsDone[1] ? 'Copied' : 'Make a copy ↗'}</a>
        </li>

        <!-- 3. Pick the copy -->
        <li class={'step ' + stepState(3)} aria-current={stepState(3) === 'current' ? 'step' : undefined}>
          <span class="step-mark" aria-hidden="true">{spreadsheet ? '✓' : '3'}</span>
          <div class="step-text">
            <strong>{spreadsheet ? 'Spreadsheet chosen' : 'Pick your copy'}</strong>
            <span>
              {#if spreadsheet}
                {spreadsheet.name || 'Your grade book'}
                <button type="button" class="link-button" onclick={chooseSpreadsheet} disabled={loading}>Change</button>
              {:else}
                We’ll check the copy has the right tabs.
              {/if}
            </span>
          </div>
          <button class="button primary step-action" onclick={chooseSpreadsheet} disabled={loading || stepState(3) !== 'current'}>
            {spreadsheet ? 'Chosen' : loading && currentStep === 3 ? 'Opening Google…' : 'Choose spreadsheet'}
          </button>
        </li>

        <!-- 4. Start grading -->
        <li class={'step ' + stepState(4)} aria-current={stepState(4) === 'current' ? 'step' : undefined}>
          <span class="step-mark" aria-hidden="true">4</span>
          <div class="step-text">
            <strong>Start grading</strong>
            <span>Today’s roster, one tap per student, saved straight to your sheet.</span>
          </div>
          <button class="button primary step-action" onclick={startGrading} disabled={loading || stepState(4) !== 'current'}>
            {loading && currentStep === 4 ? 'Opening…' : 'Start grading'}
          </button>
        </li>
      </ol>

      <p class="privacy-line">🔒 The app can access only the file you choose. Student data is never sent to an app server.</p>
    </main>
  {/if}
</div>

<dialog
  bind:this={rosterModal}
  class="roster-modal"
  onclose={() => (rosterOpen = false)}
  onclick={(event) => event.target === event.currentTarget && !saving && rosterModal.close()}
>
  <form method="dialog">
    <button class="modal-close" value="cancel" aria-label="Close" disabled={saving}><X size={22} aria-hidden="true" /></button>

    <header class="modal-heading roster-heading">
      <div>
        <p class="eyebrow">Class roster</p>
        <h2>Add your students</h2>
      </div>
    </header>

    <label class="roster-label" for="roster-names">One name per line. Paste straight from a class list or spreadsheet column.</label>
    <textarea
      id="roster-names"
      bind:this={rosterTextarea}
      bind:value={rosterText}
      class="roster-textarea"
      rows="10"
      placeholder={'Ava Martinez\nBen Okafor\nChloe Nguyen'}
      disabled={saving}
      autocomplete="off"
      autocapitalize="words"
      spellcheck="false"
    ></textarea>
    <p class="roster-count" aria-live="polite">
      {#if rosterNames.length}
        {rosterNames.length} {rosterNames.length === 1 ? 'student' : 'students'} will be added
      {:else}
        &nbsp;
      {/if}
    </p>

    <p class="privacy-callout">
      <Lock size={16} aria-hidden="true" />
      <span>No student data ever leaves your Google Drive or this device. Names are written straight to your own sheet.</span>
    </p>

    {#if error}<p class="modal-error" role="alert">{error}</p>{/if}

    <footer class="modal-actions">
      <button class="button secondary" value="cancel" disabled={saving}>Cancel</button>
      <button class="button primary" type="button" onclick={saveRoster} disabled={saving || !rosterNames.length}>
        {saving ? 'Adding…' : rosterNames.length ? `Add ${rosterNames.length} ${rosterNames.length === 1 ? 'student' : 'students'}` : 'Add students'}
      </button>
    </footer>
  </form>
</dialog>

<dialog
  bind:this={behaviorsModal}
  class="behaviors-modal"
  onclose={() => (behaviorsOpen = false)}
  onclick={(event) => event.target === event.currentTarget && !saving && behaviorsModal.close()}
>
  {#if gradebook}
    <div class="modal-body">
      <form method="dialog">
        <button class="modal-close" value="cancel" aria-label="Close" disabled={saving}><X size={22} aria-hidden="true" /></button>
      </form>

      <header class="modal-heading roster-heading">
        <div>
          <p class="eyebrow">Grading tiles</p>
          <h2>Behaviors</h2>
          <p class="subtext">What you tap for each student. Every behavior is a column of the “Day Records” tab.</p>
        </div>
      </header>

      <BehaviorsEditor
        behaviors={gradebook.behaviors}
        busy={saving}
        onadd={onAddBehavior}
        onrename={onRenameBehavior}
        onremove={onRemoveBehavior}
        onrestore={onRestoreBehavior}
      />

      {#if error}<p class="modal-error" role="alert">{error}</p>{/if}
    </div>
  {/if}
</dialog>

<dialog
  bind:this={modal}
  class="grade-modal"
  onclose={() => (selectedStudent = null)}
  onclick={(event) => event.target === event.currentTarget && modal.close()}
>
  {#if selectedStudent && draftGrades && gradebook}
    <form method="dialog">
      <button class="modal-close" value="cancel" aria-label="Close grade editor"><X size={22} aria-hidden="true" /></button>

      <header class="modal-heading">
        <div class="initials modal-initials">{selectedStudent.initials}</div>
        <div>
          <p class="eyebrow">Today’s grade</p>
          <h2>{selectedStudent.name}</h2>
        </div>
        <div class="modal-score" aria-live="polite">
          <strong>{totalFor(draftGrades, gradebook.behaviors)}</strong><span>/{active.length}</span>
        </div>
      </header>

      <fieldset class="dimensions">
        <legend>Tap each habit that applied today</legend>
        <div class="dimension-tiles">
          {#each active as index}
            {@const behavior = gradebook.behaviors[index]}
            <button
              type="button"
              class:checked={draftGrades[index]}
              class="dimension-tile"
              onclick={() => toggleBehavior(index)}
              aria-pressed={draftGrades[index]}
            >
              <span class="tile-check" aria-hidden="true"><Check size={16} strokeWidth={3} /></span>
              <span class="dimension-emoji">{behavior.emoji || behavior.name.charAt(0)}</span>
              <span class="dimension-copy">
                <strong>{behavior.name}</strong>
                {#if behavior.description}<small>{behavior.description}</small>{/if}
              </span>
            </button>
          {/each}
        </div>
      </fieldset>

      {#if error}<p class="modal-error" role="alert">{error}</p>{/if}

      <footer class="modal-actions">
        <button class="button secondary" value="cancel" disabled={saving}>Cancel</button>
        <button class="button primary" type="button" onclick={saveGrade}>Save grade</button>
      </footer>
    </form>
  {/if}
</dialog>
