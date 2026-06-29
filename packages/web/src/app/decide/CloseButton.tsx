'use client'

export function CloseButton() {
  function handleClose() {
    // Reassociate as script-opened before closing — works cross-browser
    // for tabs that were navigated to directly (e.g. tapped from email).
    window.open('', '_self', '')
    window.close()
    // Fallback: if still here after 300ms, navigate to blank
    setTimeout(() => {
      document.body.innerHTML =
        '<div style="font-family:sans-serif;text-align:center;padding:4rem;color:#666">You can close this tab.</div>'
    }, 300)
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
