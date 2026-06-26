import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // Brand accent — warm "broth" gold. Confident, premium, a little cheeky.
        brand: {
          50: '#fff8eb',
          100: '#ffedc6',
          200: '#ffd988',
          300: '#ffc14a',
          400: '#ffa91f',
          500: '#f98906',
          600: '#dd6602',
          700: '#b74706',
          800: '#94370c',
          900: '#7a2f0d',
        },
        // Ink — the bouncer's authority. Warm near-black built on stone.
        ink: {
          DEFAULT: '#1c1917',
          900: '#1c1917',
          950: '#0f0d0c',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(28 25 23 / 0.04), 0 4px 16px -4px rgb(28 25 23 / 0.08)',
        lift: '0 8px 30px -8px rgb(28 25 23 / 0.18)',
        glow: '0 10px 40px -12px rgb(249 137 6 / 0.45)',
      },
      backgroundImage: {
        'grid-faint':
          'radial-gradient(circle at 1px 1px, rgb(28 25 23 / 0.06) 1px, transparent 0)',
      },
    },
  },
  plugins: [],
}
export default config
