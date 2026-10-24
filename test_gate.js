/**
 * Runtime gate test for the shipped modules.
 *
 * Refusal checks need no secret. The positive checks (which prove the modules
 * still export a working API under Auris) need the host key, supplied at run
 * time so it is never committed:
 *
 *   AURIS_KEY=... node test_gate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const LOCK = 'This addon is only compatible with Auris';
const LINK = 'https://auris.shehriyar.ink';
const KEY = process.env.AURIS_KEY || '';

const MODULES = [
  ['modules/ax4.js', 'Auris Addon', '3.0.1'],
  ['modules/ax2.js', 'Auris Hi-Res Lossless Addon', '2.0.0'],
  ['modules/ax3.js', 'Internet Archive FLAC (archive.org)', '2.0.0'],
];

let failures = 0;
let assertions = 0;
function ok(cond, label) {
  assertions++;
  if (!cond) {
    failures++;
    console.error('  FAIL ' + label);
  } else {
    console.log('  ok   ' + label);
  }
}

function load(file, spine) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, console };
  sandbox.globalThis = sandbox;
  if (spine !== undefined) sandbox.__spine_app = spine;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file, timeout: 10000 });
  return module.exports;
}

function throwsLock(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return String(e.message).includes(LOCK) && String(e.message).includes(LINK);
  }
}

for (const [file, name, version] of MODULES) {
  console.log('\n' + file);

  ok(throwsLock(() => load(file)), 'refuses a host with no identity');
  ok(
    throwsLock(() => load(file, { id: 'auris', key: 'wrong', name: 'Auris' })),
    'refuses a forged identity',
  );
  ok(
    throwsLock(() => load(file, { id: 'bitchord', key: 'wrong' })),
    'refuses a foreign host id',
  );

  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  ok(!src.includes(LOCK), 'lock text is not readable in the shipped file');
  ok(!src.includes(LINK), 'Auris link is not readable in the shipped file');
  ok(!src.includes('__spine_app'), 'host marker is not readable in the shipped file');

  if (!KEY) {
    console.log('  skip positive checks (set AURIS_KEY to run them)');
    continue;
  }

  const exports = load(file, { id: 'auris', key: KEY, name: 'Auris' });
  ok(typeof exports.searchTracks === 'function', 'exports searchTracks');
  ok(typeof exports.getTrackStreamUrl === 'function', 'exports getTrackStreamUrl');
  ok(exports.name === name, 'exports the expected name');
  ok(exports.version === version, 'exports the expected version');
  ok(
    throwsLock(() => exports.searchTracks('x', 1, { app: { id: 'auris', key: 'wrong' } })),
    'refuses a call with a forged context',
  );
}

console.log(`\n${assertions - failures}/${assertions} assertions passed`);
process.exitCode = failures === 0 ? 0 : 1;
