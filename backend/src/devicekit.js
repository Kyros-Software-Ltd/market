// DeviceKit (mobile-next): one JSON-RPC control app for every iOS version.
// Same surface as WDAClient so control.js and automations stay engine-agnostic.
// Live view: MJPEG at GET /mjpeg on the same port as RPC (default 12004).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DeviceKitClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.size = null;
        this._id = 1;
    }

    async rpc(method, params = {}, { timeout = 20000 } = {}) {
        const res = await fetch(`${this.baseUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method, params, id: this._id++ }),
            signal: AbortSignal.timeout(timeout),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.error) {
            const msg = json.error?.message || json.error || `HTTP ${res.status}`;
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return json.result;
    }

    async status() {
        return this.rpc('device.info', {}, { timeout: 5000 });
    }

    async health() {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    }

    async createSession() {
        const info = await this.status();
        const screen = info?.screenSize || info?.screen || info;
        const width = Number(screen?.width || info?.width);
        const height = Number(screen?.height || info?.height);
        if (!width || !height) throw new Error('DeviceKit did not report a screen size');
        this.size = { width, height };
        return true;
    }

    async applySettings() {}
    async setSettings() {}
    async configureStream() {}

    // Touch RPCs share DeviceKit's XCTest process with MJPEG — each gesture pauses the
    // live stream. Keep timeouts tight so a stuck tap cannot freeze the viewer for 20s.
    tap(x, y) {
        return this.rpc('device.io.tap', { x: Math.round(x), y: Math.round(y) }, { timeout: 8000 });
    }

    longPress(x, y, ms = 500) {
        return this.rpc(
            'device.io.longpress',
            {
                x: Math.round(x),
                y: Math.round(y),
                duration: Math.max(0.05, Math.min(2, ms / 1000)),
            },
            { timeout: 8000 },
        );
    }

    swipe(x1, y1, x2, y2, durationMs = 150) {
        // DeviceKit default is ~0.1s; long mouse-drag durations block MJPEG the whole time.
        const ms = Math.max(50, Math.min(280, durationMs));
        return this.rpc(
            'device.io.swipe',
            {
                x1: Math.round(x1),
                y1: Math.round(y1),
                x2: Math.round(x2),
                y2: Math.round(y2),
                duration: ms / 1000,
            },
            { timeout: 8000 },
        );
    }

    drag(x1, y1, x2, y2, holdMs = 400, durationMs = 200) {
        const hold = Math.max(0.05, Math.min(1, holdMs / 1000));
        const move = Math.max(0.05, Math.min(0.4, durationMs / 1000));
        // DeviceKit has no separate drag; hold then swipe while "held" via longpress+swipe sequence.
        return this.rpc(
            'device.io.gesture',
            {
                actions: [
                    { type: 'pointerMove', x: Math.round(x1), y: Math.round(y1) },
                    { type: 'pointerDown' },
                    { type: 'pause', duration: hold },
                    { type: 'pointerMove', x: Math.round(x2), y: Math.round(y2), duration: move },
                    { type: 'pointerUp' },
                ],
            },
            { timeout: 10000 },
        ).catch(() => this.swipe(x1, y1, x2, y2, durationMs));
    }

    async touch(actions) {
        // Map WebDriver-style pointer actions into a DeviceKit gesture when possible.
        const mapped = [];
        for (const a of actions) {
            if (a.type === 'pointerMove')
                mapped.push({
                    type: 'pointerMove',
                    x: Math.round(a.x),
                    y: Math.round(a.y),
                    ...(a.duration ? { duration: a.duration / 1000 } : {}),
                });
            else if (a.type === 'pointerDown') mapped.push({ type: 'pointerDown' });
            else if (a.type === 'pointerUp') mapped.push({ type: 'pointerUp' });
            else if (a.type === 'pause') mapped.push({ type: 'pause', duration: (a.duration || 0) / 1000 });
        }
        try {
            return await this.rpc('device.io.gesture', { actions: mapped });
        } catch {
            // Fallback: treat as tap at last move
            const move = [...actions].reverse().find((a) => a.type === 'pointerMove');
            if (move) return this.tap(move.x, move.y);
            throw new Error('Gesture failed');
        }
    }

    type(text) {
        return this.rpc('device.io.text', { text: String(text) }, { timeout: 120000 });
    }

    /** @param {{ key: string, modifiers?: string[] }[]} combos */
    keys(combos) {
        const keys = (Array.isArray(combos) ? combos : []).map((c) => ({
            key: String(c.key || c),
            modifiers: Array.isArray(c.modifiers) ? c.modifiers.map(String) : [],
        }));
        return this.rpc('device.io.keys', { keys }, { timeout: 30000 });
    }

    home() {
        return this.rpc('device.io.button', { button: 'home' });
    }

    lock() {
        return this.rpc('device.io.button', { button: 'lock' });
    }

    unlock() {
        return this.home();
    }

    pressButton(name) {
        // DeviceKit wants { button: "home"|"lock"|"volumeUp"|"volumeDown" }, not WDA's "name".
        const map = { volumeUp: 'volumeUp', volumeDown: 'volumeDown', home: 'home', lock: 'lock' };
        return this.rpc('device.io.button', { button: map[name] || name });
    }

    launchApp(bundleId) {
        return this.rpc('device.apps.launch', { bundleId }, { timeout: 60000 });
    }

    terminateApp(bundleId) {
        return this.rpc('device.apps.terminate', { bundleId });
    }

    openUrl(url) {
        return this.rpc('device.url', { url: String(url) }, { timeout: 30000 });
    }

    async screenshot() {
        const r = await this.rpc('device.screenshot', { format: 'png' }, { timeout: 20000 });
        return r?.data || r?.png || r;
    }

    async source() {
        return this.rpc('device.dump.ui', {}, { timeout: 30000 });
    }

    async elements({ timeout = 12000 } = {}) {
        const tree = await this.rpc('device.dump.ui', {}, { timeout });
        const { width, height } = this.size || { width: 10000, height: 10000 };
        const out = [];
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            const r = node.rect || node.frame || node.bounds || {};
            const label = String(node.label || node.name || node.value || node.text || '').trim();
            const x = Number(r.x ?? r.minX ?? 0);
            const y = Number(r.y ?? r.minY ?? 0);
            const w = Number(r.width ?? (r.maxX != null ? r.maxX - x : 0));
            const h = Number(r.height ?? (r.maxY != null ? r.maxY - y : 0));
            const visible = node.isVisible !== false && node.visible !== false;
            const onScreen = w > 2 && h > 2 && x < width && y < height && x + w > 0 && y + h > 0;
            const type = String(node.type || node.role || '').replace(/^XCUIElementType/, '');
            if (label && visible && onScreen && !['Application', 'Window'].includes(type)) {
                out.push({
                    type,
                    label: label.slice(0, 80),
                    x: Math.round(x + w / 2),
                    y: Math.round(y + h / 2),
                    w: Math.round(w),
                    h: Math.round(h),
                });
            }
            for (const child of node.children || node.nodes || []) walk(child);
        };
        walk(tree?.root || tree?.hierarchy || tree);
        const seen = new Set();
        return out.filter((e) => {
            const key = `${e.label}|${Math.round(e.x / 4)}|${Math.round(e.y / 4)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
}

/** Query string for the MJPEG endpoint (same host:port as RPC). */
function mjpegPath({ framerate = 60, quality = 38, scale = 48 } = {}) {
    return `/mjpeg?fps=${framerate}&quality=${quality}&scale=${scale}`;
}

module.exports = { DeviceKitClient, mjpegPath, sleep };
