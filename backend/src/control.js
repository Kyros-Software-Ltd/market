// Every touch, key and app action goes through here, whoever sends it (you in the
// app, Claude through MCP, or an automation). It keeps one queue per phone, recovers
// a wedged WebDriverAgent, and records an activity feed so you can see who did what.
const { findElement } = require('./wda');

// Manual control goes through one queue per phone. WDA handles one touch at a time,
// so when the phone is slow (e.g. an app is loading) extra clicks would otherwise
// pile up and time out. Clicks beyond MAX_QUEUED are dropped instead.
const MAX_QUEUED = 3;

class Controller {
    constructor(devices) {
        this.devices = devices;
        this.queues = new Map(); // udid -> { tail: Promise, pending: number, timeouts: number }
        this.activity = []; // newest last
    }

    readyClient(udid) {
        const device = this.devices.get(udid);
        if (device.status !== 'ready' || !device.client) throw new Error(`${device.name} is not connected`);
        return device.client;
    }

    /** @deprecated use readyClient */
    readyWda(udid) {
        return this.readyClient(udid);
    }

    note(udid, actor, text) {
        const device = this.devices.devices.get(udid);
        const entry = { at: Date.now(), udid, phone: device ? device.name : udid, actor, text };
        this.activity.push(entry);
        if (this.activity.length > 300) this.activity.splice(0, this.activity.length - 300);
        if (device) device.lastActivity = entry;
    }

    // Runner main thread sometimes wedges. Restarting kills the live stream for seconds, so
    // only do it after many timeouts — and never for a single slow swipe on a busy app (X).
    noteTimeout(udid, device, q) {
        q.timeouts = (q.timeouts || 0) + 1;
        if (q.timeouts < 5 || device.status !== 'ready') return;
        q.timeouts = 0;
        device.log(
            device.engine === 'devicekit'
                ? 'Phone stopped responding to actions; restarting DeviceKit'
                : 'Phone stopped responding to actions; restarting legacy control app',
        );
        this.devices.connect(udid).catch(() => {});
    }

    enqueue(udid, label, fn, { drop = true, maxQueued = MAX_QUEUED } = {}) {
        const q = this.queues.get(udid) || { tail: Promise.resolve(), pending: 0 };
        this.queues.set(udid, q);
        const device = this.devices.get(udid);
        if (drop && q.pending >= maxQueued) {
            device.log(`Skipped ${label}: phone is still busy with earlier actions`);
            return Promise.resolve();
        }
        q.pending++;
        const run = q.tail.then(async () => {
            const started = Date.now();
            try {
                const result = await fn();
                q.timeouts = 0;
                return result;
            } catch (e) {
                const timedOut = /abort|timeout/i.test(e.name + e.message);
                const msg = timedOut
                    ? `${device.name} took too long to respond to ${label} (${Math.round((Date.now() - started) / 1000)}s)`
                    : `${label} failed on ${device.name}: ${e.message}`;
                device.log(msg);
                if (timedOut) this.noteTimeout(udid, device, q);
                throw new Error(msg);
            } finally {
                q.pending--;
            }
        });
        q.tail = run.catch(() => {});
        return run;
    }

    // Runs one action on one phone. Coordinates are fractions of the screen (0-1)
    // unless args.unit === 'pt', which Claude uses because it sees the screen in points.
    async act(udid, action, args = {}, actor = 'you') {
        const fn = ACTIONS[action];
        if (!fn) throw new Error(`Unknown action "${action}"`);
        // Manual clicks: keep at most one action queued. DeviceKit freezes MJPEG for the
        // whole gesture — a pile of scroll/tap RPCs means seconds of black/0 fps.
        const result = await this.enqueue(
            udid,
            action,
            () => {
                const w = this.readyClient(udid);
                return fn(w, args, pointMapper(w, args));
            },
            { drop: actor === 'you', maxQueued: actor === 'you' ? 1 : MAX_QUEUED },
        );
        this.note(udid, actor, describe(action, args, result));
        return result;
    }

