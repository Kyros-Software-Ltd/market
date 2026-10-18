// Plugging an iPhone into Windows adds an "Apple Mobile Device Ethernet" network adapter (USB
// tethering). While it's up, Apple's service stops finding phones over Wi-Fi, so a phone that
// was working wirelessly drops as soon as another phone is plugged in. Market never uses the
// adapter (it talks to phones through Apple's USB service), so switching it off is safe; it
// only needs admin rights, so the fix asks Windows for them once.
const { execFile } = require('node:child_process');

const MATCH = "InterfaceDescription -like 'Apple Mobile Device Ethernet*'";

function powershell(command, timeout = 15000) {
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', command],
            { windowsHide: true, timeout },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
        );
    });
}

/** Names of Apple USB network adapters that are currently up (none on other systems). */
async function activeAdapters() {
    if (process.platform !== 'win32') return [];
    const out = await powershell(
        `Get-NetAdapter | Where-Object { ${MATCH} -and $_.Status -eq 'Up' } | ForEach-Object { $_.Name }`,
    ).catch(() => '');
    return out.split(/\r?\n/).filter(Boolean);
}

/** Disables those adapters. Shows Windows' admin prompt; rejects if it's declined. */
async function disableAdapters() {
    if (process.platform !== 'win32') return;
    const inner = `Get-NetAdapter | Where-Object { ${MATCH} } | Disable-NetAdapter -Confirm:$false`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    try {
        await powershell(
            `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
            120000,
        );
    } catch {
        throw new Error('Windows needs your permission (admin) to switch off the Apple USB network adapter');
    }
    if ((await activeAdapters()).length) throw new Error('The adapter is still on. Try again and click Yes.');
}

module.exports = { activeAdapters, disableAdapters };
