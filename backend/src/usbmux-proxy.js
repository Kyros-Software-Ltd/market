// Market's usbmux front door. go-ios and pymobiledevice3 talk to this instead of Apple's
// usbmuxd (127.0.0.1:27015, from Apple Devices / iTunes) and everything is passed through,
// except the device list:
//  - Apple's service also finds phones over Wi-Fi once their Wi-Fi connections are on
//    ("Network" entries). Those are only shown for phones set to USB + Wi-Fi, and only
//    while the same phone isn't plugged in (cable first).
//  - Shown Wi-Fi entries are relabelled as ordinary connections, because go-ios refuses to
//    build its iOS 17+ tunnel for "Network" devices even though it works over Wi-Fi.
// Market itself asks connectionOf() to know which phones are really on Wi-Fi.
//
// Wire format: 16-byte little-endian header {length, version 1, type 8 (plist), tag}
// followed by an XML plist.
const net = require('node:net');
const plist = require('plist');

const SWITCH_GAP_MS = 6000; // longer than Market's 3 s device check, so it always notices

function frame(obj, tag) {
    const body = Buffer.from(plist.build(obj), 'utf8');
    const h = Buffer.alloc(16);
    h.writeUInt32LE(16 + body.length, 0);
    h.writeUInt32LE(1, 4);
    h.writeUInt32LE(8, 8);
    h.writeUInt32LE(tag, 12);
    return Buffer.concat([h, body]);
}

/** Splits complete messages off a buffer: [[{tag, raw, body}], rest]. */
function split(buf) {
    const out = [];
    let o = 0;
    while (buf.length - o >= 16) {
        const len = buf.readUInt32LE(o);
        if (len < 16 || buf.length - o < len) break;
        const raw = buf.subarray(o, o + len);
        let body = null;
        try {
            body = plist.parse(raw.subarray(16).toString('utf8'));
        } catch {
            /* not a plist */
        }
        out.push({ tag: raw.readUInt32LE(12), raw, body });
        o += len;
    }
    return [out, buf.subarray(o)];
}

class UsbmuxProxy {
    constructor({ port = 27115, applePort = 27015, log = () => {} } = {}) {
        this.port = port;
        this.applePort = applePort;
        this.log = log;
        this.devices = new Map(); // Apple DeviceID -> { udid, network } for everything Apple sees
        this.wifiAllowed = new Set(); // udids set to USB + Wi-Fi
        this.listeners = new Set(); // client sockets subscribed with Listen
        this.shown = new Set(); // Apple DeviceIDs currently shown to clients
        this.lastShown = new Map(); // udid -> the DeviceID it was last shown with
        this.gapUntil = new Map(); // udid -> end of its USB <-> Wi-Fi switch gap
    }

    get address() {
        return `127.0.0.1:${this.port}`;
    }

    start() {
        this.server = net.createServer((c) => this.client(c));
        this.server.on('error', (e) => this.log(`usbmux proxy: ${e.message}`));
        this.server.listen(this.port, '127.0.0.1');
        this.watch();
    }

    /** Which phones may connect over Wi-Fi. */
    setWifiAllowed(udids) {
        this.wifiAllowed = new Set(udids);
        this.publish();
    }

    /** 'usb' | 'wifi' | null: how a phone is connected as far as Market's tools see it. */
    connectionOf(udid) {
        for (const id of this.shown) {
            const d = this.devices.get(id);
            if (d?.udid === udid) return d.network ? 'wifi' : 'usb';
        }
        return null;
    }

    /** Udids Apple currently sees over Wi-Fi (whether or not they're shown). */
    networkUdids() {
        return new Set([...this.devices.values()].filter((d) => d.network).map((d) => d.udid));
    }

    visible(id) {
        const d = this.devices.get(id);
        if (!d) return false;
        if (!d.network) return true;
        if (!this.wifiAllowed.has(d.udid)) return false;
        return ![...this.devices.values()].some((o) => !o.network && o.udid === d.udid); // cable first
    }

    /** An Apple device entry as clients should see it. */
    rewrite(entry) {
        if (entry?.Properties?.ConnectionType !== 'Network') return entry;
        return { ...entry, Properties: { ...entry.Properties, ConnectionType: 'USB' } };
    }

