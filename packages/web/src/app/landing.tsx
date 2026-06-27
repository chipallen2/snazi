import Image from 'next/image'
import Link from 'next/link'

/* ----------------------------------------------------------------------------
 * Public marketing landing page (logged-out visitors at `/`).
 * Presentational only — sells the product, then routes to signup / login.
 * -------------------------------------------------------------------------- */

function StepCard({
  n,
  title,
  body,
}: {
  n: string
  title: string
  body: string
}) {
  return (
    <div className="card-pad relative">
      <span className="absolute -top-3 left-5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-sm font-bold text-brand-400 shadow-sm">
        {n}
      </span>
      <h3 className="mt-2 text-base font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-500">{body}</p>
    </div>
  )
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <div className="card-pad">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
        {icon}
      </div>
      <h3 className="mt-3.5 text-base font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-500">{body}</p>
    </div>
  )
}

/** Illustrative sender list — shows the gate in action. */
function HeroMock() {
  const rows = [
    { name: 'Mom', addr: '+1 555 0182', state: 'allow' as const },
    { name: 'Riley (work)', addr: 'riley@acme.co', state: 'allow' as const },
  ]
  return (
    <div className="card relative w-full max-w-sm overflow-hidden p-5 shadow-lift">
      <ul className="divide-y divide-stone-100">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">
                {r.name}
              </div>
              <div className="truncate font-mono text-xs text-stone-400">
                {r.addr}
              </div>
            </div>
            {r.state === 'allow' ? (
              <span className="pill bg-emerald-50 text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Allowed
              </span>
            ) : (
              <span className="pill bg-red-50 text-red-700">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                Blocked
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 rounded-xl bg-ink px-4 py-3 text-center text-sm font-semibold text-brand-300">
        Everyone else? No messages for you.
      </div>
    </div>
  )
}

export default function Landing() {
  return (
    <div>
      {/* ---- HERO ---- */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-grid-faint [background-size:22px_22px] opacity-50" />
        <div className="pointer-events-none absolute -right-32 -top-40 -z-10 h-[34rem] w-[34rem] rounded-full bg-brand-200/25 blur-[120px]" />
        <div className="container-wide grid items-start gap-12 py-16 sm:py-24 lg:grid-cols-2">
          <div>
            <span className="eyebrow">Inbox bouncer for AI agents</span>
            <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              No messages
              <br />
              for you.
            </h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-stone-600">
              snazi — short for{' '}
              <span className="font-semibold text-ink">Soup Nazi AI</span> — guards
              the inbox your AI assistant reads. Your agent can see{' '}
              <span className="font-semibold text-ink">who</span> messaged you, but
              it can&apos;t read <span className="font-semibold text-ink">what</span>{' '}
              they said until you approve that sender — so a stranger can never
              slip instructions to your AI, and your private messages stay
              private.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="btn-brand btn-lg shadow-glow">
                Get started — it&apos;s free
              </Link>
              <Link href="/login" className="btn-outline btn-lg">
                Sign in
              </Link>
            </div>
            <p className="mt-5 flex items-center gap-2 text-sm text-stone-500">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="h-4 w-4 text-emerald-600"
              >
                <path
                  d="M5 13l4 4L19 7"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Stores zero message content. An approve / deny list only.
            </p>
          </div>
          <div className="flex flex-col items-center gap-8">
            <Image
              src="/snazi-logo-text.png"
              alt="snazi — No messages for you!"
              width={800}
              height={800}
              priority
              className="w-full max-w-[12.8rem] drop-shadow-[0_24px_60px_rgba(28,25,23,0.28)] sm:max-w-[16rem]"
            />
            <HeroMock />
          </div>
        </div>
      </section>

      {/* ---- HOW IT WORKS ---- */}
      <section className="border-t border-stone-200/70 bg-white">
        <div className="container-wide py-16 sm:py-20">
          <div className="max-w-2xl">
            <span className="eyebrow">How it works</span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
              Your agent sees who. You decide what it can read.
            </h2>
            <p className="mt-3 text-stone-500">
              snazi sits between your messages and your AI assistant. Your agent
              can always see who reached out, but it can only open a message once
              you&apos;ve approved that sender.
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <StepCard
              n="1"
              title="A message comes in"
              body="Someone texts or emails you. snazi records who it's from — but not a word of what they said."
            />
            <StepCard
              n="2"
              title="snazi checks your list"
              body="If you've approved that sender, your agent can read the message. If not, it stays sealed."
            />
            <StepCard
              n="3"
              title="You approve in one tap"
              body="snazi sends you a one-tap link to allow or block each new sender. Until you allow them: no messages for you."
            />
          </div>
        </div>
      </section>

      {/* ---- FEATURES ---- */}
      <section className="border-t border-stone-200/70">
        <div className="container-wide py-16 sm:py-20">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={<IconEye />}
              title="Always know who"
              body="Your agent always sees the sender's name or address, so you never miss that someone reached out."
            />
            <FeatureCard
              icon={<IconLock />}
              title="Never leak what"
              body="Message content stays private until you approve the sender. snazi never stores a single message."
            />
            <FeatureCard
              icon={<IconBolt />}
              title="One-tap approvals"
              body="Approve or block a new sender straight from a signed link — no logging in, no friction."
            />
            <FeatureCard
              icon={<IconKey />}
              title="Read-only token"
              body="Your agent gets a token that can check the list and read approved messages — but can never approve a sender."
            />
            <FeatureCard
              icon={<IconChannels />}
              title="Built for every channel"
              body="One gate in front of iMessage and more — a single allow/deny list across the channels you connect."
            />
            <FeatureCard
              icon={<IconShield />}
              title="Private by design"
              body="No message archive to breach. snazi only ever knows the approve/deny list you control."
            />
          </div>
        </div>
      </section>

      {/* ---- PRIVACY BAND ---- */}
      <section className="border-t border-stone-200/70 bg-ink">
        <div className="container-wide flex flex-col items-center gap-4 py-16 text-center sm:py-20">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-400">
            No Messages in the Cloud
          </span>
          <h2 className="max-w-2xl text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            We can&apos;t leak what we never store.
          </h2>
          <p className="max-w-xl text-stone-300">
            snazi keeps an approve/deny list and nothing more. No message bodies,
            no archive, no copies. The gate decides; your conversations stay
            yours.
          </p>
        </div>
      </section>

      {/* ---- FINAL CTA ---- */}
      <section className="border-t border-stone-200/70 bg-white">
        <div className="container-wide flex flex-col items-center gap-6 py-16 text-center sm:py-20">
          <h2 className="max-w-2xl text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            Put a bouncer on your agent&apos;s inbox.
          </h2>
          <p className="max-w-md text-stone-500">
            Set up your list in minutes. Approve the people you trust — ignore
            everyone else.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="btn-brand btn-lg shadow-glow">
              Get started — it&apos;s free
            </Link>
            <Link href="/login" className="btn-outline btn-lg">
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ---- inline icons (presentational) ---- */
function IconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      {children}
    </svg>
  )
}
function IconEye() {
  return (
    <IconBase>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  )
}
function IconLock() {
  return (
    <IconBase>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </IconBase>
  )
}
function IconBolt() {
  return (
    <IconBase>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </IconBase>
  )
}
function IconKey() {
  return (
    <IconBase>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.5 12.5 9-9M16 6l3 3" />
    </IconBase>
  )
}
function IconChannels() {
  return (
    <IconBase>
      <path d="M8 10h8M8 13h5" />
      <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-6l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    </IconBase>
  )
}
function IconShield() {
  return (
    <IconBase>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </IconBase>
  )
}
