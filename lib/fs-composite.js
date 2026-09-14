/**
 * Composite filesystem for the dsh-remote-workspace bundle.
 *
 * Extends the deployment's sandboxed local backend (`SandboxedFileSystem extends
 * LocalFileSystem`), so LOCAL paths keep byte-for-byte the shipped behavior
 * (sandbox semantics included). Only targets whose key carries the
 * `dsh-remote://` scheme — manufactured by `resolve()` for registered remote
 * workspaces — route to the SSH daemon backend.
 *
 * Mounted by replacing the `fs-sandbox` row via the bundle's composition patch
 * (the official layering channel; no harness code is modified). The daemon RPC
 * registry is resolved lazily per call as the `remote-workspace` service
 * (provided by the bundle's main row), so activation order never matters.
 *
 * Remote semantics mirror `dsh-fs-local`: strict UTF-8 reads with binary
 * rejection, LF-normalized edit/diff bases with CRLF write-back, stale-version
 * guards, literal-edit rules (FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT), and the
 * shared FsError taxonomy. Remote versions derive from size+mtime; target keys
 * are stable `dsh-remote://<connection>/<absolute-path>` strings.
 */
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs';
import { isAbsolute, join, relative } from 'node:path';
import { isUnderAnchor } from './anchors.js';

export const REMOTE_SCHEME = 'dsh-remote://';
// POSIX-shaped target keys keep processPath() interoperable with consumers that
// join/derive paths (readRelated) and let fileUrl() build parseable file: URIs.
export const REMOTE_KEY_PREFIX = '/dsh-remote/';
const BINARY_SAMPLE_BYTES = 8192;
const DAEMON_READ_CAP = 2 * 1024 * 1024; // must stay <= the daemon's per-read cap
const READ_WHOLE_LIMIT = 64 * 1024 * 1024;

function normalizeLineEndings(content) {
  return content.replaceAll('\r\n', '\n');
}
function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split('\r\n').length - 1;
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF';
}
function restoreLineEndings(content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n');
}
function countOccurrences(content, needle) {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND');
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND');
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT');
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}
function decodeUtf8Fatal(buffer, verb, displayPath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT');
  }
}
function throwIfAborted(signal, verb) {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED');
}
function joinRemote(parentPath, name) {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}
function remoteJoin(root, rel) {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return rel && rel !== '.' ? `${base}/${rel}` : base;
}

export default class RemoteWorkspaceFileSystem extends SandboxedFileSystem {
  /** The bundle main row publishes { connectionFor(name) -> {rpc,...} | undefined }. */
  remoteApi() {
    const api = this.ctx.get('remote-workspace');
    if (!api || typeof api.connectionFor !== 'function') {
      throw new FsError('remote workspace subsystem unavailable', 'FS_IO_ERROR');
    }
    return api;
  }
  isRemoteTarget(target) {
    return target != null && typeof target.targetKey === 'string' && target.targetKey.startsWith(REMOTE_KEY_PREFIX);
  }
  splitKey(targetKey) {
    // POSIX-shaped key: '/dsh-remote/<connection>/<absolute remote path>'
    const rest = targetKey.slice(REMOTE_KEY_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) throw new FsError(`malformed remote target "${targetKey}"`, 'FS_NOT_FOUND');
    return { name: rest.slice(0, slash), path: '/' + rest.slice(slash + 1) };
  }
  rpcFor(target) {
    const { name } = this.splitKey(target.targetKey);
    const conn = this.remoteApi().connectionFor(name);
    if (!conn) throw new FsError(`remote connection "${name}" is not active`, 'FS_NOT_FOUND');
    return conn.rpc;
  }
  wrapDaemonError(error) {
    const message = String(error && error.message ? error.message : error);
    const head = message.slice(0, 12);
    let code = 'FS_IO_ERROR';
    if (head.startsWith('ENOENT') || head.startsWith('ENOTDIR')) code = 'FS_NOT_FOUND';
    else if (head.startsWith('EACCES') || head.startsWith('EPERM')) code = 'FS_PERMISSION_DENIED';
    else if (head.startsWith('EISDIR')) code = 'FS_NOT_REGULAR_FILE';
    return new FsError(message, code, { cause: error instanceof Error ? error : undefined });
  }
  remoteVersion(st) {
    return FsVersion(`rw:${st.size}:${st.mtimeMs}`);
  }
  remoteType(st) {
    if (st.isDir) return 'directory';
    if (st.isSymlink) return 'symlink';
    if (st.isFile) return 'file';
    return 'other';
  }
  async daemonStat(rpc, path) {
    try {
      return await rpc.request('fs.stat', { path });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (message.startsWith('ENOENT') || message.startsWith('ENOTDIR')) return null;
      throw this.wrapDaemonError(error);
    }
  }

