import { spawn } from 'node:child_process';

const commands = [
  ['wrangler', ['dev', '--local', '--ip', '127.0.0.1', '--port', '8787']],
  ['vite', ['--host', '127.0.0.1']],
];
const children = commands.map(([name, args]) => spawn(`./node_modules/.bin/${name}`, args, { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
