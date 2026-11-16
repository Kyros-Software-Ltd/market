// Finds plugged-in iPhones and keeps the list of them. Connecting is not done here:
// every phone gets one supervisor (phone.js) running one worker (py/phone_worker.py), which
// takes the same path for every iOS version and ends with
// WebDriverAgent on two local ports (control, and MJPEG live view on its own port so taps
// do not freeze the picture).
const path = require('node:path');
const goios = require('./goios');
const { WDAClient } = require('./wda');
const { PhoneSupervisor, startSpare, stopSpare } = require('./phone');
const { DATA_DIR, readJson, writeJson } = require('./paths');
const setup = require('./setup');
const controlApp = require('./controlapp');

const NICKNAMES_FILE = path.join(DATA_DIR, 'nicknames.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known-phones.json'); // udid -> { name, model, iosVersion }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The things a person may have to do on the phone, by the kind the worker reports.
const ACTIONS = {
    trust: (d) => ({
        kind: 'trust',
        title: 'Trust this PC',
        text: `Unlock ${d.name}, tap Trust This Computer, and enter the passcode.`,
    }),
    install: (d) => ({
        kind: 'install',
        title: 'Install Market',
        text: `Install Market on ${d.name} with your Apple ID (sign in once in Setup).`,
    }),
    resign: (d) => ({
        kind: 'resign',
        title: 'Renew Market',
        text: `Market on ${d.name} expired (free Apple IDs last 7 days). Install again to renew.`,
    }),
    devmode: (d) => ({
        kind: 'devmode',
        title: 'Turn on Developer Mode',
        text: `On ${d.name}: Settings → Privacy & Security → Developer Mode → On → Restart, then unlock and confirm.`,
    }),
    'trust-developer': (d) => ({
        kind: 'trust-developer',
        title: 'Trust the Market app',
        text: `On ${d.name}: Settings → General → VPN & Device Management → your Apple ID → Trust.`,
    }),
    unlock: (d) => ({ kind: 'unlock', title: 'Unlock the phone', text: `Unlock ${d.name} so setup can continue.` }),
};

class Device {
    constructor(udid, slot) {
        this.udid = udid;
        this.slot = slot; // stable index used to pick local ports
        this.name = udid.slice(0, 8);
        this.model = '';
        this.iosVersion = '';
        this.online = true;
        this.status = 'idle'; // idle | starting | action | ready | error | offline | stopped
        this.step = '';
        this.action = null; // { kind, title, text } while status === 'action'
        this.error = '';
        this.client = null; // WDAClient while ready
        this.engine = null; // 'wda' while ready
        this.wdaBundleId = null; // the control app's bundle id on this phone
        this.mjpegHost = null;
        this.mjpegPort = null;
        this.mjpegPath = null;
        this.supervisor = null;
        this.logs = [];
        this.lastActivity = null; // { at, actor, text } of the latest action, shown on the card
        this.apps = null; // cached installed apps
        this.connection = null; // 'usb' while plugged in
    }

    log(line) {
        this.logs.push(`${new Date().toLocaleTimeString()} ${line}`);
        if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    }

    get iosMajor() {
        return parseInt(this.iosVersion, 10) || 0;
    }

    toJSON() {
        const { expiresAt, resignSoon } = controlApp.info(this.udid);
        return {
            udid: this.udid,
            name: this.name,
            model: this.model,
            iosVersion: this.iosVersion,
            online: this.online,
            status: this.status,
            step: this.step,
            action: this.status === 'action' ? this.action : null,
            error: this.error,
            mjpegPort: this.mjpegPort,
            engine: this.engine,
            connection: this.connection,
            size: this.client?.size,
            lastActivity: this.lastActivity,
            expiresAt,
            resignSoon,
        };
    }
}

class DeviceManager {
    constructor(config) {
        this.config = config;
        this.devices = new Map();
        this.nicknames = readJson(NICKNAMES_FILE, {});
        this.known = readJson(KNOWN_FILE, {});
        this.nextSlot = 0;
        this.lastListError = '';
    }

    // Phones seen before stay in the list while away, so an unplugged one shows as offline
    // instead of vanishing.
    loadKnown() {
        for (const [udid, info] of Object.entries(this.known)) {
            if (this.devices.has(udid)) continue;
            const device = this.add(udid);
            device.online = false;
            device.status = 'offline';
            device.model = info.model || '';
            device.iosVersion = info.iosVersion || '';
            device.name = this.nicknames[udid] || info.name || device.name;
        }
    }

