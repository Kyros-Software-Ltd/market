// Loads automations from /automations and runs them as jobs, one per phone.
// Two kinds live side by side:
//   *.js   scripts with a run(ctx, params) function, for anything clever
//   *.json "flows": a list of steps, made by recording in the app, by hand, or by Claude
const fs = require('node:fs');
const path = require('node:path');
const { AUTOMATIONS_DIR, DATA_DIR, readJson, writeJson } = require('./paths');
const { findElement } = require('./wda');

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class StoppedError extends Error {}

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));

// The API automation scripts get. Coordinates passed to the *Pct helpers are
// fractions of the screen (0-1) so one script works on every iPhone size.
// Every action goes through the shared Controller, so it shows in the activity feed.
function createContext(device, job, control) {
    const wda = () => {
        if (!device.wda) throw new Error('Device is not connected');
        return device.wda;
    };
    const check = () => {
        if (job.stopRequested) throw new StoppedError('Stopped');
    };
    const act = async (action, args) => {
        check();
        return control.act(device.udid, action, args, 'automation');
    };

    const ctx = {
        device: {
            udid: device.udid,
            name: device.name,
            get wdaBundleId() {
                return device.wdaBundleId;
            },
        },
        log: (msg) => job.log(msg),
        rand,
        randInt,
        chance: (p) => Math.random() < p,

        async sleep(ms) {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                check();
                await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
            }
            check();
        },
        sleepRandom: (minMs, maxMs) => ctx.sleep(rand(minMs, maxMs)),

        get screen() {
            return { ...wda().size };
        },

        tap: (x, y) => act('tap', { x, y, unit: 'pt' }),
        tapPct: (x, y) => act('tap', { x, y }),
        doubleTapPct: (x, y) => act('doubletap', { x, y }),
        longPressPct: (x, y, ms) => act('longpress', { x, y, ms }),
        longPress: (x, y, ms) => act('longpress', { x, y, ms, unit: 'pt' }),
        openUrl: (url) => act('openUrl', { url }),
        swipe: (x1, y1, x2, y2, ms) => act('swipe', { x1, y1, x2, y2, ms, unit: 'pt' }),
        swipePct: (x1, y1, x2, y2, ms) => act('swipe', { x1, y1, x2, y2, ms }),
        dragPct: (x1, y1, x2, y2, hold, ms) => act('drag', { x1, y1, x2, y2, hold, ms }),

        // A human-looking vertical scroll: jittered start/end points and speed.
        async scrollFeed(direction = 'up') {
            const x = rand(0.4, 0.6);
            const xEnd = x + rand(-0.06, 0.06);
            const [from, to] =
                direction === 'up' ? [rand(0.68, 0.8), rand(0.18, 0.3)] : [rand(0.2, 0.3), rand(0.68, 0.8)];
            await ctx.swipePct(x, from, xEnd, to, rand(180, 420));
        },

        type: (text) => act('type', { text }),
        home: () => act('home'),
        launch: (bundleId) => act('launch', { bundleId }),
        terminate: (bundleId) => act('terminate', { bundleId }),
        async screenshot() {
            check();
            return wda().screenshot();
        },
        async source() {
            check();
            return wda().source();
        },

        // Reading the screen: lets scripts react to what's actually there.
        async elements() {
            check();
            return control.elements(device.udid);
        },
        async findText(text) {
            return findElement(await ctx.elements(), text);
        },
        async hasText(text) {
            return !!(await ctx.findText(text));
        },
        async waitForText(text, timeoutMs = 10000) {
            const end = Date.now() + timeoutMs;
            for (;;) {
                const el = await ctx.findText(text).catch(() => null);
                if (el) return el;
                if (Date.now() > end)
                    throw new Error(`"${text}" did not appear within ${Math.round(timeoutMs / 1000)}s`);
                await ctx.sleep(800);
            }
        },
        tapText: (text) => act('tapText', { text }),
        // Screen reads are kept shallow so video apps stay responsive. Light apps (Files,
        // Settings) can be read fully; this does that for the duration of fn.
        async withDeepRead(fn) {
            check();
            await wda().setSettings({ snapshotMaxDepth: 60, snapshotMaxChildren: 300 });
            try {
                return await fn();
            } finally {
                await device.wda?.applySettings().catch(() => {});
            }
        },
        async tapTextIfPresent(text) {
            const el = await ctx.findText(text).catch(() => null);
            if (el) await ctx.tap(el.x, el.y);
            return !!el;
        },
    };
    return ctx;
}

