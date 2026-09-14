'use strict';
/**
 * Smoke test: drives the daemon over stdio pipes (no SSH involved).
 * Covers: ping, fs.write/read/list/stat, exec.start/read/wait/kill, bad frames.
 * Run: node test/smoke.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const daemonPath = path.join(__dirname, '..', 'daemon', 'dsh-remote-daemon.cjs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rw-test-'));

const child = spawn(process.execPath, [daemonPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderrBuf = '';
child.stderr.on('data', (b) => { stderrBuf += b.toString('utf8'); });

let nextId = 0;
const pending = new Map();
const reader = require('readline').createInterface({ input: child.stdout });
reader.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  const entry = pending.get(frame.id);
  if (entry) {
    pending.delete(frame.id);
    entry(frame);
  }
});

function rpc(method, params, { expectError = false } = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10000);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      if (frame.ok && !expectError) resolve(frame.result);
      else if (!frame.ok && expectError) resolve(frame.error);
      else reject(new Error(`${method}: unexpected ${frame.ok ? 'ok' : 'error'}: ${JSON.stringify(frame).slice(0, 300)}`));
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
}

(async () => {
  const testFile = path.join(tmpDir, 'hello.txt');

  const ping = await rpc('ping');
  check('ping', ping.protocol === 1 && ping.version && ping.nodeVersion.startsWith('v'), JSON.stringify(ping));

  const w = await rpc('fs.write', { path: testFile, contentB64: Buffer.from('hello daemon 你好').toString('base64'), mkdirs: true });
  check('fs.write size', w.size === Buffer.from('hello daemon 你好').length, JSON.stringify(w));

  const r = await rpc('fs.read', { path: testFile });
  check('fs.read roundtrip', Buffer.from(r.contentB64, 'base64').toString('utf8') === 'hello daemon 你好' && r.truncated === false, JSON.stringify(r));

  const list = await rpc('fs.list', { path: tmpDir });
  check('fs.list', list.entries.some((e) => e.name === 'hello.txt' && e.isFile), JSON.stringify(list));

  const st = await rpc('fs.stat', { path: testFile });
  check('fs.stat', st.isFile && st.size === w.size, JSON.stringify(st));

  const enoent = await rpc('fs.read', { path: path.join(tmpDir, 'nope.txt') }, { expectError: true });
  check('fs.read ENOENT', enoent && enoent.code === 'ENOENT', JSON.stringify(enoent));

  const started = await rpc('exec.start', { argv: [process.execPath, '-e', "console.log('out-line'); console.error('err-line')"], cwd: tmpDir });
  check('exec.start', /^job-\d+-/.test(started.jobId) && Number.isInteger(started.pid), JSON.stringify(started));

  let waited = await rpc('exec.wait', { jobId: started.jobId, timeoutMs: 8000 });
  check('exec.wait exit', waited.running === false && waited.exitCode === 0, JSON.stringify(waited));
  check('exec output stdout', waited.stdout.includes('out-line'), JSON.stringify(waited.stdout));
  check('exec output stderr', waited.stderr.includes('err-line'), JSON.stringify(waited.stderr));

  const read = await rpc('exec.read', { jobId: started.jobId, fromStdout: 0, fromStderr: 0 });
  check('exec.read offsets', read.nextStdout >= waited.nextStdout && read.running === false, JSON.stringify({ nextStdout: read.nextStdout }));

  // long-running job: start, read while running, kill, confirm exit
  const long = await rpc('exec.start', { argv: [process.execPath, '-e', 'setInterval(() => console.log("tick"), 100)'] });
  await new Promise((r2) => setTimeout(r2, 400));
  const mid = await rpc('exec.read', { jobId: long.jobId, fromStdout: 0, fromStderr: 0 });
  check('exec.read while running', mid.running === true && mid.stdout.includes('tick'), JSON.stringify(mid.stdout));
  await rpc('exec.kill', { jobId: long.jobId });
  await new Promise((r2) => setTimeout(r2, 600));
  const killed = await rpc('exec.read', { jobId: long.jobId, fromStdout: mid.nextStdout, fromStderr: 0 });
  check('exec.kill', killed.running === false && killed.signal !== undefined, JSON.stringify({ signal: killed.signal, running: killed.running }));

  const bad = await rpc('no.such.method', {}, { expectError: true });
  check('unknown method', bad && bad.code === 'ENOSYS', JSON.stringify(bad));

  check('daemon stderr clean-ish', !stderrBuf.includes('uncaught'), stderrBuf.slice(-200));
})().then(async () => {
  const failed = results.filter((r) => !r.pass);
  child.stdin.end();
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
}).catch((e) => {
  console.error('SMOKE TEST CRASH:', e.message);
  child.kill();
  process.exit(1);
});
