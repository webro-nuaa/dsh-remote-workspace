/**
 * Bundle integration test: drives lib/index.js apply() with a stub Cordis
 * context wired to the REAL LocalSubprocessRuntime, then exercises the tools
 * (direct-transport connect/exec/fs) and the authenticated web routes
 * (status/profiles persistence) without a running DSH host.
 *
 * Run: node test/bundle-integration.mjs
 */
import { EventEmitter } from 'node:events';
import { spawn as cpSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storeDir = mkdtempSync(join(tmpdir(), 'dsh-rw-bundle-'));
process.env.DSH_REMOTE_WORKSPACE_STORE_DIR = storeDir;

const failures = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
  if (!cond) failures.push(name);
}

// ---- fake web server capturing registered routes ----
const routes = new Map();
const fakeWebServer = {
  register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
};
function fakeRes() {
  return {
    status: 0, body: '',
    writeHead(status) { this.status = status; },
    end(body) { if (body !== undefined) this.body = this.body + body; },
  };
}
async function callRoute(path, method, bodyObj) {
  const handler = routes.get(path);
  if (!handler) throw new Error('route not registered: ' + path);
  const req = new EventEmitter();
  req.method = method;
  const res = fakeRes();
  const promise = handler(req, res);
  req.emit('end'); // GET has no body; readJsonRequest resolves on end
  await promise;
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}
async function callRouteWithBody(path, bodyObj) {
  const handler = routes.get(path);
  if (!handler) throw new Error('route not registered: ' + path);
  const req = new EventEmitter();
  req.method = 'POST';
  const res = fakeRes();
  const promise = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
  req.emit('end');
  await promise;
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

// ---- subprocess handle double: mirrors the exact handle contract the bundle
// consumes (stdin/stdout streams, collected.readFrom, done, terminate). The
// real LocalSubprocessRuntime is already validated in-session; this isolates
// OUR logic from cordis internals.
function fakeSpawn(spec) {
  const child = cpSpawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env || {}) },
    stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (b) => out.push(b));
  child.stderr.on('data', (b) => err.push(b));
  const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: {
      stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8'), nextOffset: Buffer.concat(out).length }) },
      stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8'), nextOffset: Buffer.concat(err).length }) },
    },
    done,
    terminate() { try { child.kill(); } catch (_) {} },
    waitForExit: () => done.then(() => true),
  };
}

// ---- stub cordis context ----
const effects = [];
const registeredTools = new Map();
const serviceListeners = new Map();
const ctx = {
  subprocess: { spawn: fakeSpawn, resolveExecutable: async (name) => name },
  tools: { register: (def) => { registeredTools.set(def.name, def); return () => registeredTools.delete(def.name); } },
  on(name, fn) {
    if (!serviceListeners.has(name)) serviceListeners.set(name, []);
    serviceListeners.get(name).push(fn);
    return () => { serviceListeners.set(name, serviceListeners.get(name).filter((f) => f !== fn)); };
  },
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    if (name === 'connection') return { requestRejection: () => undefined }; // authenticated gate: pass
    return undefined;
  },
  timeout(cb, ms) { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
  effect(cb, label) { const d = cb(); effects.push(typeof d === 'function' ? d : () => {}); return d; },
};

// ---- load the bundle ----
const mod = await import(new URL('../lib/index.js', import.meta.url).href);
check('apply is a function', typeof mod.apply === 'function');
mod.apply(ctx, {});

check('six tools registered', ['remote_connect', 'remote_disconnect', 'remote_status', 'remote_exec', 'remote_fs', 'remote_diag'].every((n) => registeredTools.has(n)), [...registeredTools.keys()].join(','));
check('web routes registered', routes.has('/plugins/dsh-remote-workspace/status') && routes.has('/plugins/dsh-remote-workspace/profiles') && routes.has('/plugins/dsh-remote-workspace/connect') && routes.has('/plugins/dsh-remote-workspace/disconnect'), [...routes.keys()].join(','));

// ---- tools: direct transport end-to-end ----
const connectResult = await registeredTools.get('remote_connect').execute({ transport: 'direct' });
check('remote_connect (direct)', connectResult.includes('connected: default') && connectResult.includes('daemon: v1.0.0'), connectResult.slice(0, 200));

const execResult = await registeredTools.get('remote_exec').execute({ argv: JSON.stringify([process.execPath, '-e', "console.log('bundle-stdout'); console.error('bundle-stderr')"]) });
check('remote_exec output', execResult.includes('exit: ok') && execResult.includes('bundle-stdout') && execResult.includes('bundle-stderr'), execResult.slice(0, 200));

const testFile = join(storeDir, 'rw-test.txt');
const writeResult = await registeredTools.get('remote_fs').execute({ op: 'write', path: testFile, content: 'bundle roundtrip 你好 ✓' });
check('remote_fs write', writeResult.includes('written'), writeResult);
const readResult = await registeredTools.get('remote_fs').execute({ op: 'read', path: testFile });
check('remote_fs read', readResult === 'bundle roundtrip 你好 ✓', JSON.stringify(readResult));

// ---- web routes ----
const status1 = await callRoute('/plugins/dsh-remote-workspace/status', 'GET');
check('GET status 200 + connection', status1.status === 200 && status1.body.connections.length === 1 && status1.body.connections[0].name === 'default', JSON.stringify(status1.body).slice(0, 200));

const saved = await callRouteWithBody('/plugins/dsh-remote-workspace/profiles', { name: 'test-host', host: '203.0.113.7', port: 2222, username: 'dev', auth: 'key' });
check('POST profiles saves', saved.status === 200 && saved.body.profiles.some((p) => p.name === 'test-host' && !('password' in p)), JSON.stringify(saved.body).slice(0, 200));

const listed = await callRoute('/plugins/dsh-remote-workspace/profiles', 'GET');
check('GET profiles persists', listed.body.profiles.some((p) => p.name === 'test-host'), JSON.stringify(listed.body));

const connectSaved = await callRouteWithBody('/plugins/dsh-remote-workspace/connect', { profile: 'no-such-profile' });
check('connect unknown profile 404', connectSaved.status === 404, JSON.stringify(connectSaved.body));

const disconnected = await callRouteWithBody('/plugins/dsh-remote-workspace/disconnect', { name: 'default' });
check('POST disconnect', disconnected.status === 200 && disconnected.body.status.connections.length === 0, JSON.stringify(disconnected.body.status));

// ---- fiber teardown ----
for (const d of effects) { try { d(); } catch (_) {} }
check('teardown removes tools', registeredTools.size === 0, [...registeredTools.keys()].join(','));

rmSync(storeDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
