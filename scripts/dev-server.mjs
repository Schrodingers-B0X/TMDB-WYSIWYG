import net from 'node:net';
import { spawn } from 'node:child_process';

const DEFAULT_PORT = 3000;
const FALLBACK_PORT = 30000;

function isPortAvailable(port) {
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

const defaultPortAvailable = await isPortAvailable(DEFAULT_PORT);
const selectedPort = defaultPortAvailable ? DEFAULT_PORT : FALLBACK_PORT;

if (!defaultPortAvailable) {
  const fallbackPortAvailable = await isPortAvailable(FALLBACK_PORT);

  if (!fallbackPortAvailable) {
    console.error(
      `Port ${DEFAULT_PORT} is already in use, and fallback port ${FALLBACK_PORT} is also unavailable.`
    );
    process.exit(1);
  }

  console.log(`Port ${DEFAULT_PORT} is already in use. Starting dev server on port ${FALLBACK_PORT}.`);
} else {
  console.log(`Starting dev server on port ${DEFAULT_PORT}.`);
}

const child = spawn('ng', ['serve', '--port', String(selectedPort)], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
