'use client'

import { useState } from 'react'

/** Password field with a show/hide reveal toggle. Presentational only. */
export function PasswordInput({
  name,
  autoComplete,
  minLength,
  autoFocus,
}: {
  name: string
  autoComplete?: string
  minLength?: number
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        name={name}
        type={show ? 'text' : 'password'}
        required
        minLength={minLength}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className="input pr-11"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-1.5 top-1/2 mt-[3px] -translate-y-1/2 rounded-lg p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
      >
        {show ? (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path
              d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.7 9.7 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.1 4M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.7 9.7 0 003.9-.8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path
              d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        )}
      </button>
    </div>
  )
}
