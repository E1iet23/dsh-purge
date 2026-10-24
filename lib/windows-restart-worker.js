import path from 'node:path'
import { execFileSync } from 'node:child_process'

const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'"

export function windowsRestartLaunch(script, args, env = process.env) {
  const executable = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Start-Process joins ArgumentList with spaces. Paths are Windows filenames,
  // so quoting the complete path is sufficient (embedded double quotes are invalid).
  const quoted = value => '"' + String(value) + '"'
  const workerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quoted(script), ...args.map((value, i) => i % 2 ? quoted(value) : value)]
  const command = "$ErrorActionPreference = 'Stop'; $worker = Start-Process -FilePath " + psLiteral(executable)
    + ' -WindowStyle Hidden -PassThru -ArgumentList @(' + workerArgs.map(psLiteral).join(',')
    + '); if (-not $worker) { throw "restart worker was not started" }; Write-Output $worker.Id'
  return { executable, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] }
}

/** Start a hidden worker with its own console/lifetime, then let the broker exit normally. */
export function launchWindowsRestartWorker(script, args) {
  const launch = windowsRestartLaunch(script, args)
  const result = execFileSync(launch.executable, launch.args, {
    encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = Number(String(result).trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Restart worker did not return a process ID')
  return pid
}
