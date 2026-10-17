// AffRev sign-in. The packaged Market (the zip from affrev.com) only runs for a signed-in AffRev
// account: the dashboard shows a sign-in screen and the API refuses everything else until then.
// Signing in: the dashboard sends you to affrev.com/auth/market, which comes back to
// /api/account/callback with a token for this PC. The token lives in the data folder; Market
// rechecks it every few hours and keeps working offline for OFFLINE_GRACE after the last check.
// Copies run from the source (npm start) don't need it unless MARKET_REQUIRE_SIGNIN=1.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR, readJson, writeJson, loadConfig } = require('./paths');

const STATE_FILE = path.join(DATA_DIR, 'account.json');
const PACKAGED = fs.existsSync(path.join(__dirname, '..', '..', 'packaged.json'));
const REQUIRED = PACKAGED || process.env.MARKET_REQUIRE_SIGNIN === '1';
const CHECK_EVERY = 3 * 60 * 60 * 1000;
const OFFLINE_GRACE = 7 * 24 * 60 * 60 * 1000;
const VERSION = readJson(path.join(__dirname, '..', '..', 'package.json'), {}).version || '';

const affrevUrl = () => (loadConfig().affrevUrl || 'https://affrev.com').replace(/\/$/, '');
const load = () => readJson(STATE_FILE, {}); // { token, user, verifiedAt }
// Every call to AffRev says which version this PC runs, so AffRev can list who runs what.
const headersFor = (token) => ({
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Market',
    'X-Market-Version': VERSION,
});

let pendingState = null;
let checkError = '';

const isLoopback = (origin) => {
    try {
        const u = new URL(origin);
        return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    } catch {
        return false;
    }
};

/** Asks AffRev who a token belongs to. Throws with status 401 when it's been signed out. */
async function whoAmI(token) {
    const res = await fetch(`${affrevUrl()}/api/market/me`, {
        headers: headersFor(token),
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw Object.assign(new Error('This PC was signed out of AffRev.'), { status: 401 });
    if (!res.ok) throw new Error(`AffRev answered ${res.status}`);
    return (await res.json()).user;
}

function status() {
    const a = load();
    const signedIn = !!a.token && Date.now() - (a.verifiedAt || 0) < OFFLINE_GRACE;
    return {
        required: REQUIRED,
        signedIn,
        user: a.token ? a.user || null : null,
        error: checkError,
        affrevUrl: affrevUrl(),
    };
}

/** True when the app may be used: signed in, or sign-in isn't needed for this copy. */
const allowed = () => !REQUIRED || status().signedIn;

/** The AffRev page to send the browser to. `origin` is the dashboard's, so AffRev comes back to it. */
function signInUrl(origin) {
    if (!isLoopback(origin)) throw new Error('Open Market from this PC to sign in.');
    pendingState = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
        redirect_uri: `${origin}/api/account/callback`,
        state: pendingState,
        device: os.hostname(),
    });
    return `${affrevUrl()}/auth/market?${params}`;
}

async function finishSignIn({ token, state }) {
    if (!pendingState || state !== pendingState) throw new Error('That sign-in link expired. Try again from Market.');
    pendingState = null;
    if (!token) throw new Error('AffRev did not send a sign-in token.');
    const user = await whoAmI(token);
    writeJson(STATE_FILE, { token, user, verifiedAt: Date.now() });
    checkError = '';
}

async function verify() {
    const a = load();
    if (!a.token) return;
    try {
        const user = await whoAmI(a.token);
        writeJson(STATE_FILE, { ...a, user, verifiedAt: Date.now() });
        checkError = '';
    } catch (e) {
        if (e.status === 401) fs.rmSync(STATE_FILE, { force: true });
        else checkError = e.message; // offline: keep going until OFFLINE_GRACE runs out
    }
}

async function signOut() {
    const { token } = load();
    fs.rmSync(STATE_FILE, { force: true });
    if (!token) return;
    await fetch(`${affrevUrl()}/api/market/sign-out`, {
        method: 'POST',
        headers: headersFor(token),
        signal: AbortSignal.timeout(10000),
    }).catch(() => {});
}

function start() {
    verify();
    setInterval(verify, CHECK_EVERY).unref();
}

module.exports = {
    PACKAGED,
    affrevUrl,
    token: () => load().token || '',
    headers: () => headersFor(load().token || ''),
    status,
    allowed,
    signInUrl,
    finishSignIn,
    signOut,
    start,
};
