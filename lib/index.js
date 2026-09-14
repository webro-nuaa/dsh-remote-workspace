/**
 * dsh-remote-workspace — a DSH host-plane bundle.
 *
 * Connects agent sessions to SSH remote workspaces: bootstraps a small
 * executor daemon (`daemon/dsh-remote-daemon.js`) on the target over SSH and
 * exposes the `remote_connect` / `remote_disconnect` / `remote_status` /
 * `remote_exec` / `remote_fs` tools. The agent loop, model calls, and
 * credentials stay on the local host; only execution reaches the remote.
 *
 * Installation (bundle): `dsh plugin --profile <name> add dsh-remote-workspace`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry, so the
 * plugin needs no realm.
 *
 * @module dsh-remote-workspace
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, sendJson } from './web-routes.js';
import { listProfiles, saveProfile, deleteProfile } from './profiles-store.js';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DAEMON_PATH = join(PACKAGE_DIR, '..', 'daemon', 'dsh-remote-daemon.cjs');

export const name = 'remote-workspace';
export const inject = ['timer', 'tools', 'subprocess'];

export function apply(ctx, config) {
  const subprocess = ctx.subprocess;
  const tools = ctx.tools;
  if (!subprocess) throw new Error('dsh-remote-workspace: subprocess service unavailable');
  if (!tools) throw new Error('dsh-remote-workspace: tools registry unavailable');

  /** name -> { spec, handle, rpc, ping } */
  const conns = new Map();
  let connSeq = 0;

  // ---- base64 helpers (host runs plain JS; keep dependencies minimal) ----
  function textToBase64(text) {
    const bytes = Buffer.from(String(text), 'utf8');
    return bytes.toString('base64');
  }
  function base64ToText(b64) {
    return Buffer.from(String(b64), 'base64').toString('utf8');
  }

  function teardown(c) {
    try { if (c.rpc) c.rpc.failAll('connection closed'); } catch (_) {}
    try { if (c.handle) c.handle.terminate(); } catch (_) {}
  }

  async function readDaemonSource(daemonPath) {
    const text = await readFile(daemonPath || BUNDLED_DAEMON_PATH, 'utf8');
    if (!text || text.length === 0) throw new Error('daemon source empty at ' + (daemonPath || BUNDLED_DAEMON_PATH));
    return text;
  }

  function spawnProc(argv, opts) {
    opts = opts || {};
    return subprocess.spawn({
      argv,
      cwd: opts.cwd || process.cwd(),
      env: opts.env,
      graceMs: 5000,
      stdio: {
        stdin: (opts.input !== undefined || opts.raw) ? 'pipe' : 'ignore',
        stdout: opts.raw ? 'pipe' : { maxBytes: 512 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
    });
  }

  async function runCollect(argv, opts) {
    const h = spawnProc(argv, opts);
    if (opts && opts.input !== undefined && h.stdin) { h.stdin.write(opts.input); h.stdin.end(); }
    let facts = {};
    try { facts = (await h.done) || {}; } catch (e) { facts = { error: e }; }
    const out = h.collected && h.collected.stdout ? h.collected.stdout.readFrom(0).text : '';
    const err = h.collected && h.collected.stderr ? h.collected.stderr.readFrom(0).text : '';
    const code = facts.exitCode !== undefined ? facts.exitCode : (facts.code !== undefined ? facts.code : null);
    return { code, out, err };
  }

  // ---- RPC client over the daemon channel (raw stdout pipe + stdin writer) ----
  function RpcClient(stdin, stdoutStream) {
    this.stdin = stdin;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    stdoutStream.setEncoding('utf8');
    const self = this;
    stdoutStream.on('data', (chunk) => {
      self.buf += chunk;
      let i;
      while ((i = self.buf.indexOf('\n')) >= 0) {
        const line = self.buf.slice(0, i);
        self.buf = self.buf.slice(i + 1);
        self.onFrame(line);
      }
    });
    stdoutStream.on('close', () => { self.closed = true; self.failAll('channel closed'); });
    stdoutStream.on('error', () => { self.closed = true; self.failAll('channel error'); });
  }
  RpcClient.prototype.onFrame = function (line) {
    if (!line.trim()) return;
    let f;
    try { f = JSON.parse(line); } catch (_) { return; }
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    p.cancelTimer();
    if (f.ok) p.res(f.result);
    else p.rej(new Error(f.error ? (f.error.code + ': ' + f.error.message) : 'rpc error'));
  };
  RpcClient.prototype.request = function (method, params, timeoutMs) {
    const self = this;
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const cancelTimer = ctx.timeout(() => {
        self.pending.delete(id);
        rej(new Error('rpc timeout: ' + method));
      }, timeoutMs || 30000);
      this.pending.set(id, { res, rej, cancelTimer });
      try { this.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n'); }
      catch (e) { this.pending.delete(id); cancelTimer(); rej(e); }
    });
  };
  RpcClient.prototype.failAll = function (msg) {
    for (const entry of this.pending.values()) { entry.cancelTimer(); entry.rej(new Error(msg)); }
    this.pending.clear();
  };

  // ---- SSH transport ----
  function sshArgv(spec, remoteCmd) {
    const args = [spec._sshExe, '-p', String(spec.port || 22), '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
    if (spec.auth === 'key' && spec.keyPath) args.push('-i', spec.keyPath, '-o', 'BatchMode=yes');
    args.push(spec.username + '@' + spec.host);
    if (remoteCmd) args.push(remoteCmd);
    return args;
  }

  function sshEnv(spec) {
    const env = {};
    if (spec.auth === 'password') {
      env.DISPLAY = 'dsh:0';
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.SSH_ASKPASS = spec._askpassPath;
      // Deliberate credential forward: the askpass helper reads it in the
      // child process only; it is never persisted to disk.
      env.DSH_RW_PW = spec.password;
    }
    return env;
  }

  async function writeAskpass() {
    const rel = join(tmpdir(), 'dsh-rw-askpass-' + process.pid + '-' + (++connSeq) + '.cmd');
    await writeFile(rel, '@echo %DSH_RW_PW%\r\n', 'utf8');
    return rel;
  }

  function summarize(c) {
    const p = c.ping || {};
    return 'connected: ' + c.name + '\n' +
      '  transport: ' + c.spec.transport + '  target: ' + (c.spec.host || 'local-direct') + '\n' +
      '  daemon: v' + p.version + ' protocol=' + p.protocol + ' platform=' + p.platform + '/' + p.arch + ' node=' + p.nodeVersion + '\n' +
      '  remote home: ' + p.home;
  }

  function getConn(name) {
    const c = conns.get(name || 'default');
    if (!c) throw new Error('no connection named ' + (name || 'default') + '; call remote_connect first');
    return c;
  }

  // ---- tool implementations ----
  async function doConnect(args) {
    const name = args.name || 'default';
    if (conns.has(name)) teardown(conns.get(name));
    const spec = {
      host: args.host, port: args.port || 22, username: args.username || 'root',
      auth: args.auth || 'key', password: args.password, keyPath: args.keyPath,
      transport: args.transport || 'ssh',
    };
    const daemonPath = args.daemonPath; // default: the bundled daemon
    const daemonSource = await readDaemonSource(daemonPath);
    const daemonVersion = (daemonSource.match(/const VERSION = '([^']+)'/) || [])[1];
    if (!daemonVersion) throw new Error('cannot determine daemon version from ' + (daemonPath || BUNDLED_DAEMON_PATH));

    let handle, ping;
    if (spec.transport === 'direct') {
      // Debug transport: run the daemon locally without SSH.
      const nodeExe = await subprocess.resolveExecutable('node');
      handle = spawnProc([nodeExe, daemonPath || BUNDLED_DAEMON_PATH], { raw: true });
      const rpc = new RpcClient(handle.stdin, handle.stdout);
      ping = await rpc.request('ping', {}, 15000);
      conns.set(name, { name, spec, handle, rpc, ping });
      return summarize(conns.get(name));
    }

    spec._sshExe = await subprocess.resolveExecutable('ssh');
    if (spec.auth === 'password') {
      if (!spec.password) throw new Error('password required for auth=password');
      spec._askpassPath = await writeAskpass();
    }
    const env = sshEnv(spec);

    // 1. probe auth + reachability
    const probe = await runCollect(sshArgv(spec, 'echo __DSH_RW_OK__'), { env });
    if (probe.out.indexOf('__DSH_RW_OK__') < 0) {
      throw new Error('ssh probe failed (auth or network): ' + ((probe.err || probe.out || 'no output').trim().slice(-400)));
    }
    // 2. locate node: non-interactive ssh PATH misses nvm/fnm installs, so
    // probe the login shell and common install roots, then use the absolute path.
    const nodeProbe = await runCollect(sshArgv(spec,
      'command -v node 2>/dev/null || bash -lc \'command -v node\' 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1 || ls -1 "$HOME"/.local/bin/node /usr/local/bin/node /usr/bin/node /opt/node*/bin/node 2>/dev/null | tail -n 1'), { env });
    const nodePath = nodeProbe.out.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!nodePath) {
      throw new Error('remote host has no node (probed PATH, login shell, ~/.nvm/versions/*, /usr/local, /usr, /opt) — install node >= 16 or add it to PATH');
    }
    spec._nodePath = nodePath;
    const nodeCmd = '"' + nodePath + '"';

    // 3. daemon version check + bootstrap upload when needed
    const remoteV = await runCollect(sshArgv(spec, nodeCmd + ' ~/.dsh-remote/daemon.js --version 2>/dev/null || true'), { env });
    if (remoteV.out.trim() !== daemonVersion) {
      const up = await runCollect(
        sshArgv(spec, 'mkdir -p ~/.dsh-remote && cat > ~/.dsh-remote/daemon.js.tmp && mv ~/.dsh-remote/daemon.js.tmp ~/.dsh-remote/daemon.js && ' + nodeCmd + ' ~/.dsh-remote/daemon.js --version'),
        { env, input: daemonSource });
      if (up.code !== 0 || up.out.indexOf(daemonVersion) < 0) {
        throw new Error('daemon upload failed: ' + ((up.err || up.out || 'exit ' + up.code).trim().slice(-400)));
      }
    }
    // 4. long-lived RPC channel
    handle = spawnProc(sshArgv(spec, 'exec ' + nodeCmd + ' ~/.dsh-remote/daemon.js'), { env, raw: true });
    const rpc = new RpcClient(handle.stdin, handle.stdout);
    ping = await rpc.request('ping', {}, 20000);
    conns.set(name, { name, spec, handle, rpc, ping });
    return summarize(conns.get(name));
  }

  async function doExec(args) {
    const conn = getConn(args.name);
    let argv = null;
    if (Array.isArray(args.argv) && args.argv.length > 0) argv = args.argv;
    else if (typeof args.argv === 'string' && args.argv.trim()) {
      try { argv = JSON.parse(args.argv); } catch (_) { argv = null; }
      if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) argv = null;
    }
    if (!argv && args.command) argv = ['bash', '-c', args.command];
    if (!argv) throw new Error('command or argv required (argv may be a JSON array string)');
    const start = await conn.rpc.request('exec.start', { argv, cwd: args.cwd });
    const timeoutMs = args.timeoutMs || 60000;
    const r = await conn.rpc.request('exec.wait', { jobId: start.jobId, timeoutMs }, timeoutMs + 15000);
    const status = r.running ? 'TIMEOUT (still running; jobId=' + start.jobId + ')' :
      (r.exitCode === 0 ? 'ok' : 'exit ' + r.exitCode + (r.signal ? ' signal ' + r.signal : ''));
    return 'jobId: ' + start.jobId + '\nexit: ' + status + '\n--- stdout ---\n' + r.stdout + '\n--- stderr ---\n' + r.stderr;
  }

  async function doFs(args) {
    const conn = getConn(args.name);
    const op = args.op;
    const p = args.path;
    if (!op || !p) throw new Error('op and path required');
    if (op === 'read') {
      const r = await conn.rpc.request('fs.read', { path: p, offset: args.offset, length: args.length });
      return base64ToText(r.contentB64);
    }
    if (op === 'write') {
      if (typeof args.content !== 'string') throw new Error('content required for op=write');
      const r = await conn.rpc.request('fs.write', { path: p, contentB64: textToBase64(args.content), mkdirs: true });
      return 'written ' + r.size + ' bytes to ' + p;
    }
    if (op === 'list') {
      const r = await conn.rpc.request('fs.list', { path: p });
      return r.entries.map((e) => (e.isDir ? 'd ' : e.isSymlink ? 'l ' : '- ') + String(e.size).padStart(10) + '  ' + e.name).join('\n') || '(empty)';
    }
    if (op === 'stat') {
      const r = await conn.rpc.request('fs.stat', { path: p });
      return JSON.stringify(r);
    }
    if (op === 'remove') { await conn.rpc.request('fs.remove', { path: p, recursive: true }); return 'removed ' + p; }
    if (op === 'mkdir') { await conn.rpc.request('fs.mkdir', { path: p, recursive: true }); return 'mkdir ' + p; }
    throw new Error('unknown op: ' + op);
  }

  // ---- tool registration + lifecycle ----
  const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
  const disposers = [];
  const def = (name, description, parameters, execute) => {
    disposers.push(tools.register(defineTool({ name, description, parameters, output: textOut, execute })));
  };

  def('remote_connect',
    'Connect a DSH remote workspace: bootstrap the executor daemon on the target and open the RPC channel. transport=direct spawns the daemon locally for testing (no SSH).',
    {
      name: { type: 'string', description: 'connection name, defaults to "default"' },
      host: { type: 'string', description: 'remote host (omit for transport=direct)' },
      port: { type: 'number', description: 'ssh port, default 22' },
      username: { type: 'string', description: 'ssh user, default root' },
      auth: { type: 'string', description: 'key | password; default key (uses default ssh keys/agent)' },
      password: { type: 'string', description: 'password (auth=password only; kept in memory, never persisted)' },
      keyPath: { type: 'string', description: 'identity file for auth=key' },
      transport: { type: 'string', description: 'ssh (default) | direct (local debug, spawns daemon without SSH)' },
      daemonPath: { type: 'string', description: 'local path of the daemon source to bootstrap; defaults to the bundled daemon' },
    },
    doConnect);

  def('remote_disconnect',
    'Close a remote workspace connection and terminate its daemon channel.',
    { name: { type: 'string', description: 'connection name, defaults to "default"' } },
    async (args) => {
      const name = args.name || 'default';
      const c = conns.get(name);
      if (!c) return 'no such connection: ' + name;
      teardown(c);
      conns.delete(name);
      return 'disconnected: ' + name;
    });

  def('remote_status',
    'List active remote workspace connections with daemon info.',
    {},
    async () => {
      if (conns.size === 0) return 'no active remote connections';
      const lines = [];
      for (const c of conns.values()) lines.push(summarize(c));
      return lines.join('\n');
    });

  def('remote_exec',
    'Run a command in the remote workspace (via daemon exec.start/exec.wait) and return output. Default wraps in bash -c; pass argv (array or JSON array string) for a direct argv.',
    {
      command: { type: 'string', description: 'bash command to run remotely' },
      argv: { type: 'string', description: 'OR explicit argv as a JSON array string (skips the bash -c wrapper); one of command/argv required' },
      name: { type: 'string', description: 'connection name, defaults to "default"' },
      cwd: { type: 'string', description: 'remote working directory' },
      timeoutMs: { type: 'number', description: 'wait budget, default 60000' },
    },
    doExec);

  def('remote_fs',
    'File operations on the remote workspace: read | write | list | stat | remove | mkdir.',
    {
      op: { type: 'string', required: true, description: 'read | write | list | stat | remove | mkdir' },
      path: { type: 'string', required: true, description: 'remote absolute path' },
      content: { type: 'string', description: 'text content for op=write' },
      offset: { type: 'number', description: 'byte offset for op=read' },
      length: { type: 'number', description: 'byte length cap for op=read' },
      name: { type: 'string', description: 'connection name, defaults to "default"' },
    },
    doFs);

  // ---- web surface: settings-page API (authenticated, same-origin) ----
  // Plugin activation does not order against the web carrier row, so
  // registration retries whenever a web-server service appears (same pattern
  // as dsh-agent-teams: initial attempt + internal/service re-arm).
  const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
  let webSurfaceInstalled = false;
  let webSurfaceLastError = null;

  function installWebSurface() {
    if (webSurfaceInstalled) return true;
    const rawWebServer = WEB_SERVER_KEYS.map((key) => ctx.get(key)).find((svc) => svc !== undefined);
    if (rawWebServer === undefined) return false;
    try {
      const connection = () => ctx.get('connection');
      const webServer = authenticatedWebRoutes(rawWebServer, connection);

      const statusPayload = () => ({
        daemonPath: BUNDLED_DAEMON_PATH,
        connections: [...conns.values()].map((c) => ({
          name: c.name,
          transport: c.spec.transport,
          host: c.spec.host || 'local-direct',
          port: c.spec.port || 22,
          username: c.spec.username,
          auth: c.spec.auth,
          daemon: c.ping ? {
            version: c.ping.version, protocol: c.ping.protocol,
            platform: c.ping.platform, arch: c.ping.arch, nodeVersion: c.ping.nodeVersion,
            home: c.ping.home,
          } : null,
        })),
      });

    disposers.push(webServer.register({
      path: '/plugins/dsh-remote-workspace/status',
      async handler(req, res) { sendJson(res, 200, statusPayload()); },
    }));

    disposers.push(webServer.register({
      path: '/plugins/dsh-remote-workspace/profiles',
      async handler(req, res) {
        if (req.method === 'POST') {
          const body = await readJsonRequest(req);
          const saved = await saveProfile(body);
          sendJson(res, 200, { profile: saved, profiles: await listProfiles() });
          return;
        }
        if (req.method === 'DELETE') {
          const body = await readJsonRequest(req);
          const removed = await deleteProfile(String(body.name || ''));
          sendJson(res, 200, { removed, profiles: await listProfiles() });
          return;
        }
        sendJson(res, 200, { profiles: await listProfiles() });
      },
    }));

    disposers.push(webServer.register({
      path: '/plugins/dsh-remote-workspace/connect',
      async handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return; }
        const body = await readJsonRequest(req);
        let spec = body;
        if (body.profile && !body.host) {
          const profiles = await listProfiles();
          const saved = profiles.find((p) => p.name === String(body.profile));
          if (!saved) { sendJson(res, 404, { error: 'no saved profile named ' + body.profile }); return; }
          spec = { ...saved, password: body.password, name: saved.name };
        }
        try {
          const summary = await doConnect(spec);
          if (body.save) {
            const { password, ...persistable } = spec; // secrets never persist
            await saveProfile(persistable);
          }
          sendJson(res, 200, { ok: true, summary, status: statusPayload() });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }));

    disposers.push(webServer.register({
      path: '/plugins/dsh-remote-workspace/disconnect',
      async handler(req, res) {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return; }
        const body = await readJsonRequest(req);
        const name = String(body.name || 'default');
        const c = conns.get(name);
        if (c) { teardown(c); conns.delete(name); }
        sendJson(res, 200, { ok: true, status: statusPayload() });
      },
    }));

      webSurfaceInstalled = true;
      webSurfaceLastError = null;
      console.log('dsh-remote-workspace: web surface registered (settings-page API live)');
    } catch (error) {
      webSurfaceLastError = String(error && error.message ? error.message : error);
      console.error('dsh-remote-workspace: web surface registration failed:', webSurfaceLastError);
    }
    return webSurfaceInstalled;
  }

  installWebSurface();
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name) || name === 'connection') installWebSurface();
  });

  def('remote_diag',
    'Diagnostics for the dsh-remote-workspace bundle: service resolution, web surface state, active connections.',
    {},
    async () => JSON.stringify({
      version: '0.1.0',
      webSurfaceInstalled,
      webSurfaceLastError,
      webServerResolvedNow: WEB_SERVER_KEYS.map((k) => [k, ctx.get(k) !== undefined]),
      connections: [...conns.keys()],
      daemonPath: BUNDLED_DAEMON_PATH,
    }));

  // All side effects belong to this plugin fiber: stop/update removes the
  // tools and tears down every connection (and its daemon channel).
  ctx.effect(() => () => {
    for (const dispose of disposers) { try { dispose(); } catch (_) {} }
    for (const c of conns.values()) teardown(c);
    conns.clear();
  }, 'remote-workspace tools + connections');
}
