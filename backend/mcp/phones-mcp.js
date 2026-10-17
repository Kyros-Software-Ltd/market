#!/usr/bin/env node
// MCP server that lets Claude (Claude Code or Claude Desktop) see and control the
// iPhones. It talks to the Market app over its local API, and opens the
// app if it isn't running. No dependencies: it speaks MCP's JSON-RPC over stdio itself.
const path = require('node:path');
const { spawn } = require('node:child_process');

const LAUNCHER = path.join(__dirname, '..', '..', 'scripts', 'start.js');
const PORT = (() => {
    try {
        return require('../config.json').port || 4000;
    } catch {
        return 4000;
    }
})();
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- talking to the app ----------
async function call(method, urlPath, body, timeout = 90000) {
    const res = await fetch(BASE + urlPath, {
        method,
        headers: { 'x-actor': 'claude', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);

let launching = null;
async function ensureApp() {
    try {
        await call('GET', '/api/status', null, 3000);
        return;
    } catch {}
    if (!launching) {
        launching = (async () => {
            // Starts Market in the background (no browser window) with the same Node.
            spawn(process.execPath, [LAUNCHER, '--hidden'], {
                cwd: path.dirname(LAUNCHER),
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            }).unref();
            for (let i = 0; i < 40; i++) {
                await sleep(1500);
                try {
                    await call('GET', '/api/status', null, 3000);
                    return;
                } catch {}
            }
            throw new Error('Market did not start. Run `npm start` in the Market folder and try again.');
        })().finally(() => {
            launching = null;
        });
    }
    return launching;
}

async function phones() {
    await ensureApp();
    return (await get('/api/status')).devices;
}

// Accepts a phone's name, the start of its id, its number in the list (1, 2, 3), or "all".
async function resolve(phone, { many = false } = {}) {
    const list = await phones();
    const ready = list.filter((d) => d.status === 'ready');
    const wanted = String(phone ?? '').trim();
    if (!ready.length) throw new Error('No phones are ready. Check the Market app (list_phones shows why).');
    if (wanted.toLowerCase() === 'all') {
        if (!many) throw new Error('This tool works on one phone at a time');
        return ready;
    }
    if (!wanted) {
        if (ready.length !== 1)
            throw new Error(`Say which phone. Ready phones: ${ready.map((d) => d.name).join(', ')}`);
        return ready;
    }
    const out = [];
    for (const part of wanted
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)) {
        const d =
            list.find((x) => x.name.toLowerCase() === part) ||
            list.find((x) => x.udid.toLowerCase().startsWith(part)) ||
            (/^\d+$/.test(part) && list[Number(part) - 1]) ||
            list.find((x) => x.name.toLowerCase().includes(part));
        if (!d) throw new Error(`No phone called "${part}". Phones: ${list.map((x) => x.name).join(', ')}`);
        if (d.status !== 'ready')
            throw new Error(`${d.name} is ${d.status}${d.error ? `: ${d.error}` : ''}${d.step ? ` (${d.step})` : ''}`);
        out.push(d);
    }
    if (!many && out.length > 1) throw new Error('This tool works on one phone at a time');
    return out;
}

const text = (t) => ({ type: 'text', text: t });

function formatElements(elements) {
    if (!elements) return '';
    if (elements.error) return `\n(Could not read on-screen elements: ${elements.error})`;
    if (!elements.length) return '\nNo labelled elements found; use the image.';
    const lines = elements.slice(0, 150).map((e) => `- ${e.type} "${e.label}" at (${e.x}, ${e.y})`);
    return `\nLabelled elements (tap by text, or at these points):\n${lines.join('\n')}`;
}

async function lookContent(d, withElements = true) {
    const r = await get(`/api/devices/${d.udid}/look?elements=${withElements ? 1 : 0}`);
    return [
        { type: 'image', data: r.image, mimeType: r.mime },
        text(
            `${r.phone}: screen is ${r.width}×${r.height} points; image pixels = tap coordinates.${withElements ? formatElements(r.elements) : ''}`,
        ),
    ];
}

// Runs an action on the phone(s), then (by default) returns a fresh look so Claude sees the result.
async function act(args, action, body, summary) {
    const targets = await resolve(args.phone, { many: true });
    await post(`/api/control/${action}`, { udids: targets.map((d) => d.udid), ...body });
    const done = text(`${summary} on ${targets.map((d) => d.name).join(', ')}.`);
    if (args.look_after === false || targets.length !== 1) return [done];
    await sleep(Number(args.settle_ms ?? 900));
    return [done, ...(await lookContent(targets[0], false))];
}

async function findApp(d, app) {
    const q = String(app).trim();
    if (/^[\w-]+(\.[\w-]+)+$/.test(q)) return { bundleId: q, name: q };
    const apps = await get(`/api/devices/${d.udid}/apps`);
    const lower = q.toLowerCase();
    const hit =
        apps.find((a) => a.name.toLowerCase() === lower) || apps.find((a) => a.name.toLowerCase().includes(lower));
    if (!hit) {
        const builtIn = {
            safari: 'com.apple.mobilesafari',
            settings: 'com.apple.Preferences',
            photos: 'com.apple.mobileslideshow',
            camera: 'com.apple.camera',
            messages: 'com.apple.MobileSMS',
            'app store': 'com.apple.AppStore',
            notes: 'com.apple.mobilenotes',
        }[lower];
        if (builtIn) return { bundleId: builtIn, name: q };
        throw new Error(`No app called "${app}" on ${d.name}. Installed: ${apps.map((a) => a.name).join(', ')}`);
    }
    return hit;
}

// ---------- tools ----------
const PHONE = {
    type: 'string',
    description: 'Phone name, its number (1, 2, 3), or "all". Can be omitted when only one phone is ready.',
};
const PHONES = {
    description: 'Phone names/numbers, or "all"',
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
};
const LOOK_AFTER = { type: 'boolean', description: 'Return a screenshot ~1s after the action (default true)' };

const tools = [
    {
        name: 'list_phones',
        description:
            'List the iPhones, whether each is ready to control, its screen size in points, and what is running on it.',
        inputSchema: { type: 'object', properties: {} },
        async run() {
            await ensureApp();
            const { devices, jobs } = await get('/api/status');
            if (!devices.length) return [text('No iPhones detected. Plug them in over USB, unlock, and tap Trust.')];
            const lines = devices.map((d, i) => {
                const job = jobs.find((j) => j.udid === d.udid && j.status === 'running');
                return (
                    `${i + 1}. ${d.name} — ${d.status}${d.step ? ` (${d.step})` : ''}${d.error ? `: ${d.error}` : ''}` +
                    `${d.size ? `, screen ${d.size.width}×${d.size.height} pt` : ''}, ${d.model} iOS ${d.iosVersion}` +
                    `${job ? `, running "${job.automationName}" (job ${job.id})` : ''}`
                );
            });
            return [text(lines.join('\n'))];
        },
    },
    {
        name: 'look',
        description:
            "See a phone's screen: returns a screenshot (1 image pixel = 1 tap point) plus the labelled buttons/text on screen with their tap coordinates. Call this before acting and whenever unsure what is on screen.",
        inputSchema: {
            type: 'object',
            properties: {
                phone: PHONE,
                elements: {
                    type: 'boolean',
                    description: 'Also list on-screen elements (default true; slower in heavy apps)',
                },
            },
        },
        async run(a) {
            const [d] = await resolve(a.phone);
            return lookContent(d, a.elements !== false);
        },
    },
    {
        name: 'tap',
        description:
            'Tap a point (x, y in screen points, as seen in look) or the element whose label matches `text`. Set double=true to double-tap (e.g. like a video).',
        inputSchema: {
            type: 'object',
            properties: {
                phone: PHONE,
                x: { type: 'number' },
                y: { type: 'number' },
                text: { type: 'string', description: 'Tap the element with this label instead of x/y' },
                double: { type: 'boolean' },
                look_after: LOOK_AFTER,
            },
        },
        run(a) {
            if (a.text) return act(a, 'tapText', { text: a.text }, `Tapped "${a.text}"`);
            if (a.x === undefined || a.y === undefined) throw new Error('Give x and y, or text');
            return act(
                a,
                a.double ? 'doubletap' : 'tap',
                { x: a.x, y: a.y, unit: 'pt' },
                `${a.double ? 'Double-tapped' : 'Tapped'} (${a.x}, ${a.y})`,
            );
        },
    },
    {
        name: 'long_press',
        description: 'Press and hold at a point (screen points).',
        inputSchema: {
            type: 'object',
            properties: {
                phone: PHONE,
                x: { type: 'number' },
                y: { type: 'number' },
                ms: { type: 'number', description: 'Hold time, default 900' },
                look_after: LOOK_AFTER,
            },
            required: ['x', 'y'],
        },
        run(a) {
            return act(a, 'longpress', { x: a.x, y: a.y, ms: a.ms || 900, unit: 'pt' }, 'Long-pressed');
        },
    },
    {
        name: 'swipe',
        description:
            'Swipe. Either give a direction (finger movement: "up" goes to the next post in a feed, "down" goes back/refreshes, "left"/"right" for pages), or exact x1,y1 → x2,y2 in screen points.',
        inputSchema: {
            type: 'object',
            properties: {
                phone: PHONE,
                direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                ms: { type: 'number', description: 'Duration, default 300' },
                look_after: LOOK_AFTER,
            },
        },
        run(a) {
            if (a.direction) {
                const r = (min, max) => min + Math.random() * (max - min);
                const x = r(0.42, 0.58);
                const g = {
                    up: [x, r(0.7, 0.78), x + r(-0.04, 0.04), r(0.22, 0.3)],
                    down: [x, r(0.25, 0.32), x + r(-0.04, 0.04), r(0.7, 0.78)],
                    left: [r(0.8, 0.88), 0.5, r(0.12, 0.2), r(0.48, 0.52)],
                    right: [r(0.12, 0.2), 0.5, r(0.8, 0.88), r(0.48, 0.52)],
                }[a.direction];
                return act(
                    a,
                    'swipe',
                    { x1: g[0], y1: g[1], x2: g[2], y2: g[3], ms: a.ms || r(220, 380) },
                    `Swiped ${a.direction}`,
                );
            }
            if ([a.x1, a.y1, a.x2, a.y2].some((v) => typeof v !== 'number'))
                throw new Error('Give a direction, or x1, y1, x2 and y2');
            return act(a, 'swipe', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ms: a.ms || 300, unit: 'pt' }, 'Swiped');
        },
    },
    {
        name: 'type_text',
        description: 'Type text into the focused field (tap the field first). submit=true presses Return afterwards.',
        inputSchema: {
            type: 'object',
            properties: { phone: PHONE, text: { type: 'string' }, submit: { type: 'boolean' }, look_after: LOOK_AFTER },
            required: ['text'],
        },
        run(a) {
            return act(a, 'type', { text: a.text, submit: !!a.submit }, `Typed "${a.text}"`);
        },
    },
    {
        name: 'press_button',
        description:
            'Press a hardware-style button: home (go to home screen / close app), lock, wake, volume_up, volume_down.',
        inputSchema: {
            type: 'object',
            properties: {
                phone: PHONE,
                button: { type: 'string', enum: ['home', 'lock', 'wake', 'volume_up', 'volume_down'] },
                look_after: LOOK_AFTER,
            },
            required: ['button'],
        },
        run(a) {
            const action = {
                home: 'home',
                lock: 'lock',
                wake: 'unlock',
                volume_up: 'volumeUp',
                volume_down: 'volumeDown',
            }[a.button];
            return act(a, action, {}, `Pressed ${a.button}`);
        },
    },
    {
        name: 'open_app',
        description: 'Open an app by name (e.g. "TikTok", "Instagram") or bundle id.',
        inputSchema: {
            type: 'object',
            properties: { phone: PHONE, app: { type: 'string' }, look_after: LOOK_AFTER },
            required: ['app'],
        },
        async run(a) {
            const targets = await resolve(a.phone, { many: true });
            const app = await findApp(targets[0], a.app);
            return act(
                { ...a, settle_ms: a.settle_ms ?? 2500 },
                'launch',
                { bundleId: app.bundleId },
                `Opened ${app.name}`,
            );
        },
    },
    {
        name: 'close_app',
        description: 'Force-close an app by name or bundle id.',
        inputSchema: { type: 'object', properties: { phone: PHONE, app: { type: 'string' } }, required: ['app'] },
        async run(a) {
            const targets = await resolve(a.phone, { many: true });
            const app = await findApp(targets[0], a.app);
            return act({ ...a, look_after: false }, 'terminate', { bundleId: app.bundleId }, `Closed ${app.name}`);
        },
    },
    {
        name: 'list_apps',
        description: 'List the apps installed on a phone (name and bundle id).',
        inputSchema: { type: 'object', properties: { phone: PHONE } },
        async run(a) {
            const [d] = await resolve(a.phone);
            const apps = await get(`/api/devices/${d.udid}/apps`);
            return [text(apps.map((x) => `${x.name} — ${x.bundleId}`).join('\n') || 'No user apps found')];
        },
    },
    {
        name: 'list_media',
        description: 'List the photos and videos in the PC media library (the files that can be sent to phones).',
        inputSchema: { type: 'object', properties: {} },
        async run() {
            await ensureApp();
            const items = await get('/api/media');
            if (!items.length) return [text('The media library is empty. The user can add files on the Media page.')];
            return [text(items.map((m) => `${m.name} (${m.type}, ${(m.size / 1048576).toFixed(1)} MB)`).join('\n'))];
        },
    },
    {
        name: 'send_media',
        description:
            "Send photos/videos from the PC media library to phones. By default each file is also saved into the phone's Photos app so it can be posted. Runs as a background job; check list_jobs.",
        inputSchema: {
            type: 'object',
            properties: {
                files: { type: 'array', items: { type: 'string' }, description: 'File names from list_media' },
                phones: PHONES,
                save_to_photos: { type: 'boolean', description: 'Default true' },
            },
            required: ['files'],
        },
        async run(a) {
            const targets = await resolve(Array.isArray(a.phones) ? a.phones.join(',') : a.phones, { many: true });
            const jobs = await post('/api/media/send', {
                names: a.files,
                udids: targets.map((d) => d.udid),
                saveToPhotos: a.save_to_photos !== false,
            });
            return [
                text(
                    `Sending ${a.files.length} file(s): ${jobs.map((j) => `job ${j.id} on ${j.deviceName}`).join(', ')}.`,
                ),
            ];
        },
    },
    {
        name: 'list_automations',
        description: 'List saved automations (scripts and step flows) with their parameters.',
        inputSchema: { type: 'object', properties: {} },
        async run() {
            await ensureApp();
            const list = await get('/api/automations');
            return [
                text(
                    list
                        .map(
                            (x) =>
                                `• ${x.id} (${x.kind}) — ${x.name}: ${x.description || ''}` +
                                (x.params.length
                                    ? `\n  params: ${x.params.map((p) => `${p.key}=${JSON.stringify(p.default)}${p.options ? ` [${p.options.join('|')}]` : ''}`).join(', ')}`
                                    : ''),
                        )
                        .join('\n'),
                ),
            ];
        },
    },
    {
        name: 'run_automation',
        description: 'Start an automation on one or more phones. It runs in the background; check it with list_jobs.',
        inputSchema: {
            type: 'object',
            properties: {
                automation: { type: 'string', description: 'Automation id from list_automations' },
                phones: PHONES,
                params: { type: 'object' },
            },
            required: ['automation'],
        },
        async run(a) {
            const targets = await resolve(Array.isArray(a.phones) ? a.phones.join(',') : a.phones, { many: true });
            const jobs = await post(`/api/automations/${encodeURIComponent(a.automation)}/run`, {
                udids: targets.map((d) => d.udid),
                params: a.params || {},
            });
            return [text(`Started ${jobs.map((j) => `job ${j.id} on ${j.deviceName}`).join(', ')}.`)];
        },
    },
    {
        name: 'list_jobs',
        description: 'Show running and recent automation jobs with their latest log lines.',
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
        async run(a) {
            await ensureApp();
            const jobs = await get(`/api/jobs?limit=${a.limit || 15}`);
            if (!jobs.length) return [text('No jobs yet.')];
            return [
                text(
                    jobs
                        .map(
                            (j) =>
                                `job ${j.id}: ${j.automationName} on ${j.deviceName} — ${j.status}${j.error ? ` (${j.error})` : ''}\n  ${j.logs.slice(-3).join('\n  ')}`,
                        )
                        .join('\n'),
                ),
            ];
        },
    },
    {
        name: 'stop_jobs',
        description: 'Stop one job by id, or all running jobs if no id is given.',
        inputSchema: { type: 'object', properties: { job_id: { type: 'number' } } },
        async run(a) {
            await ensureApp();
            if (a.job_id) await post(`/api/jobs/${a.job_id}/stop`);
            else await post('/api/jobs/stop-all');
            return [text(a.job_id ? `Stopping job ${a.job_id}` : 'Stopping all jobs')];
        },
    },
    {
        name: 'save_flow',
        description:
            'Create or overwrite a reusable step automation ("flow") that the app can run and schedule. Coordinates are FRACTIONS of the screen (0-1), not points, so the flow works on every phone. ' +
            'Steps: {do:"launch",bundleId} {do:"terminate",bundleId} {do:"tap",x,y} {do:"doubletap",x,y} {do:"longpress",x,y,ms} {do:"swipe",x1,y1,x2,y2,ms} ' +
            '{do:"scroll",direction:"up"|"down"} {do:"tapText",text,optional?} {do:"waitForText",text,timeoutMs} {do:"type",text,submit?} {do:"home"} ' +
            '{do:"wait",ms} {do:"waitRandom",minMs,maxMs} {do:"log",text}. Any step can have chance:0-1 to only run sometimes. Taps and waits are jittered automatically.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'File-safe id, e.g. "tiktok-like-3"' },
                name: { type: 'string' },
                description: { type: 'string' },
                repeat: { type: 'number', description: 'Default times to repeat the steps' },
                steps: { type: 'array', items: { type: 'object' } },
            },
            required: ['id', 'name', 'steps'],
        },
        async run(a) {
            await ensureApp();
            const { id, ...flow } = a;
            await post(`/api/flows/${encodeURIComponent(id)}`, flow);
            return [text(`Saved flow "${a.name}" (${a.steps.length} steps) as ${id}. Run it with run_automation.`)];
        },
    },
    {
        name: 'get_flow',
        description: "Read a saved flow's steps (e.g. one recorded in the app) to inspect or improve it.",
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        async run(a) {
            await ensureApp();
            return [text(JSON.stringify(await get(`/api/flows/${encodeURIComponent(a.id)}`), null, 2))];
        },
    },
    {
        name: 'list_schedules',
        description: 'List scheduled automations and when each runs next.',
        inputSchema: { type: 'object', properties: {} },
        async run() {
            await ensureApp();
            const { schedules, log } = await get('/api/schedules');
            const lines = schedules.map(
                (s) =>
                    `• ${s.id}: ${s.name} — ${s.automationId} at ${s.times.join(', ')} (+0-${s.windowMinutes} min random) on ${s.phones === 'all' ? 'all phones' : s.phones.join(', ')}` +
                    `${s.enabled ? '' : ' [paused]'}${s.next ? `, next ≈ ${new Date(s.next).toLocaleString()}` : ''}`,
            );
            return [
                text(
                    (lines.join('\n') || 'No schedules.') +
                        (log.length
                            ? `\n\nRecent:\n${log
                                  .slice(-8)
                                  .map((l) => `${new Date(l.at).toLocaleString()} ${l.text}`)
                                  .join('\n')}`
                            : ''),
                ),
            ];
        },
    },
    {
        name: 'save_schedule',
        description:
            'Create or update a schedule that runs an automation every day (or chosen weekdays) at set times, each run starting at a random moment within windowMinutes after the time.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Existing schedule id to update; omit to create' },
                name: { type: 'string' },
                automationId: { type: 'string' },
                phones: { type: 'array', items: { type: 'string' }, description: 'Phone names; omit for all phones' },
                params: { type: 'object' },
                times: { type: 'array', items: { type: 'string' }, description: '24h times like "09:00"' },
                windowMinutes: { type: 'number', description: 'Random spread after each time, default 30' },
                days: { type: 'array', items: { type: 'number' }, description: '0=Sun … 6=Sat; omit for every day' },
                enabled: { type: 'boolean' },
            },
            required: ['automationId', 'times'],
        },
        async run(a) {
            await ensureApp();
            const s = await post('/api/schedules', a);
            return [text(`Saved schedule ${s.id}: ${s.name} at ${s.times.join(', ')}.`)];
        },
    },
    {
        name: 'delete_schedule',
        description: 'Delete a schedule by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        async run(a) {
            await ensureApp();
            await call('DELETE', `/api/schedules/${encodeURIComponent(a.id)}`);
            return [text(`Deleted schedule ${a.id}`)];
        },
    },
];

