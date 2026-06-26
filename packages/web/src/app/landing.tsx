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
    { name: 'Unknown sender', addr: '+1 555 7741', state: 'block' as const },
  ]
  return (
    <div className="card relative w-full max-w-sm overflow-hidden p-5 shadow-lift">
      <div className="flex items-center justify-between border-b border-stone-100 pb-3">
        <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
          Who can reach your agent
        </span>
        <span className="pill bg-brand-50 text-brand-700">live</span>
      </div>
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
        <div className="container-wide grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-2">
          <div>
            <span className="eyebrow">Inbox bouncer for AI agents</span>
            <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              No messages
              <br />
              for you.
            </h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-stone-600">
              snazi is the bouncer for your AI assistant&apos;s inbox. It always
              tells your agent <span className="font-semibold text-ink">who</span>{' '}
              reached out — but only hands over the message if{' '}
              <span className="font-semibold text-ink">you&apos;ve approved</span>{' '}
              that sender.
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
          <div className="flex justify-center lg:justify-end">
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
              Your agent learns the name. You decide the rest.
            </h2>
            <p className="mt-3 text-stone-500">
              snazi sits between the world and your assistant, so a stranger
              never gets a free pass to your conversations.
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            <StepCard
              n="1"
              title="Someone messages your agent"
              body="A text or email lands. snazi captures who it's from — never the contents."
            />
            <StepCard
              n="2"
              title="snazi checks your list"
              body="Approved senders pass. Unknown or blocked ones get held at the door."
            />
            <StepCard
              n="3"
              title="You stay in control"
              body="Approve a new sender with one tap from a signed link. Everyone else? No messages for you."
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
            Privacy, not theater
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
