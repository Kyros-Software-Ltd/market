// Thin wrapper around the go-ios CLI (https://github.com/danielpaulus/go-ios), which talks
// to iPhones through usbmux: Market's proxy (usbmux-proxy.js) in front of Apple's service,
// set via USBMUXD_SOCKET_ADDRESS when the server starts.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

function findBinary() {
    if (process.env.GOIOS_PATH) return process.env.GOIOS_PATH;
    const pkgDir = path.dirname(require.resolve('go-ios/package.json'));
    const distDir = path.join(pkgDir, 'dist');
    const exe = process.platform === 'win32' ? 'ios.exe' : 'ios';
    for (const dir of fs.readdirSync(distDir)) {
        if (!dir.includes(process.platform === 'win32' ? 'windows' : process.platform)) continue;
        const candidate = path.join(distDir, dir, exe);
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('go-ios binary not found. Reinstall Market.');
}

const BIN = findBinary();

// go-ios writes its tunnel identity and downloaded developer images into the current
// folder, so run it in the data folder rather than wherever the app was started from.
fs.mkdirSync(DATA_DIR, { recursive: true });
const OPTS = { cwd: DATA_DIR, windowsHide: true };

// go-ios prints its result as JSON on stdout and logs as JSON lines on stderr.
function parseJsonOutput(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        // Some commands print one JSON object per line; return the last parseable one.
        const lines = trimmed.split(/\r?\n/).reverse();
        for (const line of lines) {
            try {
                return JSON.parse(line);
            } catch {}
        }
        return trimmed;
    }
}

function lastErrorMessage(stderr) {
    const lines = stderr.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
        try {
            const obj = JSON.parse(line);
            if (obj.level === 'ERROR' || obj.level === 'FATAL') return obj.err ? `${obj.msg}: ${obj.err}` : obj.msg;
        } catch {}
    }
    return lines[0] || 'unknown go-ios error';
}

/** Run a short go-ios command and resolve with its parsed JSON output. */
// usbmux: set to talk to a specific usbmux service (e.g. Apple's own, bypassing Market's proxy).
function run(args, { udid, timeout = 30000, usbmux } = {}) {
    const fullArgs = udid ? [...args, `--udid=${udid}`] : args;
    const env = usbmux ? { ...process.env, USBMUXD_SOCKET_ADDRESS: usbmux } : process.env;
    return new Promise((resolve, reject) => {
        execFile(BIN, fullArgs, { ...OPTS, env, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = parseJsonOutput(stdout);
            if (err && out == null) return reject(new Error(lastErrorMessage(stderr || err.message)));
            resolve(out);
        });
    });
}

/** Start a long-running go-ios process (forward, runwda, tunnel). */
function spawnLong(args, { udid, onLog } = {}) {
    const fullArgs = udid ? [...args, `--udid=${udid}`] : args;
    const child = spawn(BIN, fullArgs, OPTS);
    const forward = (buf) => {
        if (!onLog) return;
        for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLog(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (e) => onLog?.(`process error: ${e.message}`));
    return child;
}

module.exports = { BIN, run, spawnLong };
