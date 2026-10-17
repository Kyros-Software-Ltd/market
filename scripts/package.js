#!/usr/bin/env node
// Builds the packaged Market, the zip people download from affrev.com: the compiled dashboard,
// the minified backend and launcher, production packages and a copy of node.exe, with no source.
// The Release workflow runs it after npm ci, npm run build and npm prune --omit=dev.
//   node scripts/package.js         writes dist/Market/, dist/market-<version>.zip, dist/latest.json
//   ESBUILD=<folder>                where to load esbuild from (it isn't one of Market's packages)
//   RELEASE_NOTES=<text>            what goes in latest.json's notes
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'Market');
const esbuild = require(process.env.ESBUILD || 'esbuild');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const src = (...p) => path.join(ROOT, ...p);
const dest = (...p) => path.join(OUT, ...p);

function copy(from, to, filter) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: filter ? (f) => filter(path.relative(from, f)) : undefined });
}

/** Copies a script minified: no comments, short local names. */
function minify(rel) {
    const code = fs.readFileSync(src(rel), 'utf8');
    const out = esbuild.transformSync(code, {
        loader: 'js',
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        minify: true,
        legalComments: 'none',
    }).code;
    fs.mkdirSync(path.dirname(dest(rel)), { recursive: true });
    fs.writeFileSync(dest(rel), out);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- app ----------
const { scripts, devDependencies, workspaces, ...manifest } = pkg;
fs.writeFileSync(dest('package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
for (const f of ['LICENSE', 'NOTICE']) copy(src(f), dest(f));
minify('scripts/start.js');

for (const f of fs.readdirSync(src('backend/src'))) if (f.endsWith('.js')) minify(`backend/src/${f}`);
for (const f of fs.readdirSync(src('backend/mcp'))) if (f.endsWith('.js')) minify(`backend/mcp/${f}`);
copy(src('backend/src/py'), dest('backend/src/py'), (f) => !f.includes('__pycache__'));
copy(src('backend/automations'), dest('backend/automations'));
for (const f of ['config.json', 'package.json']) copy(src('backend', f), dest('backend', f));

// Dashboard: the build output only. Source maps and the build cache stay behind.
copy(src('frontend/package.json'), dest('frontend/package.json'));
copy(src('frontend/public'), dest('frontend/public'));
copy(src('frontend/.next'), dest('frontend/.next'), (f) => !/^(cache|trace)/.test(f) && !f.endsWith('.map'));
fs.writeFileSync(dest('frontend/.next/market-version'), VERSION);
// next start would need TypeScript to read next.config.ts; ship it as plain JavaScript.
fs.writeFileSync(
    dest('frontend/next.config.mjs'),
    esbuild.transformSync(fs.readFileSync(src('frontend/next.config.ts'), 'utf8'), { loader: 'ts', format: 'esm' })
        .code,
);

// ---------- packages ----------
// The workspace links point back at the source, next start doesn't need the compiler, and only
// go-ios's Windows build is used.
const skipPackage = (f) =>
    !/^(@market|\.bin|\.cache|@next[\\/]swc-|@biomejs)/.test(f) &&
    !/^go-ios[\\/]dist[\\/]go-ios-(darwin|linux)/.test(f);
copy(src('node_modules'), dest('node_modules'), skipPackage);
for (const ws of ['backend', 'frontend'])
    if (fs.existsSync(src(ws, 'node_modules'))) copy(src(ws, 'node_modules'), dest(ws, 'node_modules'), skipPackage);

// The sideloading helper (sideload/, built with cargo before this runs).
const helper = src('sideload/target/release/market-sideload.exe');
if (fs.existsSync(helper)) copy(helper, dest('bin/market-sideload.exe'));
else console.warn('No sideloading helper built; the package will need Sideloadly.');
// Its 32-bit partner that gets anisette from iCloud for Windows.
const anisette = src('sideload/anisette/target/i686-pc-windows-msvc/release/market-anisette.exe');
if (fs.existsSync(anisette)) copy(anisette, dest('bin/market-anisette.exe'));

// ---------- runtime and launcher ----------
copy(process.execPath, dest('runtime', path.basename(process.execPath)));
fs.writeFileSync(
    dest('Start Market.cmd'),
    '@echo off\r\ntitle Market\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\start.js" %*\r\n',
);
fs.writeFileSync(
    dest('packaged.json'),
    `${JSON.stringify({ version: VERSION, builtAt: new Date().toISOString(), commit: process.env.GITHUB_SHA || '' }, null, 4)}\n`,
);

// ---------- zip and manifest ----------
const zipName = `market-${VERSION}.zip`;
const zipPath = path.join(DIST, zipName);
// Windows' own tar writes zips (-a picks the format from the name).
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const zip = spawnSync(tar, ['-a', '-cf', zipPath, '-C', OUT, ...fs.readdirSync(OUT)], { stdio: 'inherit' });
if (zip.status !== 0) throw new Error('tar failed to write the zip');
const data = fs.readFileSync(zipPath);
const latest = {
    version: VERSION,
    file: zipName, // the release asset AffRev serves
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    notes: process.env.RELEASE_NOTES || '',
    publishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(DIST, 'latest.json'), `${JSON.stringify(latest, null, 4)}\n`);
console.log(`Packaged Market ${VERSION}: ${zipName}, ${Math.round(data.length / 1024 / 1024)} MB`);
