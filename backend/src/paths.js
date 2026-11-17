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

// Built-in automations are copied into the user's folder so people can edit them and add their
// own. A newer version of a built-in replaces the user's copy only if they haven't changed it
// (its contents still match what was copied last time); an edited or deleted copy is left alone.
const hash = (file) => require('node:crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');

function prepareDataDir() {
    // The app was called "Marketing Phones" before; move its data folder over once.
    const legacy = path.join(APP_DATA, 'Marketing Phones');
    if (!process.env.MP_DATA_DIR && fs.existsSync(legacy) && !fs.existsSync(DATA_DIR)) {
        try {
            fs.renameSync(legacy, DATA_DIR);
        } catch {}
    }
    fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true });
    const seededFile = path.join(DATA_DIR, '.seeded-automations.json');
    const raw = readJson(seededFile, {});
    // Older versions kept a plain list of names: copied once, contents unknown.
    const seeded = Array.isArray(raw) ? Object.fromEntries(raw.map((f) => [f, null])) : raw;
    for (const file of fs.readdirSync(BUILTIN_AUTOMATIONS_DIR)) {
        const source = path.join(BUILTIN_AUTOMATIONS_DIR, file);
        const target = path.join(AUTOMATIONS_DIR, file);
        const latest = hash(source);
        if (!(file in seeded)) {
            if (!fs.existsSync(target)) fs.copyFileSync(source, target);
        } else if (fs.existsSync(target) && seeded[file] !== latest) {
            const mine = hash(target);
            // Unchanged since it was copied (or copied by an older version and still the file
            // that shipped then): safe to bring up to date.
            if (mine === seeded[file] || (seeded[file] === null && mine !== latest && isShipped(file, mine)))
                fs.copyFileSync(source, target);
            else if (mine !== latest) continue; // edited by the user: keep theirs, keep the old record
        } else if (!fs.existsSync(target)) continue; // deleted by the user: don't bring it back
        seeded[file] = latest;
    }
    writeJson(seededFile, seeded);
}

// Copies made by versions that didn't record contents: Post to TikTok is the only built-in
// that changed since, and these are the versions of it that shipped.
const SHIPPED = { 'post-tiktok.js': ['6fa967eed38e7f76de259e1f53df3544808539a0'] }; // 2.0.25
function isShipped(file, contentHash) {
    return (SHIPPED[file] || []).includes(contentHash);
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
