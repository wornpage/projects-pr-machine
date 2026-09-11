// Test-only processes. No GitHub access, shell evaluation, or production recovery.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  createProcessSession
} from '../../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';
import {
  withRepositoryLifecycleLock
} from '../../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';

const [role, portText, token, root] = process.argv.slice(2);
const port = Number(portText);
if (!['controller', 'relay', 'descendant'].includes(role)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !/^[a-f0-9-]{36}$/u.test(token ?? '')
    || (role === 'controller' && !root)) process.exit(90);

// Every fixture self-expires even if the test runner dies before cleanup.
setTimeout(() => process.exit(91), 25_000);
const socket = net.createConnection({ host: '127.0.0.1', port });
let stopCode = 0;
socket.on('error', () => process.exit(92));
socket.on('close', () => process.exit(stopCode));
socket.setEncoding('utf8');
const connected = new Promise(resolve => socket.once('connect', resolve));
const send = (event, nonce = '') => socket.write(`${JSON.stringify({ token, role, event, nonce })}\n`);
let buffer = '';
socket.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 4096) process.exit(93);
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line === 'stop:0' || line === 'stop:7') {
      // Complete the TCP shutdown before exiting; abrupt exit can reset the peer.
      stopCode = Number(line.slice(5));
      socket.end();
      return;
    }
    if (/^ping:[a-f0-9-]{36}$/u.test(line)) send('pong', line.slice(5));
    else process.exit(94);
  }
});
const self = fileURLToPath(import.meta.url);
const childArgs = [self, 'descendant', portText, token];

async function announce() {
  await connected;
  // Flush both markers before the ready handshake; pipe contents are not control data.
  await Promise.all(['stdout', 'stderr'].map(name => new Promise((resolve, reject) => {
    process[name].write(`${role}:${name}\n`, error => error ? reject(error) : resolve());
  })));
  send('ready');
}

if (role === 'controller') {
  const session = createProcessSession();
  await withRepositoryLifecycleLock(root, async () => {
    await announce(); // The controller owns its lock before announcing readiness.
    await session.runner({ executable: 'node',
      args: [self, 'relay', portText, token], timeoutMs: 20_000 });
  }, { runner: session.runner, canRelease: session.canRelease });
  process.exit(95); // The crash test must kill this controller, not let it complete.
} else {
  if (role === 'relay') {
    const child = spawn('node', childArgs, {
      // Explicitly model work escaping its parent, including Windows job cleanup.
      // The inherited output handles still exercise actual pipe lifetime.
      detached: true, shell: false, windowsHide: true, stdio: ['ignore', 1, 2]
    });
    child.on('error', () => process.exit(96));
  }
  await announce();
}
