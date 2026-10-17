// Where everything lives. Everything Market writes (phone names, automations, schedules,
// media, WDA.ipa, the iOS helper) goes to the data folder: %APPDATA%\Market on Windows
// (the same folder the old desktop app used), or MP_DATA_DIR if set.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..'); // backend/
const APP_DATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_DIR = process.env.MP_DATA_DIR || path.join(APP_DATA, 'Market');
const AUTOMATIONS_DIR = path.join(DATA_DIR, 'automations');
const BUILTIN_AUTOMATIONS_DIR = path.join(ROOT, 'automations');
const PY_DIR = path.join(__dirname, 'py');

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Built-in example automations are copied into the user's folder once, so
// people can edit them and add their own without touching the app.
function prepareDataDir() {
    // The app was called "Marketing Phones" before; move its data folder over once.
    const legacy = path.join(APP_DATA, 'Marketing Phones');
    if (!process.env.MP_DATA_DIR && fs.existsSync(legacy) && !fs.existsSync(DATA_DIR)) {
        try {
            fs.renameSync(legacy, DATA_DIR);
        } catch {}
    }
    fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true });
    const seeded = path.join(DATA_DIR, '.seeded-automations.json');
    const done = new Set(readJson(seeded, []));
    for (const file of fs.readdirSync(BUILTIN_AUTOMATIONS_DIR)) {
        if (done.has(file)) continue;
        const target = path.join(AUTOMATIONS_DIR, file);
        if (!fs.existsSync(target)) fs.copyFileSync(path.join(BUILTIN_AUTOMATIONS_DIR, file), target);
        done.add(file);
    }
    writeJson(seeded, [...done]);
}

// backend/config.json ships with the app; a config.json in the data folder overrides any of its keys.
function loadConfig() {
    const base = readJson(path.join(ROOT, 'config.json'), {});
    const user = readJson(path.join(DATA_DIR, 'config.json'), {});
    return {
        ...base,
        ...user,
        wda: { ...base.wda, ...user.wda },
        localPorts: { ...base.localPorts, ...user.localPorts },
    };
}

module.exports = {
    ROOT,
    DATA_DIR,
    AUTOMATIONS_DIR,
    PY_DIR,
    readJson,
    writeJson,
    prepareDataDir,
    loadConfig,
};
