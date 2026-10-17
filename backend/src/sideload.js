// Built-in sideloading, instead of Sideloadly: market-sideload (the Rust helper in sideload/, built
// on isideload) signs WDA.ipa with the user's free Apple ID and installs it on a phone.
// - Setup signs in once (2FA included) and the helper keeps the password in the Windows Credential
//   Manager, so later installs and re-signs need nothing from you.
// - One helper runs at a time; installs wait their turn in a queue.
// - A free Apple ID's signature lasts 7 days, so phones that are plugged in get re-signed by
//   themselves a day before it runs out.
// The helper talks JSON lines: we send {"password"} then any {"twoFactor"} answers, it sends
// status / twoFactor / progress / done / error events.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DATA_DIR, readJson, writeJson, loadConfig } = require('./paths');
const setup = require('./setup');
const controlApp = require('./controlapp');

const APP_ROOT = path.join(__dirname, '..', '..');
const STATE_FILE = path.join(DATA_DIR, 'sideload.json'); // { appleId, installs: { udid: at } }
const WORK_DIR = path.join(DATA_DIR, 'sideload'); // anisette state and the signing certificate
const RESIGN_BEFORE_MS = 24 * 3600000;
const RETRY_AFTER_MS = 6 * 3600000; // after a failed automatic re-sign
const CHECK_EVERY_MS = 30 * 60000;

// The packaged app ships the helper in bin/; a source checkout uses its own cargo build.
const helperPath = () =>
    [
        path.join(APP_ROOT, 'bin', 'market-sideload.exe'),
        path.join(APP_ROOT, 'sideload', 'target', 'release', 'market-sideload.exe'),
    ].find((p) => fs.existsSync(p)) || null;

const load = () => readJson(STATE_FILE, {});

let job = null; // the running helper: { kind, udid, step, percent, twoFactor, startedAt, child }
let lastError = null; // { kind, udid, message, at }
const queue = []; // { udid, auto }
const autoTried = new Map(); // udid -> when an automatic re-sign last failed
let devices = null;

function status() {
    const { appleId } = load();
    return {
        available: !!helperPath(),
        appleId: appleId || null,
        job: job && {
            kind: job.kind,
            udid: job.udid,
            step: job.step,
            percent: job.percent,
            twoFactor: job.twoFactor,
            startedAt: job.startedAt,
        },
        queued: queue.map((q) => q.udid),
        lastError,
    };
}

/** Runs the helper once. Resolves with its "done" event, rejects with its error. */
function runHelper(kind, args, { password = '', udid = null } = {}) {
    const exe = helperPath();
    if (!exe) return Promise.reject(new Error("This copy of Market doesn't include the sideloading helper."));
    const anisette = loadConfig().sideloadAnisetteUrl;
    const child = spawn(exe, [...args, '--data', WORK_DIR, ...(anisette ? ['--anisette', anisette] : [])], {
        windowsHide: true,
        env: process.env, // USBMUXD_SOCKET_ADDRESS: Market's usbmux proxy, so Wi-Fi phones work too
    });
    job = { kind, udid, step: 'Starting…', percent: null, twoFactor: null, startedAt: Date.now(), child };
    child.stdin.write(`${JSON.stringify({ password })}\n`);

    return new Promise((resolve, reject) => {
        let result = null;
        let failure = null;
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf('\n');
                let ev;
                try {
                    ev = JSON.parse(line);
                } catch {
                    continue;
                }
                if (ev.event === 'status') job.step = ev.text;
                else if (ev.event === 'progress') job.percent = ev.percent;
                else if (ev.event === 'twoFactor') job.twoFactor = ev.params;
                else if (ev.event === 'done') result = ev;
                else if (ev.event === 'error') failure = ev.message;
            }
        });
        const log = [];
        child.stderr.on('data', (chunk) => log.push(String(chunk)));
        child.on('error', (e) => (failure = e.message));
        child.on('close', (code) => {
            job = null;
            if (result) return resolve(result);
            if (log.length) console.log(`[sideload] ${log.join('').slice(-2000)}`);
            reject(new Error(failure || `The sideloading helper stopped (${code})`));
        });
    });
}

