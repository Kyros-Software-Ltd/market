// Updates. Applying one happens in scripts/start.js, because Windows locks the native modules the
// backend and dashboard have loaded: the backend asks for the update and exits with
// UPDATE_EXIT_CODE, then start.js calls applyPending() and starts Market again.
//
// Two kinds of copy:
// - Packaged (the zip from affrev.com, built by scripts/package.js): asks AffRev for the latest
//   build with its sign-in token, downloads the zip, checks its sha256 and swaps the new files in,
//   keeping the old ones until the swap has worked.
// - Source (git clone or npm start): checks the repo's GitHub Releases (package.json "repository"),
//   then fast-forwards git to the release tag (or downloads its source) and runs npm install; the
//   restart rebuilds the dashboard. A private repo needs a read-only GitHub token: "updateToken" in
//   the data folder's config.json, or MARKET_UPDATE_TOKEN.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DATA_DIR, readJson, writeJson, loadConfig } = require('./paths');
const account = require('./account');

const APP_ROOT = path.join(__dirname, '..', '..');
const PKG = readJson(path.join(APP_ROOT, 'package.json'), {});
const VERSION = PKG.version || '0.0.0';
const REPO = repoName(PKG.repository); // "owner/name"
const STATE_FILE = path.join(DATA_DIR, 'update.json');
const UPDATE_EXIT_CODE = 75;
const CHECK_EVERY = 5 * 60 * 1000; // a new release shows up within 5 minutes
// Packaged updates unpack here, and the replaced files wait here until the next start.
const NEW_DIR = path.join(APP_ROOT, '.update-new');
const OLD_DIR = path.join(APP_ROOT, '.update-old');

function repoName(repository) {
    const url = typeof repository === 'string' ? repository : repository?.url || '';
    const m = url.match(/github\.com[/:]([^/]+\/[^/#]+?)(\.git)?\/?$/);
    return m ? m[1] : null;
}

const clean = (tag) => String(tag || '').replace(/^v/i, '');
const parts = (v) =>
    clean(v)
        .split(/[.-]/)
        .slice(0, 3)
        .map((n) => Number.parseInt(n, 10) || 0);
/** True when version a is newer than b (major.minor.patch). */
function newer(a, b) {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
}

// Read each time, so a token added to config.json works without a restart.
const token = () => process.env.MARKET_UPDATE_TOKEN || loadConfig().updateToken || '';
function githubHeaders() {
    const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'Market' };
    if (token()) h.Authorization = `Bearer ${token()}`;
    return h;
}
const affrevHeaders = () => account.headers();

let latest = null; // { version, tag, notes, url, publishedAt, sha256? }
let checkedAt = 0;
let checkError = '';
let notFound = false; // no releases yet, or a private repo without a token
let exitForUpdate = null;

async function checkGithub() {
    if (!REPO) return;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(15000),
    });
    notFound = res.status === 404;
    if (notFound) {
        latest = null;
        return;
    }
    if (res.status === 401) throw new Error('the update token was refused (expired or revoked?)');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    latest = {
        version: clean(r.tag_name),
        tag: r.tag_name,
        notes: r.body || '',
        url: r.html_url,
        publishedAt: Date.parse(r.published_at) || null,
    };
}

async function checkAffrev() {
    if (!account.token()) {
        latest = null; // checked again once someone signs in
        return;
    }
    const res = await fetch(`${account.affrevUrl()}/api/market/latest`, {
        headers: affrevHeaders(),
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new Error('sign in with AffRev to get updates');
    if (!res.ok) throw new Error(`AffRev answered ${res.status}`);
    const { release } = await res.json();
    notFound = !release;
    latest = release
        ? {
              version: clean(release.version),
              tag: release.version,
              notes: release.notes || '',
              url: `${account.affrevUrl()}/dashboard/market`,
              publishedAt: Date.parse(release.publishedAt) || null,
              sha256: release.sha256,
          }
        : null;
}

async function check() {
    try {
        await (account.PACKAGED ? checkAffrev() : checkGithub());
        checkError = '';
    } catch (e) {
        checkError = e.message;
    }
    checkedAt = Date.now();
}

function start() {
    check();
    setInterval(check, CHECK_EVERY).unref();
}

function status() {
    const state = readJson(STATE_FILE, {});
    return {
        version: VERSION,
        source: account.PACKAGED ? 'affrev' : 'github',
        repo: account.PACKAGED ? 'AffRev' : REPO,
        latest,
        available: !!latest && newer(latest.version, VERSION),
        checkedAt,
        error: checkError,
        notFound,
        hasToken: account.PACKAGED ? !!account.token() : !!token(),
        // Only start.js can apply an update; a backend started on its own can't restart itself.
        canApply: process.env.MARKET_SUPERVISED === '1' && !!exitForUpdate,
        last: state.last || null, // { from, to, ok, error, at } from the last update
    };
}

/** Called once the backend is up: how to shut down and hand over to start.js. */
function onApply(fn) {
    exitForUpdate = fn;
}

function requestApply() {
    const s = status();
    if (!s.available) throw new Error('Market is already up to date.');
    if (!s.canApply) throw new Error('Market was started without its launcher. Close it and start it again to update.');
    writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), pending: latest.tag, sha256: latest.sha256 || '' });
    setTimeout(exitForUpdate, 300); // let the response go out first
    return { updating: latest.version };
}

