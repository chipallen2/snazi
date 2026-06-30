'use client'

import { useState } from 'react'

export function CloseButton() {
  const [fallback, setFallback] = useState(false)

  function handleClose() {
    // Works when the tab was opened by a native app (iOS Mail, Messages, etc.)
    // or any script-opened context. Modern desktop browsers block it for
    // direct-navigation tabs — detect that and show a friendly fallback.
    window.open('', '_self', '')
    window.close()
    // If still here after a tick, the browser blocked the close — show message.
    setTimeout(() => {
      if (!window.closed) setFallback(true)
    }, 150)
  }

  if (fallback) {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-lg font-semibold text-stone-700">You can close this tab.</p>
        <p className="text-sm text-stone-400">Your browser blocked automatic close.</p>
      </div>
    )
  }

  return (
    <button
      onClick={handleClose}
      className="btn btn-lg w-full max-w-xs bg-stone-900 py-4 text-white shadow-sm hover:bg-stone-700 active:bg-stone-800"
    >
      Close
    </button>
  )
}