  // ---- path-entry points ----
  /**
   * Anchor mapping: a relative/absolute path landing under a workspace anchor
   * directory rewrites to the mapped remote target BEFORE any local resolution.
   * Returns undefined when the path is not anchored (caller falls back to local).
   */
  async resolveAnchored(path, opts) {
    const anchors = (await this.remoteApi().anchors?.()) || [];
    if (anchors.length === 0) return undefined;
    const cwd = opts?.cwd ?? this.config.cwd;
    const abs = isAbsolute(path) ? path : join(cwd, path);
    for (const anchor of anchors) {
      if (!anchor.remoteRoot || !anchor.anchorDir || !isUnderAnchor(abs, anchor.anchorDir)) continue;
      const rel = relative(anchor.anchorDir, abs).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue; // sibling anchor with a shared prefix
      const remotePath = remoteJoin(anchor.remoteRoot, rel);
      return this.resolve(REMOTE_KEY_PREFIX + anchor.connection + '/' + remotePath.replace(/^\//, ''), opts);
    }
    return undefined;
  }
  async resolve(path, opts) {
    if (typeof path === 'string' && (path.startsWith(REMOTE_KEY_PREFIX) || path.startsWith(REMOTE_SCHEME))) {
      throwIfAborted(opts?.signal, 'resolve');
      // Accept both POSIX keys ('/dsh-remote/<conn>/<path>') and the legacy
      // scheme spelling; keys are emitted in the POSIX form.
      const rest = path.startsWith(REMOTE_SCHEME) ? path.slice(REMOTE_SCHEME.length) : path.slice(REMOTE_KEY_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash <= 0 || rest.length - slash <= 1) {
        throw new FsError(`file_path must reference a remote workspace directory: ${path}`, 'FS_NOT_FOUND');
      }
      const name = rest.slice(0, slash);
      const conn = this.remoteApi().connectionFor(name);
      if (!conn) throw new FsError(`remote connection "${name}" is not active`, 'FS_NOT_FOUND');
      const rpath = '/' + rest.slice(slash + 1);
      return {
        targetKey: FsTargetKey(REMOTE_KEY_PREFIX + name + '/' + rpath.slice(1)),
        displayPath: `${name}:${rpath}`,
      };
    }
    const anchored = await this.resolveAnchored(path, opts);
    if (anchored !== undefined) return anchored;
    return super.resolve(path, opts);
  }
  processPath(target) {
    return this.isRemoteTarget(target) ? String(target.targetKey) : super.processPath(target);
  }
  processPathFromHostPath(hostPath) {
    // Host paths are local by definition; remote targets are never manufactured here.
    return super.processPathFromHostPath(hostPath);
  }
  fileUrl(target) {
    if (this.isRemoteTarget(target)) {
      // Identity URL, parsed with `new URL` by consumers that derive relative
      // workspace paths from root/target pairs — never fetched. Percent-encode
      // each segment so '#'/'?'/non-ASCII survive URL parsing.
      const { name, path } = this.splitKey(target.targetKey);
      const segments = ['dsh-remote', name, ...path.split('/').filter(Boolean)];
      return 'file:///' + segments.map(encodeURIComponent).join('/');
    }
    return super.fileUrl(target);
  }
  contains(parent, child) {
    if (this.isRemoteTarget(parent) || this.isRemoteTarget(child)) {
      if (!this.isRemoteTarget(parent) || !this.isRemoteTarget(child)) return false;
      const a = this.splitKey(parent.targetKey);
      const b = this.splitKey(child.targetKey);
      if (a.name !== b.name) return false;
      return b.path === a.path || b.path.startsWith(a.path.endsWith('/') ? a.path : a.path + '/');
    }
    return super.contains(parent, child);
  }

  // ---- metadata ----
  async stat(target, signal) {
    if (!this.isRemoteTarget(target)) return super.stat(target, signal);
    throwIfAborted(signal, 'stat');
    const { path } = this.splitKey(target.targetKey);
    const st = await this.daemonStat(this.rpcFor(target), path);
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED');
    if (!st) return undefined;
    return { version: this.remoteVersion(st), type: this.remoteType(st), size: st.size };
  }
  async lstat(path, opts, signal) {
    if (typeof path === 'string' && !path.startsWith(REMOTE_KEY_PREFIX) && !path.startsWith(REMOTE_SCHEME)) {
      const anchored = await this.resolveAnchored(path, opts);
      if (anchored) return this.stat(anchored, signal);
    }
    if (typeof path !== 'string' || (!path.startsWith(REMOTE_KEY_PREFIX) && !path.startsWith(REMOTE_SCHEME))) return super.lstat(path, opts, signal);
    const target = await this.resolve(path, opts);
    return this.stat(target, signal); // v1: follow symlinks like stat
  }

  // ---- reads ----
  async daemonReadAll(rpc, path, byteCap, signal) {
    const chunks = [];
    let offset = 0;
    let size = 0;
    for (;;) {
      throwIfAborted(signal, 'read');
      const r = await rpc.request('fs.read', { path, offset, length: DAEMON_READ_CAP }).catch((error) => { throw this.wrapDaemonError(error); });
      const chunk = Buffer.from(r.contentB64, 'base64');
      chunks.push(chunk);
      size = r.size;
      offset += chunk.length;
      if (!r.truncated || chunk.length === 0 || offset >= byteCap) break;
    }
    return { buffer: Buffer.concat(chunks), size };
  }
  async readText(target, signal) {
    if (!this.isRemoteTarget(target)) return super.readText(target, signal);
    throwIfAborted(signal, 'read');
    const { path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    const st = await this.daemonStat(rpc, path);
    if (!st) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND');
    if (!st.isFile) throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
    if (st.size > READ_WHOLE_LIMIT) throw new FsError(`cannot read "${display}": ${st.size} bytes exceeds the ${READ_WHOLE_LIMIT}-byte limit`, 'FS_TOO_LARGE');
    const { buffer } = await this.daemonReadAll(rpc, path, READ_WHOLE_LIMIT, signal);
    if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new FsError(`cannot read "${display}": binary file`, 'FS_NOT_TEXT');
    }
    throwIfAborted(signal, 'read');
    return decodeUtf8Fatal(buffer, 'read', display);
  }
  remoteParts(target) {
    const { name, path } = this.splitKey(target.targetKey);
    return { name, path, display: target.displayPath || `${name}:${path}` };
  }
  streamText(target, signal) {
    if (!this.isRemoteTarget(target)) return super.streamText(target, signal);
    const self = this;
    const generator = async function* () {
      yield await self.readText(target, signal);
    };
    return Promise.resolve(generator());
  }
  async readBytes(target, signal, maxBytes) {
    if (!this.isRemoteTarget(target)) return super.readBytes(target, signal, maxBytes);
    throwIfAborted(signal, 'read');
    const { path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    const st = await this.daemonStat(rpc, path);
    if (!st) throw new FsError(`cannot read "${display}": not found`, 'FS_NOT_FOUND');
    if (!st.isFile) throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
    if (st.size > maxBytes) throw new FsError(`cannot read "${display}": ${st.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE');
    const { buffer } = await this.daemonReadAll(rpc, path, maxBytes, signal);
    return new Uint8Array(buffer);
  }
  async readByteRange(target, range, signal) {
    if (!this.isRemoteTarget(target)) return super.readByteRange(target, range, signal);
    throwIfAborted(signal, 'read');
    const { path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    if (range.length === 0) return new Uint8Array(0);
    const r = await rpc.request('fs.read', { path, offset: range.offset, length: range.length }).catch((error) => { throw this.wrapDaemonError(error); });
    return new Uint8Array(Buffer.from(r.contentB64, 'base64'));
  }

  // ---- listing ----
  async listDir(target, signal) {
    if (!this.isRemoteTarget(target)) return super.listDir(target, signal);
    throwIfAborted(signal, 'list');
    const { name, path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    const st = await this.daemonStat(rpc, path);
    if (!st) throw new FsError(`cannot list "${display}": not found`, 'FS_NOT_FOUND');
    if (st.isSymlink) { /* v1: list through symlinks like stat */ } else if (!st.isDir) {
      throw new FsError(`cannot list "${display}": not a directory`, 'FS_NOT_DIRECTORY');
    }
    const r = await rpc.request('fs.list', { path }).catch((error) => { throw this.wrapDaemonError(error); });
    throwIfAborted(signal, 'list');
    const childPath = (childName) => joinRemote(path, childName);
    const childKey = (childName) => REMOTE_KEY_PREFIX + name + '/' + childPath(childName).slice(1);
    return r.entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDir ? 'directory' : entry.isSymlink ? 'symlink' : entry.isFile ? 'file' : 'other',
        target: {
          targetKey: FsTargetKey(childKey(entry.name)),
          displayPath: `${name}:${childPath(entry.name)}`,
        },
        version: FsVersion(`rw:${entry.size}:${entry.mtimeMs}`),
        ...(entry.isFile ? { size: entry.size } : {}),
      }));
  }

  // ---- mutations ----
  async writeText(target, content, expected, signal, sandboxPolicy) {
    if (!this.isRemoteTarget(target)) return super.writeText(target, content, expected, signal, sandboxPolicy);
    const { path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    return this.withLock(target.targetKey, async () => {
      throwIfAborted(signal, 'write');
      const existing = await this.daemonStat(rpc, path);
      if (existing && !existing.isFile) throw new FsError(`cannot write "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) throw new FsError(`cannot write "${display}": file no longer exists`, 'FS_STALE_VERSION');
        if (this.remoteVersion(existing) !== expected.version) {
          throw new FsError(`cannot write "${display}": file changed since it was read`, 'FS_STALE_VERSION');
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        throw new FsError(`cannot overwrite existing "${display}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      let before = null;
      if (existing && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes) {
        try {
          before = normalizeLineEndings(await this.readText(target, signal));
        } catch (_) { before = null; }
      }
      throwIfAborted(signal, 'write');
      await rpc.request('fs.write', { path, contentB64: Buffer.from(content, 'utf8').toString('base64'), mkdirs: true }).catch((error) => { throw this.wrapDaemonError(error); });
      const after = await this.daemonStat(rpc, path);
      return {
        operation: existing ? 'update' : 'create',
        version: after ? this.remoteVersion(after) : FsVersion(`missing:${target.targetKey}`),
        before,
        after: normalizeLineEndings(content),
      };
    });
  }
  async editText(target, edit, expected, signal, sandboxPolicy) {
    if (!this.isRemoteTarget(target)) return super.editText(target, edit, expected, signal, sandboxPolicy);
    const { path, display } = this.remoteParts(target);
    const rpc = this.rpcFor(target);
    return this.withLock(target.targetKey, async () => {
      throwIfAborted(signal, 'edit');
      const existing = await this.daemonStat(rpc, path);
      if (!existing) throw new FsError(`cannot edit "${display}": file changed since it was read`, 'FS_STALE_VERSION');
      if (!existing.isFile) throw new FsError(`cannot edit "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE');
      const currentVersion = this.remoteVersion(existing);
      if (expected && currentVersion !== expected.version) {
        throw new FsError(`cannot edit "${display}": file changed since it was read`, 'FS_STALE_VERSION');
      }
      const raw = await this.readText(target, signal); // strict UTF-8 + binary rejection
      const normalized = normalizeLineEndings(raw);
      const lineEndings = detectLineEndings(raw);
      const edited = applyLiteralEdit(normalized, edit.oldString, edit.newString, edit.replaceAll, display);
      const content = restoreLineEndings(edited.content, lineEndings);
      throwIfAborted(signal, 'edit');
      await rpc.request('fs.write', { path, contentB64: Buffer.from(content, 'utf8').toString('base64'), mkdirs: true }).catch((error) => { throw this.wrapDaemonError(error); });
      const after = await this.daemonStat(rpc, path);
      return {
        version: after ? this.remoteVersion(after) : FsVersion(`missing:${target.targetKey}`),
        before: normalized,
        after: edited.content,
      };
    });
  }
}
