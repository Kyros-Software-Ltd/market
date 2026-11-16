// Keeps one phone connected. It runs that phone's worker (py/phone_worker.py), mirrors what
// the worker says onto the phone's card, and starts a fresh worker whenever one stops.
// That restart is the only retry in Market: nothing else tries to repair a connection.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DATA_DIR, PY_DIR } = require('./paths');
const setup = require('./setup');

const SCRIPT = path.join(PY_DIR, 'phone_worker.py');
// The first restart is immediate: most drops are one-offs (a cable pulled, an app re-signed).
const BACKOFF_MS = [0, 2000, 5000, 15000, 30000];
// The phone clears these by itself once the person has done the step, so keep checking.
const SELF_CLEARING = ['unlock', 'trust', 'trust-developer', 'devmode'];
const ACTION_RECHECK_MS = 8000;
const HEALTH_EVERY_MS = 5000;
const HEALTH_MISSES = 3;
// A worker that says nothing for this long is stuck.
const QUIET_LIMIT_MS = 100000;
const QUIET_LIMIT_MOUNT_MS = 330000; // the developer image can be a slow download

// Starting Python and loading the iOS libraries takes about 2 seconds, so one worker is kept
// started and waiting. A connect hands it its phone and a new spare is started behind it.
let spare = null;

