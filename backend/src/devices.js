// Finds iPhones on USB or Wi-Fi and gets each one to "ready" with no manual steps on the PC.
// DeviceKit handles taps/swipes (JSON-RPC). Live view prefers go-ios screenshot --stream so
// PC actions do not freeze the picture (DeviceKit's own /mjpeg shares the XCTest process with
// gestures). USB / older Wi-Fi use a per-phone go-ios tunnel; iOS 27 Wi-Fi uses pymobiledevice3
// to start DeviceKit. No CoreDevice screen stream — avoids app blackouts.
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const goios = require('./goios');
const { DeviceKitClient, mjpegPath } = require('./devicekit');
const { pairForWifi, startDeviceKitRunner } = require('./devicekit-runner');
const { WDAClient } = require('./wda');
const { DATA_DIR, readJson, writeJson } = require('./paths');
const setup = require('./setup');
const controlApp = require('./controlapp');

const NICKNAMES_FILE = path.join(DATA_DIR, 'nicknames.json');
const KNOWN_FILE = path.join(DATA_DIR, 'known-phones.json'); // udid -> { name, model, iosVersion }
const ACTION_RETRY_MS = 8000;
const ERROR_RETRY_MS = 15000;
const ERROR_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A step that can't continue until the person does something on the phone.
class NeedsAction extends Error {
    constructor(kind, title, text) {
        super(title);
        this.action = { kind, title, text };
    }
}

