/**
 * Minimal API-key auth for route handlers.
 *
 * Accepts the key via either:
 *   - x-api-key: <key>
 *   - Authorization: Bearer <key>
 *
 * The expected value is read from the named environment variable so different
 * routes can require different keys (read vs admin vs service).
 */
export function requireApiKey(req: Request, keyEnvVar: string): boolean {
  const expected = process.env[keyEnvVar]
  if (!expected) {
    // Fail closed if the server is misconfigured.
    return false
  }
  const key =
    req.headers.get('x-api-key') ||
    req.headers.get('authorization')?.replace('Bearer ', '') ||
    ''
  return key === expected
}

/** Standard 401 response for missing/invalid keys. */
export function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized.' }, { status: 401 })
}
