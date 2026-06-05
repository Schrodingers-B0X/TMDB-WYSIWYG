import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 3000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(PROJECT_ROOT, '.angular');
const STATE_FILE = path.join(STATE_DIR, 'dev-server.json');
const ANGULAR_CLI = path.join(PROJECT_ROOT, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const IS_WINDOWS = process.platform === 'win32';

function runCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function uniquePids(values) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }

      console.error(`Unable to check port ${port}: ${error.message}`);
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port);
  });
}

async function findListeningPidsOnWindows(port) {
  const psCommand = [
    '$ErrorActionPreference = "SilentlyContinue";',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen |`,
    'Select-Object -ExpandProperty OwningProcess -Unique'
  ].join(' ');
  const ps = await runCommand('powershell.exe', ['-NoProfile', '-Command', psCommand]);

  if (ps.stdout.trim()) {
    return uniquePids(ps.stdout.trim().split(/\s+/));
  }

  const netstat = await runCommand('netstat.exe', ['-ano', '-p', 'tcp']);
  const pids = netstat.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 5 && parts[0] === 'TCP' && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING')
    .map((parts) => parts[4]);

  return uniquePids(pids);
}

async function findListeningPidsOnUnix(port) {
  const lsof = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);

  if (lsof.stdout.trim()) {
    return uniquePids(lsof.stdout.trim().split(/\s+/));
  }

  const ss = await runCommand('ss', ['-H', '-ltnp', `sport = :${port}`]);

  if (ss.stdout.trim()) {
    return uniquePids([...ss.stdout.matchAll(/pid=(\d+)/g)].map((match) => match[1]));
  }

  const netstat = await runCommand('netstat', ['-ltnp']);

  if (netstat.stdout.trim()) {
    return uniquePids(
      netstat.stdout
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${port} `) && line.includes('LISTEN'))
        .map((line) => line.match(/(\d+)\//)?.[1])
    );
  }

  return [];
}

async function findListeningPids(port) {
  return IS_WINDOWS ? findListeningPidsOnWindows(port) : findListeningPidsOnUnix(port);
}

