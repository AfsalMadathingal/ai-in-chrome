#!/usr/bin/env node
// Copies package.json's version into extension/manifest.json. Runs from `npm version <patch|minor|major>`,
// so the CLI and the extension always report the same version.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../extension/manifest.json', import.meta.url);
const text = fs.readFileSync(file, 'utf8');
const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${pkg.version}$2`);
if (next !== text) fs.writeFileSync(file, next);
console.log(`extension/manifest.json → ${pkg.version}`);
