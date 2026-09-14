/**
 * Composite filesystem routing test: local paths delegate to the real sandboxed
 * local backend (constructed with a stub cordis context), `/dsh-remote/...`
 * targets route to a fake daemon RPC. Verifies shapes match the dsh-fs contract.
 *
 * Run: node test/fs-composite.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RemoteWorkspaceFileSystem, { REMOTE_SCHEME, REMOTE_KEY_PREFIX } from '../lib/fs-composite.js';
import { FsError } from '@deepseek-ai/dsh-fs';

const failures = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
  if (!cond) failures.push(name);
}

// ---- fake daemon RPC over an in-memory filesystem ----
function fakeRpc(files) {
  // files: Map<'/abs/path', {content?: Buffer, isDir?: bool, mtimeMs?: number}>
  const enc = (b) => b.toString('base64');
  return {
    async request(method, params) {
      if (method === 'fs.stat') {
        const f = files.get(params.path);
        if (!f) throw new Error('ENOENT: ' + params.path);
        return {
          isDir: !!f.isDir, isFile: !f.isDir, isSymlink: false,
          size: f.content ? f.content.length : 0,
          mtimeMs: f.mtimeMs ?? 1000, mode: 0o644,
        };
      }
      if (method === 'fs.list') {
        const dir = params.path.endsWith('/') ? params.path : params.path + '/';
        const names = [...files.keys()].filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'));
        if (names.length === 0 && !files.has(params.path)) throw new Error('ENOENT: ' + params.path);
        return {
          entries: names.map((p) => {
            const f = files.get(p);
            return { name: p.slice(dir.length), isDir: !!f.isDir, isFile: !f.isDir, isSymlink: false, size: f.content?.length ?? 0, mtimeMs: f.mtimeMs ?? 1000 };
          }),
        };
      }
      if (method === 'fs.read') {
        const f = files.get(params.path);
        if (!f) throw new Error('ENOENT: ' + params.path);
        const buf = f.content ?? Buffer.alloc(0);
        const offset = params.offset ?? 0;
        const len = Math.min(params.length ?? 2 * 1024 * 1024, 2 * 1024 * 1024);
        return { contentB64: enc(buf.subarray(offset, offset + len)), size: buf.length, truncated: offset + len < buf.length };
      }
      if (method === 'fs.write') {
        files.set(params.path, { content: Buffer.from(params.contentB64, 'base64'), mtimeMs: (files.get(params.path)?.mtimeMs ?? 1000) + 1 });
        return { size: Buffer.from(params.contentB64, 'base64').length };
      }
      throw new Error('ENOSYS: ' + method);
    },
  };
}

const remoteFiles = new Map([
  ['/data2/proj', { isDir: true }],
  ['/data2/proj/README.md', { content: Buffer.from('hello remote') }],
  ['/data2/proj/bin.dat', { content: Buffer.from([0x00, 0x01, 0x02]) }],
  ['/data2/proj/src', { isDir: true }],
  ['/data2/proj/src/main.js', { content: Buffer.from('const a = 1;\r\nconst b = 2;\r\n') }],
]);
const api = {
  connectionFor: (name) => (name === 'test' ? { rpc: fakeRpc(remoteFiles) } : undefined),
  async anchors() {
    return [{ connection: 'test', remoteRoot: '/data2', anchorDir: anchorTmpDir }];
  },
};

// ---- stub cordis context ----
const effects = [];
const provided = new Map();
const fakeCtx = {
  reflect: { provide() {} },
  logger: { warn() {}, info() {}, error() {} },
  sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: localDir }) },
  get(name) {
    if (name === 'remote-workspace') return provided.get(name) ?? api;
    if (name === 'connection') return { requestRejection: () => undefined };
    return undefined;
  },
  provide(name, value) { provided.set(name, value); },
  on() { return () => {}; },
  timeout(cb, ms) { const t = setTimeout(cb, ms); return () => clearTimeout(t); },
  effect(cb) { const d = cb && cb(); return typeof d === 'function' ? d : () => {}; },
};

// ---- local half: real tmp dir ----
const localDir = mkdtempSync(join(tmpdir(), 'dsh-rw-fs-'));
writeFileSync(join(localDir, 'local.txt'), 'local content', 'utf8');
const localReal = realpathSync(localDir);
const anchorTmpDir = mkdtempSync(join(tmpdir(), 'dsh-rw-anchor-')); // stands in for the workspace anchor

const fsInstance = new RemoteWorkspaceFileSystem(fakeCtx, { cwd: localDir, diffBasisMaxBytes: 10 * 1024 * 1024 });

// ---- local delegation ----
const lt = await fsInstance.resolve('local.txt');
check('local resolve keeps realpath key', typeof lt.targetKey === 'string' && !lt.targetKey.startsWith(REMOTE_KEY_PREFIX) && lt.targetKey.includes('local.txt'), JSON.stringify(lt));
const lr = await fsInstance.readText(lt);
check('local readText delegates', lr === 'local content', JSON.stringify(lr));
const lstat1 = await fsInstance.lstat('local.txt');
check('local lstat delegates', lstat1 && lstat1.type === 'file', JSON.stringify(lstat1));

// ---- remote resolve ----
const rt = await fsInstance.resolve('dsh-remote://test/data2/proj');
check('remote resolve key (POSIX form)', rt.targetKey === '/dsh-remote/test/data2/proj' && rt.displayPath === 'test:/data2/proj', JSON.stringify(rt));
const rt2 = await fsInstance.resolve('/dsh-remote/test/data2/proj');
check('remote resolve accepts POSIX key input', rt2.targetKey === '/dsh-remote/test/data2/proj', JSON.stringify(rt2));

const bad = await fsInstance.resolve('/dsh-remote/nope/data2/proj').catch((e) => e);
check('remote resolve inactive connection', bad instanceof FsError && bad.code === 'FS_NOT_FOUND', JSON.stringify({ code: bad.code, message: bad.message }));

// ---- remote stat / listDir ----
const fileTarget = await fsInstance.resolve('/dsh-remote/test/data2/proj/README.md');
const st = await fsInstance.stat(fileTarget);
check('remote stat shape', st && st.type === 'file' && st.size === 12 && String(st.version).startsWith('rw:'), JSON.stringify(st));
const missing = await fsInstance.stat(await fsInstance.resolve('/dsh-remote/test/data2/proj/nope.txt'));
check('remote stat missing -> undefined', missing === undefined, JSON.stringify(missing));

const dirTarget = await fsInstance.resolve('/dsh-remote/test/data2/proj');
const listing = await fsInstance.listDir(dirTarget);
check('remote listDir names+order (localeCompare parity with local)', listing.map((e) => e.name).join(',') === 'bin.dat,README.md,src', JSON.stringify(listing.map((e) => e.name)));
check('remote listDir child keys', listing.every((e) => e.target.targetKey.startsWith('/dsh-remote/test/data2/proj/')), JSON.stringify(listing[0]));
check('remote listDir types', listing.find((e) => e.name === 'src').type === 'directory' && listing.find((e) => e.name === 'README.md').type === 'file', JSON.stringify(listing.map((e) => [e.name, e.type])));

// ---- remote reads ----
const text = await fsInstance.readText(fileTarget);
check('remote readText', text === 'hello remote', JSON.stringify(text));
await fsInstance.readText(await fsInstance.resolve('/dsh-remote/test/data2/proj/bin.dat')).then(
  () => check('remote binary rejected', false, 'no throw'),
  (e) => check('remote binary rejected', e instanceof FsError && e.code === 'FS_NOT_TEXT', e.message),
);
const bytes = await fsInstance.readBytes(fileTarget, undefined, 1024);
check('remote readBytes', bytes instanceof Uint8Array && bytes.length === 12, JSON.stringify(bytes));
const range = await fsInstance.readByteRange(fileTarget, { offset: 6, length: 6 });
check('remote readByteRange', Buffer.from(range).toString('utf8') === 'remote', JSON.stringify(Buffer.from(range).toString('utf8')));
const streamed = [];
for await (const chunk of await fsInstance.streamText(fileTarget)) streamed.push(chunk);
check('remote streamText', streamed.join('') === 'hello remote', JSON.stringify(streamed));

// ---- contains ----
check('remote contains inside', fsInstance.contains(dirTarget, fileTarget) === true);
check('remote contains mixed false', fsInstance.contains(dirTarget, lt) === false);

// ---- remote writes ----
const newFile = await fsInstance.resolve('/dsh-remote/test/data2/proj/new.txt');
const w1 = await fsInstance.writeText(newFile, 'written remotely\nline2\n');
check('remote writeText create', w1.operation === 'create' && String(w1.version).startsWith('rw:') && w1.after === 'written remotely\nline2\n', JSON.stringify(w1));
check('remote write visible in fake fs', remoteFiles.get('/data2/proj/new.txt').content.toString('utf8') === 'written remotely\nline2\n');

const w2 = await fsInstance.writeText(newFile, 'x', { kind: 'replaceIfVersion', version: 'rw:999:999' }).catch((e) => e);
check('remote write stale guard', w2 instanceof FsError && w2.code === 'FS_STALE_VERSION', JSON.stringify({ code: w2.code }));

// ---- remote edits (CRLF normalize + restore) ----
const mainTarget = await fsInstance.resolve('/dsh-remote/test/data2/proj/src/main.js');
const e1 = await fsInstance.editText(mainTarget, { oldString: 'const a = 1;', newString: 'const a = 42;' });
check('remote edit success', e1.after.includes('const a = 42;') && e1.before.includes('const a = 1;'), JSON.stringify(e1));
check('remote edit preserves CRLF', remoteFiles.get('/data2/proj/src/main.js').content.toString('utf8').includes('\r\n'), JSON.stringify(remoteFiles.get('/data2/proj/src/main.js').content.toString('utf8')));
const e2 = await fsInstance.editText(mainTarget, { oldString: 'not present anywhere', newString: 'x' }).catch((err) => err);
check('remote edit not found', e2 instanceof FsError && e2.code === 'FS_EDIT_NOT_FOUND', JSON.stringify({ code: e2.code }));
const e3 = await fsInstance.editText(mainTarget, { oldString: 'const', newString: 'let' }).catch((err) => err);
check('remote edit ambiguous', e3 instanceof FsError && e3.code === 'FS_AMBIGUOUS_EDIT', JSON.stringify({ code: e3.code }));

// ---- local mutation still works through the composite (sandbox chain intact) ----
const lw = await fsInstance.writeText(lt, 'local content v2');
check('local writeText delegates', lw.operation === 'update' && lw.after === 'local content v2', JSON.stringify(lw));

// ---- anchor mapping: session cwd = anchor dir -> remote rewrite ----
const anchoredTarget = await fsInstance.resolve('proj/README.md', { cwd: anchorTmpDir });
check('anchor cwd rewrites to remote key', anchoredTarget.targetKey === '/dsh-remote/test/data2/proj/README.md', JSON.stringify(anchoredTarget));
const anchoredAbs = await fsInstance.resolve(join(anchorTmpDir, 'proj', 'src', 'main.js'), {});
check('anchor absolute path rewrites', anchoredAbs.targetKey === '/dsh-remote/test/data2/proj/src/main.js', JSON.stringify(anchoredAbs));
const anchorRootItself = await fsInstance.resolve('.', { cwd: anchorTmpDir });
check('anchor root maps to remote root', anchorRootItself.targetKey === '/dsh-remote/test/data2', JSON.stringify(anchorRootItself));
const outside = await fsInstance.resolve('local.txt');
check('non-anchored path stays local', !outside.targetKey.startsWith(REMOTE_KEY_PREFIX), JSON.stringify(outside));

// ---- fileUrl identity contract (workspacePathOf compatibility) ----
const rootUrl = fsInstance.fileUrl(dirTarget);
const childUrl = fsInstance.fileUrl(fileTarget);
function workspacePathOf(rootUrl, targetUrl) {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, "");
  const target = new URL(targetUrl).pathname;
  if (target === root) return "";
  return target.slice(root.length + 1).split("/").map(decodeURIComponent).join("/");
}
check('fileUrl parses and derives relative path', workspacePathOf(rootUrl, childUrl) === 'README.md', JSON.stringify({ rootUrl, childUrl, derived: workspacePathOf(rootUrl, childUrl) }));

rmSync(localDir, { recursive: true, force: true });
rmSync(anchorTmpDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
