#!/usr/bin/env node
/**
 * Approval-status cache tests.
 *
 * Stands up a mock /api/senders/check that COUNTS how many times each address is
 * actually fetched, so we can prove the cache collapses repeated checks into one
 * round-trip — and that the safety rules hold:
 *   - approved/denied are cached; 'unknown' is NOT (new approvals act instantly)
 *   - --fresh bypasses the cache
 *   - `cache clear` / clearCache() forces a live check
 *   - ttl <= 0 disables caching
 *   - keys are normalized (formatting variants share one entry)
 *   - expired entries are ignored
 *
 * Run:  npm run build && node test/cache.test.cjs
 */
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Isolate the cache file to a temp path so we never touch the real ~/.snazi.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snazi-cache-'))
const cacheFile = path.join(tmpDir, 'check-cache.json')
process.env.SNAZI_CACHE_FILE = cacheFile
delete process.env.SNAZI_CHECK_CACHE_TTL_MS // exercise config-driven ttl

const APPROVED = '+15550000001'
const DENIED = '+15550000002'
const UNKNOWN = '+15550000003'

// Mock web /api/senders/check. Counts hits per address.
const hits = Object.create(null)
const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.headers['x-api-key'] !== 'READ_KEY') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'unauthorized' }))
  }
  if (url.pathname === '/api/senders/check') {
    const address = url.searchParams.get('address') || ''
    hits[address] = (hits[address] || 0) + 1
    const status =
      address === APPROVED ? 'approved' : address === DENIED ? 'denied' : 'unknown'
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status }))
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

async function main() {
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const apiUrl = `http://127.0.0.1:${web.address().port}`
  const {
    checkSenderCached,
    getCachedStatus,
    setCachedStatus,
    clearCache,
    cacheTtlMs,
  } = require('../dist/cache.js')

  const cfg = { apiUrl, apiKey: 'READ_KEY', checkCacheTtlMs: 60_000 }

  // --- ttl resolution: env > config > default ---
  check(cacheTtlMs(cfg) === 60_000, 'cacheTtlMs reads config.checkCacheTtlMs')
  check(cacheTtlMs({ apiUrl, apiKey: 'x' }) === 300_000, 'cacheTtlMs default is 5 min')

  // --- approved is cached: 2 calls -> 1 network hit ---
  let s1 = await checkSenderCached(cfg, 'imessage', APPROVED)
  let s2 = await checkSenderCached(cfg, 'imessage', APPROVED)
  check(s1 === 'approved' && s2 === 'approved', 'approved returned both times')
  check(hits[APPROVED] === 1, 'approved fetched ONCE then served from cache')

  // --- denied is cached too ---
  await checkSenderCached(cfg, 'imessage', DENIED)
  const d2 = await checkSenderCached(cfg, 'imessage', DENIED)
  check(d2 === 'denied' && hits[DENIED] === 1, 'denied cached (1 fetch)')

  // --- unknown is NOT cached: 2 calls -> 2 hits (new approvals act instantly) ---
  await checkSenderCached(cfg, 'imessage', UNKNOWN)
  await checkSenderCached(cfg, 'imessage', UNKNOWN)
  check(hits[UNKNOWN] === 2, 'unknown is never cached (re-checked every call)')

  // --- --fresh bypasses the cache ---
  await checkSenderCached(cfg, 'imessage', APPROVED, { fresh: true })
  check(hits[APPROVED] === 2, 'fresh:true forces a live check')

  // --- clearCache forces a live check next time ---
  clearCache()
  await checkSenderCached(cfg, 'imessage', APPROVED)
  check(hits[APPROVED] === 3, 'clearCache() drops cache -> next check is live')

  // --- ttl <= 0 disables caching ---
  const noCacheCfg = { apiUrl, apiKey: 'READ_KEY', checkCacheTtlMs: 0 }
  clearCache()
  await checkSenderCached(noCacheCfg, 'imessage', DENIED)
  await checkSenderCached(noCacheCfg, 'imessage', DENIED)
  check(hits[DENIED] === 3, 'ttl=0 disables caching (2 more live hits)')

  // --- key normalization: formatting variants share one entry ---
  clearCache()
  setCachedStatus('imessage', '+15559990000', 'approved', 60_000)
  check(
    getCachedStatus('imessage', '(555) 999-0000') === 'approved',
    'cache key is normalized (formatted variant hits the same entry)'
  )
  check(
    getCachedStatus('imessage', '5559990000') === 'approved',
    'cache key is normalized (bare national variant hits the same entry)'
  )

  // --- expired entries are ignored ---
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ 'imessage|+15551110000': { status: 'approved', expiresAt: Date.now() - 1 } })
  )
  check(
    getCachedStatus('imessage', '+15551110000') === undefined,
    'expired entry is ignored'
  )

  // --- a short ttl really does expire ---
  clearCache()
  setCachedStatus('imessage', '+15552220000', 'approved', 25)
  check(getCachedStatus('imessage', '+15552220000') === 'approved', 'fresh short-ttl entry present')
  await sleep(50)
  check(getCachedStatus('imessage', '+15552220000') === undefined, 'short-ttl entry expired after wait')

  await new Promise((r) => web.close(r))
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}

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