// ---------- flows ----------
// A flow step is { do: <action>, ...args }. Taps get ±1% jitter and waits get
// ±25% so repeated runs never look identical.
const jitter = (v, amount) => Math.min(1, Math.max(0, Number(v) + rand(-amount, amount)));
const FLOW_STEPS = {
    tap: (ctx, s) => ctx.tapPct(jitter(s.x, 0.01), jitter(s.y, 0.01)),
    doubletap: (ctx, s) => ctx.doubleTapPct(jitter(s.x, 0.01), jitter(s.y, 0.01)),
    longpress: (ctx, s) => ctx.longPressPct(jitter(s.x, 0.01), jitter(s.y, 0.01), s.ms || 800),
    swipe: (ctx, s) =>
        ctx.swipePct(
            jitter(s.x1, 0.015),
            jitter(s.y1, 0.015),
            jitter(s.x2, 0.015),
            jitter(s.y2, 0.015),
            (s.ms || 300) * rand(0.85, 1.15),
        ),
    drag: (ctx, s) =>
        ctx.dragPct(
            jitter(s.x1, 0.01),
            jitter(s.y1, 0.01),
            jitter(s.x2, 0.01),
            jitter(s.y2, 0.01),
            s.hold || 600,
            (s.ms || 400) * rand(0.85, 1.15),
        ),
    scroll: (ctx, s) => ctx.scrollFeed(s.direction || 'up'),
    tapText: (ctx, s) => (s.optional ? ctx.tapTextIfPresent(s.text) : ctx.tapText(s.text)),
    waitForText: (ctx, s) => ctx.waitForText(s.text, s.timeoutMs || 10000),
    type: (ctx, s) => ctx.type(s.text + (s.submit ? '\n' : '')),
    home: (ctx) => ctx.home(),
    launch: (ctx, s) => ctx.launch(s.bundleId),
    terminate: (ctx, s) => ctx.terminate(s.bundleId).catch(() => {}),
    wait: (ctx, s) => ctx.sleep((s.ms || 1000) * rand(0.75, 1.25)),
    waitRandom: (ctx, s) => ctx.sleepRandom(s.minMs || 1000, s.maxMs || 3000),
    log: (ctx, s) => ctx.log(s.text || ''),
};

function flowToAutomation(id, flow) {
    return {
        id,
        kind: 'flow',
        name: flow.name || id,
        description: flow.description || `${(flow.steps || []).length} recorded steps`,
        params: [
            { key: 'repeat', label: 'Repeat (times)', type: 'number', default: flow.repeat || 1 },
            {
                key: 'startDelayMax',
                label: 'Random start delay up to (s)',
                type: 'number',
                default: flow.startDelayMax ?? 5,
            },
        ],
        flow,
        async run(ctx, p) {
            if (p.startDelayMax > 0) await ctx.sleepRandom(0, p.startDelayMax * 1000);
            const steps = flow.steps || [];
            for (let round = 1; round <= Math.max(1, p.repeat); round++) {
                if (p.repeat > 1) ctx.log(`Round ${round}/${p.repeat}`);
                for (const [i, step] of steps.entries()) {
                    const fn = FLOW_STEPS[step.do];
                    if (!fn) throw new Error(`Step ${i + 1}: unknown step "${step.do}"`);
                    if (step.chance !== undefined && !ctx.chance(step.chance)) continue;
                    await fn(ctx, step);
                }
            }
        },
    };
}

// ---------- jobs ----------
class Job {
    constructor(id, automation, device, params, trigger) {
        this.id = id;
        this.automationId = automation.id;
        this.automationName = automation.name;
        this.udid = device.udid;
        this.deviceName = device.name;
        this.params = params;
        this.trigger = trigger; // 'you' | 'claude' | 'schedule'
        this.status = 'running'; // running | done | stopped | failed
        this.startedAt = Date.now();
        this.endedAt = null;
        this.error = '';
        this.logs = [];
        this.stopRequested = false;
    }

    log(msg) {
        this.logs.push(`${new Date().toLocaleTimeString()} ${msg}`);
        if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    }

    toJSON() {
        const { stopRequested, ...rest } = this;
        return rest;
    }
}

class AutomationRunner {
    constructor(deviceManager, control) {
        this.devices = deviceManager;
        this.control = control;
        this.jobs = new Map();
        // Finished jobs from earlier runs of the app, so history survives restarts.
        for (const j of readJson(HISTORY_FILE, [])) this.jobs.set(j.id, Object.assign(Object.create(Job.prototype), j));
        this.nextId = Math.max(0, ...this.jobs.keys()) + 1;
        this.builtins = []; // automations that ship with the app's code (e.g. sending media)
    }

    /** Adds an automation implemented in the app itself; it isn't listed for running by hand. */
    registerBuiltin(automation) {
        this.builtins.push({ kind: 'builtin', hidden: true, ...automation });
    }