const ACTIONS = {
    trustWifi: (d) =>
        new NeedsAction(
            'trust',
            'Trust this PC',
            `${d.name} needs one cable session first. Unlock it, tap Trust This Computer, then you can use Wi‑Fi.`,
        ),
    trust: (d) =>
        new NeedsAction(
            'trust',
            'Trust this PC',
            `Unlock ${d.name}, tap Trust This Computer, and enter the passcode.`,
        ),
    install: (d) =>
        new NeedsAction(
            'install',
            'Install Market',
            `Install Market on ${d.name} with your Apple ID (sign in once in Setup).`,
        ),
    resign: (d) =>
        new NeedsAction(
            'resign',
            'Renew Market',
            `Market on ${d.name} expired (free Apple IDs last 7 days). Install again to renew.`,
        ),
    devmode: (d) =>
        new NeedsAction(
            'devmode',
            'Turn on Developer Mode',
            `On ${d.name}: Settings → Privacy & Security → Developer Mode → On → Restart, then unlock and confirm.`,
        ),
    trustDeveloper: (d) =>
        new NeedsAction(
            'trust-developer',
            'Trust the Market app',
            `On ${d.name}: Settings → General → VPN & Device Management → your Apple ID → Trust.`,
        ),
    unlock: (d) => new NeedsAction('unlock', 'Unlock the phone', `Unlock ${d.name} so setup can continue.`),
    plugInImage: (d) =>
        new NeedsAction(
            'trust',
            'Plug in once for Wi‑Fi',
            `${d.name} needs one cable session so wireless control can be set up. After that you can unplug.`,
        ),
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
        this.actionAt = 0;
        this.error = '';
        this.client = null; // DeviceKitClient (or legacy WDAClient) while connected
        this.engine = null; // 'devicekit' | 'wda' while connected
        this.enginePreference = 'auto'; // 'auto' | 'devicekit' | 'wda'
        this.tunnelInfoPort = null; // this phone's private go-ios tunnel agent port
        this.tunnelProc = null; // long-lived userspace tunnel for this phone only
        this.tunnelRestartedAt = 0;
        this.pmd3Runner = false; // DeviceKit started via pymobiledevice3 (iOS 27 Wi-Fi)
        this.viewProc = null; // go-ios screenshot --stream (live view, separate from DeviceKit)
        this.procs = [];
        this.logs = [];
        this.connecting = null;
        this.lastActivity = null; // { at, actor, text } of the latest action, shown on the card
        this.apps = null; // cached installed apps
        this.connection = null; // 'usb' | 'wifi' while connected
        this.mode = 'usb'; // the connection choice from Setup: 'usb' or 'wifi' (USB + Wi-Fi)
        this.wifiReady = false; // Apple's service already sees it on Wi-Fi, so the cable can come out
        this.usbSince = 0; // when it last started being connected by cable
        this.lastTransport = null; // 'usb' | 'wifi': how it was last connected
        this.errorAt = 0;
        this.errorRetries = 0; // automatic retries since the last good start
        // Session caches so reconnects skip checks that already passed.
        this.devModeOk = false;
        this.imageMountedFor = null; // iosVersion string when mount last succeeded
        this.cachedBundleId = null; // DeviceKit / WDA bundle id while the app stays installed
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
            enginePreference: this.enginePreference,
            connection: this.connection,
            mode: this.mode,
            canUnplug: this.connection === 'usb' && this.mode === 'wifi' && this.wifiReady,
            // Wi-Fi is on and it has been plugged in a while, yet Apple's service can't see it on the network.
            wifiMissing:
                this.connection === 'usb' && this.mode === 'wifi' && !this.wifiReady && Date.now() - this.usbSince > 30000,
            size: this.client?.size,
            legacy: this.engine === 'wda',
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
        this.wifi = null; // set by the server (wifi.js)
    }

    // Phones seen before stay in the list while they're away, so one that is unplugged or waiting
    // on Wi-Fi shows as offline instead of vanishing (and being set up all over again).
    loadKnown() {
        for (const [udid, info] of Object.entries(this.known)) {
            if (this.devices.has(udid)) continue;
            const device = new Device(udid, this.nextSlot++);
            device.online = false;
            device.status = 'offline';
            device.model = info.model || '';
            device.iosVersion = info.iosVersion || '';
            // DeviceKit freezes live view on every PC tap (same XCTest process as MJPEG).
            // WDA keeps stream on its own port — treat saved "devicekit" as auto → WDA.
            device.enginePreference = info.enginePreference === 'wda' ? 'wda' : 'auto';
            device.name = this.nicknames[udid] || info.name || device.name;
            if (this.wifi) device.mode = this.wifi.mode(udid);
            this.devices.set(udid, device);
        }
    }

    remember(device) {
        const next = { name: device.name, model: device.model, iosVersion: device.iosVersion, enginePreference: device.enginePreference };
        const old = this.known[device.udid];
        if (old && old.name === next.name && old.model === next.model && old.iosVersion === next.iosVersion && old.enginePreference === next.enginePreference) return;
        this.known[device.udid] = next;
        writeJson(KNOWN_FILE, this.known);
    }

    /** Removes a phone that is away from the list (it comes back by itself if it connects again). */
    forget(udid) {
        const device = this.get(udid);
        if (device.online) throw new Error('Unplug it or switch it off first');
        this.stopProcesses(device);
        this.devices.delete(udid);
        delete this.known[udid];
        writeJson(KNOWN_FILE, this.known);
    }

    start() {
        this.loadKnown();
        const tick = async () => {
            await this.refresh().catch(() => {});
            this.timer = setTimeout(tick, 3000);
        };
        tick();
    }

    /** Ports for this phone's private userspace tunnel (isolated from every other phone). */
    tunnelPorts(device) {
        const bases = this.config.localPorts || {};
        return {
            info: (bases.tunnelInfoBase || 28200) + device.slot,
            userspace: (bases.tunnelUserspaceBase || 60305) + device.slot,
        };
    }

    /** go-ios options scoped to this phone's tunnel agent. */
    iosOpts(device, extra = {}) {
        return { udid: device.udid, tunnelInfoPort: device.tunnelInfoPort || undefined, ...extra };
    }

    /** Kill only this phone's tunnel agent (other phones keep theirs). */
    killPhoneTunnel(device) {
        const child = device.tunnelProc;
        device.tunnelProc = null;
        device.tunnelInfoPort = null;
        device.pmd3Runner = false;
        if (!child) return;
        try {
            child.removeAllListeners('exit');
            child.kill();
        } catch {}
        device.procs = device.procs.filter((p) => p !== child);
    }

    /** iOS 27 Wi-Fi: go-ios tunnel fails; DeviceKit must start inside pymobiledevice3. */
    needsPmd3Runner(device) {
        return device.connection === 'wifi' && device.iosMajor >= 27;
    }

    /**
     * go-ios keeps retrying a torn-down USB tunnel on the dead ports instead of
     * building a fresh one over Wi-Fi. Kill this phone's agent; if it was live,
     * mark idle so only this phone reconnects.
     */
    bumpPhoneAfterTunnelLoss(device, reason) {
        if (Date.now() - (device.tunnelRestartedAt || 0) < 8000) return;
        device.tunnelRestartedAt = Date.now();
        device.log(`Tunnel needs a fresh start (${reason})`);
        this.killPhoneTunnel(device);
        // Mid-connect: the ensurePhoneTunnel waiter sees the death and retries.
        if (device.connecting || device.status === 'starting') return;
        if (device.status === 'stopped' || device.status === 'offline') return;
        this.stopProcesses(device);
        device.status = device.online ? 'idle' : 'offline';
        device.log('Reconnecting only this phone');
    }

    // iOS 17+ needs a userspace RSD tunnel. One process per phone so a drop only
    // reconnects that phone. Older iOS skips this. iOS 27 Wi-Fi skips go-ios and
    // starts DeviceKit inside pymobiledevice3 instead (see connectDeviceKitPmd3).
    async ensurePhoneTunnel(device) {
        if (device.iosMajor < 17) {
            device.tunnelInfoPort = null;
            device.pmd3Runner = false;
            return;
        }
        if (device.connection === 'wifi') {
            const wait = Math.max(0, (device.wifiSettleUntil || 0) - Date.now());
            await sleep(wait > 0 ? wait : 2500);
            device.wifiSettleUntil = 0;
        }

        if (this.needsPmd3Runner(device)) {
            this.killPhoneTunnel(device);
            device.pmd3Runner = true;
            device.log('iOS 27 Wi-Fi: DeviceKit will start through pymobiledevice3');
            return;
        }

        const attempts = device.connection === 'wifi' ? 5 : 2;
        let lastErr = null;
        for (let i = 0; i < attempts; i++) {
            try {
                await this.startPhoneTunnelOnce(device);
                device.pmd3Runner = false;
                return;
            } catch (e) {
                lastErr = e;
                device.log(`Tunnel attempt ${i + 1}/${attempts} failed: ${e.message}`);
                this.killPhoneTunnel(device);
                if (i + 1 < attempts) await sleep(2000 + i * 1000);
            }
        }
        // Wi-Fi fallback: same pmd3 path used for iOS 27.
        if (device.connection === 'wifi') {
            device.pmd3Runner = true;
            device.log('go-ios tunnel failed on Wi-Fi; falling back to pymobiledevice3 DeviceKit runner');
            return;
        }
        throw lastErr || new Error(`Private tunnel for ${device.name} did not become ready`);
    }

    async startPhoneTunnelOnce(device) {
        this.killPhoneTunnel(device);
        // Brief pause so the previous agent's ports are free before we bind again.
        await sleep(400);

        const { info, userspace } = this.tunnelPorts(device);
        device.tunnelInfoPort = info;
        device.step = 'Starting a private tunnel for this phone';
        let negotiated = false;
        let startFailed = null;
        let tornDown = false;
        const child = goios.spawnLong(
            [
                'tunnel',
                'start',
                '--userspace',
                `--userspace-port=${userspace}`,
                `--tunnel-info-port=${info}`,
            ],
            {
                udid: device.udid,
                onLog: (l) => {
                    device.log(`[tunnel] ${l}`);
                    if (/userspace tunnel negotiated|tunnel.*ready|address assigned/i.test(l)) negotiated = true;
                    const fail = l.match(/"failed to start tunnel".*"error":"([^"]+)"/i) || l.match(/failed to start tunnel[^\n]*error[^\n]*:\s*"?([^"}\n]+)/i);
                    if (fail) startFailed = fail[1] || 'failed to start tunnel';
                    if (/could not exchange tunnel parameters/i.test(l)) startFailed = 'could not exchange tunnel parameters';
                    // Process often stays alive and retries dead USB ports — force a fresh agent.
                    if (/tearing down tunnel/i.test(l)) {
                        tornDown = true;
                        this.bumpPhoneAfterTunnelLoss(device, 'tunnel tore down');
                    }
                },
            },
        );
        device.tunnelProc = child;
        device.procs.push(child);
        child.on('exit', (code) => {
            if (device.tunnelProc === child) device.tunnelProc = null;
            device.log(`Private tunnel stopped (exit ${code})`);
            if (device.status === 'ready') {
                device.status = 'idle';
                device.log("This phone's tunnel dropped; reconnecting only this phone");
            }
        });

        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (tornDown) throw new Error('Tunnel tore down while starting');
            if (child.exitCode !== null) throw new Error(`Private tunnel for ${device.name} quit while starting`);
            if (startFailed) throw new Error(`Tunnel start failed: ${startFailed}`);
            if (negotiated) {
                device.log(`Private tunnel ready on info port ${info}`);
                return;
            }
            try {
                const list = await goios.run(['tunnel', 'ls'], { tunnelInfoPort: info, timeout: 4000 });
                const text = JSON.stringify(list ?? '');
                if (text.includes(device.udid)) {
                    device.log(`Private tunnel ready on info port ${info}`);
                    return;
                }
            } catch {
                /* agent not answering yet */
            }
            await sleep(700);
        }
        throw new Error(`Private tunnel for ${device.name} did not become ready`);
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

    async refresh() {
        let result;
        try {
            result = await goios.run(['list', '--details'], { timeout: 10000 });
            this.lastListError = '';
        } catch (e) {
            this.lastListError = e.message;
            return;
        }
        const entries = result?.deviceList || [];
        const seen = new Set();

        for (const entry of entries) {
            const udid = typeof entry === 'string' ? entry : entry.Udid;
            if (!udid) continue;
            seen.add(udid);
            let device = this.devices.get(udid);
            if (!device) {
                device = new Device(udid, this.nextSlot++);
                this.devices.set(udid, device);
                const pref = this.known[udid]?.enginePreference;
                device.enginePreference = pref === 'wda' ? 'wda' : 'auto';
                device.log('Phone connected');
                this.applyEntry(device, entry);
                // iOS 17+ phones need the helper to mount the developer image; get it ready in the background.
                if (device.iosMajor >= 17) setup.ensureHelper().catch(() => {});
            }
            if (this.wifi) {
                device.mode = this.wifi.mode(udid);
                device.connection = this.wifi.proxy.connectionOf(udid);
                device.wifiReady = this.wifi.proxy.networkUdids().has(udid);
                if (device.connection === 'usb' && device.lastTransport !== 'usb') device.usbSince = Date.now();
            }
            this.remember(device);
            const switched =
                device.connection &&
                device.lastTransport &&
                device.connection !== device.lastTransport;
            if (!device.online) {
                device.online = true;
                device.status = 'idle';
                device.log(`Phone reconnected${device.connection === 'wifi' ? ' over Wi-Fi' : ''}`);
                // Common path after unplug: brief offline, then Wi-Fi — give lockdown time to settle.
                if (device.connection === 'wifi') device.wifiSettleUntil = Date.now() + 6000;
            } else if (switched) {
                // USB ↔ Wi-Fi: the old tunnel is on dead ports; only this phone restarts.
                device.log(`Switched to ${device.connection}; rebuilding this phone's tunnel`);
                this.killPhoneTunnel(device);
                this.stopProcesses(device);
                device.status = 'idle';
                if (device.connection === 'wifi') device.wifiSettleUntil = Date.now() + 6000;
            }
            if (device.connection) device.lastTransport = device.connection;
            if (!this.config.autoConnect) continue;
            // Phones waiting on you are re-checked every few seconds, so they continue by themselves.
            const retryAction = device.status === 'action' && Date.now() - device.actionAt > ACTION_RETRY_MS;
            // A failed start (often just the tunnel not being up yet) is tried again a few times by itself.
            const retryError =
                device.status === 'error' &&
                device.errorRetries < ERROR_RETRIES &&
                Date.now() - device.errorAt > ERROR_RETRY_MS;
            if (retryError) {
                device.errorRetries++;
                device.log(`Trying again (${device.errorRetries}/${ERROR_RETRIES})`);
            }
            if (retryAction) {
                // Keep this phone's tunnel up — only re-check install / Developer Mode / etc.
                device.actionAt = Date.now();
                this.connect(udid, { keepTunnel: true }).catch(() => {});
            } else if (device.status === 'idle' || retryError) {
                this.connect(udid).catch(() => {});
            }
        }

        for (const device of this.devices.values()) {
            if (this.wifi) device.mode = this.wifi.mode(device.udid); // also for phones that are away
            if (!seen.has(device.udid) && device.online) {
                device.log('Phone disconnected');
                device.online = false;
                device.connection = null;
                device.wifiReady = false;
                this.stopProcesses(device);
                // Phone may reboot while away — remount / re-check Developer Mode next time.
                device.devModeOk = false;
                device.imageMountedFor = null;
                device.status = 'offline';
            }
        }
    }

    applyEntry(device, entry) {
        if (typeof entry === 'object') {
            device.model = entry.ProductType || '';
            device.iosVersion = entry.ProductVersion || '';
            if (entry.DeviceName) device.name = entry.DeviceName;
        }
        if (this.nicknames[device.udid]) device.name = this.nicknames[device.udid];
    }

    // Reading device info only works once the phone trusts this PC, so it doubles as the trust check.
    async checkTrusted(device) {
        try {
            // pmd3 Wi-Fi path has no go-ios tunnel; usbmux lockdown may still answer.
            const info = await goios.run(['info'], { ...this.iosOpts(device), timeout: 15000 });
            if (!info || typeof info !== 'object') throw new Error('no info');
            device.name = this.nicknames[device.udid] || info.DeviceName || device.name;
            device.model = info.ProductType || device.model;
            device.iosVersion = info.ProductVersion || device.iosVersion;
        } catch (e) {
            if (device.pmd3Runner && device.connection === 'wifi') {
                device.log(`Skipping go-ios trust check on pmd3 Wi-Fi (${e.message})`);
                return;
            }
            device.log(`Not trusted yet (${e.message}); asking the phone to trust this PC`);
            if (device.connection === 'wifi') throw ACTIONS.trustWifi(device); // trusting only works over USB
            await goios.run(['pair'], { ...this.iosOpts(device), timeout: 20000 }).catch(() => {});
            throw ACTIONS.trust(device);
        }
    }

    rename(udid, name) {
        const device = this.get(udid);
        device.name = name;
        this.nicknames[udid] = name;
        writeJson(NICKNAMES_FILE, this.nicknames);
        this.remember(device);
    }

    // Default is WDA (separate MJPEG port). DeviceKit is optional and freezes view on tap.
    setEnginePreference(udid, preference) {
        const device = this.get(udid);
        if (!['auto', 'devicekit', 'wda'].includes(preference)) throw new Error('Choose Auto, DeviceKit, or WDA');
        device.enginePreference = preference;
        this.remember(device);
        this.disconnect(udid);
        if (device.online) this.connect(udid).catch(() => {});
    }

    connect(udid, opts) {
        const device = this.get(udid);
        if (!device.online) throw new Error('Phone is not connected');
        if (device.connecting) return device.connecting;
        device.connecting = this._connect(device, opts).finally(() => {
            device.connecting = null;
        });
        return device.connecting;
    }

    /** Local DeviceKit HTTP port for this phone's slot. */
    deviceKitPort(device) {
        return (this.config.localPorts?.devicekitBase || 12004) + device.slot;
    }

    /**
     * If DeviceKit is already answering on the local forward, attach and mark ready.
     * Avoids tearing everything down and walking every setup step again.
     */
    async tryReuseDeviceKit(device) {
        if (!this.usesDeviceKit(device)) return false;
        const tunnelAlive = device.tunnelProc && device.tunnelProc.exitCode === null;
        const otherProcs = device.procs.filter((p) => p !== device.tunnelProc);
        // go-ios path needs forward/runwda still around; pmd3's tunnelProc is the runner itself.
        const mightBeLive =
            !!device.client ||
            !!device.mjpegPort ||
            otherProcs.length > 0 ||
            (device.pmd3Runner && tunnelAlive);
        if (!mightBeLive) return false;

        const localPort = device.mjpegPort || this.deviceKitPort(device);
        device.step = 'Checking if control is already live';
        const client = new DeviceKitClient(`http://127.0.0.1:${localPort}`);
        try {
            const probe = Promise.all([
                client.health().catch(() => false),
                client.status().then(() => true).catch(() => false),
            ]).then(async ([healthOk, statusOk]) => {
                if (!healthOk && !statusOk) return false;
                await client.createSession();
                return true;
            });
            const ok = await Promise.race([probe, sleep(1500).then(() => false)]);
            if (!ok || !client.size) return false;
            await this.finishDeviceKitReady(device, client, localPort, 'Already live — skipped setup steps');
            return true;
        } catch {
            return false;
        }
    }

    /** True once something is accepting TCP on port (go-ios MJPEG server is up). */
    waitPortOpen(port, deadlineMs = 8000) {
        const deadline = Date.now() + deadlineMs;
        return new Promise((resolve, reject) => {
            const attempt = () => {
                const socket = net.connect({ host: '127.0.0.1', port }, () => {
                    socket.destroy();
                    resolve();
                });
                socket.on('error', () => {
                    socket.destroy();
                    if (Date.now() > deadline) reject(new Error(`nothing listening on ${port}`));
                    else setTimeout(attempt, 150);
                });
            };
            attempt();
        });
    }

    /**
     * Live view through go-ios instruments screenshots — separate from DeviceKit, so taps
     * and swipes from the PC do not pause the picture.
     */
    async startIndependentView(device) {
        const port = (this.config.localPorts?.screenshotBase || 13333) + device.slot;
        if (device.viewProc) {
            try {
                device.viewProc.removeAllListeners('exit');
                device.viewProc.kill();
            } catch {}
            device.procs = device.procs.filter((p) => p !== device.viewProc);
            device.viewProc = null;
        }

        let exited = false;
        const child = goios.spawnLong(['screenshot', '--stream', `--port=${port}`], {
            ...this.iosOpts(device),
            onLog: (l) => device.log(`[view] ${l}`),
        });
        device.viewProc = child;
        device.procs.push(child);
        child.on('exit', (code) => {
            exited = true;
            if (device.viewProc === child) device.viewProc = null;
            device.log(`View stream stopped (exit ${code})`);
            if (device.status !== 'ready' || device.engine !== 'devicekit') return;
            if (Date.now() - (device.viewRestartedAt || 0) < 3000) return;
            device.viewRestartedAt = Date.now();
            // Keep control up; bring the picture back without a full DeviceKit restart.
            this.startIndependentView(device).catch((e) => device.log(`View stream restart failed: ${e.message}`));
        });

        try {
            await this.waitPortOpen(port, 10000);
        } catch (e) {
            try {
                child.removeAllListeners('exit');
                child.kill();
            } catch {}
            device.procs = device.procs.filter((p) => p !== child);
            if (device.viewProc === child) device.viewProc = null;
            if (exited) throw new Error('view stream quit while starting');
            throw e;
        }

        device.mjpegHost = '127.0.0.1';
        device.mjpegPort = port;
        device.mjpegPath = '/';
        return port;
    }

    async finishDeviceKitReady(device, client, localPort, logLine) {
        const { devicekit: dkCfg } = this.config;
        controlApp.started(device.udid, device.wdaBundleId || device.cachedBundleId || this.config.devicekit?.bundleId);
        device.client = client;
        device.engine = 'devicekit';

        const dkStream = {
            host: '127.0.0.1',
            port: localPort,
            path: mjpegPath({
                framerate: dkCfg.mjpegFramerate,
                quality: dkCfg.mjpegQuality,
                scale: dkCfg.mjpegScale,
            }),
        };
        // Prefer go-ios view so Market gestures do not freeze the live picture.
        const viewAlive =
            device.viewProc &&
            device.viewProc.exitCode === null &&
            device.mjpegPort &&
            device.mjpegPath === '/';
        if (!viewAlive) {
            try {
                await this.startIndependentView(device);
                device.log('Live view via go-ios (keeps moving while you tap)');
            } catch (e) {
                device.log(`Independent view failed (${e.message}); using DeviceKit stream`);
                device.mjpegHost = dkStream.host;
                device.mjpegPort = dkStream.port;
                device.mjpegPath = dkStream.path;
            }
        }

        const wifiIp = this.wifi?.proxy?.wifiIpOf?.(device.udid) || this.wifi?.data[device.udid]?.ip;
        if (wifiIp) this.wifi?.learnIp(device.udid, wifiIp);
        if (device.connection === 'wifi' && wifiIp) this.keepWifiAwake(device, wifiIp);
        device.status = 'ready';
        device.step = '';
        device.error = '';
        device.action = null;
        device.errorRetries = 0;
        device.log(
            logLine ||
                `Ready via DeviceKit (screen ${client.size.width}x${client.size.height} pt)`,
        );
        this.remember(device);
    }

    /** Wait until DeviceKit /health or /rpc answers; both are probed together each tick. */
    async waitForDeviceKitHttp(client, { deadlineMs = 90000, tick = () => {} } = {}) {
        const deadline = Date.now() + deadlineMs;
        for (;;) {
            tick();
            const [healthOk, statusOk] = await Promise.all([
                client.health().catch(() => false),
                client.status().then(() => true).catch(() => false),
            ]);
            if (healthOk || statusOk) return;
            if (Date.now() > deadline) throw new Error('DeviceKit did not start. Keep the phone unlocked and try again.');
            await sleep(400);
        }
    }

    /**
     * Bundle id, Developer Mode, and Wi-Fi pair record in parallel; mount only if not cached.
     */
    async prepareDeviceKit(device, { skipPair = false } = {}) {
        device.step = 'Checking the phone';
        const usbmux = process.env.USBMUXD_SOCKET_ADDRESS || `127.0.0.1:${this.config.usbmuxProxyPort}`;
        const jobs = [];

        jobs.push(
            (async () => {
                try {
                    const id = await this.findDeviceKitBundle(device);
                    if (id) device.cachedBundleId = id;
                    else device.cachedBundleId = null;
                    return id;
                } catch (e) {
                    if (device.cachedBundleId) {
                        device.log(`Could not list apps (${e.message}); using cached DeviceKit id`);
                        return device.cachedBundleId;
                    }
                    throw e;
                }
            })(),
        );

        if (device.iosMajor >= 16 && !device.devModeOk) {
            jobs.push(
                this.checkDeveloperMode(device).then(() => {
                    device.devModeOk = true;
                }),
            );
        } else {
            jobs.push(Promise.resolve());
        }

        if (!skipPair && device.connection === 'usb') {
            jobs.push(
                (async () => {
                    try {
                        const python = await setup.ensureHelper((step) => device.log(step));
                        await pairForWifi(python, device.udid, usbmux);
                    } catch (e) {
                        device.log(`Wi-Fi pairing record: ${e.message}`);
                    }
                })(),
            );
        } else {
            jobs.push(Promise.resolve());
        }

        const [bundleId] = await Promise.all(jobs);
        device.wdaBundleId = bundleId;
        if (!bundleId) {
            device.cachedBundleId = null;
            throw ACTIONS.install(device);
        }

        if (device.imageMountedFor !== device.iosVersion) {
            device.step = 'Mounting developer image';
            await this.mountDeveloperImage(device);
            device.imageMountedFor = device.iosVersion;
        }

        return bundleId;
    }

    async _connect(device, opts = {}) {
        const { wda: wdaCfg, localPorts } = this.config;
        const udid = device.udid;

        // Already viewing and controlling? Do not tear down and re-walk every step.
        if (!opts.force && (await this.tryReuseDeviceKit(device))) return;

        const tunnelAlive =
            device.tunnelProc &&
            device.tunnelProc.exitCode === null &&
            (device.tunnelInfoPort || device.pmd3Runner);
        // pmd3 runner is DeviceKit itself — soft retries must restart it after Install.
        const keepTunnel = opts.keepTunnel && tunnelAlive && !device.pmd3Runner;
        if (keepTunnel) {
            // Drop DeviceKit / forwards only; leave this phone's private tunnel running.
            for (const p of device.procs) {
                if (p === device.tunnelProc) continue;
                try {
                    p.removeAllListeners('exit');
                    p.kill();
                } catch {}
            }
            device.procs = [device.tunnelProc];
            device.client = null;
            device.engine = null;
            device.mjpegPort = null;
            device.mjpegHost = null;
            device.mjpegPath = null;
        } else {
            this.stopProcesses(device);
        }
        device.status = 'starting';
        device.error = '';
        device.action = null;

        try {
            if (!keepTunnel) await this.ensurePhoneTunnel(device);
            device.step = 'Checking the phone trusts this PC';
            await this.checkTrusted(device);

            if (this.usesDeviceKit(device)) {
                await this.connectDeviceKit(device);
                return;
            }

            device.log('Using legacy WebDriverAgent');
            device.step = 'Checking the control app';
            const bundleId = await this.findWdaBundle(device);
            device.wdaBundleId = bundleId;
            if (!bundleId) throw ACTIONS.install(device);

            if (device.iosMajor >= 16) {
                device.step = 'Checking Developer Mode';
                await this.checkDeveloperMode(device);
            }

            device.step = 'Mounting developer image';
            await this.mountDeveloperImage(device);

            device.step = 'Starting the control app';
            let wdaExited = false;
            let wdaOutput = '';
            const runwda = goios.spawnLong(
                [
                    'runwda',
                    `--bundleid=${bundleId}`,
                    `--testrunnerbundleid=${bundleId}`,
                    `--xctestconfig=${wdaCfg.xctestConfig}`,
                ],
                {
                    ...this.iosOpts(device),
                    onLog: (l) => {
                        wdaOutput += `${l}\n`;
                        device.log(`[wda] ${l}`);
                    },
                },
            );
            device.procs.push(runwda);
            runwda.on('exit', (code) => {
                wdaExited = true;
                device.log(`Control app stopped (exit ${code})`);
                if (device.status === 'ready') {
                    device.status = 'idle'; // auto-connect brings it back
                    device.log('Restarting the control app');
                }
            });

            const wdaPort = localPorts.wdaBase + device.slot;
            const mjpegPort = localPorts.mjpegBase + device.slot;
            for (const [local, remote] of [
                [wdaPort, wdaCfg.devicePort],
                [mjpegPort, wdaCfg.mjpegDevicePort],
            ]) {
                device.procs.push(
                    goios.spawnLong(['forward', String(local), String(remote)], {
                        ...this.iosOpts(device),
                        onLog: (l) => device.log(`[forward ${local}] ${l}`),
                    }),
                );
            }

            device.step = 'Waiting for the control app';
            const client = new WDAClient(`http://127.0.0.1:${wdaPort}`);
            const deadline = Date.now() + 90000;
            for (;;) {
                // iOS won't start an app from a developer you haven't trusted yet; go-ios only sees "no pid".
                if (/explicitly trusted|not trusted|untrusted|could not get pid|failed to launch app/i.test(wdaOutput))
                    throw ACTIONS.trustDeveloper(device);
                if (
                    /invalid code signature|profile has expired|no longer valid|0xe8008018|0xe800801c/i.test(wdaOutput)
                ) {
                    controlApp.expired(udid);
                    throw ACTIONS.resign(device);
                }
                if (/locked|passcode/i.test(wdaOutput) && wdaExited) throw ACTIONS.unlock(device);
                if (wdaExited)
                    throw new Error('The control app quit while starting. Open the phone for its connection log.');
                try {
                    await client.status();
                    break;
                } catch {}
                if (Date.now() > deadline)
                    throw new Error('The control app did not start. Keep the phone unlocked and try again.');
                await sleep(1500);
            }

            device.step = 'Opening session';
            for (let attempt = 1; ; attempt++) {
                try {
                    await client.createSession();
                    break;
                } catch (e) {
                    if (wdaExited || attempt >= 3) throw e;
                    device.log(`Opening session failed (${e.message}), retrying (${attempt}/3)`);
                    await sleep(2000);
                }
            }
            await client
                .configureStream({
                    framerate: wdaCfg.mjpegFramerate,
                    scalingFactor: wdaCfg.mjpegScalingFactor,
                    quality: wdaCfg.mjpegQuality,
                })
                .catch((e) => device.log(`stream settings: ${e.message}`));

            controlApp.started(udid, bundleId);
            // Remember its Wi-Fi address: Apple's service can't always find phones on Wi-Fi by itself.
            if (this.wifi)
                this.wifi.learnIp(
                    udid,
                    await client
                        .status()
                        .then((st) => st?.ios?.ip)
                        .catch(() => null),
                );
            device.client = client;
            device.engine = 'wda';
            device.mjpegHost = '127.0.0.1';
            device.mjpegPort = mjpegPort;
            if (device.connection === 'wifi') {
                const ip = await client
                    .status()
                    .then((st) => st?.ios?.ip)
                    .catch(() => null);
                if (ip) {
                    this.wifi?.learnIp(udid, ip);
                    this.keepWifiAwake(device, ip);
                }
            }
            device.status = 'ready';
            device.step = '';
            device.errorRetries = 0;
            device.log(`Ready via legacy control app (screen ${client.size.width}x${client.size.height} pt)`);
            this.remember(device);
            // First time over the cable with no choice made yet: switch Wi-Fi on, so the phone keeps
            // working once it is unplugged and the one USB port is free for the next phone.
            if (this.wifi && device.connection === 'usb' && !this.wifi.data[udid]) {
                this.wifi
                    .setMode(udid, 'wifi')
                    .then(() => {
                        device.mode = 'wifi';
                        device.log('Wi-Fi switched on: you can unplug it once it shows on Wi-Fi');
                    })
                    .catch((e) => device.log(`Could not switch Wi-Fi on: ${e.message}`));
            }
        } catch (e) {
            this.stopProcesses(device);
            device.step = '';
            if (e.action) {
                device.status = 'action';
                device.action = e.action;
                device.actionAt = Date.now();
                device.log(`Waiting for you: ${e.action.title}`);
            } else {
                device.status = 'error';
                device.error = e.message;
                // Some iOS versions hang up on every service connection made over Wi-Fi (the phone answers,
                // then closes after the handshake). Retrying can't help, so say so and stop trying.
                if (device.connection === 'wifi' && /forcibly closed|aborted|terminated abruptly|\bEOF\b|reset by peer/i.test(e.message)) {
                    device.error = `${device.name} answers on Wi-Fi but its iOS (${device.iosVersion}) closes the connection when Market tries to control it. Plug it in with a cable to use it.`;
                    device.errorRetries = ERROR_RETRIES;
                }
                device.errorAt = Date.now();
                device.log(`Connect failed: ${e.message}`);
            }
            throw e;
        }
    }

    // iPhones put Wi-Fi to sleep between packets (802.11 power save), which adds up to seconds
    // of delay. A tiny packet every 15 ms keeps the radio awake: measured ~2x lower latency and
    // more frames. Stopped with the phone's other processes.
    keepWifiAwake(device, ip) {
        if (!ip) return;
        const sock = dgram.createSocket('udp4');
        const ping = Buffer.alloc(1);
        const timer = setInterval(() => sock.send(ping, 9, ip, () => {}), 15);
        device.procs.push({
            removeAllListeners() {},
            kill() {
                clearInterval(timer);
                sock.close();
            },
        });
    }

    // Default: WDA — MJPEG on its own port so PC taps do not freeze the live view.
    // DeviceKit only when forced (preference or controlEngine).
    usesDeviceKit(device) {
        if (device.enginePreference === 'wda') return false;
        if (device.enginePreference === 'devicekit') return true;
        return (this.config.controlEngine || 'wda') === 'devicekit';
    }

    async connectDeviceKit(device) {
        if (device.pmd3Runner) {
            await this.connectDeviceKitPmd3(device);
            return;
        }

        const { devicekit: dkCfg } = this.config;
        const udid = device.udid;
        const localPort = this.deviceKitPort(device);

        // Tunnel kept, DeviceKit maybe still up after a soft retry — probe before spawning again.
        if (await this.tryReuseDeviceKit(device)) return;

        const bundleId = await this.prepareDeviceKit(device);

        device.step = 'Starting DeviceKit';
        let exited = false;
        let output = '';
        const run = goios.spawnLong(
            [
                'runwda',
                `--bundleid=${bundleId}`,
                `--testrunnerbundleid=${bundleId}`,
                `--xctestconfig=${dkCfg.xctestConfig}`,
            ],
            {
                ...this.iosOpts(device),
                onLog: (l) => {
                    output += `${l}\n`;
                    device.log(`[devicekit] ${l}`);
                },
            },
        );
        device.procs.push(run);
        run.on('exit', (code) => {
            exited = true;
            device.log(`DeviceKit stopped (exit ${code})`);
            if (device.status === 'ready') {
                device.status = 'idle';
                device.log('Restarting DeviceKit');
            }
        });

        device.procs.push(
            goios.spawnLong(['forward', String(localPort), String(dkCfg.devicePort || 12004)], {
                ...this.iosOpts(device),
                onLog: (l) => device.log(`[forward ${localPort}] ${l}`),
            }),
        );

        device.step = 'Waiting for DeviceKit';
        const client = new DeviceKitClient(`http://127.0.0.1:${localPort}`);
        await this.waitForDeviceKitHttp(client, {
            tick: () => {
                if (/explicitly trusted|not trusted|untrusted|could not get pid|failed to launch app/i.test(output))
                    throw ACTIONS.trustDeveloper(device);
                if (/invalid code signature|profile has expired|no longer valid|0xe8008018|0xe800801c/i.test(output)) {
                    controlApp.expired(udid);
                    device.cachedBundleId = null;
                    throw ACTIONS.resign(device);
                }
                if (/locked|passcode/i.test(output) && exited) throw ACTIONS.unlock(device);
                if (exited) throw new Error('DeviceKit quit while starting. Keep the phone unlocked and try again.');
            },
        });

        device.step = 'Opening session';
        for (let attempt = 1; ; attempt++) {
            try {
                await client.createSession();
                break;
            } catch (e) {
                if (exited || attempt >= 3) throw e;
                device.log(`DeviceKit info failed (${e.message}), retrying (${attempt}/3)`);
                await sleep(800);
            }
        }

        await this.finishDeviceKitReady(
            device,
            client,
            localPort,
            `Ready via DeviceKit (screen ${client.size.width}x${client.size.height} pt)`,
        );
        if (this.wifi && device.connection === 'usb') {
            // First cable session, or mode never set to wifi yet: turn wireless control on.
            if (!this.wifi.data[udid] || this.wifi.mode(udid) !== 'wifi') {
                this.wifi
                    .setMode(udid, 'wifi')
                    .then(() => {
                        device.mode = 'wifi';
                        device.log('Wi-Fi switched on: you can unplug it once it shows on Wi-Fi');
                    })
                    .catch((e) => device.log(`Could not switch Wi-Fi on: ${e.message}`));
            }
        }
    }

    // iOS 27 Wi-Fi (and go-ios Wi-Fi tunnel failures): start DeviceKit inside pymobiledevice3.
    async connectDeviceKitPmd3(device) {
        const udid = device.udid;
        const wifi = device.connection === 'wifi';
        const usbmux = process.env.USBMUXD_SOCKET_ADDRESS || `127.0.0.1:${this.config.usbmuxProxyPort}`;
        const localPort = this.deviceKitPort(device);

        if (await this.tryReuseDeviceKit(device)) return;

        device.step = 'Getting the iOS helper ready';
        const [python, bundleId] = await Promise.all([
            setup.ensureHelper((step) => {
                device.step = step;
                device.log(step);
            }),
            (async () => {
                if (device.cachedBundleId) return device.cachedBundleId;
                const configured = this.config.devicekit?.bundleId;
                const found = await this.findDeviceKitBundle(device).catch(() => null);
                const id = found || configured || null;
                if (id) device.cachedBundleId = id;
                return id;
            })(),
        ]);
        device.wdaBundleId = bundleId;
        if (!bundleId) {
            device.cachedBundleId = null;
            throw ACTIONS.install(device);
        }

        if (!wifi) {
            await this.prepareDeviceKit(device, { skipPair: true });
            device.step = 'Setting up Wi-Fi';
            await pairForWifi(python, udid, usbmux).catch((e) => device.log(`Could not set up Wi-Fi: ${e.message}`));
        }

        device.step = wifi ? 'Starting DeviceKit over Wi-Fi' : 'Starting DeviceKit';
        let output = '';
        const child = startDeviceKitRunner(python, {
            udid,
            localPort,
            bundleId,
            usbmux,
            wifi,
            onLog: (l) => {
                output = `${output}${l}\n`.slice(-4000);
                device.log(`[pmd3] ${l}`);
            },
        });
        device.tunnelProc = child;
        device.procs.push(child);
        child.on('exit', (code) => {
            if (device.tunnelProc === child) device.tunnelProc = null;
            device.log(`DeviceKit runner stopped (exit ${code})`);
            if (device.status === 'ready') {
                device.status = 'idle';
                device.log('Restarting DeviceKit');
            }
        });

        try {
            await Promise.race([
                child.ready,
                sleep(120000).then(() => {
                    throw new Error('DeviceKit runner timed out');
                }),
            ]);
        } catch (e) {
            if (wifi && /advertising|pairing|remote|EOF|abrupt/i.test(`${e.message}\n${output}`))
                throw ACTIONS.plugInImage(device);
            throw e;
        }

        device.step = 'Waiting for DeviceKit';
        const client = new DeviceKitClient(`http://127.0.0.1:${localPort}`);
        await this.waitForDeviceKitHttp(client, {
            tick: () => {
                if (child.exitCode === null) return;
                if (/locked|passcode/i.test(output)) throw ACTIONS.unlock(device);
                if (/explicitly trusted|not trusted|untrusted/i.test(output)) throw ACTIONS.trustDeveloper(device);
                if (/invalid code signature|profile has expired|0xe8008018/i.test(output)) {
                    controlApp.expired(udid);
                    device.cachedBundleId = null;
                    throw ACTIONS.resign(device);
                }
                if (wifi) throw ACTIONS.plugInImage(device);
                throw new Error('DeviceKit runner quit while starting');
            },
        });

        device.step = 'Opening session';
        await client.createSession();
        await this.finishDeviceKitReady(
            device,
            client,
            localPort,
            `Ready via DeviceKit${wifi ? ' over Wi-Fi' : ''} (pmd3 tunnel, screen ${client.size.width}x${client.size.height} pt)`,
        );
    }

    async findDeviceKitBundle(device) {
        const configured = this.config.devicekit?.bundleId;
        try {
            const apps = await goios.run(['apps'], { ...this.iosOpts(device), timeout: 30000 });
            const ids = (Array.isArray(apps) ? apps : [])
                .map((a) => (typeof a === 'string' ? a : a.CFBundleIdentifier))
                .filter(Boolean);
            if (configured && ids.includes(configured)) return configured;
            return (
                ids.find((id) => /devicekit-iosuitests\.xctrunner/i.test(id)) ||
                ids.find((id) => /devicekit.*xctrunner/i.test(id)) ||
                ids.find((id) => /mobilenext\.devicekit/i.test(id)) ||
                null
            );
        } catch (e) {
            if (configured) {
                device.log(`Could not list apps (${e.message}); using configured DeviceKit id`);
                return configured;
            }
            throw e;
        }
    }

    async checkDeveloperMode(device) {
        let out;
        try {
            out = await goios.run(['devmode', 'get'], { ...this.iosOpts(device), timeout: 15000 });
        } catch (e) {
            device.log(`Could not read Developer Mode (${e.message}); continuing`);
            return;
        }
        const text = JSON.stringify(out);
        if (/true|enabled/i.test(text) && !/false|disabled/i.test(text)) return;
        // Makes the Developer Mode switch appear in Settings, which iOS hides until asked.
        await goios.run(['devmode', 'reveal'], { ...this.iosOpts(device), timeout: 15000 }).catch(() => {});
        throw ACTIONS.devmode(device);
    }

    // go-ios fetches the image signature from gs.apple.com over HTTPS, which fails on
    // Windows because Apple's private CA isn't trusted there. pymobiledevice3 uses plain
    // HTTP for the same request, so fall back to it (the app installs it the first time).
    async mountDeveloperImage(device) {
        try {
            await goios.run(['image', 'auto'], { ...this.iosOpts(device), timeout: 180000 });
            return;
        } catch (e) {
            device.log(`image auto (go-ios): ${e.message}`);
        }
        let python;
        try {
            python = await setup.ensureHelper((step) => {
                device.step = step;
                device.log(step);
            });
        } catch (e) {
            device.log(`Could not install the iOS helper: ${e.message}`);
            return;
        }
        device.step = 'Mounting developer image';
        device.log('Retrying image mount with pymobiledevice3');
        await new Promise((resolve) => {
            execFile(
                python,
                ['-m', 'pymobiledevice3', 'mounter', 'auto-mount', '--udid', device.udid],
                {
                    cwd: DATA_DIR,
                    timeout: 300000,
                    windowsHide: true,
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                },
                (err, stdout, stderr) => {
                    const out = `${stdout}\n${stderr}`;
                    if (/mounted successfully|already mounted/i.test(out)) device.log('Developer image mounted');
                    else device.log(`pymobiledevice3 mount failed: ${err?.message || out.trim().split('\n').pop()}`);
                    resolve();
                },
            );
        });
    }

    // Signing with a free Apple ID changes the bundle id (it gets your team id added),
    // so look for anything that looks like a WDA runner. Returns null if none is installed.
    async findWdaBundle(device) {
        const configured = this.config.wda.bundleId;
        const apps = await goios.run(['apps'], { ...this.iosOpts(device), timeout: 30000 });
        const ids = (Array.isArray(apps) ? apps : [])
            .map((a) => (typeof a === 'string' ? a : a.CFBundleIdentifier))
            .filter(Boolean);
        if (ids.includes(configured)) return configured;
        return (
            ids.find((id) => /webdriveragentrunner/i.test(id) && /xctrunner/i.test(id)) ||
            ids.find((id) => /webdriveragent/i.test(id)) ||
            null
        );
    }

    // Apps you installed (not Apple's built-ins), as { bundleId, name }.
    async listApps(udid, { refresh = false } = {}) {
        const device = this.get(udid);
        if (device.apps && !refresh) return device.apps;
        const apps = await goios.run(['apps'], { ...this.iosOpts(device), timeout: 30000 });
        device.apps = (Array.isArray(apps) ? apps : [])
            .map((a) =>
                typeof a === 'string'
                    ? { bundleId: a, name: a }
                    : {
                          bundleId: a.CFBundleIdentifier,
                          name: a.CFBundleDisplayName || a.CFBundleName || a.CFBundleIdentifier,
                      },
            )
            .filter((a) => a.bundleId && !/webdriveragent/i.test(a.bundleId) && !/devicekit/i.test(a.bundleId))
            .sort((a, b) => a.name.localeCompare(b.name));
        return device.apps;
    }

    disconnect(udid) {
        const device = this.get(udid);
        this.stopProcesses(device);
        // 'stopped' (not 'idle') so auto-connect leaves a phone the user turned off alone.
        device.status = device.online ? 'stopped' : 'offline';
        device.log('Disconnected');
    }

    stopProcesses(device) {
        this.killPhoneTunnel(device);
        for (const p of device.procs) {
            try {
                p.removeAllListeners('exit');
                p.kill();
            } catch {}
        }
        device.procs = [];
        device.viewProc = null;
        device.client = null;
        device.engine = null;
        device.tunnelInfoPort = null;
        device.mjpegPort = null;
        device.mjpegHost = null;
        device.mjpegPath = null;
    }

    shutdown() {
        clearTimeout(this.timer);
        for (const d of this.devices.values()) this.stopProcesses(d);
    }
}

module.exports = { DeviceManager };
