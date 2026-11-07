// Runs iOS 27+ phones through Apple's own developer services instead of WebDriverAgent: 60 fps
// video and touch with nothing installed on the phone. py/direct.py holds the connection and
// DirectClient has the same methods as WDAClient, so control.js and automations don't care
// which one a phone uses. Over Wi-Fi it needs a pairing made once on the cable (pairForWifi).
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const SCRIPT = path.join(__dirname, 'py', 'direct.py');
const HID_MAX = 65535; // touch coordinates run 0..65535 across the screen
const MOVE_STEP_MS = 16;

const SAFARI_ADDRESS_BAR = [0xe3, 0x0f]; // HID key codes: Left Cmd + L

const BUTTONS = { volumeUp: 'volume-up', volumeDown: 'volume-down', home: 'home', lock: 'lock' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, body, timeout = 20000) {
    const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new Error(data?.error || `Phone answered ${res.status}`);
    return data ?? text;
}

class DirectClient {
    constructor(streamPort, controlPort) {
        this.stream = `http://127.0.0.1:${streamPort}`;
        this.control = `http://127.0.0.1:${controlPort}`;
        this.streamPort = streamPort;
        this.size = null; // screen size in points, like WDAClient
    }

    async status() {
        return request(`${this.control}/info`);
    }

    /** True once the phone's video has started. */
    async streaming() {
        return request(`${this.stream}/codec`, undefined, 8000).then(
            () => true,
            () => false,
        );
    }

    point(x, y) {
        const { width, height } = this.size;
        const scale = (value, max) => Math.round(Math.min(1, Math.max(0, value / max)) * HID_MAX);
        return { x: scale(x, width), y: scale(y, height) };
    }

    sendTouch(type, x, y) {
        return request(`${this.stream}/touch`, { type, ...this.point(x, y) });
    }

    async move(x1, y1, x2, y2, durationMs) {
        const steps = Math.max(1, Math.round(durationMs / MOVE_STEP_MS));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            await this.sendTouch('contact', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
            await sleep(MOVE_STEP_MS);
        }
    }

    tap(x, y) {
        return this.sendTouch('tap', x, y);
    }

    async longPress(x, y, ms = 800) {
        await this.sendTouch('contact', x, y);
        await sleep(ms);
        await this.sendTouch('release', x, y);
    }

    async drag(x1, y1, x2, y2, holdMs = 600, durationMs = 400) {
        await this.sendTouch('contact', x1, y1);
        await sleep(holdMs);
        await this.move(x1, y1, x2, y2, durationMs);
        await this.sendTouch('release', x2, y2);
    }

    async swipe(x1, y1, x2, y2, durationMs = 300) {
        await this.sendTouch('contact', x1, y1);
        await this.move(x1, y1, x2, y2, durationMs);
        await this.sendTouch('release', x2, y2);
    }

    // The WebDriver pointer actions WDAClient takes, for callers that build their own gestures.
    async touch(actions) {
        let x = 0;
        let y = 0;
        for (const a of actions) {
            if (a.type === 'pointerMove') {
                x = a.x;
                y = a.y;
            } else if (a.type === 'pointerDown') await this.sendTouch('contact', x, y);
            else if (a.type === 'pointerUp') await this.sendTouch('release', x, y);
            else if (a.type === 'pause') await sleep(a.duration);
        }
    }

    type(text) {
        return request(`${this.control}/type`, { text }, 120000);
    }

    pressButton(name) {
        return request(`${this.stream}/button`, { name: BUTTONS[name] || name });
    }

    home() {
        return this.pressButton('home');
    }

    lock() {
        return this.pressButton('lock');
    }

    unlock() {
        return this.pressButton('home');
    }

    launchApp(bundleId) {
        return request(`${this.control}/launch`, { bundleId });
    }

    terminateApp(bundleId) {
        return request(`${this.control}/terminate`, { bundleId });
    }

    // No service opens a link, so do what a person would: Safari, Cmd+L, type it, Return.
    async openUrl(url) {
        await this.launchApp('com.apple.mobilesafari');
        await sleep(1200);
        await request(`${this.control}/shortcut`, { usages: SAFARI_ADDRESS_BAR });
        await sleep(500);
        await this.type(`${url}
`);
    }

    async screenshot() {
        return (await request(`${this.control}/screenshot`, {})).png;
    }

    async elements() {
        throw new Error(
            'Reading labels on screen needs the control app, which iOS 27 phones run without. Tap by position.',
        );
    }

    async applySettings() {}
}

/** Over the cable, once per phone: lets it connect over Wi-Fi from then on, with no prompt. */
function pairForWifi(python, udid, usbmux) {
    const record = path.join(os.homedir(), '.pymobiledevice3', `remote_${udid}.plist`);
    if (fs.existsSync(record)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        execFile(
            python,
            [SCRIPT, 'pair', udid],
            {
                cwd: DATA_DIR,
                timeout: 60000,
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', USBMUXD_SOCKET_ADDRESS: usbmux },
            },
            (err, _stdout, stderr) =>
                err ? reject(new Error(stderr.trim().split('\n').pop() || err.message)) : resolve(),
        );
    });
}

/** Starts py/direct.py for a phone. The caller stops it with kill(). */
function startDirect(python, { udid, streamPort, controlPort, usbmux, wifi, onLog }) {
    const args = ['-u', SCRIPT, udid, String(streamPort), String(controlPort)];
    if (wifi) args.push('wifi');
    const child = spawn(python, args, {
        cwd: DATA_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', USBMUXD_SOCKET_ADDRESS: usbmux },
    });
    const forward = (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) onLog(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (e) => onLog(`process error: ${e.message}`));
    return child;
}

module.exports = { DirectClient, pairForWifi, startDirect };