    // The same action on several phones at once; throws one combined error if any failed.
    async actMany(udids, action, args, actor) {
        const results = await Promise.allSettled(udids.map((u) => this.act(u, action, args, actor)));
        const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
        if (failed.length) throw new Error(failed.join('; '));
        return results.map((r) => r.value);
    }

    async elements(udid) {
        return this.enqueue(udid, 'read screen', () => this.readyClient(udid).elements(), { drop: false });
    }
}

function pointMapper(w, args) {
    const { width, height } = w.size;
    return (x, y) => (args.unit === 'pt' ? [Number(x), Number(y)] : [Number(x) * width, Number(y) * height]);
}

const ACTIONS = {
    tap: (w, b, pt) => w.tap(...pt(b.x, b.y)),
    longpress: (w, b, pt) => w.longPress(...pt(b.x, b.y), b.ms || 800),
    swipe: (w, b, pt) => w.swipe(...pt(b.x1, b.y1), ...pt(b.x2, b.y2), b.ms || 300),
    drag: (w, b, pt) => w.drag(...pt(b.x1, b.y1), ...pt(b.x2, b.y2), b.hold || 600, b.ms || 400),
    doubletap: async (w, b, pt) => {
        const [x, y] = pt(b.x, b.y);
        await w.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 },
            { type: 'pause', duration: 90 },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 },
        ]);
    },
    // Taps the on-screen element whose label best matches `text`.
    tapText: async (w, b) => {
        const el = findElement(await w.elements(), b.text);
        if (!el) throw new Error(`Nothing labelled "${b.text}" is on screen`);
        await w.tap(el.x, el.y);
        return el;
    },
    type: async (w, b) => {
        const text = String(b.text || '');
        if (text) await w.type(text);
        if (b.submit) {
            if (typeof w.keys === 'function') await w.keys([{ key: 'return', modifiers: [] }]);
            else await w.type('\n');
        }
    },
    keys: (w, b) => {
        if (typeof w.keys !== 'function') throw new Error('This phone cannot send key presses');
        const keys = b.keys || (b.key ? [{ key: b.key, modifiers: b.modifiers || [] }] : []);
        return w.keys(keys);
    },
    home: (w) => w.home(),
    lock: (w) => w.lock(),
    unlock: (w) => w.unlock(),
    volumeUp: (w) => w.pressButton('volumeUp'),
    volumeDown: (w) => w.pressButton('volumeDown'),
    launch: (w, b) => w.launchApp(b.bundleId),
    openUrl: (w, b) => w.openUrl(String(b.url)),
    terminate: (w, b) => w.terminateApp(b.bundleId),
};

function describe(action, b, result) {
    const n = (v) => (b.unit === 'pt' ? Math.round(v) : `${Math.round(v * 100)}%`);
    switch (action) {
        case 'tap':
            return `tap ${n(b.x)}, ${n(b.y)}`;
        case 'doubletap':
            return `double-tap ${n(b.x)}, ${n(b.y)}`;
        case 'longpress':
            return `long-press ${n(b.x)}, ${n(b.y)}`;
        case 'drag':
            return `hold and drag ${n(b.x1)}, ${n(b.y1)} to ${n(b.x2)}, ${n(b.y2)}`;
        case 'swipe':
            return `swipe ${b.y2 < b.y1 ? 'up' : b.y2 > b.y1 ? 'down' : b.x2 < b.x1 ? 'left' : 'right'}`;
        case 'tapText':
            return `tap "${result?.label || b.text}"`;
        case 'type':
            return `type "${String(b.text || '').slice(0, 40)}${b.submit ? '⏎' : ''}"`;
        case 'keys':
            return `key ${(b.keys || [{ key: b.key }]).map((k) => k.key || k).join('+')}`;
        case 'launch':
            return `open ${b.bundleId}`;
        case 'openUrl':
            return `open link ${String(b.url).slice(0, 40)}`;
        case 'terminate':
            return `close ${b.bundleId}`;
        default:
            return action;
    }
}

module.exports = { Controller, ACTIONS };