/** Answers Apple's 2FA question: { SubmitCode: "123456" }, "SendToDevices", { SendSms: id }, "ResendCode" or "Abort". */
function answerTwoFactor(response) {
    if (!job?.twoFactor) throw new Error('Nothing is waiting for a code.');
    job.twoFactor = null;
    job.step = 'Checking the code…';
    job.child.stdin.write(`${JSON.stringify({ twoFactor: response })}\n`);
}

function cancel() {
    queue.length = 0;
    if (job) job.child.kill();
}

/** Signs in to Apple once (2FA if Apple asks) and remembers the Apple ID and password. */
async function signIn(appleId, password) {
    appleId = String(appleId || '').trim();
    if (!appleId || !password) throw new Error('Enter your Apple ID email and password.');
    if (job) throw new Error('Wait for the current install to finish.');
    lastError = null;
    try {
        await runHelper('login', ['login', '--apple-id', appleId, '--remember'], { password });
    } catch (e) {
        lastError = { kind: 'login', udid: null, message: e.message, at: Date.now() };
        throw e;
    }
    writeJson(STATE_FILE, { ...load(), appleId });
    pump();
}

async function signOut() {
    const { appleId } = load();
    cancel();
    writeJson(STATE_FILE, { ...load(), appleId: null });
    if (appleId) await runHelper('forget', ['forget', '--apple-id', appleId]).catch(() => {});
}

/** Queues a phone for installing (or re-signing) the control app. */
function install(udid, { auto = false } = {}) {
    if (!load().appleId) throw new Error('Sign in with your Apple ID in Setup first.');
    if (job?.udid === udid || queue.some((q) => q.udid === udid)) return;
    queue.push({ udid, auto });
    pump();
}

async function pump() {
    if (job || !queue.length) return;
    const { udid, auto } = queue.shift();
    const { appleId } = load();
    try {
        const ipa = await setup.ensureWdaIpa();
        const done = await runHelper('install', ['install', '--apple-id', appleId, '--ipa', ipa, '--udid', udid], {
            udid,
        });
        controlApp.installed(udid, done.bundleId);
        writeJson(STATE_FILE, { ...load(), installs: { ...(load().installs || {}), [udid]: Date.now() } });
        autoTried.delete(udid);
        lastError = null;
        try {
            devices?.get(udid).log(auto ? 'Re-signed the control app' : 'Installed the control app');
            devices?.connect(udid).catch(() => {});
        } catch {}
    } catch (e) {
        if (auto) autoTried.set(udid, Date.now());
        lastError = { kind: 'install', udid, message: e.message, at: Date.now() };
        try {
            devices?.get(udid).log(`Installing the control app failed: ${e.message}`);
        } catch {}
    }
    pump();
}

/** Re-signs plugged-in phones before their 7 days run out, and ones that already expired. */
function checkExpiring() {
    if (!devices || !load().appleId || !helperPath()) return;
    for (const d of devices.list()) {
        if (!d.online) continue;
        const expiring = d.expiresAt && d.expiresAt - Date.now() < RESIGN_BEFORE_MS;
        const expired = d.status === 'action' && d.action?.kind === 'resign';
        if (!expiring && !expired) continue;
        if (Date.now() - (autoTried.get(d.udid) || 0) < RETRY_AFTER_MS) continue;
        install(d.udid, { auto: true });
    }
}

function start(deviceManager) {
    devices = deviceManager;
    setTimeout(checkExpiring, 60000);
    setInterval(checkExpiring, CHECK_EVERY_MS).unref();
}

module.exports = { status, signIn, signOut, install, answerTwoFactor, cancel, start };
