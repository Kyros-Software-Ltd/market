// Minimal WebDriverAgent HTTP client. WDA runs on the iPhone and exposes a
// W3C WebDriver API (port 8100) plus an MJPEG screen stream (port 9100).

// Applied to every session before anything else touches the phone. Before most
// commands WDA asks iOS which app is in front and reads its UI tree. Apps that keep
// their main thread busy (TikTok, Reels) never answer, so by default WDA waits
// forever and every command queues behind it. Measured on an iPhone XS in TikTok:
// stuck for 30s+ without these, ~0.6s per tap with them.
const RESPONSIVE_SETTINGS = {
    accessibilityDeadline: 1, // give up on an unresponsive app after 1s instead of waiting forever
    // Reading TikTok's whole UI tree takes 13s+ and blocks taps meanwhile; keep reads
    // shallow (tabs and top-level buttons still show; video side buttons need coordinates).
    snapshotMaxDepth: 15,
    snapshotMaxChildren: 30,
    waitForIdleTimeout: 0,
    animationCoolOffTimeout: 0,
};

class WDAClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.sessionId = null;
        this.size = null; // logical screen size in points, e.g. { width: 390, height: 844 }
    }

    async request(method, path, body, { timeout = 15000 } = {}) {
        const res = await fetch(this.baseUrl + path, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeout),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.value?.error) {
            const msg = (json.value && (json.value.message || json.value.error)) || `HTTP ${res.status}`;
            const err = new Error(msg);
            err.invalidSession = /invalid session|session.*does not exist/i.test(msg);
            throw err;
        }
        return json;
    }

    async status() {
        return (await this.request('GET', '/status', null, { timeout: 3000 })).value;
    }

    async createSession() {
        const json = await this.request(
            'POST',
            '/session',
            {
                capabilities: {
                    alwaysMatch: {
                        // XCTest normally waits for the app on screen to go idle after every action.
                        // Apps that never idle (TikTok, Reels: video always playing) then make each tap
                        // hang until it times out, so switch that waiting off for the whole session.
                        shouldWaitForQuiescence: false,
                        waitForIdleTimeout: 0,
                        disableAutomaticScreenshots: true,
                        shouldUseCompactResponses: true,
                    },
                },
            },
            { timeout: 60000 },
        );
        this.sessionId = json.sessionId || json.value?.sessionId;
        // A new session starts with default settings; ours must go in before any other call.
        await this.applySettings().catch(() => {});
        if (!this.size) this.size = await this.screenSize();
        return this.sessionId;
    }

    /** Changes some settings until the next applySettings(), which puts ours back. */
    async setSettings(partial) {
        if (!this.sessionId) await this.createSession();
        return this.request('POST', `/session/${this.sessionId}/appium/settings`, { settings: partial });
    }

    applySettings() {
        return this.request('POST', `/session/${this.sessionId}/appium/settings`, {
            settings: { ...RESPONSIVE_SETTINGS, ...this.settings },
        });
    }

    // /wda/screen answers without touching the foreground app; window/size snapshots
    // the active app and can hang for 15s+ while something like TikTok is busy.
    async screenSize() {
        try {
            const screen = (await this.request('GET', '/wda/screen', null, { timeout: 10000 })).value;
            if (screen?.screenSize) return screen.screenSize;
        } catch {}
        return (await this.request('GET', `/session/${this.sessionId}/window/size`, null, { timeout: 30000 })).value;
    }

    // Runs a session-scoped call, re-creating the session once if WDA dropped it.
    async session(method, path, body, opts) {
        if (!this.sessionId) await this.createSession();
        try {
            return await this.request(method, `/session/${this.sessionId}${path}`, body, opts);
        } catch (e) {
            if (!e.invalidSession) throw e;
            await this.createSession();
            return this.request(method, `/session/${this.sessionId}${path}`, body, opts);
        }
    }

    async configureStream({ framerate, scalingFactor, quality }) {
        this.settings = {
            mjpegServerFramerate: framerate,
            mjpegScalingFactor: scalingFactor,
            mjpegServerScreenshotQuality: quality,
            // Don't wait for the app to go idle / animations to settle before each
            // action: measured ~100ms faster taps, which matters for remote control.
            waitForIdleTimeout: 0,
            animationCoolOffTimeout: 0,
        };
        if (!this.sessionId) await this.createSession();
        await this.applySettings();
    }

    touch(actions) {
        return this.session('POST', '/actions', {
            actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
        });
    }

    tap(x, y) {
        return this.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 60 },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    longPress(x, y, ms = 800) {
        return this.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: ms },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    // Press and hold, then move while still holding (moving an app icon, dragging a list item).
    drag(x1, y1, x2, y2, holdMs = 600, durationMs = 400) {
        return this.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: holdMs },
            { type: 'pointerMove', duration: Math.round(durationMs), x: Math.round(x2), y: Math.round(y2) },
            { type: 'pause', duration: 150 },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    swipe(x1, y1, x2, y2, durationMs = 300) {
        return this.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 30 },
            { type: 'pointerMove', duration: Math.round(durationMs), x: Math.round(x2), y: Math.round(y2) },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    type(text) {
        return this.session('POST', '/wda/keys', { value: [...text] });
    }

    home() {
        return this.request('POST', '/wda/homescreen');
    }

    lock() {
        return this.request('POST', '/wda/lock');
    }

    unlock() {
        return this.request('POST', '/wda/unlock');
    }

    launchApp(bundleId) {
        return this.session('POST', '/wda/apps/launch', { bundleId }, { timeout: 60000 });
    }

    terminateApp(bundleId) {
        return this.session('POST', '/wda/apps/terminate', { bundleId });
    }

    async screenshot() {
        return (await this.request('GET', '/screenshot', null, { timeout: 20000 })).value; // base64 PNG
    }

    async source() {
        return (await this.session('GET', '/source', null, { timeout: 30000 })).value;
    }

    // Visible, labelled UI elements with their frames in points. This is what lets
    // automations and Claude "tap 'Like'" instead of guessing coordinates.
    async elements({ timeout = 12000 } = {}) {
        const tree = (await this.request('GET', '/source?format=json', null, { timeout })).value;
        const { width, height } = this.size || { width: 10000, height: 10000 };
        const out = [];
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            const r = node.rect || node.frame || {};
            const label = String(node.label || node.name || node.value || '').trim();
            const visible =
                node.isVisible === undefined ||
                node.isVisible === true ||
                node.isVisible === '1' ||
                node.isVisible === 1;
            const onScreen =
                r.width > 2 && r.height > 2 && r.x < width && r.y < height && r.x + r.width > 0 && r.y + r.height > 0;
            const type = String(node.type || '').replace(/^XCUIElementType/, '');
            // Plain containers ("Other") only count when they are accessible, e.g. custom buttons.
            const useful = !['Application', 'Window'].includes(type) && (type !== 'Other' || node.isAccessible);
            if (label && visible && onScreen && useful) {
                out.push({
                    type,
                    label: label.slice(0, 80),
                    x: Math.round(r.x + r.width / 2),
                    y: Math.round(r.y + r.height / 2),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                });
            }
            for (const child of node.children || []) walk(child);
        };
        walk(tree);
        // Drop duplicates that share a label and position (WDA often nests them).
        const seen = new Set();
        return out.filter((e) => {
            const key = `${e.label}|${Math.round(e.x / 4)}|${Math.round(e.y / 4)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    // Opens a URL or app link (e.g. shareddocuments://…) the way tapping a link would.
    openUrl(url) {
        return this.session('POST', '/url', { url }, { timeout: 30000 });
    }

    pressButton(name) {
        return this.request('POST', '/wda/pressButton', { name });
    }
}

// Picks the element that best matches some text: exact label first, then
// starts-with, then contains (all case-insensitive). Smaller elements win ties
// because a big container often repeats its children's text.
function findElement(elements, text) {
    const q = String(text).trim().toLowerCase();
    if (!q) return null;
    const by = (pred) => elements.filter((e) => pred(e.label.toLowerCase())).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    return by((l) => l === q) || by((l) => l.startsWith(q)) || by((l) => l.includes(q)) || null;
}

module.exports = { WDAClient, findElement };
