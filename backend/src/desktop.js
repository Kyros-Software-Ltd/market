// The few Windows desktop things Market does without Electron: open a folder or show a
// file in Explorer, start a program, and "Start with Windows" (a Startup-folder script
// that launches Market in the background at sign-in).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LAUNCHER = path.join(__dirname, '..', '..', 'scripts', 'start.js');
const STARTUP_DIR = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
);
const STARTUP_FILE = path.join(STARTUP_DIR, 'Market.vbs');

function run(exe, args) {
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/** Opens a folder (or file) in Explorer. */
function openPath(target) {
    if (!fs.existsSync(target)) throw new Error(`${target} doesn't exist`);
    run('explorer.exe', [target]);
}

/** Opens Explorer with the file selected. */
function showItemInFolder(file) {
    run('explorer.exe', [`/select,${file}`]);
}

/** Starts a program (e.g. Sideloadly) on its own. */
function openProgram(exe) {
    if (!fs.existsSync(exe)) throw new Error(`${exe} doesn't exist`);
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
}

function openAtLogin() {
    return fs.existsSync(STARTUP_FILE);
}

/** Adds or removes the sign-in script. It runs Market hidden (no browser), so schedules keep going. */
function setOpenAtLogin(on) {
    if (!on) {
        fs.rmSync(STARTUP_FILE, { force: true });
        return;
    }
    const q = (s) => s.replace(/"/g, '""');
    const vbs =
        `' Starts Market in the background when you sign in (made by Market's Setup page).\r\n` +
        `CreateObject("WScript.Shell").Run """${q(process.execPath)}"" ""${q(LAUNCHER)}"" --hidden", 0, False\r\n`;
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
    fs.writeFileSync(STARTUP_FILE, vbs);
}

module.exports = { openPath, showItemInFolder, openProgram, openAtLogin, setOpenAtLogin, LAUNCHER };
