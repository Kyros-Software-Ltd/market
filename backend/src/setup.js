// One-time setup the app does by itself:
// - installs the pymobiledevice3 helper (needed to mount the developer image on iOS 17+)
// - downloads WebDriverAgent (the control app that runs on each phone) from GitHub and
//   packages it as WDA.ipa, which you install on each phone with Sideloadly
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT, DATA_DIR } = require('./paths');

const HELPER_DIR = path.join(DATA_DIR, 'helper');
const WDA_IPA = path.join(DATA_DIR, 'WDA.ipa');
const EMBED_PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const WDA_RELEASE_API = 'https://api.github.com/repos/appium/WebDriverAgent/releases/latest';

const run = (file, args, opts = {}) =>
    new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60000, ...opts },
            (err, stdout, stderr) => {
                if (err)
                    reject(
                        Object.assign(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')), {
                            stdout,
                        }),
                    );
                else resolve(stdout);
            },
        );
    });

// Windows' own tar (bsdtar) handles zip files; another tar earlier on PATH (e.g. Git's) may not.
const SYSTEM_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const TAR = fs.existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar';

async function download(url, file) {
    const res = await fetch(url, { headers: { 'User-Agent': 'market-app' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
}

// ---------- pymobiledevice3 helper ----------
const state = { helper: 'unknown', helperStep: '', helperError: '', wda: '', wdaError: '' };

function pythonCandidates() {
    return [
        path.join(HELPER_DIR, 'venv', 'Scripts', 'python.exe'),
        path.join(HELPER_DIR, 'python', 'python.exe'),
        path.join(ROOT, '.venv', 'Scripts', 'python.exe'), // older setups made by start.bat
    ];
}

async function hasPymobiledevice(python) {
    try {
        await run(python, ['-c', 'import pymobiledevice3'], { timeout: 60000 });
        return true;
    } catch {
        return false;
    }
}

async function findHelper() {
    for (const p of pythonCandidates()) if (fs.existsSync(p) && (await hasPymobiledevice(p))) return p;
    return null;
}

// A real Python on the PC (not the Microsoft Store stub that just opens the Store).
async function systemPython() {
    for (const [cmd, args] of [
        ['py', ['-3', '-c', 'import sys;print(sys.executable)']],
        ['python', ['-c', 'import sys;print(sys.executable)']],
    ]) {
        try {
            const exe = (await run(cmd, args, { timeout: 20000 })).trim();
            if (exe && !/WindowsApps/i.test(exe)) return exe;
        } catch {}
    }
    return null;
}

let installing = null;
/** Resolves with a python.exe that has pymobiledevice3, installing it the first time. */
function ensureHelper(onStep = () => {}) {
    if (installing) return installing;
    installing = (async () => {
        const existing = await findHelper();
        if (existing) {
            state.helper = 'ready';
            return existing;
        }
        state.helper = 'installing';
        state.helperError = '';
        const step = (s) => {
            state.helperStep = s;
            onStep(s);
        };
        try {
            let python;
            const sys = await systemPython();
            if (sys) {
                step('Setting up the iOS helper (first time only)');
                await run(sys, ['-m', 'venv', path.join(HELPER_DIR, 'venv')]);
                python = path.join(HELPER_DIR, 'venv', 'Scripts', 'python.exe');
            } else {
                // No Python on this PC: use Python's self-contained "embeddable" build, kept inside the data folder.
                step('Downloading Python for the iOS helper (first time only)');
                const dir = path.join(HELPER_DIR, 'python');
                const zip = await download(EMBED_PYTHON_URL, path.join(HELPER_DIR, 'python.zip'));
                fs.mkdirSync(dir, { recursive: true });
                await run(TAR, ['-xf', zip, '-C', dir]);
                fs.unlinkSync(zip);
                // The embeddable build ignores installed packages until "import site" is switched on.
                for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('._pth'))) {
                    const pth = path.join(dir, f);
                    fs.writeFileSync(pth, fs.readFileSync(pth, 'utf8').replace(/^#\s*import site/m, 'import site'));
                }
                python = path.join(dir, 'python.exe');
                await run(python, [
                    await download(GET_PIP_URL, path.join(HELPER_DIR, 'get-pip.py')),
                    '--no-warn-script-location',
                ]);
            }
            step('Installing the iOS helper (first time only, ~2 min)');
            await run(python, [
                '-m',
                'pip',
                'install',
                '--quiet',
                '--disable-pip-version-check',
                '--no-warn-script-location',
                'pymobiledevice3',
            ]);
            state.helper = 'ready';
            state.helperStep = '';
            return python;
        } catch (e) {
            state.helper = 'error';
            state.helperError = e.message;
            throw e;
        }
    })().finally(() => {
        installing = null;
    });
    return installing;
}

// ---------- WebDriverAgent IPA ----------
// Bump when the packaging changes, so copies built by an older version get rebuilt.
// 2: file sharing on, shown on the phone as "Market".
// 4: rebuilt without the screen broadcast extension that version 3 carried.
const WDA_BUILD_VERSION = 4;
const WDA_VERSION_FILE = `${WDA_IPA}.version`;

// File sharing lets the app copy photos and videos into the control app over USB and
// lets the Files app open them, so they can be saved to Photos (see media.js).
function patchInfoPlist(file) {
    let xml = fs.readFileSync(file, 'utf8');
    if (!xml.trimStart().startsWith('<?xml')) throw new Error('Unexpected Info.plist format in WebDriverAgent');
    const set = (key, valueXml) => {
        const re = new RegExp(`<key>${key}</key>\\s*<[^>]+>(?:[^<]*</[^>]+>)?`);
        xml = re.test(xml)
            ? xml.replace(re, `<key>${key}</key>${valueXml}`)
            : xml.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>${valueXml}\n</dict>\n</plist>\n`);
    };
    set('UIFileSharingEnabled', '<true/>');
    set('LSSupportsOpeningDocumentsInPlace', '<true/>');
    set('CFBundleDisplayName', '<string>Market</string>');
    fs.writeFileSync(file, xml);
}

const wdaIpaCurrent = () =>
    fs.existsSync(WDA_IPA) &&
    (() => {
        try {
            return Number(fs.readFileSync(WDA_VERSION_FILE, 'utf8')) >= WDA_BUILD_VERSION;
        } catch {
            return false;
        }
    })();

/** Downloads the latest WebDriverAgent build and packages it as WDA.ipa, ready to sign. */
async function buildWdaIpa() {
    state.wda = 'Finding the latest WebDriverAgent';
    state.wdaError = '';
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-'));
    try {
        const release = await (await fetch(WDA_RELEASE_API, { headers: { 'User-Agent': 'market-app' } })).json();
        const asset = (release.assets || []).find((a) => a.name === 'WebDriverAgentRunner-Runner.zip');
        if (!asset)
            throw new Error('Could not find WebDriverAgentRunner-Runner.zip in the latest WebDriverAgent release');
        state.wda = `Downloading WebDriverAgent ${release.tag_name}`;
        const zip = await download(asset.browser_download_url, path.join(work, 'wda.zip'));

        state.wda = 'Packaging WDA.ipa';
        const out = path.join(work, 'out');
        const payload = path.join(out, 'Payload');
        fs.mkdirSync(payload, { recursive: true });
        await run(TAR, ['-xf', zip, '-C', out]);
        for (const name of fs.readdirSync(out)) {
            if (name.endsWith('.app')) fs.renameSync(path.join(out, name), path.join(payload, name));
        }
        if (!fs.readdirSync(payload).some((n) => n.endsWith('.app')))
            throw new Error('No .app inside the WebDriverAgent download');
        // Debug-symbol folders (.dSYM) aren't part of the app and break signing.
        const removeDsym = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const full = path.join(dir, e.name);
                if (e.name.endsWith('.dSYM')) fs.rmSync(full, { recursive: true, force: true });
                else removeDsym(full);
            }
        };
        removeDsym(payload);
        for (const name of fs.readdirSync(payload))
            if (name.endsWith('.app')) patchInfoPlist(path.join(payload, name, 'Info.plist'));
        fs.rmSync(WDA_IPA, { force: true });
        // An .ipa is a zip; tar picks the format from the extension, which it doesn't know, so force zip.
        await run(TAR, ['--format', 'zip', '-c', '-f', WDA_IPA, 'Payload'], { cwd: out });
        fs.writeFileSync(WDA_VERSION_FILE, String(WDA_BUILD_VERSION));
        state.wda = '';
        return WDA_IPA;
    } catch (e) {
        state.wda = '';
        state.wdaError = e.message;
        throw e;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

let buildingIpa = null;
/** WDA.ipa, built once and reused (Sideloadly signs it for each phone). */
function ensureWdaIpa() {
    if (wdaIpaCurrent()) return Promise.resolve(WDA_IPA);
    if (!buildingIpa)
        buildingIpa = buildWdaIpa().finally(() => {
            buildingIpa = null;
        });
    return buildingIpa;
}

// ---------- Sideloadly ----------
// Sideloadly (https://sideloadly.io) installs per user; check its usual spots.
function sideloadlyPath() {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return (
        [
            path.join(local, 'Sideloadly', 'sideloadly.exe'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Sideloadly', 'sideloadly.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Sideloadly', 'sideloadly.exe'),
        ].find((p) => fs.existsSync(p)) || null
    );
}

// ---------- status for the Setup tab ----------
async function status() {
    if (state.helper === 'unknown') state.helper = (await findHelper()) ? 'ready' : 'missing';
    return {
        sideloadly: !!sideloadlyPath(),
        wdaIpa: wdaIpaCurrent(),
        wdaBuilding: state.wda,
        wdaError: state.wdaError,
        helper: state.helper,
        helperStep: state.helperStep,
        helperError: state.helperError,
        dataDir: DATA_DIR,
    };
}

module.exports = { ensureHelper, ensureWdaIpa, sideloadlyPath, status, WDA_IPA };
