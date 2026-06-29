'use client'

export function CloseButton() {
  return (
    <button
      onClick={() => window.close()}
      className="btn btn-lg w-full max-w-xs bg-stone-900 py-4 text-white shadow-sm hover:bg-stone-700 active:bg-stone-800"
    >
      Close
    </button>
  )
}
