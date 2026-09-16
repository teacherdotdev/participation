<script lang="ts">
  import ArchiveRestore from '@lucide/svelte/icons/archive-restore'
  import Check from '@lucide/svelte/icons/check'
  import Plus from '@lucide/svelte/icons/plus'
  import BehaviorRow from './BehaviorRow.svelte'
  import { activeBehaviors, behaviorHeader, type Behavior, type BehaviorDraft } from './lib/types'

  interface Props {
    behaviors: Behavior[]
    busy: boolean
    onadd: (draft: BehaviorDraft) => Promise<boolean>
    onrename: (index: number, draft: BehaviorDraft) => Promise<boolean>
    onremove: (index: number) => Promise<boolean>
    onrestore: (index: number) => Promise<boolean>
  }
  let { behaviors, busy, onadd, onrename, onremove, onrestore }: Props = $props()
  let name = $state('')
  let emoji = $state('')
  let justAdded = $state(false)
  const active = $derived(activeBehaviors(behaviors))
  const archived = $derived(behaviors.flatMap((behavior, index) => (behavior.archived ? [index] : [])))
  const duplicate = $derived(behaviors.some((behavior) => behavior.name.toLowerCase() === name.trim().toLowerCase()))

  async function add() {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean || duplicate || busy) return
    if (await onadd({ name: clean, emoji: emoji.trim() })) {
      name = ''
      emoji = ''
      justAdded = true
      setTimeout(() => (justAdded = false), 1200)
    }
  }
</script>

<form class="behavior-add" onsubmit={(event) => { event.preventDefault(); void add() }}>
  <label><span>Emoji <small>optional</small></span><input class="emoji-input" bind:value={emoji} maxlength="4" placeholder="🌱" disabled={busy} aria-label="Behavior emoji" /></label>
  <label><span>Behavior</span><input bind:value={name} maxlength="60" placeholder="Kind words" disabled={busy} aria-label="New behavior name" /></label>
  <button class="button primary" type="submit" disabled={busy || !name.trim() || duplicate}>
    {#if justAdded}<Check size={18} aria-hidden="true" /> Added{:else}<Plus size={18} aria-hidden="true" /> Add{/if}
  </button>
  {#if duplicate && name.trim()}<p class="row-error">That behavior already exists.</p>{/if}
</form>

<div class="behavior-list">
  {#each active as index (index + behaviorHeader(behaviors[index]))}
    <BehaviorRow behavior={behaviors[index]} {index} {behaviors} {busy} canRemove={active.length > 1} {onrename} {onremove} />
  {/each}
</div>

{#if archived.length}
  <section class="archived-behaviors" aria-labelledby="archived-heading">
    <h3 id="archived-heading">Archived</h3>
    <p class="subtext">Past grades are kept in a hidden column of the sheet. Restore one to start grading it again.</p>
    <ul class="archived-list">
      {#each archived as index (index + behaviorHeader(behaviors[index]))}
        <li>
          <span class="archived-name">{behaviorHeader(behaviors[index])}</span>
          <button class="icon-action restore-action" type="button" onclick={() => onrestore(index)} disabled={busy} aria-label={'Restore ' + behaviors[index].name}>
            <ArchiveRestore size={18} aria-hidden="true" /><span>Restore</span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}
