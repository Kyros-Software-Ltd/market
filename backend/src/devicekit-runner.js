// Starts DeviceKit through pymobiledevice3's in-process userspace tunnel (needed for
// iOS 27 Wi-Fi where go-ios tunnel handshake fails), and proxies its HTTP/MJPEG port
// to localhost so DeviceKitClient stays unchanged.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const SCRIPT = path.join(__dirname, 'py', 'devicekit_runner.py');
const PAIR_RECORD = (udid) => path.join(os.homedir(), '.pymobiledevice3', `remote_${udid}.plist`);

function pairForWifi(python, udid, usbmux) {
    if (fs.existsSync(PAIR_RECORD(udid))) return Promise.resolve();
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

/**
 * @returns {import('node:child_process').ChildProcess & { ready: Promise<{ localPort: number }> }}
 */
function startDeviceKitRunner(python, { udid, localPort, bundleId, usbmux, wifi, onLog }) {
    const args = ['-u', SCRIPT, udid, String(localPort), bundleId];
    if (wifi) args.push('wifi');
    const child = spawn(python, args, {
        cwd: DATA_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', USBMUXD_SOCKET_ADDRESS: usbmux },
    });

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    child.ready = ready;

    let buf = '';
    const onData = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            onLog?.(line);
            try {
                const msg = JSON.parse(line);
                if (msg.ready) resolveReady({ localPort: msg.localPort || localPort });
            } catch {
                /* log line */
            }
        }
        buf += text;
        if (buf.length > 8000) buf = buf.slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
        onLog?.(`process error: ${e.message}`);
        rejectReady(e);
    });
    child.on('exit', (code) => {
        rejectReady(new Error(`DeviceKit runner exited (code ${code}). ${buf.trim().split('\n').pop() || ''}`.trim()));
    });

    return child;
}

module.exports = { pairForWifi, startDeviceKitRunner, PAIR_RECORD };
