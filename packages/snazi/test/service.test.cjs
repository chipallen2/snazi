#!/usr/bin/env node
/**
 * Background-service wrapper tests (snazi start/stop/restart).
 *
 * These cover the PURE, side-effect-free pieces only — the service-definition
 * renderers for each OS and the read-only status probe. We deliberately do NOT
 * invoke serviceStart/serviceStop/serviceRestart here: those shell out to
 * launchctl/systemctl/schtasks and would mutate the dev machine's real service.
 *
 * Run:  npm run build && node test/service.test.cjs
 * Exits nonzero on failure.
 */
const {
  renderSystemdUnit,
  renderVbsLauncher,
  renderTaskXml,
  serviceStatus,
  readServePid,
  PID_PATH,
  WIN_TASK_NAME,
  SYSTEMD_UNIT,
} = require('../dist/service.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS: ${msg}`)
  else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

// --- exported constants ----------------------------------------------------
check(typeof PID_PATH === 'string' && PID_PATH.endsWith('serve.pid'), 'PID_PATH points at serve.pid')
check(WIN_TASK_NAME === 'snazi-serve', 'WIN_TASK_NAME is snazi-serve')
check(SYSTEMD_UNIT === 'snazi.service', 'SYSTEMD_UNIT is snazi.service')

// --- systemd unit ----------------------------------------------------------
{
  const unit = renderSystemdUnit('/usr/bin/node', '/opt/snazi/dist/cli.js', '100.64.0.5', 8787)
  check(
    unit.includes('ExecStart=/usr/bin/node /opt/snazi/dist/cli.js serve --bind 100.64.0.5 --port 8787'),
    'systemd unit ExecStart runs serve with bind + port'
  )
  check(/Restart=on-failure/.test(unit), 'systemd unit restarts on failure')
  check(/\[Install\][\s\S]*WantedBy=default\.target/.test(unit), 'systemd unit installs into default.target')
}

// --- Windows VBS launcher (hidden) -----------------------------------------
{
  const vbs = renderVbsLauncher('C:\\Program Files\\node.exe', 'C:\\snazi\\dist\\cli.js', '127.0.0.1', 8787)
  check(/WScript\.Shell/.test(vbs), 'vbs uses WScript.Shell')
  check(vbs.includes(', 0, False'), 'vbs runs hidden (window style 0) and async')
  // Paths with spaces must be wrapped in real quotes (doubled "" in VBS source).
  check(vbs.includes('""C:\\Program Files\\node.exe""'), 'vbs double-quotes the node path (handles spaces)')
  check(vbs.includes('""C:\\snazi\\dist\\cli.js""'), 'vbs double-quotes the cli path')
  check(vbs.includes('serve --bind 127.0.0.1 --port 8787'), 'vbs passes the serve args')
}

// --- Windows Task Scheduler XML --------------------------------------------
{
  const xml = renderTaskXml('C:\\Users\\me\\.snazi\\snazi-serve.vbs')
  check(/<LogonTrigger>/.test(xml), 'task xml triggers at logon')
  check(/<Command>wscript\.exe<\/Command>/.test(xml), 'task xml runs wscript.exe')
  check(/<RunLevel>LeastPrivilege<\/RunLevel>/.test(xml), 'task xml runs least-privilege')
  // The vbs path lands in <Arguments>, with its quotes XML-escaped.
  check(
    xml.includes('//B //Nologo &quot;C:\\Users\\me\\.snazi\\snazi-serve.vbs&quot;'),
    'task xml passes the (XML-escaped) hidden vbs path'
  )
  // Ampersands in a path must be XML-escaped so the file stays valid.
  const xml2 = renderTaskXml('C:\\a&b\\snazi-serve.vbs')
  check(
    xml2.includes('C:\\a&amp;b\\snazi-serve.vbs') && !xml2.includes('a&b'),
    'task xml escapes & in paths'
  )
}

// --- readServePid is read-only and well-typed ------------------------------
{
  const pid = readServePid()
  check(pid === null || (Number.isInteger(pid) && pid > 0), 'readServePid returns null or a positive integer')
}

// --- serviceStatus is read-only and never throws ---------------------------
async function main() {
  let status
  try {
    status = await serviceStatus({ apiUrl: 'https://snazi.dev', apiKey: 'x' })
  } catch (e) {
    check(false, `serviceStatus threw: ${e}`)
    status = {}
  }
  check(status && typeof status.manager === 'string', 'serviceStatus reports a manager for this platform')
  if (process.platform === 'darwin') {
    check(status.manager === 'launchd', 'darwin: manager is launchd')
    check(typeof status.installed === 'boolean', 'darwin: installed is a boolean')
  } else if (process.platform === 'linux') {
    check(status.manager === 'systemd (--user)', 'linux: manager is systemd (--user)')
  } else if (process.platform === 'win32') {
    check(status.manager === 'Windows Task Scheduler', 'win32: manager is Task Scheduler')
  }

  if (failures === 0) {
    console.log('\nRESULT: PASS')
    process.exit(0)
  } else {
    console.error(`\nRESULT: FAIL (${failures} assertion(s) failed)`)
    process.exit(1)
  }
}

main()
