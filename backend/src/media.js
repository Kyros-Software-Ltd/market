// Media library: photos and videos on the PC that can be sent to phones.
//
// iOS has no USB route straight into Photos, so sending is two steps:
//   1. copy the file over USB into the control app's Documents/Market folder
//      (pymobiledevice3 house_arrest, see py/media.py)
//   2. on the phone, open that folder in Files and use Share → Save Video/Image
// Step 2 is UI automation through the control app; if it can't finish, the file is
// still in Files → On My iPhone → Market → Market, ready to save by hand.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DATA_DIR, PY_DIR } = require('./paths');
const setup = require('./setup');

const LIBRARY = path.join(DATA_DIR, 'media');
const SCRIPT = path.join(PY_DIR, 'media.py');

const TYPES = {
    '.mp4': 'video',
    '.mov': 'video',
    '.m4v': 'video',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.png': 'image',
    '.heic': 'image',
    '.gif': 'image',
    '.webp': 'image',
};

const kind = (name) => TYPES[path.extname(name).toLowerCase()] || null;

// Keeps names safe for the PC and the phone: no folders, no odd characters.
function safeName(name) {
    const base = path
        .basename(String(name || ''))
        .replace(/[^\w.\- ()]+/g, '_')
        .replace(/^\.+/, '')
        .trim();
    if (!base || !kind(base))
        throw new Error('Only photos and videos can be added (mp4, mov, jpg, png, heic, gif, webp)');
    return base;
}

function list() {
    fs.mkdirSync(LIBRARY, { recursive: true });
    return fs
        .readdirSync(LIBRARY)
        .filter((n) => kind(n))
        .map((name) => {
            const st = fs.statSync(path.join(LIBRARY, name));
            return { name, type: kind(name), size: st.size, addedAt: st.mtimeMs };
        })
        .sort((a, b) => b.addedAt - a.addedAt);
}

function filePath(name) {
    const p = path.join(LIBRARY, safeName(name));
    if (!fs.existsSync(p)) throw Object.assign(new Error('No such file in the library'), { status: 404 });
    return p;
}

/** Streams an upload into the library, picking a free name if it already exists. */
function save(name, stream) {
    fs.mkdirSync(LIBRARY, { recursive: true });
    let final = safeName(name);
    const ext = path.extname(final);
    for (let i = 2; fs.existsSync(path.join(LIBRARY, final)); i++)
        final = `${path.basename(safeName(name), ext)} (${i})${ext}`;
    const target = path.join(LIBRARY, final);
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(target);
        stream.pipe(out);
        out.on('finish', () => resolve({ name: final }));
        out.on('error', reject);
        stream.on('error', (e) => {
            out.destroy();
            fs.rmSync(target, { force: true });
            reject(e);
        });
    });
}

function remove(name) {
    fs.rmSync(filePath(name), { force: true });
}

async function helper(args) {
    const python = await setup.ensureHelper();
    return new Promise((resolve, reject) => {
        execFile(
            python,
            ['-I', SCRIPT, ...args],
            {
                windowsHide: true,
                timeout: 10 * 60000,
                maxBuffer: 8 * 1024 * 1024,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            },
            (err, stdout, stderr) => {
                const line = String(stdout).trim().split(/\r?\n/).pop();
                let out;
                try {
                    out = JSON.parse(line);
                } catch {
                    return reject(
                        new Error((stderr || err?.message || 'media helper failed').trim().split('\n').pop()),
                    );
                }
                if (!out.ok) return reject(new Error(out.error));
                resolve(out);
            },
        );
    });
}

// ---------- the "Send media" job ----------
// Saves one file that's already in Documents/Market into Photos, through the Files app.
async function saveToPhotos(ctx, name, containerPath) {
    const stem = path.basename(name, path.extname(name));
    ctx.log(`Saving ${name} to Photos`);
    // Files' tiles sit deeper in the screen tree than the fast default read reaches.
    await ctx.withDeepRead(async () => {
        await ctx.openUrl(`shareddocuments://${containerPath}/Documents/Market`);
        const file = await ctx.waitForText(stem, 15000);
        await ctx.sleepRandom(500, 900);
        await ctx.longPress(file.x, file.y, 900);
        await ctx.sleepRandom(700, 1100);
        await ctx.waitForText('Share', 8000);
        await ctx.tapText('Share');
        const saveLabel = kind(name) === 'video' ? 'Save Video' : 'Save Image';
        await ctx.waitForText(saveLabel, 10000);
        await ctx.tapText(saveLabel);
        await ctx.sleepRandom(1500, 2500);
    });
    ctx.log(`${name} is in Photos`);
}

const sendAutomation = {
    id: 'send-media',
    name: 'Send media',
    description: 'Copies photos/videos from the PC to the phone and saves them to Photos.',
    params: [
        { key: 'names', type: 'list' },
        { key: 'saveToPhotos', type: 'checkbox', default: true },
    ],
    async run(ctx, p) {
        const bundleId = ctx.device.wdaBundleId;
        if (!bundleId) throw new Error("The control app isn't running on this phone yet");
        const names = (p.names || []).map(safeName);
        ctx.log(`Copying ${names.length} file${names.length === 1 ? '' : 's'} to the phone`);
        await helper(['push', ctx.device.udid, bundleId, ...names.map(filePath)]);
        ctx.log("Copied. They're in Files → On My iPhone → Market");
        if (!p.saveToPhotos) return;

        const info = await helper(['container', ctx.device.udid, bundleId]);
        if (!info.fileSharing) {
            ctx.log('To save into Photos automatically, reinstall the control app once (Reinstall on the phone card).');
            throw new Error(
                'Copied, but the control app is an older build without file sharing; reinstall it once from the phone card',
            );
        }
        for (const name of names) {
            try {
                await saveToPhotos(ctx, name, info.container);
            } catch (e) {
                if (/Stopped/.test(e.message)) throw e;
                throw new Error(
                    `Couldn't save ${name} to Photos automatically (${e.message}). It's in Files → On My iPhone → Market; open it there and use Share → Save.`,
                );
            }
            // It's in Photos now, so drop the copy in Files to keep that folder from filling up.
            await helper(['remove', ctx.device.udid, bundleId, name]).catch((e) =>
                ctx.log(`Couldn't tidy up the copy in Files: ${e.message}`),
            );
        }
        await ctx.home();
    },
};

/** Starts a "Send media" job on each phone. */
function send(runner, names, udids, { saveToPhotos = true } = {}, trigger = 'you') {
    if (!names?.length) throw new Error('Pick at least one file');
    names.forEach(filePath); // fail early on missing files
    return runner.start('send-media', udids, { names, saveToPhotos }, trigger);
}

module.exports = { list, save, remove, filePath, send, sendAutomation, LIBRARY };
