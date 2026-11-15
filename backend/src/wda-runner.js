// Starts WebDriverAgent through pymobiledevice3 userspace RSD (iOS 27 Wi-Fi when
// go-ios tunnel fails). Proxies device 8100+9100 to local ports so WDAClient and
// the MJPEG hub stay unchanged.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const SCRIPT = path.join(__dirname, 'py', 'wda_runner.py');
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
 * @returns {import('node:child_process').ChildProcess & { ready: Promise<{ wdaPort: number, mjpegPort: number }> }}
 */
function startWdaRunner(python, { udid, wdaPort, mjpegPort, bundleId, usbmux, wifi, phoneIp, devicePorts, onLog }) {
    const args = ['-u', SCRIPT, udid, String(wdaPort), String(mjpegPort), bundleId, wifi ? 'wifi' : 'usb'];
    if (devicePorts) args.push(String(devicePorts.wda), String(devicePorts.mjpeg));
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', USBMUXD_SOCKET_ADDRESS: usbmux };
    if (phoneIp) env.MARKET_PHONE_IP = phoneIp;

    const child = spawn(python, args, {
        cwd: DATA_DIR,
        windowsHide: true,
        env,
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
                if (msg.ready) {
                    resolveReady({
                        wdaPort: msg.wdaPort || wdaPort,
                        mjpegPort: msg.mjpegPort || mjpegPort,
                    });
                }
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
        rejectReady(new Error(`WDA runner exited (code ${code}). ${buf.trim().split('\n').pop() || ''}`.trim()));
    });

    return child;
}

module.exports = { pairForWifi, startWdaRunner, PAIR_RECORD };
