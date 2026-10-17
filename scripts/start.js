#!/usr/bin/env node
// Starts Market: the backend (phones, automations, API on :4000) and the Next.js dashboard
// (:4100), then opens the dashboard in your browser.
//   npm start            build the dashboard if needed, run both, open the browser
//   npm run dev          same, with the dashboard in dev mode (hot reload)
//   ... --hidden         don't open the browser (used by Start with Windows and Claude)
// If Market is already running it just opens the browser. Ctrl+C stops everything.
// Updates: when you click Update, the backend exits with UPDATE_EXIT_CODE; this script then applies
// the release (backend/src/updater.js) and runs a fresh copy of itself, which rebuilds the dashboard.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const updater = require('../backend/src/updater');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const BACKEND_URL = 'http://127.0.0.1:4000';
const DASHBOARD_PORT = 4100;
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
const dev = process.argv.includes('--dev');
const hidden = process.argv.includes('--hidden');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const up = (url) =>
    fetch(url, { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.status < 500,
        () => false,
    );

function openBrowser() {
    if (hidden) return;
    if (process.platform === 'win32')
        spawn('cmd', ['/c', 'start', '', DASHBOARD_URL], { detached: true, stdio: 'ignore' }).unref();
    else
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [DASHBOARD_URL], {
            detached: true,
            stdio: 'ignore',
        }).unref();
}

const nextBin = () => require.resolve('next/dist/bin/next', { paths: [FRONTEND] });

(async () => {
    if ((await up(`${BACKEND_URL}/api/status`)) && (await up(DASHBOARD_URL))) {
        console.log(`Market is already running: ${DASHBOARD_URL}`);
        openBrowser();
        return;
    }

    // Build the dashboard on the first run and after every update.
    const stamp = path.join(FRONTEND, '.next', 'market-version');
    const built = fs.existsSync(path.join(FRONTEND, '.next', 'BUILD_ID')) && fs.existsSync(stamp);
    if (!dev && (!built || fs.readFileSync(stamp, 'utf8') !== updater.VERSION)) {
        console.log(
            built ? `Building the dashboard for ${updater.VERSION}…` : 'Building the dashboard (first run only)…',
        );
        const r = spawnSync(process.execPath, [nextBin(), 'build'], { cwd: FRONTEND, stdio: 'inherit' });
        if (r.status !== 0) process.exit(r.status || 1);
        fs.writeFileSync(stamp, updater.VERSION);
    }

    const children = [];
    const run = (name, args, cwd) => {
        const child = spawn(process.execPath, args, {
            cwd,
            stdio: hidden ? 'ignore' : 'inherit',
            windowsHide: true,
            env: { ...process.env, MARKET_SUPERVISED: '1' },
        });
        child.on('exit', (code) => {
            if (stopping) return;
            if (code === updater.UPDATE_EXIT_CODE) return update();
            console.log(`${name} stopped (${code}); stopping Market`);
            stop();
        });
        children.push(child);
    };

    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        for (const c of children) {
            try {
                c.kill();
            } catch {}
        }
        setTimeout(() => process.exit(0), 1500);
    };
    // Stop the dashboard, apply the update, then hand over to a fresh copy of this script.
    // It stays attached to this console so the terminal keeps showing Market's output.
    const update = async () => {
        stopping = true;
        for (const c of children) {
            try {
                c.kill();
            } catch {}
        }
        await sleep(1500); // let Windows release the files they had open
        console.log('\nUpdating Market…');
        await updater.applyPending();
        const args = process.argv.slice(2).filter((a) => a !== '--hidden');
        const next = spawn(process.execPath, [__filename, ...args, '--hidden'], {
            stdio: 'inherit',
            windowsHide: true,
        });
        next.on('exit', (code) => process.exit(code ?? 0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    run('Backend', [path.join(ROOT, 'backend', 'src', 'index.js')], path.join(ROOT, 'backend'));
    run('Dashboard', [nextBin(), dev ? 'dev' : 'start', '-p', String(DASHBOARD_PORT)], FRONTEND);

    for (let i = 0; i < 120; i++) {
        if ((await up(`${BACKEND_URL}/api/status`)) && (await up(DASHBOARD_URL))) {
            console.log(`\n  Market is running: ${DASHBOARD_URL}\n`);
            openBrowser();
            return;
        }
        await sleep(500);
    }
    console.log('Market is taking a while to start; open', DASHBOARD_URL, 'when it is ready.');
})();