function startSpare(python) {
    if (spare) return;
    const child = spawn(python, ['-u', SCRIPT, '--standby'], {
        cwd: DATA_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    spare = child;
    const gone = () => {
        if (spare === child) spare = null;
    };
    child.on('exit', gone);
    child.on('error', gone);
    child.stdin.on('error', () => {});
}

function stopSpare() {
    const child = spare;
    spare = null;
    try {
        child?.kill();
    } catch {}
}

/** A worker for one phone: the waiting spare if there is one, otherwise a fresh process. */
function startWorker(python, args, env) {
    let child = spare;
    spare = null;
    if (child && child.exitCode === null && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ argv: args, env })}
`);
    } else {
        child = spawn(python, ['-u', SCRIPT, ...args], {
            cwd: DATA_DIR,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env },
        });
        child.stdin.on('error', () => {});
    }
    startSpare(python);
    return child;
}

class PhoneSupervisor {
    /**
     * @param hooks.spawnOptions () => { ports, devicePorts, env }
     * @param hooks.onReady      async ({ wdaPort, mjpegPort, bundleId }) => client   (throws if WDA does not answer)
     * @param hooks.onLive       (client, msg) => void   the phone is ready to use
     * @param hooks.onAction     (kind) => void
     * @param hooks.onDown       () => void   the worker is gone: drop the client and the live view
     */
    constructor(device, hooks) {
        this.device = device;
        this.hooks = hooks;
        this.wanted = false;
        this.child = null;
        this.failures = 0;
        this.timer = null; // next start
        this.spawning = false;
        this.parked = false; // waiting for the person to install or renew the control app
        this.rechecking = false; // quietly checking whether the person has done what was asked
        this.restarting = false; // the running worker was stopped on purpose to start a new one
        this.health = null;
        this.quiet = null;
        this.waiters = []; // connect() callers waiting for the next outcome
    }

    /** Start (or start over). Resolves when the phone is ready, rejects when it needs the person or fails. */
    connect() {
        this.wanted = true;
        this.failures = 0;
        this.parked = false;
        this.rechecking = false;
        const outcome = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
        this.restart();
        return outcome;
    }

    /** Make sure a worker is running or scheduled, without disturbing one that is. */
    ensure() {
        if (this.wanted && (this.child || this.timer || this.spawning || this.parked)) return;
        this.wanted = true;
        this.failures = 0;
        this.schedule(0);
    }

    stop() {
        this.wanted = false;
        this.parked = false;
        this.restarting = false;
        clearTimeout(this.timer);
        this.timer = null;
        this.settle(new Error('Disconnected'));
        this.kill();
        this.hooks.onDown();
    }

    restart() {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.child) {
            this.restarting = true; // its exit starts the next one, and is not a failure
            this.kill();
        } else this.schedule(0);
    }

    kill() {
        clearInterval(this.health);
        clearTimeout(this.quiet);
        this.health = null;
        const child = this.child;
        if (!child) return;
        try {
            child.kill();
        } catch {}
    }

    settle(error, value) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) error ? w.reject(error) : w.resolve(value);
    }

    schedule(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.spawning = true;
            this.spawn()
                .catch((e) => this.failed(e.message))
                .finally(() => {
                    this.spawning = false;
                });
        }, ms);
    }

    failed(message) {
        const { device } = this;
        this.hooks.onDown();
        if (!this.wanted) return;
        const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
        this.failures++;
        device.status = 'error';
        device.step = '';
        device.error = message;
        device.log(wait ? `${message} — trying again in ${Math.round(wait / 1000)}s` : `${message} — reconnecting`);
        this.settle(new Error(message));
        this.schedule(wait);
    }

    watchQuiet(limit = QUIET_LIMIT_MS) {
        clearTimeout(this.quiet);
        this.quiet = setTimeout(() => {
            this.device.log('The phone stopped answering during setup; starting over');
            this.kill();
        }, limit);
    }

    async spawn() {
        if (!this.wanted || this.child) return;
        const { device } = this;
        // While re-checking, the card keeps showing what the person has to do instead of
        // flickering through the setup steps every few seconds.
        const quiet = this.rechecking && device.status === 'action';
        this.rechecking = false;
        if (!quiet) {
            device.status = 'starting';
            device.step = 'Getting the iOS helper ready';
            device.error = '';
            device.action = null;
        }
        const python = await setup.ensureHelper((s) => {
            if (!quiet) device.step = s;
        });
        if (!this.wanted || this.child) return;

        const { ports, devicePorts, env } = this.hooks.spawnOptions();
        const child = startWorker(
            python,
            [device.udid, String(ports.wda), String(ports.mjpeg), String(devicePorts.wda), String(devicePorts.mjpeg)],
            env,
        );
        this.child = child;
        if (!quiet) device.log('Connecting');
        this.watchQuiet();

        let outcome = null; // what this worker reported before it stopped: 'action' | 'dead'
        let lastError = '';
        let rest = '';
        const onData = (chunk) => {
            const lines = (rest + chunk.toString()).split(/\r?\n/);
            rest = lines.pop();
            for (const line of lines) {
                if (!line.trim() || this.child !== child) continue;
                let msg = null;
                if (line.startsWith('{')) {
                    try {
                        msg = JSON.parse(line);
                    } catch {}
                }
                if (!msg?.state) {
                    device.log(`[worker] ${line}`);
                    continue;
                }
                if (msg.state === 'starting') {
                    if (!quiet) {
                        device.status = 'starting';
                        device.step = msg.step;
                    }
                    this.watchQuiet(/developer image/i.test(msg.step) ? QUIET_LIMIT_MOUNT_MS : QUIET_LIMIT_MS);
                } else if (msg.state === 'needs_action') {
                    outcome = 'action';
                    if (!(quiet && device.action?.kind === msg.kind)) this.hooks.onAction(msg.kind);
                    this.settle(new Error(device.action?.title || msg.kind));
                } else if (msg.state === 'dead') {
                    outcome = 'dead';
                    lastError = msg.error;
                } else if (msg.state === 'ready') {
                    this.watchQuiet();
                    this.hooks
                        .onReady(msg)
                        .then((client) => {
                            if (this.child !== child) return;
                            clearTimeout(this.quiet);
                            this.failures = 0;
                            this.hooks.onLive(client, msg);
                            this.settle(null, true);
                            this.watchHealth(child, client);
                        })
                        .catch((e) => {
                            if (this.child !== child) return;
                            lastError = e.message;
                            this.kill();
                        });
                }
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (e) => {
            lastError = e.message;
        });
        child.on('exit', () => {
            if (this.child !== child) return;
            this.child = null;
            clearInterval(this.health);
            clearTimeout(this.quiet);
            this.health = null;
            if (!this.wanted) {
                this.hooks.onDown();
                return;
            }
            if (this.restarting) {
                this.restarting = false;
                this.hooks.onDown();
                this.schedule(0);
                return;
            }
            if (outcome === 'action') {
                this.hooks.onDown();
                // Install and Renew wait for the person (or the automatic re-sign) to call connect().
                if (SELF_CLEARING.includes(device.action?.kind)) {
                    this.rechecking = true;
                    this.schedule(ACTION_RECHECK_MS);
                } else this.parked = true;
                return;
            }
            this.failed(friendly(lastError) || 'The connection to the phone dropped');
        });
    }

    // The worker exits by itself when the tunnel or the control app dies. This covers the
    // case where both look alive but the control app has stopped answering.
    watchHealth(child, client) {
        let misses = 0;
        clearInterval(this.health);
        this.health = setInterval(() => {
            client.status().then(
                () => {
                    misses = 0;
                },
                () => {
                    if (this.child !== child || ++misses < HEALTH_MISSES) return;
                    this.device.log('The control app stopped answering; restarting it');
                    this.kill();
                },
            );
        }, HEALTH_EVERY_MS);
    }
}

// Turns the worker's raw error into something a person can act on.
function friendly(error) {
    const e = String(error || '');
    if (!e) return '';
    if (
        /ConnectionTerminated|forcibly closed|aborted|reset by peer|\bEOF\b|ConnectionAbortedError|IncompleteRead/i.test(
            e,
        )
    )
        return 'The phone closed the connection. Keep it unlocked.';
    if (/NoDeviceConnected|DeviceNotFound|phone gone/i.test(e))
        return 'The phone could not be reached. Check the cable.';
    if (/TimeoutError|timed out/i.test(e)) return 'The phone took too long to answer. Keep it unlocked.';
    return e.replace(/^\w+(Error|Exception):\s*/, '') || e;
}

module.exports = { PhoneSupervisor, startSpare, stopSpare };
