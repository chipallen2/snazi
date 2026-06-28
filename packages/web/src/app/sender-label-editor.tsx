'use client'

import { useState } from 'react'
import { renameSender } from './actions'

export function SenderLabelEditor({
  channelId,
  senderAddress,
  label,
}: {
  channelId: string
  senderAddress: string
  label: string | null
}) {
  const [editing, setEditing] = useState(false)
  const primary = label || senderAddress
  const sub = label ? senderAddress : null

  if (editing) {
    return (
      <form
        action={renameSender.bind(null, channelId, senderAddress)}
        className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={() => setEditing(false)}
      >
        <input
          name="label"
          required
          maxLength={64}
          defaultValue={label ?? ''}
          placeholder="Name"
          autoFocus
          className="input min-w-0 flex-1 py-1.5 text-sm"
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="submit"
            className="rounded-lg border border-stone-200 px-3 py-1.5 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-lg px-3 py-1.5 text-sm text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          >
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <div className="truncate font-semibold text-ink">{primary}</div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          aria-label={label ? `Rename ${label}` : `Add name for ${senderAddress}`}
        >
          {label ? 'Rename' : 'Add name'}
        </button>
      </div>
      {sub && <div className="truncate font-mono text-xs text-stone-500">{sub}</div>}
    </div>
  )
}
