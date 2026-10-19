#!/usr/bin/env node
// ============================================================
//  make-manifest.js - regenerates audio/manifest.json
//
//  WHY: GitHub Pages (and every static host) has NO directory
//  listings, so the game cannot auto-discover recordings there.
//  The manifest is a plain list of file names it can fetch.
//
//  RUN THIS AFTER ADDING / REMOVING / RENAMING A RECORDING:
//      node tools/make-manifest.js
//
//  Local dev servers with directory listings (npx http-server)
//  keep working either way - the game prefers the manifest, then
//  falls back to listing, then to a built-in list.
// ============================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const DIRS = ['audio/weapons', 'audio/sfx'];

const out = {};
for (const d of DIRS) {
    let files = [];
    try {
        files = fs.readdirSync(path.join(root, d))
            .filter(f => /\.(mp3|wav|ogg)$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (e) { files = []; }
    out[d] = files;
}

const dest = path.join(root, 'audio', 'manifest.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`wrote ${path.relative(root, dest).replace(/\\/g, '/')}`);
for (const d of DIRS) console.log(`  ${d}/ -> ${out[d].length} file(s)`);

const weapons = out['audio/weapons'].length;
const sfx = out['audio/sfx'].length;
if (!weapons) console.warn('  ! no weapon recordings found - guns will be silent');
if (!sfx) console.log('  i no SFX recordings - Aura\'s synth fallbacks cover them');
