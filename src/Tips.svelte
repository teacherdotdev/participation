<script lang="ts">
  import { getSeenTips, markTipsSeen } from './lib/setup'

  /**
   * First-visit tips, shown one after another as a short tour (the same pattern as Happy
   * Hallways). Each points at the element marked `data-tip="{id}"`, waits until it has settled on
   * the page, steps aside while a dialog is open, and is shown once per device.
   */
  const tips = [
    {
      id: 'tip-grade',
      title: 'Tap a student to grade',
      text: 'Every behavior starts as Yes each day. Tap a student to change theirs, then Save grade.',
    },
    {
      id: 'tip-save',
      title: 'Grades wait for Save',
      text: 'Grades are kept on this device as you go, and a dot marks each unsaved student. Press Save to sheet to send them to your Google Sheet; it reconnects Google if needed.',
    },
  ]

  let seen = $state(getSeenTips())
  const tour = $derived(tips.filter((tip) => !seen.includes(tip.id)))
  const tip = $derived(tour[0] ?? null)
  let target = $state<DOMRect | null>(null)

  $effect(() => {
    if (!tip) return
    const id = tip.id
    const since = Date.now()
    const find = () => {
      const element = document.querySelector(`[data-tip="${id}"]`)
      const dialogOpen = document.querySelector('dialog[open]')
      target = element && !dialogOpen && Date.now() - since >= 700 ? element.getBoundingClientRect() : null
    }
    find()
    const timer = setInterval(find, 400)
    window.addEventListener('scroll', find, true)
    window.addEventListener('resize', find)
    return () => {
      clearInterval(timer)
      window.removeEventListener('scroll', find, true)
      window.removeEventListener('resize', find)
      target = null
    }
  })

  function done(ids: string[]) {
    markTipsSeen(ids)
    seen = getSeenTips()
  }

  /** Beside its target when there's room, otherwise below it, always on screen. */
  const placement = $derived.by(() => {
    if (!target) return null
    const width = 300
    const right = target.right + 16
    if (right + width < window.innerWidth - 12 && target.width < 400) {
      return { left: right, top: Math.max(12, Math.min(target.top, window.innerHeight - 220)), side: 'left' }
    }
    return {
      left: Math.max(12, Math.min(target.left, window.innerWidth - width - 12)),
      top: Math.min(target.bottom + 12, window.innerHeight - 220),
      side: 'top',
    }
  })
  const tipNumber = $derived(tip ? tips.indexOf(tip) + 1 : 0)
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && tip && target && done(tour.map((each) => each.id))} />

{#if tip && placement && target}
  <div
    class="tip-spotlight"
    aria-hidden="true"
    style:left="{target.left - 6}px"
    style:top="{target.top - 6}px"
    style:width="{target.width + 12}px"
    style:height="{target.height + 12}px"
  ></div>
  <div class="tip" role="dialog" aria-labelledby="tip-title" style:left="{placement.left}px" style:top="{placement.top}px">
    <p class="eyebrow">Tip · {tipNumber} of {tips.length}</p>
    <h3 id="tip-title">{tip.title}</h3>
    <p class="tip-text">{tip.text}</p>
    <div class="tip-actions">
      {#if tour.length > 1}
        <button class="button secondary" onclick={() => done(tour.map((each) => each.id))}>Skip</button>
        <button class="button primary" onclick={() => done([tip.id])}>Next</button>
      {:else}
        <button class="button primary" onclick={() => done([tip.id])}>Got it</button>
      {/if}
    </div>
  </div>
{/if}