    add(udid) {
        const device = new Device(udid, this.nextSlot++);
        device.supervisor = new PhoneSupervisor(device, {
            spawnOptions: () => this.spawnOptions(device),
            onAction: (kind) => this.onAction(device, kind),
            onReady: (msg) => this.openWda(device, msg),
            onLive: (client, msg) => this.onLive(device, client, msg),
            onDown: () => this.onDown(device),
        });
        this.devices.set(udid, device);
        return device;
    }

    remember(device) {
        const old = this.known[device.udid] || {};
        if (old.name === device.name && old.model === device.model && old.iosVersion === device.iosVersion) return;
        this.known[device.udid] = { name: device.name, model: device.model, iosVersion: device.iosVersion };
        writeJson(KNOWN_FILE, this.known);
    }

    /** Removes a phone that is away from the list (it comes back by itself if it connects again). */
    forget(udid) {
        const device = this.get(udid);
        if (device.online) throw new Error('Unplug it or switch it off first');
        device.supervisor.stop();
        this.devices.delete(udid);
        delete this.known[udid];
        writeJson(KNOWN_FILE, this.known);
    }

    start() {
        this.loadKnown();
        // Every phone needs the helper, so get it (and one waiting worker) ready now.
        setup
            .ensureHelper()
            .then(startSpare)
            .catch(() => {});
        const tick = async () => {
            await this.refresh().catch(() => {});
            this.timer = setTimeout(tick, 1500);
        };
        tick();
    }

    list() {
        return [...this.devices.values()].map((d) => d.toJSON());
    }

    get(udid) {
        const d = this.devices.get(udid);
        if (!d) throw Object.assign(new Error('Unknown device'), { status: 404 });
        return d;
    }

    readyDevices() {
        return [...this.devices.values()].filter((d) => d.status === 'ready');
    }

    // Which phones are plugged in. Starting and restarting them is the job of each supervisor;
    // this only tells it when a phone arrives or leaves.
    async refresh() {
        let result;
        try {
            result = await goios.run(['list', '--details'], { timeout: 10000 });
            this.lastListError = '';
        } catch (e) {
            this.lastListError = e.message;
            return;
        }
        const seen = new Set();

        for (const entry of result?.deviceList || []) {
            const udid = typeof entry === 'string' ? entry : entry.Udid;
            if (!udid) continue;
            // The usbmux service also lists phones it sees on the network. Market is cable only.
            if (typeof entry === 'object' && entry.ConnectionType && entry.ConnectionType !== 'USB') continue;
            seen.add(udid);
            let device = this.devices.get(udid);
            if (!device) {
                device = this.add(udid);
                device.log('Phone connected');
            }
            if (typeof entry === 'object') {
                device.model = entry.ProductType || device.model;
                device.iosVersion = entry.ProductVersion || device.iosVersion;
                device.name = this.nicknames[udid] || entry.DeviceName || device.name;
            }
            device.connection = 'usb';
            this.remember(device);

            if (!device.online) {
                device.online = true;
                device.status = 'idle';
                device.log('Phone plugged in');
            }
            if (this.config.autoConnect && device.status !== 'stopped') device.supervisor.ensure();
        }

        for (const device of this.devices.values()) {
            if (seen.has(device.udid) || !device.online) continue;
            device.log('Phone unplugged');
            device.online = false;
            device.connection = null;
            device.supervisor.stop();
            device.status = 'offline';
            device.step = '';
            device.action = null;
        }
    }

    rename(udid, name) {
        const device = this.get(udid);
        device.name = name;
        this.nicknames[udid] = name;
        writeJson(NICKNAMES_FILE, this.nicknames);
        this.remember(device);
    }

    /** Starts the phone over. Resolves when it is ready; rejects if it needs the person or fails. */
    connect(udid) {
        const device = this.get(udid);
        if (!device.online) throw new Error('Phone is not connected');
        return device.supervisor.connect();
    }

    disconnect(udid) {
        const device = this.get(udid);
        device.supervisor.stop();
        // 'stopped' (not 'idle') so auto-connect leaves a phone the user turned off alone.
        device.status = device.online ? 'stopped' : 'offline';
        device.step = '';
        device.action = null;
        device.log('Disconnected');
    }

    // ---------- what the supervisor asks for ----------

    // The ports WDA listens on inside the phone. Its defaults (8100, 9100) are what an app on
    // the phone checks to spot it, so each start picks two random high ones instead.
    wdaDevicePorts() {
        const wdaCfg = this.config.wda;
        if (wdaCfg.randomDevicePorts === false) return { wda: wdaCfg.devicePort, mjpeg: wdaCfg.mjpegDevicePort };
        const wda = 20000 + Math.floor(Math.random() * 40000);
        // WDA walks upward from its port when it is taken, so keep the stream well clear of it.
        const mjpeg = 20000 + ((wda - 20000 + 1000 + Math.floor(Math.random() * 38000)) % 40000);
        return { wda, mjpeg };
    }

