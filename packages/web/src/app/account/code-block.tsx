'use client'

import { useState } from 'react'

/** Scrollable code block with a one-click copy button so long values
 *  (like the API token) are never lost to truncation. */
export function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <div className="relative">
      <pre className="code-block whitespace-pre-wrap break-all pr-16">{code}</pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2.5 top-2.5 rounded-lg border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-semibold text-stone-100 backdrop-blur transition-colors hover:bg-white/20"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}
