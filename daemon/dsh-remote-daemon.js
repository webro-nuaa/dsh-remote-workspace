#!/usr/bin/env node
/**
 * dsh-remote-daemon v1 — DSH remote workspace executor.
 *
 * Runs on the remote host as: ssh <host> node ~/.dsh-remote/daemon.js
 * Protocol: NDJSON over stdin/stdout (see docs/protocol.md).
 * Zero third-party dependencies. Node >= 16.
 *
 * stdout carries ONLY protocol frames; diagnostics go to stderr; every child
 * process is captured through pipes (never inherited) so the channel stays clean.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PROTOCOL = 1;
const VERSION = '1.0.0';
const READ_CAP_BYTES = 2 * 1024 * 1024; // fs.read default cap
const JOB_BUF_CAP = 1 * 1024 * 1024;    // per-job output tail cap (lossy beyond)

// ---------------------------------------------------------------- utilities

function log(msg) {
  process.stderr.write(`[dsh-remote-daemon] ${msg}\n`);
}

function errOf(code, message) {
  return { code: String(code || 'EUNKNOWN'), message: String(message || 'unknown error') };
}

// Ring-buffered byte stream with whole-stream offsets and lossy head drop.
class ByteStream {
  constructor(cap) {
    this.cap = cap;
    this.chunks = [];
    this.buffered = 0; // bytes currently retained
    this.total = 0;    // whole-stream bytes ever pushed
    this.dropped = 0;  // whole-stream bytes discarded from the head
    this.ended = false;
  }
  push(buf) {
    if (this.ended || buf.length === 0) return;
    this.chunks.push(buf);
    this.buffered += buf.length;
    this.total += buf.length;
    while (this.buffered > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift();
      this.buffered -= head.length;
      this.dropped += head.length;
    }
  }
  end() { this.ended = true; }
  readFrom(fromByte) {
    const windowStart = this.total - this.buffered;
    const lossy = fromByte < windowStart;
    const start = lossy ? windowStart : fromByte;
    const parts = [];
    let scan = this.total - this.buffered;
    for (const chunk of this.chunks) {
      const chunkEnd = scan + chunk.length;
      if (chunkEnd <= start) { scan = chunkEnd; continue; }
      const from = Math.max(0, start - scan);
      parts.push(chunk.subarray(from));
      scan = chunkEnd;
    }
    return {
      text: Buffer.concat(parts).toString('utf8'),
      nextOffset: this.total,
      lossy,
    };
  }
}

// ------------------------------------------------------------- fs handlers

async function fsStat(p) {
  const st = await fsp.stat(p);
  return { isDir: st.isDirectory(), isFile: st.isFile(), isSymlink: false, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
}

async function fsList(p) {
  const dirents = await fsp.readdir(p, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    let size = 0, mtimeMs = 0;
    try {
      const st = await fsp.stat(path.join(p, d.name));
      size = st.size; mtimeMs = st.mtimeMs;
    } catch (_) { /* unreadable entry: report shape only */ }
    entries.push({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(), size, mtimeMs });
  }
  return { entries };
}

async function fsRead(p, params) {
  const offset = Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
  const length = Number.isInteger(params.length) && params.length > 0 ? params.length : READ_CAP_BYTES;
  const cap = Math.min(length, READ_CAP_BYTES);
  const fh = await fsp.open(p, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    if (offset >= size) return { contentB64: '', size, truncated: false };
    const len = Math.min(cap, size - offset);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return { contentB64: buf.toString('base64'), size, truncated: offset + len < size };
  } finally {
    await fh.close();
  }
}

async function fsWrite(p, params) {
  if (typeof params.contentB64 !== 'string') throw errOf('EINVAL', 'contentB64 required');
  if (params.mkdirs) await fsp.mkdir(path.dirname(p), { recursive: true });
  const buf = Buffer.from(params.contentB64, 'base64');
  await fsp.writeFile(p, buf);
  return { size: buf.length };
}

function resolveFsTarget(p) {
  const abs = path.resolve(String(p || ''));
  if (abs === path.parse(abs).root) throw errOf('EPERM', 'refusing to operate on filesystem root');
  return abs;
}

// ----------------------------------------------------------- exec handlers

const jobs = new Map(); // jobId -> {child, stdout: ByteStream, stderr: ByteStream, argv, pid, exit: {code, signal}|null, waiters: []}
let jobSeq = 0;

function jobSnapshot(job) {
  return {
    jobId: job.jobId, argv: job.argv, pid: job.pid,
    running: job.exit === null && job.child.exitCode === null && !job.child.signalCode,
    exitCode: job.exit ? job.exit.code : undefined,
    signal: job.exit ? job.exit.signal : undefined,
  };
}

function onJobExit(job, code, signal) {
  job.exit = { code, signal };
  job.stdout.end();
  job.stderr.end();
  for (const w of job.waiters) w();
  job.waiters = [];
}