    spawnOptions(device) {
        const { wda: wdaCfg, localPorts } = this.config;
        const udid = device.udid;
        return {
            ports: { wda: localPorts.wdaBase + device.slot, mjpeg: localPorts.mjpegBase + device.slot },
            devicePorts: this.wdaDevicePorts(),
            env: {
                MARKET_WDA_BUNDLE: wdaCfg.bundleId,
                MARKET_IOS_VERSION: device.iosVersion || '',
            },
        };
    }

    onAction(device, kind) {
        const make = ACTIONS[kind] || ACTIONS.unlock;
        device.status = 'action';
        device.step = '';
        device.error = '';
        device.action = make(device);
        device.log(`Waiting for you: ${device.action.title}`);
        if (kind === 'resign') controlApp.expired(device.udid);
        if (kind === 'install') device.wdaBundleId = null;
    }

    // The worker has WebDriverAgent listening. Open a session and set the live view up.
    // Throws if WDA does not answer, which makes the supervisor start the phone over.
    async openWda(device, { wdaPort }) {
        const wdaCfg = this.config.wda;
        const client = new WDAClient(`http://127.0.0.1:${wdaPort}`);
        device.step = 'Waiting for the control app';
        for (const deadline = Date.now() + 30000; ; ) {
            try {
                await client.status();
                break;
            } catch (e) {
                if (Date.now() > deadline) throw new Error('The control app did not answer. Keep the phone unlocked.');
                await sleep(150);
            }
        }

        // The screen size is needed to pick the live view scale, and asking for it needs no
        // session. Knowing it first means the session is opened once with its final settings.
        device.step = 'Opening session';
        client.size = await client.screenSize().catch(() => null);

        // WDA shrinks every frame on the phone, one at a time. On big screens (1290x2796) that
        // takes longer than taking the screenshot, so frames pile up and arrive as duplicate pairs
        // with ~150 ms gaps. Measured on an iPhone 15 Plus: 55% gave 7 new frames/s, 40% gave 15
        // at half the bandwidth. So aim for a fixed output width instead of a fixed percentage.
        let scalingFactor = wdaCfg.mjpegScalingFactor;
        const pixelWidth = (client.size?.width || 0) * (client.scale || 0);
        if (pixelWidth && wdaCfg.mjpegTargetWidth) {
            const fit = Math.round((wdaCfg.mjpegTargetWidth / pixelWidth) * 100);
            scalingFactor = Math.max(20, Math.min(scalingFactor, fit));
        }
        device.log(`Live view scale ${scalingFactor}%`);
        client.settings = {
            mjpegServerFramerate: wdaCfg.mjpegFramerate,
            mjpegScalingFactor: scalingFactor,
            mjpegServerScreenshotQuality: wdaCfg.mjpegQuality,
        };
        await client.createSession(); // applies the settings above
        return client;
    }

    onLive(device, client, { mjpegPort, bundleId, iosVersion }) {
        const udid = device.udid;
        if (iosVersion) device.iosVersion = iosVersion;
        device.wdaBundleId = bundleId;
        controlApp.started(udid, bundleId);
        device.client = client;
        device.engine = 'wda';
        device.mjpegHost = '127.0.0.1';
        device.mjpegPort = mjpegPort;
        device.mjpegPath = '/';
        device.status = 'ready';
        device.step = '';
        device.error = '';
        device.action = null;
        const size = client.size || { width: '?', height: '?' };
        device.log(`Ready (iOS ${device.iosVersion}, screen ${size.width}x${size.height} pt)`);
        this.remember(device);
    }

    onDown(device) {
        device.client = null;
        device.engine = null;
        device.mjpegHost = null;
        device.mjpegPort = null;
        device.mjpegPath = null;
    }

    // Apps you installed (not Apple's built-ins), as { bundleId, name }.
    async listApps(udid, { refresh = false } = {}) {
        const device = this.get(udid);
        if (device.apps && !refresh) return device.apps;
        const apps = await goios.run(['apps'], { udid, timeout: 30000 });
        device.apps = (Array.isArray(apps) ? apps : [])
            .map((a) =>
                typeof a === 'string'
                    ? { bundleId: a, name: a }
                    : {
                          bundleId: a.CFBundleIdentifier,
                          name: a.CFBundleDisplayName || a.CFBundleName || a.CFBundleIdentifier,
                      },
            )
            .filter((a) => a.bundleId && !/webdriveragent/i.test(a.bundleId))
            .sort((a, b) => a.name.localeCompare(b.name));
        return device.apps;
    }

    shutdown() {
        clearTimeout(this.timer);
        for (const d of this.devices.values()) d.supervisor.stop();
        stopSpare();
    }
}

module.exports = { DeviceManager };
