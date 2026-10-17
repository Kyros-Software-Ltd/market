// Tracks each phone's control app (WebDriverAgent), which sideload.js installs with your Apple ID.
// A free Apple ID signature lasts 7 days, so remember when each install first started
// working and count down from there. A fresh install or re-sign resets the clock.
const path = require('node:path');
const { DATA_DIR, readJson, writeJson } = require('./paths');

const FILE = path.join(DATA_DIR, 'control-app.json');
const LIFETIME_MS = 7 * 86400000;
const WARN_BEFORE_MS = 1.5 * 86400000;

const load = () => readJson(FILE, {});

/** Call when the control app starts. Returns the record ({ bundleId, since }). */
function started(udid, bundleId) {
    const all = load();
    const rec = all[udid];
    // Unknown phone, a different install (re-signed with a new id), or one we saw expire.
    if (!rec || rec.bundleId !== bundleId || rec.expired) {
        all[udid] = { bundleId, since: Date.now() };
        writeJson(FILE, all);
    }
    return all[udid];
}

/** Call when the phone refuses to run the control app because its signature expired. */
function expired(udid) {
    const all = load();
    all[udid] = { ...(all[udid] || {}), expired: true };
    writeJson(FILE, all);
}

/** Call after Market itself (re)signed and installed the control app: its 7 days start now. */
function installed(udid, bundleId) {
    const all = load();
    all[udid] = { bundleId, since: Date.now() };
    writeJson(FILE, all);
}

function info(udid) {
    const rec = load()[udid];
    if (!rec?.since || rec.expired) return { expiresAt: null, resignSoon: false };
    const expiresAt = rec.since + LIFETIME_MS;
    return { expiresAt, resignSoon: expiresAt - Date.now() < WARN_BEFORE_MS };
}

module.exports = { started, expired, installed, info };
