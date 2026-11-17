// Minimal WebDriverAgent HTTP client. WDA runs on the iPhone and exposes a
// W3C WebDriver API (port 8100) plus an MJPEG screen stream (port 9100).
const { humanPath, tapHoldMs, rand } = require('./touch-path');

// Applied to every session before anything else touches the phone. Before most
// commands WDA asks iOS which app is in front and reads its UI tree. Apps that keep
// their main thread busy (TikTok, Reels) never answer, so by default WDA waits
// forever and every command queues behind it. Measured on an iPhone XS in TikTok:
// stuck for 30s+ without these, ~0.6s per tap with them.
const RESPONSIVE_SETTINGS = {
    // Before every command WDA works out which app is in front by asking that app over
    // accessibility. TikTok and Instagram take ~12 s to answer, twice per tap, so taps took 24 s
    // and piled up until Market restarted the control app. Naming the home screen as the
    // active app skips that question; touches are sent to the screen, so they still land in
    // whatever app is open. Measured on an iPhone XR in TikTok: 24.5 s per tap before, 0.47 s
    // after. Reading the screen switches this back for the one call (see elements()).
    defaultActiveApplication: 'com.apple.springboard',
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
        // The app Market last opened. Reads name it as the app in front, which skips the
        // phone working out what's in front (seconds in TikTok). null = let the phone decide.
        this.frontApp = null;
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
            if (screen?.scale) this.scale = screen.scale; // pixels per point (2 or 3)
            if (screen?.screenSize) return screen.screenSize;
        } catch {}
        if (!this.sessionId) return null; // the fallback below needs a session
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
            { type: 'pause', duration: tapHoldMs() },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    // A few pointerMoves along a finger-like path (see touch-path.js for why so few).
    moves(x1, y1, x2, y2, durationMs, opts) {
        return humanPath(x1, y1, x2, y2, durationMs, opts).map((p) => ({
            type: 'pointerMove',
            duration: p.dt,
            x: Math.round(p.x),
            y: Math.round(p.y),
        }));
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
            ...this.moves(x1, y1, x2, y2, durationMs, { flick: false }),
            { type: 'pause', duration: Math.round(rand(120, 200)) },
            { type: 'pointerUp', button: 0 },
        ]);
    }

    swipe(x1, y1, x2, y2, durationMs = 300) {
        return this.touch([
            { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: Math.round(rand(20, 45)) },
            ...this.moves(x1, y1, x2, y2, durationMs),
            { type: 'pointerUp', button: 0 },
        ]);
    }

    type(text) {
        return this.session('POST', '/wda/keys', { value: [...text] });
    }

    /** Best-effort map of DeviceKit-style key combos onto WDA's /wda/keys. */
    keys(combos) {
        const named = {
            return: '\n',
            enter: '\n',
            backspace: '\b',
            delete: '\b',
            tab: '\t',
            space: ' ',
            escape: '\uE00C',
        };
        const value = [];
        for (const c of Array.isArray(combos) ? combos : []) {
            const key = String(c.key || c);
            const lower = key.toLowerCase();
            if (named[lower] !== undefined) value.push(named[lower]);
            else if (key.length === 1) value.push(key);
        }
        if (!value.length) return Promise.resolve();
        return this.session('POST', '/wda/keys', { value });
    }

    home() {
        this.frontApp = null;
        return this.request('POST', '/wda/homescreen');
    }

    lock() {
        return this.request('POST', '/wda/lock');
    }

    unlock() {
        return this.request('POST', '/wda/unlock');
    }

    /**
     * The on-screen element whose label is the text (or, failing that, starts with it), without
     * reading the whole screen: ~0.2 s in TikTok against 1-6 s for a full read. null if none.
     */
    async findText(text) {
        const q = String(text).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        if (!q) return null;
        const { width, height } = this.size || { width: 10000, height: 10000 };
        return this.inFrontApp(async () => {
            for (const predicate of [`label ==[c] "${q}"`, `label BEGINSWITH[c] "${q}"`]) {
                const found = (await this.session('POST', '/elements', { using: 'predicate string', value: predicate }))
                    .value;
                const hits = [];
                for (const el of (found || []).slice(0, 6)) {
                    const id = el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf'];
                    const r = (await this.session('GET', `/element/${id}/rect`)).value;
                    const onScreen =
                        r.width > 2 &&
                        r.height > 2 &&
                        r.x < width &&
                        r.y < height &&
                        r.x + r.width > 0 &&
                        r.y + r.height > 0;
                    if (onScreen)
                        hits.push({
                            label: String(text),
                            x: r.x + r.width / 2,
                            y: r.y + r.height / 2,
                            w: r.width,
                            h: r.height,
                        });
                }
                // Smallest first: a big container often repeats its children's text.
                if (hits.length) return hits.sort((a, b) => a.w * a.h - b.w * b.h)[0];
            }
            return null;
        });
    }

    launchApp(bundleId) {
        this.frontApp = bundleId;
        return this.session('POST', '/wda/apps/launch', { bundleId }, { timeout: 60000 });
    }

    terminateApp(bundleId) {
        if (this.frontApp === bundleId) this.frontApp = null;
        return this.session('POST', '/wda/apps/terminate', { bundleId });
    }

    async screenshot() {
        return (await this.request('GET', '/screenshot', null, { timeout: 20000 })).value; // base64 PNG
    }

    // Runs fn against the app that is really in front, instead of the home screen that
    // RESPONSIVE_SETTINGS names for speed. Slow in busy apps: the phone has to work out which
    // app is in front (about 12 s in TikTok) before it reads anything.
    async inFrontApp(fn) {
        await this.setSettings({ defaultActiveApplication: this.frontApp || 'auto' });
        try {
            return await fn();
        } finally {
            await this.applySettings().catch(() => {});
        }
    }

    async source() {
        return this.inFrontApp(async () => (await this.session('GET', '/source', null, { timeout: 60000 })).value);
    }

    // Visible, labelled UI elements with their frames in points. This is what lets
    // automations and Claude "tap 'Like'" instead of guessing coordinates.
    // Best effort: in TikTok and Reels reading the tree takes over a minute, so give up after
    // 20 s rather than hold every tap behind it. Touches by position still work there.
    async elements({ timeout = 20000 } = {}) {
        const tree = await this.inFrontApp(
            async () => (await this.request('GET', '/source?format=json', null, { timeout })).value,
        );
        const { width, height } = this.size || { width: 10000, height: 10000 };
        const out = [];
        // Views drawn by another process (the share sheet) report their contents relative to
        // their own corner, not the screen's: on iOS 27 the share sheet's "Save Image" came back
        // at 48% down while it sits at 91%. Shift those children by the container's position.
        const walk = (node, ox = 0, oy = 0) => {
            if (!node || typeof node !== 'object') return;
            const raw = node.rect || node.frame || {};
            const r = { ...raw, x: (raw.x || 0) + ox, y: (raw.y || 0) + oy };
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
            const remote = /RemoteContainerView/.test(String(node.name || node.label || ''));
            for (const child of node.children || []) walk(child, remote ? r.x : ox, remote ? r.y : oy);
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

    // Market's own control app only (controlapp/FBMarketCommands.m). Older builds answer
    // "unhandled endpoint", which callers treat as "use the Files route instead".
    /** "authorized" | "limited" | "asking" (the phone is showing the prompt) | "denied" */
    async photosAccess() {
        return (await this.request('GET', '/market/photos/access', null, { timeout: 10000 })).value;
    }

    /** Saves Documents/Market/<name> into Photos, dated now, and removes the copy. */
    async saveToPhotos(name) {
        return (await this.request('POST', '/market/photos', { name, remove: true }, { timeout: 200000 })).value;
    }

    // Opens a URL or app link (e.g. shareddocuments://…) the way tapping a link would.
    openUrl(url) {
        return this.session('POST', '/url', { url }, { timeout: 30000 });
    }

    pressButton(name) {
        // Session-scoped: the control app has no session-less /wda/pressButton.
        return this.session('POST', '/wda/pressButton', { name });
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
