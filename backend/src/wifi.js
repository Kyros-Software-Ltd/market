// Each phone's connection choice: USB only (the default) or USB + Wi-Fi, where the phone
// uses the cable when it's plugged in and Wi-Fi when it isn't. Wi-Fi needs the phone to
// trust this PC and have Wi-Fi connections switched on, both of which happen over USB once.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DATA_DIR, PY_DIR, readJson, writeJson } = require('./paths');
const setup = require('./setup');
const goios = require('./goios');

const FILE = path.join(DATA_DIR, 'connections.json');
const SCRIPT = path.join(PY_DIR, 'wifi.py');

class Wifi {
    constructor(proxy, applePort) {
        this.proxy = proxy;
        this.apple = `127.0.0.1:${applePort}`;
        this.data = readJson(FILE, {}); // udid -> { mode, wifiMac }
        this.names = new Map(); // udid -> { name, model, iosVersion } for phones found on Wi-Fi
        this.syncProxy();
    }

    mode(udid) {
        return this.data[udid]?.mode === 'wifi' ? 'wifi' : 'usb';
    }

    syncProxy() {
        this.proxy.setWifiAllowed(Object.keys(this.data).filter((u) => this.mode(u) === 'wifi'));
    }

    save() {
        writeJson(FILE, this.data);
        this.syncProxy();
    }

    async helper(cmd, udid) {
        const python = await setup.ensureHelper();
        return new Promise((resolve, reject) => {
            execFile(
                python,
                ['-I', SCRIPT, cmd, udid],
                { windowsHide: true, timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
                (err, stdout, stderr) => {
                    let out;
                    try {
                        out = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
                    } catch {
                        return reject(
                            new Error((stderr || err?.message || 'Wi-Fi helper failed').trim().split('\n').pop()),
                        );
                    }
                    if (!out.ok) return reject(new Error(out.error));
                    resolve(out);
                },
            );
        });
    }

    /** Switches a phone between 'usb' and 'wifi'. Turning Wi-Fi on needs the cable, unless the phone is already found on Wi-Fi. */
    async setMode(udid, mode) {
        const via = this.proxy.connectionOf(udid);
        if (mode === 'wifi') {
            const entry = this.data[udid] || {};
            if (via === 'usb') {
                const r = await this.helper('enable', udid);
                entry.wifiMac = r.wifiMac;
            } else if (!this.proxy.networkUdids().has(udid)) {
                throw new Error('Plug the phone in once to switch on Wi-Fi');
            }
            this.data[udid] = { ...entry, mode: 'wifi' };
        } else {
            // Over USB, also switch the phone's Wi-Fi connections off so it stops advertising itself.
            if (via === 'usb') await this.helper('disable', udid).catch(() => {});
            this.data[udid] = { ...this.data[udid], mode: 'usb' };
        }
        this.save();
        return this.info(udid);
    }

    info(udid) {
        return {
            mode: this.mode(udid),
            connection: this.proxy.connectionOf(udid),
            onWifi: this.proxy.networkUdids().has(udid),
        };
    }

    /** Phones Apple's service sees on Wi-Fi that aren't set to use it yet (already trusted with this PC). */
    async found() {
        const out = [];
        for (const udid of this.proxy.networkUdids()) {
            if (this.mode(udid) === 'wifi') continue;
            if (!this.names.has(udid)) {
                const info = await goios.run(['info'], { udid, usbmux: this.apple, timeout: 15000 }).catch(() => null);
                if (info && typeof info === 'object')
                    this.names.set(udid, {
                        name: info.DeviceName,
                        model: info.ProductType,
                        iosVersion: info.ProductVersion,
                    });
            }
            out.push({ udid, ...(this.names.get(udid) || {}) });
        }
        return out;
    }
}

module.exports = { Wifi };