function execStart(params) {
  const argv = params.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw errOf('EINVAL', 'argv must be a non-empty string array');
  }
  const jobId = `job-${++jobSeq}-${Date.now().toString(36)}`;
  const child = spawn(argv[0], argv.slice(1), {
    cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : os.homedir(),
    env: { ...process.env, ...(params.env && typeof params.env === 'object' ? params.env : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const job = {
    jobId, argv, pid: child.pid, child,
    stdout: new ByteStream(JOB_BUF_CAP), stderr: new ByteStream(JOB_BUF_CAP),
    exit: null, waiters: [],
  };
  child.stdout.on('data', (b) => job.stdout.push(b));
  child.stderr.on('data', (b) => job.stderr.push(b));
  child.on('error', (e) => {
    job.stderr.push(Buffer.from(`\n[dsh-remote-daemon] spawn error: ${e.message}\n`));
    onJobExit(job, -1, null);
  });
  child.on('close', (code, signal) => onJobExit(job, code, signal));
  jobs.set(jobId, job);
  return { jobId, pid: child.pid };
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw errOf('ENOENT', `unknown jobId: ${jobId}`);
  return job;
}

function isRunning(job) {
  return job.exit === null && job.child.exitCode === null && !job.child.signalCode;
}

function execRead(params) {
  const job = getJob(params.jobId);
  const out = job.stdout.readFrom(Number.isInteger(params.fromStdout) ? params.fromStdout : 0);
  const err = job.stderr.readFrom(Number.isInteger(params.fromStderr) ? params.fromStderr : 0);
  return {
    stdout: out.text, stderr: err.text,
    nextStdout: out.nextOffset, nextStderr: err.nextOffset,
    lossy: out.lossy || err.lossy,
    running: isRunning(job),
    exitCode: job.exit ? job.exit.code : undefined,
    signal: job.exit ? job.exit.signal : undefined,
  };
}

function execKill(params) {
  const job = getJob(params.jobId);
  if (!isRunning(job)) return {};
  const signal = typeof params.signal === 'string' ? params.signal : 'SIGTERM';
  if (process.platform !== 'win32') {
    try { process.kill(-job.pid, signal); } catch (_) { try { job.child.kill(signal); } catch (_) {} }
  } else {
    try { job.child.kill(signal); } catch (_) {}
  }
  return {};
}

function execWait(params, respond) {
  const job = getJob(params.jobId);
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(0, params.timeoutMs) : 0;
  const finish = (timedOut) => respond({
    ...execRead(params),
    ...(timedOut ? { timedOut: true } : {}),
  });
  if (!isRunning(job)) { finish(false); return; }
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    const i = job.waiters.indexOf(fire);
    if (i >= 0) job.waiters.splice(i, 1);
    finish(false);
  };
  const timer = timeoutMs > 0 ? setTimeout(() => {
    if (done) return;
    done = true;
    const i = job.waiters.indexOf(fire);
    if (i >= 0) job.waiters.splice(i, 1);
    finish(true);
  }, timeoutMs) : null;
  job.waiters.push(fire);
}

function execList() {
  return { jobs: [...jobs.values()].filter((j) => isRunning(j) || jobs.size <= 64).map(jobSnapshot) };
}

// ---------------------------------------------------------------- dispatch

const methods = {
  ping: () => ({
    protocol: PROTOCOL, version: VERSION,
    platform: process.platform, arch: process.arch, nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()), home: os.homedir(),
  }),
  'fs.stat': (p) => fsStat(resolveFsTarget(p.path)),
  'fs.list': (p) => fsList(resolveFsTarget(p.path)),
  'fs.read': (p) => fsRead(resolveFsTarget(p.path), p),
  'fs.write': (p) => fsWrite(resolveFsTarget(p.path), p),
  'fs.mkdir': (p) => fsp.mkdir(resolveFsTarget(p.path), { recursive: !!p.recursive }).then(() => ({})),
  'fs.remove': (p) => fsp.rm(resolveFsTarget(p.path), { recursive: !!p.recursive, force: true }).then(() => ({})),
  'fs.rename': (p) => fsp.rename(resolveFsTarget(p.from), resolveFsTarget(p.to)).then(() => ({})),
  'exec.start': (p) => execStart(p),
  'exec.read': (p) => execRead(p),
  'exec.kill': (p) => execKill(p),
  'exec.list': () => execList(),
};

function dispatch(frame) {
  const { id, method, params } = frame || {};
  const respond = (payload) => writeFrame({ id: id === undefined ? null : id, ...payload });
  try {
    if (typeof method !== 'string') throw errOf('EINVAL', 'method required');
    if (method === 'exec.wait') {
      // Long-poll: resolve asynchronously without blocking the dispatch loop.
      let responded = false;
      execWait(params || {}, (result) => {
        if (responded) return;
        responded = true;
        respond({ ok: true, result });
      });
      return;
    }
    const handler = methods[method];
    if (!handler) throw errOf('ENOSYS', `unknown method: ${method}`);
    Promise.resolve(handler(params || {})).then(
      (result) => respond({ ok: true, result }),
      (e) => respond({ ok: false, error: errOf(e.code, e.message) }),
    );
  } catch (e) {
    respond({ ok: false, error: errOf(e.code, e.message) });
  }
}

function writeFrame(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log(`write failed: ${e.message}`);
  }
}

// ----------------------------------------------------------------- startup

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let idx;
  while ((idx = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, idx).trim();
    input = input.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch (e) {
      writeFrame({ id: null, ok: false, error: errOf('EBADFRAME', `unparseable frame: ${e.message}`) });
      continue;
    }
    dispatch(frame);
  }
});
process.stdin.on('end', () => {
  // ssh session gone: terminate managed children so nothing leaks on the host.
  for (const job of jobs.values()) {
    if (!isRunning(job)) continue;
    if (process.platform !== 'win32') {
      try { process.kill(-job.pid, 'SIGTERM'); } catch (_) { try { job.child.kill('SIGTERM'); } catch (_) {} }
    } else {
      try { job.child.kill('SIGTERM'); } catch (_) {}
    }
  }
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (e) => {
  log(`uncaught: ${e.stack || e.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log(`unhandled rejection: ${e && (e.stack || e.message)}`);
});

log(`ready protocol=${PROTOCOL} version=${VERSION} node=${process.version}`);
