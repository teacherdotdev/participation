<script lang="ts">
  import { untrack } from 'svelte'
  import Save from '@lucide/svelte/icons/save'
  import Trash from '@lucide/svelte/icons/trash'
  import type { Behavior, BehaviorDraft } from './lib/types'

  interface Props {
    behavior: Behavior
    index: number
    behaviors: Behavior[]
    busy: boolean
    /** False when this is the last active behavior; at least one must remain. */
    canRemove: boolean
    onrename: (index: number, draft: BehaviorDraft) => Promise<boolean>
    onremove: (index: number) => Promise<boolean>
  }
  let { behavior, index, behaviors, busy, canRemove, onrename, onremove }: Props = $props()
  let name = $state(untrack(() => behavior.name))
  let emoji = $state(untrack(() => behavior.emoji))
  let confirming = $state(false)
  const changed = $derived(name.trim() !== behavior.name || emoji.trim() !== behavior.emoji)
  const duplicate = $derived(
    behaviors.some((entry, other) => other !== index && entry.name.toLowerCase() === name.trim().toLowerCase()),
  )

  async function save() {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean || duplicate || busy) return
    if (await onrename(index, { name: clean, emoji: emoji.trim() })) confirming = false
  }

  async function remove() {
    if (!confirming) {
      confirming = true
      return
    }
    if (await onremove(index)) confirming = false
  }
</script>

<form class="behavior-row" class:confirming onsubmit={(event) => { event.preventDefault(); void save() }}>
  <input class="emoji-input" bind:value={emoji} maxlength="4" disabled={busy} aria-label={'Emoji for ' + behavior.name} />
  <label><span class="sr-only">Behavior name</span><input bind:value={name} maxlength="60" disabled={busy} aria-label={'Behavior name: ' + behavior.name} /></label>
  <button class="icon-action save-action" type="submit" disabled={busy || !changed || !name.trim() || duplicate} aria-label={'Save ' + behavior.name}>
    <Save size={18} aria-hidden="true" />
  </button>
  <button
    class="icon-action delete-action"
    class:confirming
    type="button"
    onclick={remove}
    disabled={busy || !canRemove}
    title={canRemove ? undefined : 'Keep at least one behavior'}
    aria-label={(confirming ? 'Confirm remove ' : 'Remove ') + behavior.name}
  >
    <Trash size={18} aria-hidden="true" /><span>{confirming ? 'Confirm' : ''}</span>
  </button>
  {#if duplicate}
    <p class="row-error">That behavior already exists.</p>
  {:else if confirming}
    <p class="row-hint">
      {#if behavior.hasHistory}
        Past days keep their grades; new days will not show it. You can restore it later.
      {:else}
        Nothing was graded for it before today, so its column will be deleted.
      {/if}
    </p>
  {/if}
</form>
