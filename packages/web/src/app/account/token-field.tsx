'use client'

import { useState } from 'react'

/** Read-only token display with mask, reveal toggle, and one-click copy. */
export function TokenField({ token }: { token: string }) {
  const [show, setShow] = useState(false)
  const [copied, setCopied] = useState(false)
  // Keep the mask short so it never wraps to a stray second line.
  const masked = `${token.slice(0, 6)}${'•'.repeat(8)}${token.slice(-4)}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      <code className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 font-mono text-xs text-stone-800">
        {show ? token : masked}
      </code>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="btn-outline px-3 py-2"
        >
          {show ? 'Hide' : 'Reveal'}
        </button>
        <button
          type="button"
          onClick={copy}
          className="btn-ink px-3 py-2"
          aria-live="polite"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
