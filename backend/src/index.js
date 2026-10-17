const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const sharp = require('sharp');
const { ROOT, DATA_DIR, prepareDataDir, loadConfig } = require('./paths');
const desktop = require('./desktop');
const { DeviceManager } = require('./devices');
const setup = require('./setup');
const updater = require('./updater');
const account = require('./account');
const sideload = require('./sideload');
const media = require('./media');
const { Controller } = require('./control');
const { AutomationRunner } = require('./automations');
const { Scheduler } = require('./scheduler');
const { UsbmuxProxy } = require('./usbmux-proxy');
const { Wifi } = require('./wifi');

const config = loadConfig();
const MCP_SCRIPT = path.join(ROOT, 'mcp', 'phones-mcp.js');

function createApp() {
    prepareDataDir();
    // Every phone tool (go-ios, the Python helper) goes through Market's usbmux proxy, which
    // passes USB straight to Apple's service and adds phones set to connect over Wi-Fi.
    const proxy = new UsbmuxProxy({
        port: config.usbmuxProxyPort,
        applePort: config.appleUsbmuxPort,
        log: (l) => console.log(l),
    });
    process.env.USBMUXD_SOCKET_ADDRESS = proxy.address;
    const wifi = new Wifi(proxy, config.appleUsbmuxPort);
    const devices = new DeviceManager(config);
    devices.wifi = wifi;
    const control = new Controller(devices);
    const runner = new AutomationRunner(devices, control);
    const scheduler = new Scheduler(devices, runner);
    runner.registerBuiltin(media.sendAutomation);

    const app = express();
    // Only answer requests addressed to this PC (localhost, 127.0.0.1, ::1). A website can point its own
    // domain at 127.0.0.1 (DNS rebinding) and then talk to this API from your browser; its Host header
    // gives it away.
    app.use((req, res, next) => {
        let hostname = '';
        try {
            hostname = new URL(`http://${req.headers.host || ''}`).hostname;
        } catch {}
        if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return next();
        res.status(403).json({ error: 'Market only answers requests to localhost.' });
    });
    app.use(express.json({ limit: '2mb' }));

    // Wrap async handlers so thrown errors become JSON responses.
    const api = (fn) => async (req, res) => {
        try {
            res.json((await fn(req, res)) ?? { ok: true });
        } catch (e) {
            res.status(e.status || 400).json({ error: e.message });
        }
    };
    // ---------- AffRev account: the packaged app is locked until someone signs in ----------
    app.get(
        '/api/account',
        api(() => account.status()),
    );
    app.post(
        '/api/account/sign-in',
        api((req) => ({ url: account.signInUrl(String(req.body.origin || '')) })),
    );
    // AffRev sends the browser back here (through the dashboard's /api proxy) with this PC's token.
    app.get('/api/account/callback', async (req, res) => {
        try {
            await account.finishSignIn({ token: String(req.query.token || ''), state: String(req.query.state || '') });
            updater.check(); // the packaged app gets its updates through this account
            res.redirect('/');
        } catch (e) {
            res.redirect(`/?signin_error=${encodeURIComponent(e.message)}`);
        }
    });
    app.post(
        '/api/account/sign-out',
        api(() => account.signOut()),
    );
    // Everything else waits for the sign-in. Updates stay open so a locked copy can still update.
    app.use('/api', (req, res, next) => {
        if (account.allowed() || req.path.startsWith('/update')) return next();
        res.status(401).json({ error: 'Sign in with AffRev to use Market.', signIn: true });
    });

    // Who sent a request: the MCP server marks Claude's requests so the app can show them.
    const actor = (req) => (req.get('x-actor') === 'claude' ? 'claude' : 'you');

    app.get(
        '/api/status',
        api(() => ({
            devices: devices.list(),
            jobs: runner.listJobs(60),
            usbError: devices.lastListError,
            activity: control.activity.slice(-60),
        })),
    );

    app.get(
        '/api/devices/:udid/logs',
        api((req) => ({ logs: devices.get(req.params.udid).logs })),
    );
    app.post(
        '/api/devices/:udid/connect',
        api(async (req) => {
            await devices.connect(req.params.udid);
        }),
    );
    app.post(
        '/api/devices/:udid/disconnect',
        api((req) => {
            devices.disconnect(req.params.udid);
        }),
    );
    // Connection choice: 'usb' (USB only) or 'wifi' (USB + Wi-Fi, cable first).
    app.post(
        '/api/devices/:udid/connection',
        api(async (req) => {
            const mode = req.body.mode === 'wifi' ? 'wifi' : 'usb';
            const out = await wifi.setMode(req.params.udid, mode);
            try {
                devices.get(req.params.udid).mode = mode;
            } catch {
                /* not connected right now */
            }
            return out;
        }),
    );
    // Phones already trusted with this PC that Apple's service sees on Wi-Fi but aren't set to use it.
    app.get(
        '/api/wifi/found',
        api(() => wifi.found()),
    );
    app.post(
        '/api/devices/:udid/rename',
        api((req) => {
            devices.rename(req.params.udid, String(req.body.name || '').trim());
        }),
    );
    app.get(
        '/api/devices/:udid/apps',
        api((req) => devices.listApps(req.params.udid, { refresh: req.query.refresh === '1' })),
    );
    app.get(
        '/api/devices/:udid/elements',
        api((req) => control.elements(req.params.udid)),
    );

    app.get('/api/devices/:udid/screenshot', async (req, res) => {
        try {
            const png = await control.readyWda(req.params.udid).screenshot();
            res.type('png').send(Buffer.from(png, 'base64'));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // The phone's MJPEG screen stream, passed through so the UI can read it same-origin
    // (WDA sends no CORS headers) and paint frames itself instead of via <img>.
    app.get('/api/devices/:udid/stream', (req, res) => {
        let port;
        let host;
        try {
            ({ mjpegPort: port, mjpegHost: host } = devices.get(req.params.udid));
        } catch (e) {
            return res.status(404).json({ error: e.message });
        }
        if (!port) return res.status(409).json({ error: 'Phone is not streaming' });
        const upstream = http.get({ host: host || '127.0.0.1', port, path: '/' }, (up) => {
            res.writeHead(up.statusCode || 200, {
                'Content-Type': up.headers['content-type'] || 'multipart/x-mixed-replace',
                'Cache-Control': 'no-store',
            });
            up.pipe(res);
        });
        upstream.on('error', (e) => {
            if (!res.headersSent) res.status(502).json({ error: e.message });
            else res.end();
        });
        req.on('close', () => upstream.destroy());
    });

    // What Claude "sees": the screen scaled to the phone's size in points (so a pixel
    // in the image is exactly a tap coordinate), plus the labelled elements on screen.
    app.get(
        '/api/devices/:udid/look',
        api(async (req) => {
            const udid = req.params.udid;
            const wda = control.readyWda(udid);
            const { width, height } = wda.size;
            const [png, elements] = await Promise.all([
                wda.screenshot(),
                req.query.elements === '0' ? null : control.elements(udid).catch((e) => ({ error: e.message })),
            ]);
            let image = png;
            let mime = 'image/png';
            // Scaled so one pixel is one tap point, and JPEG to keep it small for Claude.
            try {
                image = (
                    await sharp(Buffer.from(png, 'base64')).resize(width, height).jpeg({ quality: 72 }).toBuffer()
                ).toString('base64');
                mime = 'image/jpeg';
            } catch {
                /* send the original PNG */
            }
            control.note(udid, actor(req), 'looked at the screen');
            return { phone: devices.get(udid).name, width, height, mime, image, elements };
        }),
    );

    // POST /api/control/:action  { udids: [...], ...args }
    app.post(
        '/api/control/:action',
        api(async (req) => {
            const results = await control.actMany(req.body.udids || [], req.params.action, req.body, actor(req));
            return { ok: true, results };
        }),
    );

    app.get(
        '/api/automations',
        api(() => runner.listAutomations()),
    );
    app.post(
        '/api/automations/:id/run',
        api((req) => runner.start(req.params.id, req.body.udids || [], req.body.params, actor(req))),
    );
    app.get(
        '/api/flows/:id',
        api(
            (req) =>
                runner.getFlow(req.params.id) ||
                Promise.reject(Object.assign(new Error('No such flow'), { status: 404 })),
        ),
    );
    app.post(
        '/api/flows/:id',
        api((req) => runner.saveFlow(req.params.id, req.body)),
    );
    app.delete(
        '/api/flows/:id',
        api((req) => {
            runner.deleteFlow(req.params.id);
        }),
    );

    app.get(
        '/api/jobs',
        api((req) => runner.listJobs(Number(req.query.limit) || 100)),
    );
    app.post(
        '/api/jobs/:id/stop',
        api((req) => {
            runner.stop(req.params.id);
        }),
    );
    app.post(
        '/api/jobs/stop-all',
        api(() => {
            runner.stopAll();
        }),
    );
    app.post(
        '/api/jobs/clear',
        api(() => {
            runner.clearFinished();
        }),
    );

    // ---------- media library: photos/videos on the PC, sent to phones ----------
    app.get(
        '/api/media',
        api(() => media.list()),
    );
    // Raw upload: the file is the request body, its name is ?name=.
    app.post(
        '/api/media',
        api((req) => media.save(req.query.name, req)),
    );
    app.get('/api/media/file/:name', (req, res) => {
        try {
            res.sendFile(media.filePath(req.params.name));
        } catch (e) {
            res.status(e.status || 400).json({ error: e.message });
        }
    });
    app.delete(
        '/api/media/:name',
        api((req) => {
            media.remove(req.params.name);
        }),
    );
    app.post(
        '/api/media/send',
        api((req) =>
            media.send(
                runner,
                req.body.names,
                req.body.udids || [],
                { saveToPhotos: req.body.saveToPhotos !== false },
                actor(req),
            ),
        ),
    );
    app.post(
        '/api/open-media-folder',
        api(() => {
            fs.mkdirSync(media.LIBRARY, { recursive: true });
            desktop.openPath(media.LIBRARY);
        }),
    );

    app.get(
        '/api/schedules',
        api(() => ({ schedules: scheduler.list(), log: scheduler.log.slice(-50) })),
    );
    app.post(
        '/api/schedules',
        api((req) => scheduler.save(req.body)),
    );
    app.delete(
        '/api/schedules/:id',
        api((req) => {
            scheduler.remove(req.params.id);
        }),
    );

    // ---------- setup: USB driver, control app, helpers ----------
    app.get(
        '/api/setup',
        api(async () => ({
            ...(await setup.status()),
            usbOk: !devices.lastListError,
            usbError: devices.lastListError,
        })),
    );
    // Built-in sideloading with the user's Apple ID (see sideload.js).
    app.get(
        '/api/sideload',
        api(() => sideload.status()),
    );
    app.post(
        '/api/sideload/sign-in',
        api((req) => sideload.signIn(req.body.appleId, req.body.password)),
    );
    app.post(
        '/api/sideload/sign-out',
        api(() => sideload.signOut()),
    );
    app.post(
        '/api/sideload/install',
        api((req) => {
            const udids = Array.isArray(req.body.udids) ? req.body.udids : [req.body.udid];
            for (const udid of udids.filter(Boolean)) sideload.install(String(udid));
        }),
    );
    app.post(
        '/api/sideload/two-factor',
        api((req) => sideload.answerTwoFactor(req.body.response)),
    );
    app.post(
        '/api/sideload/cancel',
        api(() => sideload.cancel()),
    );
    app.get(
        '/api/settings',
        api(() => ({
            desktop: process.platform === 'win32',
            openAtLogin: desktop.openAtLogin(),
        })),
    );
    app.post(
        '/api/settings',
        api((req) => {
            if (typeof req.body.openAtLogin === 'boolean') desktop.setOpenAtLogin(req.body.openAtLogin);
        }),
    );
    // Updates from the repo's GitHub Releases; start.js applies them (see updater.js).
    app.get(
        '/api/update',
        api(() => updater.status()),
    );
    app.post(
        '/api/update/check',
        api(async () => {
            await updater.check();
            return updater.status();
        }),
    );
    app.post(
        '/api/update',
        api(() => {
            if (runner.listJobs(200).some((j) => j.status === 'running'))
                throw new Error('Automations are running. Stop them or let them finish, then update.');
            return updater.requestApply();
        }),
    );
    app.post(
        '/api/open-folder',
        api((req) => {
            const target = req.body.which === 'automations' ? path.join(DATA_DIR, 'automations') : DATA_DIR;
            desktop.openPath(target);
        }),
    );

    app.get(
        '/api/claude',
        api(() => ({
            mcpScript: MCP_SCRIPT,
            claudeCodeCommand: claudeCodeCommand(),
            desktopConfigs: claudeDesktopConfigs().map((file) => ({ file, connected: isConnected(file) })),
            activity: control.activity.filter((a) => a.actor === 'claude').slice(-100),
        })),
    );
    app.post(
        '/api/claude/connect-desktop',
        api(() => connectClaudeDesktop()),
    );

    return { app, devices, control, runner, scheduler, proxy, wifi };
}

// ---------- Claude Desktop hookup ----------
// Claude Desktop reads MCP servers from claude_desktop_config.json. The Microsoft
// Store build keeps it inside its package folder, so check both places.
function claudeDesktopConfigs() {
    const found = [];
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    found.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
    const packages = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    try {
        for (const dir of fs.readdirSync(packages)) {
            if (/^(Anthropic\.)?Claude/i.test(dir))
                found.push(path.join(packages, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
        }
    } catch {}
    return found;
}

function isConnected(file) {
    try {
        return !!JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['marketing-phones'];
    } catch {
        return false;
    }
}

// Runs the MCP script with the same Node that runs Market.
function mcpEntry() {
    return { command: process.execPath, args: [MCP_SCRIPT] };
}

function claudeCodeCommand() {
    const e = mcpEntry();
    const env = Object.entries(e.env || {})
        .map(([k, v]) => `-e ${k}=${v} `)
        .join('');
    return `claude mcp add --scope user marketing-phones ${env}-- "${e.command}" "${e.args[0]}"`;
}

function connectClaudeDesktop() {
    const files = claudeDesktopConfigs().filter((f, i) => i === 0 || fs.existsSync(path.dirname(f)));
    for (const file of files) {
        let cfg = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            try {
                cfg = JSON.parse(raw);
            } catch {
                throw new Error(`${file} isn't valid JSON; fix or delete it first`);
            }
            fs.writeFileSync(`${file}.bak`, raw);
        }
        cfg.mcpServers = { ...(cfg.mcpServers || {}), 'marketing-phones': mcpEntry() };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    }
    return { files };
}

/** Starts everything. Resolves once the dashboard is listening. */
// go-ios processes from a crashed earlier run keep the phones' ports busy; clear them first.
function killLeftovers() {
    if (process.platform !== 'win32') return Promise.resolve();
    return new Promise((resolve) => {
        require('node:child_process').execFile(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                "Get-Process ios -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*go-ios*' } | Stop-Process -Force",
            ],
            { windowsHide: true, timeout: 10000 },
            () => resolve(),
        );
    });
}

async function start({ port = config.port } = {}) {
    await killLeftovers();
    const ctx = createApp();
    return new Promise((resolve, reject) => {
        const server = ctx.app.listen(port, '127.0.0.1', () => {
            ctx.proxy.start();
            ctx.devices.start();
            ctx.scheduler.start();
            account.start();
            sideload.start(ctx.devices);
            updater.start();
            const shutdown = () => {
                ctx.runner.stopAll();
                ctx.scheduler.stop();
                ctx.devices.shutdown();
                server.close();
            };
            resolve({ ...ctx, port, url: `http://127.0.0.1:${port}`, shutdown });
        });
        server.on('error', reject);
    });
}

module.exports = { start };

if (require.main === module) {
    start()
        .then(({ url, shutdown }) => {
            console.log(`\n  Market is running:  ${url}\n`);
            const stop = () => {
                shutdown();
                process.exit(0);
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            updater.onApply(() => {
                shutdown();
                process.exit(updater.UPDATE_EXIT_CODE);
            });
        })
        .catch((e) => {
            console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is in use. Is Market already open?` : e);
            process.exit(1);
        });
}
