/**
 * Remote workspace anchors: a real local directory per saved connection that
 * stands in for the remote root, so the stock workspace registry (which
 * realpaths + stats the path) accepts it untouched.
 *
 *   ~/.dsh/remote-workspace/workspaces/<profile>/   (anchor, real local dir)
 *        mapped by the composite fs onto  <connection>:<remoteRoot>/...
 *
 * Every fs call resolving under an anchor is rewritten to a
 * `/dsh-remote/<connection>/<remoteRoot>/<rel>` target before any local I/O;
 * the anchor itself is never read or written by the harness.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function anchorsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'remote-workspace', 'workspaces');
}

export function sanitizeAnchorName(name) {
  // Unicode-preserving: 连接名可以是非 ASCII（新服务器 → 新服务器，而非 ____）
  const cleaned = String(name).replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return cleaned || 'default';
}

export function anchorDirFor(profileName) {
  return join(anchorsRoot(), sanitizeAnchorName(profileName));
}

/** Create (or confirm) the anchor directory and drop a self-describing marker. */
export async function ensureAnchor(profileName, meta = {}) {
  const dir = anchorDirFor(profileName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, '.dsh-remote-anchor.json'),
    JSON.stringify({ connection: profileName, ...meta }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

/** Case-insensitive prefix test on Windows, case-sensitive elsewhere. */
export function isUnderAnchor(child, anchor) {
  const norm = (p) => p.replace(/[\\/]+$/, '');
  const c = norm(child);
  const a = norm(anchor);
  const ci = process.platform === 'win32';
  const cc = ci ? c.toLowerCase() : c;
  const aa = ci ? a.toLowerCase() : a;
  if (cc === aa) return true;
  const sep = c.includes('/') ? '/' : '\\';
  return cc.startsWith(aa + sep);
}
