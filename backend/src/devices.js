// Finds iPhones on USB or Wi-Fi and gets each one to "ready" with no manual steps on the PC:
//   trusted → control app present (you install it with Sideloadly) → Developer Mode on
//   → developer image mounted → WebDriverAgent running → live screen + touch.
// When a step needs you to do something, the phone gets an "action" with plain
// instructions, and the app keeps retrying until you've done it.
const path = require('node:path');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const goios = require('./goios');
const { WDAClient } = require('./wda');
const { DATA_DIR, readJson, writeJson } = require('./paths');
const setup = require('./setup');
const controlApp = require('./controlapp');

const NICKNAMES_FILE = path.join(DATA_DIR, 'nicknames.json');
const ACTION_RETRY_MS = 8000;

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
            'Plug the phone in once',
            `${d.name} doesn't trust this PC yet. Plug it in with a cable, unlock it and tap Trust This Computer. After that it can stay on Wi-Fi.`,
        ),
    trust: (d) =>
        new NeedsAction(
            'trust',
            'Tap "Trust" on the phone',
            `Unlock ${d.name}, tap Trust This Computer and enter the passcode. If no pop-up shows, unplug it and plug it back in while unlocked.`,
        ),
    install: (d) =>
        new NeedsAction(
            'install',
            'Install the control app',
            `${d.name} doesn't have the control app yet. Click Install to put it on with your Apple ID (sign in once in Setup), or use Sideloadly with WDA.ipa. This page carries on by itself once it's installed.`,
        ),
    resign: (d) =>
        new NeedsAction(
            'resign',
            'Re-sign the control app',
            `The control app on ${d.name} expired (free Apple IDs last 7 days). Click Install to re-sign it with your Apple ID; Market also does this by itself for plugged-in phones once you've signed in in Setup.`,
        ),
    devmode: (d) =>
        new NeedsAction(
            'devmode',
            'Turn on Developer Mode',
            `On ${d.name}: Settings → Privacy & Security → Developer Mode → On → Restart. After it restarts, unlock it and tap Turn On.`,
        ),
    trustDeveloper: (d) =>
        new NeedsAction(
            'trust-developer',
            'Trust the control app',
            `On ${d.name}: Settings → General → VPN & Device Management → tap your Apple ID email → Trust. Keep the phone unlocked while it connects.`,
        ),
    unlock: (d) => new NeedsAction('unlock', 'Unlock the phone', `Unlock ${d.name} so the app can start.`),
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
        this.wda = null;
        this.procs = [];
        this.logs = [];
        this.connecting = null;
        this.lastActivity = null; // { at, actor, text } of the latest action, shown on the card
        this.apps = null; // cached installed apps
        this.connection = null; // 'usb' | 'wifi' while connected
        this.mode = 'usb'; // the connection choice from Setup: 'usb' or 'wifi' (USB + Wi-Fi)
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
            connection: this.connection,
            mode: this.mode,
            size: this.wda?.size,
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
        this.nextSlot = 0;
        this.tunnel = null;
        this.lastListError = '';
        this.wifi = null; // set by the server (wifi.js)
    }

    start() {
        if (this.config.startTunnel) this.startTunnel();
        const tick = async () => {
            await this.refresh().catch(() => {});
            this.timer = setTimeout(tick, 3000);
        };
        tick();
    }

    // iOS 17+ needs a tunnel for developer services. The userspace tunnel
    // needs no admin rights or extra drivers; it is harmless for older iOS.
    startTunnel() {
        this.tunnel = goios.spawnLong(['tunnel', 'start', '--userspace'], {
            onLog: (l) => {
                if (/error|fatal/i.test(l)) console.log('[tunnel]', l);
            },
        });
        this.tunnel.on('exit', (code) => {
            console.log(`[tunnel] exited (${code}); restarting in 10s`);
            this.tunnel = null;
            this.tunnelRestart = setTimeout(() => this.startTunnel(), 10000);
        });
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
                device.log('Phone connected');
                this.applyEntry(device, entry);
                // iOS 17+ phones need the helper to mount the developer image; get it ready in the background.
                if (device.iosMajor >= 17) setup.ensureHelper().catch(() => {});
            }
            if (this.wifi) {
                device.mode = this.wifi.mode(udid);
                device.connection = this.wifi.proxy.connectionOf(udid);
            }
            if (!device.online) {
                device.online = true;
                device.status = 'idle';
                device.log(`Phone reconnected${device.connection === 'wifi' ? ' over Wi-Fi' : ''}`);
            }
            if (!this.config.autoConnect) continue;
            // Phones waiting on you are re-checked every few seconds, so they continue by themselves.
            const retryAction = device.status === 'action' && Date.now() - device.actionAt > ACTION_RETRY_MS;
            if (device.status === 'idle' || retryAction) this.connect(udid).catch(() => {});
        }

        for (const device of this.devices.values()) {
            if (!seen.has(device.udid) && device.online) {
                device.log('Phone disconnected');
                device.online = false;
                device.connection = null;
                this.stopProcesses(device);
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
            const info = await goios.run(['info'], { udid: device.udid, timeout: 15000 });
            if (!info || typeof info !== 'object') throw new Error('no info');
            device.name = this.nicknames[device.udid] || info.DeviceName || device.name;
            device.model = info.ProductType || device.model;
            device.iosVersion = info.ProductVersion || device.iosVersion;
        } catch (e) {
            device.log(`Not trusted yet (${e.message}); asking the phone to trust this PC`);
            if (device.connection === 'wifi') throw ACTIONS.trustWifi(device); // trusting only works over USB
            await goios.run(['pair'], { udid: device.udid, timeout: 20000 }).catch(() => {});
            throw ACTIONS.trust(device);
        }
    }

    rename(udid, name) {
        const device = this.get(udid);
        device.name = name;
        this.nicknames[udid] = name;
        writeJson(NICKNAMES_FILE, this.nicknames);
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

    async _connect(device) {
        const { wda: wdaCfg, localPorts } = this.config;
        const udid = device.udid;
        this.stopProcesses(device);
        device.status = 'starting';
        device.error = '';
        device.action = null;

        try {
            device.step = 'Checking the phone trusts this PC';
            await this.checkTrusted(device);

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
                    udid,
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
                        udid,
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
            device.wda = client;
            device.mjpegHost = '127.0.0.1';
            device.mjpegPort = mjpegPort;
            // Over Wi-Fi, talk to the control app at the phone's own address: going through the
            // port forward adds several hops through Apple's service (measured ~2x fewer frames).
            if (device.connection === 'wifi') {
                const ip = await client
                    .status()
                    .then((st) => st?.ios?.ip)
                    .catch(() => null);
                const direct = ip && new WDAClient(`http://${ip}:${wdaCfg.devicePort}`);
                if (
                    direct &&
                    (await direct.status().then(
                        () => true,
                        () => false,
                    ))
                ) {
                    client.baseUrl = direct.baseUrl;
                    device.mjpegHost = ip;
                    device.mjpegPort = wdaCfg.mjpegDevicePort;
                    device.log(`Using the phone's Wi-Fi address ${ip}`);
                    // iPhones put Wi-Fi to sleep between packets (802.11 power save), which adds up to
                    // seconds of delay. A tiny packet every 15 ms keeps the radio awake: measured ~2x
                    // lower latency and more frames. Stopped with the phone's other processes.
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
            }
            device.status = 'ready';
            device.step = '';
            device.log(`Ready (screen ${client.size.width}x${client.size.height} pt)`);
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
                device.log(`Connect failed: ${e.message}`);
            }
            throw e;
        }
    }

    async checkDeveloperMode(device) {
        let out;
        try {
            out = await goios.run(['devmode', 'get'], { udid: device.udid, timeout: 15000 });
        } catch (e) {
            device.log(`Could not read Developer Mode (${e.message}); continuing`);
            return;
        }
        const text = JSON.stringify(out);
        if (/true|enabled/i.test(text) && !/false|disabled/i.test(text)) return;
        // Makes the Developer Mode switch appear in Settings, which iOS hides until asked.
        await goios.run(['devmode', 'reveal'], { udid: device.udid, timeout: 15000 }).catch(() => {});
        throw ACTIONS.devmode(device);
    }

    // go-ios fetches the image signature from gs.apple.com over HTTPS, which fails on
    // Windows because Apple's private CA isn't trusted there. pymobiledevice3 uses plain
    // HTTP for the same request, so fall back to it (the app installs it the first time).
    async mountDeveloperImage(device) {
        try {
            await goios.run(['image', 'auto'], { udid: device.udid, timeout: 180000 });
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
        const apps = await goios.run(['apps'], { udid: device.udid, timeout: 30000 });
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

    disconnect(udid) {
        const device = this.get(udid);
        this.stopProcesses(device);
        // 'stopped' (not 'idle') so auto-connect leaves a phone the user turned off alone.
        device.status = device.online ? 'stopped' : 'offline';
        device.log('Disconnected');
    }

    stopProcesses(device) {
        for (const p of device.procs) {
            try {
                p.removeAllListeners('exit');
                p.kill();
            } catch {}
        }
        device.procs = [];
        device.wda = null;
    }

    shutdown() {
        clearTimeout(this.timer);
        clearTimeout(this.tunnelRestart);
        for (const d of this.devices.values()) this.stopProcesses(d);
        if (this.tunnel) {
            this.tunnel.removeAllListeners('exit');
            this.tunnel.kill();
        }
    }
}

module.exports = { DeviceManager };