    /** Recomputes what's shown and sends Attached/Detached to Listen clients for changes. */
    publish() {
        const now = Date.now();
        const next = new Set();
        for (const id of this.devices.keys()) {
            if (!this.visible(id)) continue;
            const udid = this.devices.get(id).udid;
            // Switching between USB and Wi-Fi: hide the phone briefly so go-ios drops its old
            // tunnel and Market restarts the control app, instead of both clinging to a dead link.
            const before = this.lastShown.get(udid);
            if (before !== undefined && before !== id && !this.gapUntil.has(udid)) {
                this.gapUntil.set(udid, now + SWITCH_GAP_MS);
                setTimeout(() => {
                    this.gapUntil.delete(udid);
                    this.publish();
                }, SWITCH_GAP_MS + 50);
            }
            if (this.gapUntil.has(udid)) continue;
            next.add(id);
        }
        for (const id of next) this.lastShown.set(this.devices.get(id).udid, id);
        const events = [];
        for (const id of this.shown) if (!next.has(id)) events.push({ MessageType: 'Detached', DeviceID: id });
        for (const id of next) if (!this.shown.has(id)) events.push(this.rewrite(this.devices.get(id).entry));
        this.shown = next;
        for (const c of this.listeners) for (const e of events) c.write(frame(e, 0));
    }

    // Our own Listen on Apple's service: the full picture of USB and Wi-Fi phones.
    watch() {
        const s = net.connect(this.applePort, '127.0.0.1');
        let buf = Buffer.alloc(0);
        // kLibUSBMuxVersion 3: Apple only reports Wi-Fi phones to clients that ask for them.
        s.on('connect', () =>
            s.write(
                frame(
                    { MessageType: 'Listen', ClientVersionString: 'market', ProgName: 'market', kLibUSBMuxVersion: 3 },
                    1,
                ),
            ),
        );
        s.on('data', (d) => {
            let msgs;
            [msgs, buf] = split(Buffer.concat([buf, d]));
            for (const { body } of msgs) {
                if (body?.MessageType === 'Attached') {
                    this.devices.set(body.DeviceID, {
                        udid: body.Properties?.SerialNumber,
                        network: body.Properties?.ConnectionType === 'Network',
                        entry: body,
                    });
                } else if (body?.MessageType === 'Detached') {
                    this.devices.delete(body.DeviceID);
                } else continue;
                this.publish();
            }
        });
        s.on('error', () => {});
        s.on('close', () => {
            this.devices.clear();
            this.publish();
            setTimeout(() => this.watch(), 3000);
        });
    }

    client(c) {
        const up = net.connect(this.applePort, '127.0.0.1');
        let raw = false; // after Connect, both ways are a plain pipe
        let inBuf = Buffer.alloc(0);
        let upBuf = Buffer.alloc(0);
        const pendingList = new Set(); // ListDevices tags awaiting Apple's reply
        let listening = false;

        const closeAll = () => {
            c.destroy();
            up.destroy();
            this.listeners.delete(c);
        };
        c.on('error', closeAll);
        c.on('close', closeAll);
        up.on('error', closeAll);
        up.on('close', closeAll);

        up.on('data', (d) => {
            if (raw === true) {
                c.write(d);
                return;
            }
            upBuf = Buffer.concat([upBuf, d]);
            if (raw === 'pending') {
                // Apple's reply to Connect, then (maybe in the same chunk) the phone's own bytes.
                if (upBuf.length < 16 || upBuf.length < upBuf.readUInt32LE(0)) return;
                raw = true;
                c.write(upBuf);
                upBuf = Buffer.alloc(0);
                return;
            }
            let msgs;
            [msgs, upBuf] = split(upBuf);
            for (const m of msgs) {
                if (pendingList.has(m.tag) && Array.isArray(m.body?.DeviceList)) {
                    pendingList.delete(m.tag);
                    const list = m.body.DeviceList.filter((e) => this.visible(e.DeviceID)).map((e) => this.rewrite(e));
                    c.write(frame({ ...m.body, DeviceList: list }, m.tag));
                } else if (listening && (m.body?.MessageType === 'Attached' || m.body?.MessageType === 'Detached')) {
                    // Device events come from publish() so hidden Wi-Fi entries never leak through.
                } else {
                    c.write(m.raw);
                }
            }
        });

        c.on('data', (d) => {
            if (raw) {
                up.write(d);
                return;
            }
            let msgs;
            [msgs, inBuf] = split(Buffer.concat([inBuf, d]));
            for (let i = 0; i < msgs.length; i++) {
                const { tag, raw: bytes, body } = msgs[i];
                const type = body?.MessageType;
                if (type === 'ListDevices') pendingList.add(tag);
                if (type === 'Listen') {
                    listening = true;
                    this.listeners.add(c);
                    // Apple answers with a Result; then send what's currently shown.
                    setTimeout(() => {
                        if (!c.destroyed)
                            for (const id of this.shown) c.write(frame(this.rewrite(this.devices.get(id).entry), 0));
                    }, 50);
                }
                if (type === 'Connect') {
                    raw = 'pending';
                    up.write(Buffer.concat([bytes, ...msgs.slice(i + 1).map((m) => m.raw), inBuf]));
                    inBuf = Buffer.alloc(0);
                    return;
                }
                up.write(bytes);
            }
        });
    }
}

module.exports = { UsbmuxProxy };
