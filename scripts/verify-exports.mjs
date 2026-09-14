// Verifies the bundle package loads as ESM and exports the cordis plugin
// contract (name / inject / apply), and that the bundled daemon is readable.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + (detail || '')}`);
  if (!cond) failures.push(name);
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href);
check('export name', mod.name === 'remote-workspace', String(mod.name));
check('export inject', Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('subprocess'), JSON.stringify(mod.inject));
check('export apply', typeof mod.apply === 'function', typeof mod.apply);

const daemon = await readFile(new URL('../daemon/dsh-remote-daemon.js', import.meta.url), 'utf8');
check('bundled daemon readable', daemon.includes("const VERSION = '1.0.0'"), 'version marker');

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
check('patch references package', patch.includes('name: dsh-remote-workspace'), 'row name');

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check('bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh));
check('main is lib/index.js', pkg.main === 'lib/index.js', pkg.main);

process.exit(failures.length ? 1 : 0);