// ---------- applying (runs inside start.js, with the backend and dashboard stopped) ----------

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { cwd: APP_ROOT, stdio: 'inherit', windowsHide: true, ...opts });
    // The arguments can hold the token, so they stay out of the message.
    if (r.status !== 0)
        throw new Error(`${path.basename(cmd)} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
}

// Windows' own tar (it also reads zips); Git's GNU tar on PATH would read "C:" as a remote host.
const TAR =
    process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function downloadSource(tag, log) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'market-update-'));
    try {
        log(`Downloading ${tag}…`);
        // The API redirects to a short-lived download link, which also works for private repos.
        const res = await fetch(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(tag)}`, {
            headers: githubHeaders(),
            signal: AbortSignal.timeout(5 * 60 * 1000),
        });
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        fs.writeFileSync(path.join(tmp, 'release.tar.gz'), Buffer.from(await res.arrayBuffer()));
        const out = path.join(tmp, 'out');
        fs.mkdirSync(out);
        run(TAR, ['-xzf', '../release.tar.gz', '--strip-components=1'], { cwd: out });
        log('Copying the new files…');
        fs.cpSync(out, APP_ROOT, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function updateSource(tag, log) {
    if (!REPO) throw new Error('package.json has no GitHub repository');
    if (!fs.existsSync(path.join(APP_ROOT, '.git'))) return downloadSource(tag, log);
    log(`Fetching ${tag} with git…`);
    const auth = token()
        ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token()}`).toString('base64')}`]
        : [];
    run('git', [...auth, 'fetch', '--force', `https://github.com/${REPO}.git`, `refs/tags/${tag}:refs/tags/${tag}`]);
    run('git', ['merge', '--ff-only', tag]);
}

/** Moves the files in `from` over APP_ROOT, putting the replaced ones in OLD_DIR; undoes it all on failure. */
function swapIn(from) {
    fs.mkdirSync(OLD_DIR, { recursive: true });
    const moved = []; // [path in APP_ROOT, its place in OLD_DIR]
    const placed = [];
    const move = (src, dest) => {
        if (fs.existsSync(dest)) {
            const old = path.join(OLD_DIR, path.relative(APP_ROOT, dest));
            fs.mkdirSync(path.dirname(old), { recursive: true });
            fs.renameSync(dest, old);
            moved.push([dest, old]);
        }
        fs.renameSync(src, dest);
        placed.push(dest);
    };
    try {
        for (const name of fs.readdirSync(from)) {
            const src = path.join(from, name);
            const dest = path.join(APP_ROOT, name);
            // The running node.exe can be renamed but not its folder, so the runtime goes file by file.
            if (name === 'runtime' && fs.existsSync(dest)) {
                for (const file of fs.readdirSync(src)) move(path.join(src, file), path.join(dest, file));
            } else {
                move(src, dest);
            }
        }
    } catch (e) {
        for (const dest of placed.reverse()) fs.rmSync(dest, { recursive: true, force: true });
        for (const [dest, old] of moved.reverse()) fs.renameSync(old, dest);
        throw e;
    }
}

async function updatePackage(expectedSha, log) {
    log('Downloading the update from AffRev…');
    const res = await fetch(`${account.affrevUrl()}/api/market/download`, {
        headers: affrevHeaders(),
        signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (res.status === 401) throw new Error('Sign in with AffRev to update.');
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const zip = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(zip).digest('hex');
    if (expectedSha && sha !== expectedSha) throw new Error("The download didn't match its checksum. Try again.");

    fs.rmSync(NEW_DIR, { recursive: true, force: true });
    fs.mkdirSync(NEW_DIR);
    try {
        fs.writeFileSync(path.join(NEW_DIR, 'update.zip'), zip);
        const out = path.join(NEW_DIR, 'files');
        fs.mkdirSync(out);
        log('Unpacking…');
        run(TAR, ['-xf', '../update.zip'], { cwd: out });
        if (!fs.existsSync(path.join(out, 'packaged.json'))) throw new Error("The download isn't a Market build.");
        log('Installing…');
        swapIn(out);
    } finally {
        fs.rmSync(NEW_DIR, { recursive: true, force: true });
    }
}

/** Clears what the last packaged update left behind (files that were still in use then). */
function cleanUp() {
    for (const dir of [OLD_DIR, NEW_DIR]) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
    }
}

/** Applies the update the backend asked for, if any. Returns true when files changed. */
async function applyPending(log = console.log) {
    const state = readJson(STATE_FILE, {});
    const tag = state.pending;
    if (!tag) return false;
    const last = { from: VERSION, to: clean(tag), ok: false, error: '', at: Date.now() };
    try {
        if (account.PACKAGED) {
            cleanUp();
            await updatePackage(state.sha256, log);
        } else {
            await updateSource(tag, log);
            log('Installing packages…');
            run('npm', ['install', '--no-audit', '--no-fund'], { shell: process.platform === 'win32' });
        }
        last.ok = true;
        log(`Updated to ${clean(tag)}.`);
    } catch (e) {
        last.error = e.message;
        log(`Update failed: ${e.message}`);
    }
    writeJson(STATE_FILE, { last });
    return last.ok;
}

module.exports = { VERSION, UPDATE_EXIT_CODE, start, check, status, onApply, requestApply, applyPending, cleanUp };