function normalizeComparablePath(value) {
  const resolved = path.resolve(value);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function normalizeSearchText(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}

function isWithinProject(candidatePath) {
  if (!candidatePath) {
    return false;
  }

  const root = normalizeComparablePath(PROJECT_ROOT);
  const candidate = normalizeComparablePath(candidatePath);
  const relative = path.relative(root, candidate);

  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function commandMentionsProject(command) {
  return normalizeSearchText(command).includes(normalizeSearchText(PROJECT_ROOT));
}

async function getUnixProcessInfo(pid) {
  const info = { pid, parentPid: null, cwd: null, command: '' };

  if (process.platform === 'linux') {
    try {
      info.cwd = await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      // Best effort only. The command line check below still protects us.
    }

    try {
      const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      info.command = cmdline.split('\0').filter(Boolean).join(' ');
    } catch {
      // Fall through to ps.
    }

    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      info.parentPid = Number(stat.match(/^\d+ \(.+\) [A-Z] (\d+) /)?.[1]) || null;
    } catch {
      // Fall through to ps.
    }
  }

  if (!info.cwd) {
    const lsof = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    info.cwd = lsof.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('n'))
      ?.slice(1) ?? null;
  }

  if (!info.command || !info.parentPid) {
    const ps = await runCommand('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'command=']);
    const line = ps.stdout.trim();

    if (line) {
      const match = line.match(/^(\d+)\s+(.*)$/s);
      info.parentPid = info.parentPid ?? (Number(match?.[1]) || null);
      info.command = info.command || match?.[2] || line;
    }
  }

  return info;
}

async function getWindowsProcessInfo(pid) {
  const command = [
    '$ErrorActionPreference = "SilentlyContinue";',
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";`,
    'if ($null -ne $process) {',
    '$process | Select-Object ProcessId, ParentProcessId, CommandLine, ExecutablePath | ConvertTo-Json -Compress',
    '}'
  ].join(' ');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', command]);
  const output = result.stdout.trim();

  if (!output) {
    return { pid, parentPid: null, cwd: null, command: '' };
  }

  try {
    const parsed = JSON.parse(output);

    return {
      pid,
      parentPid: Number(parsed.ParentProcessId) || null,
      cwd: null,
      command: [parsed.CommandLine, parsed.ExecutablePath].filter(Boolean).join(' ')
    };
  } catch {
    return { pid, parentPid: null, cwd: null, command: output };
  }
}

async function getProcessInfo(pid) {
  return IS_WINDOWS ? getWindowsProcessInfo(pid) : getUnixProcessInfo(pid);
}

async function hasAncestor(pid, ancestorPid) {
  let currentPid = pid;

  for (let depth = 0; depth < 24; depth += 1) {
    const info = await getProcessInfo(currentPid);

    if (!info.parentPid) {
      return false;
    }

    if (info.parentPid === ancestorPid) {
      return true;
    }

    currentPid = info.parentPid;
  }

  return false;
}

function processLooksProjectOwned(info) {
  return isWithinProject(info.cwd) || commandMentionsProject(info.command);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function removeStateForPid(pid) {
  const state = await readState();

  if (state?.pid === pid) {
    await fs.rm(STATE_FILE, { force: true });
  }
}

function stateMatchesProject(state) {
  return state?.projectRoot && normalizeComparablePath(state.projectRoot) === normalizeComparablePath(PROJECT_ROOT);
}

async function getTrustedPortOwners(port) {
  const pids = await findListeningPids(port);
  const state = await readState();
  const statePid = Number(state?.pid);
  const stateIsUs = stateMatchesProject(state) && Number(state?.port) === port && Number.isInteger(statePid);
  const owners = [];

  for (const pid of pids) {
    const info = await getProcessInfo(pid);
    const linkedToState =
      stateIsUs && (pid === statePid || (await hasAncestor(pid, statePid)) || (await hasAncestor(statePid, pid)));

    if (processLooksProjectOwned(info) || linkedToState) {
      owners.push({ pid, info });
    }
  }

  if (owners.length === 0 && stateIsUs) {
    const info = await getProcessInfo(statePid);

    if (processLooksProjectOwned(info)) {
      owners.push({ pid: statePid, info });
    }
  }

  return { owners, pids };
}

async function waitForPortToOpen(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function terminateProcess(pid, force = false) {
  if (IS_WINDOWS) {
    const args = ['/PID', String(pid), '/T'];

    if (force) {
      args.push('/F');
    }

    await runCommand('taskkill.exe', args);
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Some processes are not process-group leaders; fall back to the single PID.
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

async function restartExistingProjectServer(port) {
  const { owners, pids } = await getTrustedPortOwners(port);

  if (owners.length === 0) {
    const ownerList = pids.length > 0 ? pids.join(', ') : 'unknown process';
    console.error(`Port ${port} is already in use by ${ownerList}, but it does not look like this project.`);
    console.error('Leaving that process running. Close it manually if it should be replaced.');
    process.exit(1);
  }

  for (const owner of owners) {
    console.log(`Port ${port} is already used by this project (PID ${owner.pid}). Restarting it on the same port.`);
    await terminateProcess(owner.pid);
  }

  if (!(await waitForPortToOpen(port))) {
    for (const owner of owners) {
      await terminateProcess(owner.pid, true);
    }
  }

  if (!(await waitForPortToOpen(port))) {
    console.error(`Unable to free port ${port} after stopping the existing project server.`);
    process.exit(1);
  }
}

async function ensureAngularCliExists() {
  try {
    await fs.access(ANGULAR_CLI);
  } catch {
    console.error('Angular CLI was not found in node_modules. Run npm install, then try again.');
    process.exit(1);
  }
}

async function startAngularServer(port) {
  await ensureAngularCliExists();

  console.log(`Starting dev server on port ${port}.`);

  const child = spawn(process.execPath, [ANGULAR_CLI, 'serve', '--port', String(port)], {
    cwd: PROJECT_ROOT,
    detached: !IS_WINDOWS,
    stdio: 'inherit',
    windowsHide: false
  });

  await writeState({
    pid: child.pid,
    port,
    projectRoot: PROJECT_ROOT,
    command: `ng serve --port ${port}`,
    startedAt: new Date().toISOString()
  });

  let forwardedSignal = false;

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (forwardedSignal) {
        return;
      }

      forwardedSignal = true;

      try {
        await terminateProcess(child.pid);
      } catch {
        // The child may have exited between the signal and our forwarding attempt.
      }
    });
  }

  child.on('exit', async (code, signal) => {
    await removeStateForPid(child.pid);

    if (signal) {
      process.exit(0);
    }

    process.exit(code ?? 0);
  });
}

if (!(await isPortAvailable(DEFAULT_PORT))) {
  await restartExistingProjectServer(DEFAULT_PORT);
}

await startAngularServer(DEFAULT_PORT);