const INSTRUCTIONS = `You control real iPhones plugged into this PC via the Market app.
Loop: look → act → check the returned screenshot. Coordinates are screen points; the image you get is scaled so 1 pixel = 1 point.
Prefer tap with text when the element list has a matching label. Act like a person: vary timing, don't spam.
The element list is kept shallow so busy video apps stay responsive: in TikTok/Reels the like, comment, save and share buttons on the video usually aren't listed, so tap them by their position in the screenshot.
For repeatable work, build a flow with save_flow (fractions 0-1) and run or schedule it instead of tapping step by step.
Never enter passwords, payment details or 2FA codes; ask the user to do that on the phone.`;

// ---------- MCP over stdio ----------
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
    const { id, method, params = {} } = msg;
    if (id === undefined) return; // notification
    try {
        let result;
        if (method === 'initialize') {
            result = {
                protocolVersion: params.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'marketing-phones', version: '1.0.0' },
                instructions: INSTRUCTIONS,
            };
        } else if (method === 'ping') {
            result = {};
        } else if (method === 'tools/list') {
            result = { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        } else if (method === 'tools/call') {
            const tool = tools.find((t) => t.name === params.name);
            if (!tool) throw Object.assign(new Error(`Unknown tool ${params.name}`), { code: -32602 });
            try {
                result = { content: await tool.run(params.arguments || {}) };
            } catch (e) {
                result = {
                    content: [
                        text(
                            e.name === 'TimeoutError'
                                ? 'The phone took too long to respond. Try look, then retry.'
                                : e.message,
                        ),
                    ],
                    isError: true,
                };
            }
        } else if (method === 'resources/list' || method === 'prompts/list') {
            result = { [method.split('/')[0]]: [] };
        } else {
            throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
        }
        send({ jsonrpc: '2.0', id, result });
    } catch (e) {
        send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } });
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        handle(msg);
    }
});
process.stdin.on('end', () => process.exit(0));