    // Re-read from disk each time so edited or new automations show up without a restart.
    loadAll() {
        const list = [...this.builtins];
        for (const file of fs.readdirSync(AUTOMATIONS_DIR)) {
            const full = path.join(AUTOMATIONS_DIR, file);
            const id = path.basename(file, path.extname(file));
            try {
                if (file.endsWith('.js')) {
                    delete require.cache[require.resolve(full)];
                    list.push({ id, kind: 'script', ...require(full) });
                } else if (file.endsWith('.json')) {
                    list.push(flowToAutomation(id, JSON.parse(fs.readFileSync(full, 'utf8'))));
                }
            } catch (e) {
                list.push({ id, name: file, description: `Failed to load: ${e.message}`, broken: true });
            }
        }
        return list;
    }

    listAutomations() {
        return this.loadAll()
            .filter((a) => !a.hidden)
            .map(({ id, kind, name, description, params, broken, flow }) => ({
                id,
                kind,
                name,
                description,
                params: params || [],
                broken,
                steps: flow ? flow.steps : undefined,
            }));
    }

    getFlow(id) {
        return readJson(this.flowPath(id), null);
    }

    flowPath(id) {
        if (!/^[\w-]+$/.test(id)) throw new Error('Use only letters, numbers, - and _ in the automation id');
        return path.join(AUTOMATIONS_DIR, `${id}.json`);
    }

    saveFlow(id, flow) {
        if (!flow || !Array.isArray(flow.steps)) throw new Error('A flow needs a "steps" list');
        for (const [i, s] of flow.steps.entries()) {
            if (!FLOW_STEPS[s.do])
                throw new Error(
                    `Step ${i + 1}: unknown step "${s.do}". Use one of: ${Object.keys(FLOW_STEPS).join(', ')}`,
                );
        }
        if (fs.existsSync(path.join(AUTOMATIONS_DIR, `${id}.js`)))
            throw new Error(`"${id}" is already a script automation; pick another id`);
        writeJson(this.flowPath(id), flow);
        return { id };
    }

    deleteFlow(id) {
        const file = this.flowPath(id);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    start(automationId, udids, rawParams = {}, trigger = 'you') {
        const automation = this.loadAll().find((a) => a.id === automationId);
        if (!automation || automation.broken)
            throw new Error(`Automation "${automationId}" not found or failed to load`);

        const params = {};
        for (const p of automation.params || []) {
            let v = rawParams[p.key] ?? p.default;
            if (p.type === 'number') v = Number(v);
            if (p.type === 'checkbox') v = v === true || v === 'true';
            params[p.key] = v;
        }

        // Validate every phone before starting any, so a bad selection starts nothing.
        const devices = udids.map((udid) => {
            const device = this.devices.get(udid);
            const busy = this.runningOn(udid);
            if (busy) throw new Error(`${device.name} is already running "${busy.automationName}"`);
            if (device.status !== 'ready') throw new Error(`${device.name} is not ready`);
            return device;
        });

        const started = [];
        for (const device of devices) {
            const job = new Job(this.nextId++, automation, device, params, trigger);
            this.jobs.set(job.id, job);
            started.push(job);
            this.execute(automation, device, job);
        }
        return started;
    }

    runningOn(udid) {
        return [...this.jobs.values()].find((j) => j.udid === udid && j.status === 'running');
    }

    async execute(automation, device, job) {
        job.log(`Starting "${automation.name}" on ${device.name}`);
        try {
            await automation.run(createContext(device, job, this.control), job.params);
            job.status = 'done';
            job.log('Finished');
        } catch (e) {
            if (e instanceof StoppedError || job.stopRequested) {
                job.status = 'stopped';
                job.log('Stopped');
            } else {
                job.status = 'failed';
                job.error = e.message;
                job.log(`Failed: ${e.message}`);
            }
        }
        job.endedAt = Date.now();
        this.saveHistory();
    }

    saveHistory() {
        const finished = [...this.jobs.values()].filter((j) => j.status !== 'running').slice(-300);
        try {
            writeJson(
                HISTORY_FILE,
                finished.map((j) => ({ ...j.toJSON(), logs: j.logs.slice(-80) })),
            );
        } catch {}
    }

    stop(jobId) {
        const job = this.jobs.get(Number(jobId));
        if (job && job.status === 'running') job.stopRequested = true;
    }

    stopAll() {
        for (const job of this.jobs.values()) if (job.status === 'running') job.stopRequested = true;
    }

    listJobs(limit = 100) {
        return [...this.jobs.values()]
            .reverse()
            .slice(0, limit)
            .map((j) => j.toJSON());
    }

    clearFinished() {
        for (const [id, job] of this.jobs) if (job.status !== 'running') this.jobs.delete(id);
        this.saveHistory();
    }
}

module.exports = { AutomationRunner, FLOW_STEPS };
