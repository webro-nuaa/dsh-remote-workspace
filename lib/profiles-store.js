/**
 * Saved remote connection profiles for the dsh-remote-workspace bundle.
 *
 * Persisted as one JSON file under the DSH home so profiles survive Host
 * restarts. Secrets are NEVER persisted: `auth=password` connections prompt
 * for the password at connect time and keep it in memory for the process
 * lifetime only.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STORE_DIR = process.env.DSH_REMOTE_WORKSPACE_STORE_DIR
  || join(homedir(), '.dsh', 'remote-workspace');
const STORE_FILE = join(STORE_DIR, 'connections.json');
const PROFILE_FIELDS = ['name', 'host', 'port', 'username', 'auth', 'keyPath'];

function sanitizeProfile(input) {
  if (typeof input !== 'object' || input === null) return null;
  const name = String(input.name || '').trim();
  const host = String(input.host || '').trim();
  if (!name || !host) return null;
  const profile = { name, host };
  if (Number.isFinite(input.port) && input.port > 0) profile.port = input.port;
  if (input.username) profile.username = String(input.username);
  if (input.auth === 'password' || input.auth === 'key') profile.auth = input.auth;
  if (input.keyPath) profile.keyPath = String(input.keyPath);
  return profile;
}

export async function listProfiles() {
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    if (!Array.isArray(raw.profiles)) return [];
    return raw.profiles.map(sanitizeProfile).filter(Boolean);
  } catch {
    return [];
  }
}

export async function saveProfile(input) {
  const profile = sanitizeProfile(input);
  if (!profile) throw new Error('profile requires at least name and host');
  const profiles = await listProfiles();
  const index = profiles.findIndex((p) => p.name === profile.name);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  await persist(profiles);
  return profile;
}

export async function deleteProfile(name) {
  const profiles = await listProfiles();
  const next = profiles.filter((p) => p.name !== name);
  await persist(next);
  return next.length !== profiles.length;
}

async function persist(profiles) {
  await mkdir(dirname(STORE_FILE), { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify({ version: 1, profiles }, null, 2) + '\n', 'utf8');
  await rename(tmp, STORE_FILE);
}
