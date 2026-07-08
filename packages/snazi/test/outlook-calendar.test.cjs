#!/usr/bin/env node
/**
 * Outlook (Microsoft Graph) CALENDAR adapter tests. No network: globalThis.fetch
 * is stubbed to model Graph + the Microsoft OAuth2 token endpoint. Asserts:
 *   - listCalendars maps GET /me/calendars -> {id,name,isDefault}
 *   - createCalendarEvent POSTs to /me/calendars/{id}/events
 *   - all-day date math: end is submitted as the EXCLUSIVE day-after the last
 *     inclusive day (single-day AND multi-day range)
 *   - timed events pass their ISO datetimes through untouched
 *   - date-only vs full-datetime handling
 *
 * Run:  npm run build && node test/outlook-calendar.test.cjs
 */
const { outlookAdapter } = require('../dist/channels/outlook.js')
const { clearTokenCache } = require('../dist/channels/oauth.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

function resp(json, ok = true, status = 200) {
  return { ok, status, json: async () => json, text: async () => JSON.stringify(json) }
}

const ctx = {
  id: 'outlook-work',
  type: 'outlook',
  name: 'Work',
  auth: { clientId: 'cid', clientSecret: '***', refreshToken: 'rtok', tenantId: 'contoso' },
}

const calls = []
function installFetch() {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('login.microsoftonline.com')) {
      return resp({ access_token: '***', expires_in: 3600 })
    }
    if (u.includes('/me/calendars') && (!init || (init.method || 'GET') === 'GET') && !/\/events$/.test(u)) {
      return resp({
        value: [
          { id: 'cal-default', name: 'Calendar', isDefaultCalendar: true },
          { id: 'cal-vac', name: 'Vacation', isDefaultCalendar: false },
        ],
      })
    }
    if (/\/me\/calendars\/[^/]+\/events$/.test(u) && init && init.method === 'POST') {
      const body = JSON.parse(init.body)
      return resp({ id: 'evt-1', ...body })
    }
    return resp({ error: `unexpected url ${u}` }, false, 500)
  }
}

async function main() {
  check(typeof outlookAdapter.listCalendars === 'function', 'adapter exposes listCalendars')
  check(typeof outlookAdapter.createCalendarEvent === 'function', 'adapter exposes createCalendarEvent')
  check(outlookAdapter.calendarAvailability(ctx).available === true, 'calendar available with creds')

  installFetch()
  clearTokenCache()

  // --- listCalendars ---
  const cals = await outlookAdapter.listCalendars(ctx)
  check(cals.length === 2, `lists 2 calendars (got ${cals.length})`)
  check(cals[0].id === 'cal-default' && cals[0].isDefault === true, 'default calendar flagged')
  check(cals[1].name === 'Vacation', 'named calendar surfaced')

  // --- single-day all-day event: end = day after ---
  calls.length = 0
  const single = await outlookAdapter.createCalendarEvent(ctx, {
    calendarId: 'cal-vac',
    subject: 'Abhi Vacation',
    start: '2026-07-20',
    allDay: true,
  })
  const singleCall = calls.find((c) => /\/me\/calendars\/cal-vac\/events$/.test(c.url))
  check(Boolean(singleCall) && singleCall.init.method === 'POST', 'single all-day POSTs to the named calendar')
  const singleBody = JSON.parse(singleCall.init.body)
  check(singleBody.isAllDay === true, 'single all-day sets isAllDay:true')
  check(singleBody.start.dateTime === '2026-07-20T00:00:00', 'single all-day start is date midnight')
  check(singleBody.end.dateTime === '2026-07-21T00:00:00', 'single all-day end is the EXCLUSIVE day-after')
  check(singleBody.start.timeZone === 'UTC' && singleBody.end.timeZone === 'UTC', 'default tz UTC on both ends')
  check(single.id === 'evt-1', 'returns created event id')

  // --- multi-day all-day range: end (inclusive) -> day-after ---
  calls.length = 0
  await outlookAdapter.createCalendarEvent(ctx, {
    calendarId: 'cal-vac',
    subject: 'Engagement (busy)',
    start: '2026-08-20',
    end: '2026-08-25', // inclusive last day
    allDay: true,
  })
  const rangeBody = JSON.parse(calls.find((c) => /\/events$/.test(c.url)).init.body)
  check(rangeBody.start.dateTime === '2026-08-20T00:00:00', 'range start correct')
  check(rangeBody.end.dateTime === '2026-08-26T00:00:00', 'range end = inclusive-last + 1 day (Aug 25 -> Aug 26)')

  // --- month rollover in day-after math ---
  calls.length = 0
  await outlookAdapter.createCalendarEvent(ctx, {
    calendarId: 'cal-vac',
    subject: 'Month end',
    start: '2026-07-31',
    allDay: true,
  })
  const rolloverBody = JSON.parse(calls.find((c) => /\/events$/.test(c.url)).init.body)
  check(rolloverBody.end.dateTime === '2026-08-01T00:00:00', 'July 31 all-day rolls to Aug 01 exclusive end')

  // --- custom timezone honored ---
  calls.length = 0
  await outlookAdapter.createCalendarEvent(ctx, {
    calendarId: 'cal-vac',
    subject: 'TZ test',
    start: '2026-07-20',
    allDay: true,
    timeZone: 'America/Los_Angeles',
  })
  const tzBody = JSON.parse(calls.find((c) => /\/events$/.test(c.url)).init.body)
  check(tzBody.start.timeZone === 'America/Los_Angeles', 'custom tz applied to start')
  check(tzBody.end.timeZone === 'America/Los_Angeles', 'custom tz applied to end')

  // --- timed (non-all-day) event passes ISO through, no day-after ---
  calls.length = 0
  await outlookAdapter.createCalendarEvent(ctx, {
    calendarId: 'cal-default',
    subject: 'Timed meeting',
    start: '2026-07-20T09:00:00',
    end: '2026-07-20T10:00:00',
    allDay: false,
    timeZone: 'America/Los_Angeles',
  })
  const timedBody = JSON.parse(calls.find((c) => /\/events$/.test(c.url)).init.body)
  check(timedBody.isAllDay === false, 'timed event isAllDay:false')
  check(timedBody.start.dateTime === '2026-07-20T09:00:00', 'timed start passed through')
  check(timedBody.end.dateTime === '2026-07-20T10:00:00', 'timed end passed through (no day-after)')

  // --- invalid all-day date rejected ---
  let threw = false
  try {
    await outlookAdapter.createCalendarEvent(ctx, {
      calendarId: 'cal-vac',
      subject: 'bad',
      start: 'not-a-date',
      allDay: true,
    })
  } catch {
    threw = true
  }
  check(threw, 'invalid all-day start date throws')

  if (failures === 0) {
    console.log('\nRESULT: PASS')
    process.exit(0)
  } else {
    console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
