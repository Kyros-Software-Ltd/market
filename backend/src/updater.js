// Updates. The backend checks the repo's GitHub Releases (package.json "repository") for a newer
// version. Applying one happens in scripts/start.js, because Windows locks the native modules the
// backend and dashboard have loaded: the backend asks for the update and exits with
// UPDATE_EXIT_CODE, then start.js calls applyPending() (download the release or git fast-forward
// to its tag, npm install) and starts Market again, which rebuilds the dashboard for the new version.
// A private repo needs a read-only GitHub token: "updateToken" in the data folder's config.json, or
// MARKET_UPDATE_TOKEN.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DATA_DIR, readJson, writeJson, loadConfig } = require('./paths');

const APP_ROOT = path.join(__dirname, '..', '..');
const PKG = readJson(path.join(APP_ROOT, 'package.json'), {});
const VERSION = PKG.version || '0.0.0';
const REPO = repoName(PKG.repository); // "owner/name"
const STATE_FILE = path.join(DATA_DIR, 'update.json');
const UPDATE_EXIT_CODE = 75;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

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

let latest = null; // { version, tag, notes, url, publishedAt }
let checkedAt = 0;
let checkError = '';
let notFound = false; // GitHub said 404: no releases yet, or a private repo without a token
let exitForUpdate = null;

async function check() {
    if (!REPO) return;
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: githubHeaders(),
            signal: AbortSignal.timeout(15000),
        });
        notFound = res.status === 404;
        if (notFound) {
            latest = null;
        } else if (res.status === 401) {
            throw new Error('the update token was refused (expired or revoked?)');
        } else if (!res.ok) {
            throw new Error(`GitHub answered ${res.status}`);
        } else {
            const r = await res.json();
            latest = {
                version: clean(r.tag_name),
                tag: r.tag_name,
                notes: r.body || '',
                url: r.html_url,
                publishedAt: Date.parse(r.published_at) || null,
            };
        }
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
        repo: REPO,
        latest,
        available: !!latest && newer(latest.version, VERSION),
        checkedAt,
        error: checkError,
        notFound,
        hasToken: !!token(),
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
    if (!s.canApply) throw new Error('Market was started without its launcher. Close it and run npm start to update.');
    writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), pending: latest.tag });
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

async function downloadRelease(tag, log) {
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
        // Windows' own tar; Git's GNU tar on PATH would read "C:" as a remote host.
        const tar =
            process.platform === 'win32'
                ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
                : 'tar';
        run(tar, ['-xzf', '../release.tar.gz', '--strip-components=1'], { cwd: out });
        log('Copying the new files…');
        fs.cpSync(out, APP_ROOT, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Applies the update the backend asked for, if any. Returns true when files changed. */
async function applyPending(log = console.log) {
    const state = readJson(STATE_FILE, {});
    const tag = state.pending;
    if (!tag) return false;
    const last = { from: VERSION, to: clean(tag), ok: false, error: '', at: Date.now() };
    try {
        if (!REPO) throw new Error('package.json has no GitHub repository');
        if (fs.existsSync(path.join(APP_ROOT, '.git'))) {
            log(`Fetching ${tag} with git…`);
            const auth = token()
                ? [
                      '-c',
                      `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token()}`).toString('base64')}`,
                  ]
                : [];
            run('git', [
                ...auth,
                'fetch',
                '--force',
                `https://github.com/${REPO}.git`,
                `refs/tags/${tag}:refs/tags/${tag}`,
            ]);
            run('git', ['merge', '--ff-only', tag]);
        } else {
            await downloadRelease(tag, log);
        }
        log('Installing packages…');
        run('npm', ['install', '--no-audit', '--no-fund'], { shell: process.platform === 'win32' });
        last.ok = true;
        log(`Updated to ${clean(tag)}.`);
    } catch (e) {
        last.error = e.message;
        log(`Update failed: ${e.message}`);
    }
    writeJson(STATE_FILE, { last });
    return last.ok;
}

module.exports = { VERSION, UPDATE_EXIT_CODE, start, check, status, onApply, requestApply, applyPending };
