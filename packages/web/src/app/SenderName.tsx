'use client'

import { useState } from 'react'
import type { SenderStatus } from '@/lib/types'

type RenameAction = (
  channel_id: string,
  sender_address: string,
  status: SenderStatus,
  formData: FormData
) => Promise<void>

/**
 * The name/address block of a sender row, with inline rename.
 *
 * Display mode shows the friendly name (or raw address) plus a small pencil to
 * edit, and an "Add name" affordance when no label is set. Edit mode reveals a
 * text input that saves the new label via the renameSender server action (the
 * admin key stays server-side; this component only holds a serializable
 * reference to the action). The current status is forwarded so a rename never
 * changes whether the sender is allowed or blocked.
 */
export function SenderName({
  channelId,
  senderAddress,
  label,
  status,
  channelBadge,
  renameSender,
}: {
  channelId: string
  senderAddress: string
  label: string | null
  status: SenderStatus
  channelBadge: string
  renameSender: RenameAction
}) {
  const [editing, setEditing] = useState(false)

  const primary = label || senderAddress
  const sub = label ? senderAddress : null

  if (editing) {
    return (
      <form
        action={async (formData) => {
          await renameSender(channelId, senderAddress, status, formData)
          setEditing(false)
        }}
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        <input
          name="label"
          defaultValue={label ?? ''}
          autoFocus
          placeholder="Name"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-400 hover:text-neutral-700"
        >
          Cancel
        </button>
      </form>
    )
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium text-neutral-900">{primary}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={label ? 'Rename' : 'Add name'}
          aria-label={label ? `Rename ${primary}` : `Add name for ${primary}`}
          className="shrink-0 rounded px-1 text-xs text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600"
        >
          ✎
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500">
        {sub && <span className="font-mono">{sub}</span>}
        <span className="rounded bg-neutral-100 px-1.5 py-0.5">
          {channelBadge}
        </span>
        {!label && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-neutral-400 underline decoration-dotted hover:text-neutral-700"
          >
            Add name
          </button>
        )}
      </div>
    </div>
  )
}
