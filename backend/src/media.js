// Media library: photos and videos on the PC that can be sent to phones.
//
// iOS has no USB route straight into Photos, so sending is two steps:
//   1. copy the file over USB into the control app's Documents/Market folder
//      (pymobiledevice3 house_arrest, see py/media.py), dated today so it is the newest
//      item in Photos and in every app's picker
//   2. on the phone, open that one file by its link (no browsing in Files) and use
//      Share → Save Image/Video
// Step 2 is UI automation through the control app; if it can't finish, the file is
// still in Files → On My iPhone → Market → Market, ready to save by hand.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
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

// ---------- dated today ----------
// The Photos picker in TikTok and Instagram sorts by the date a photo or video was taken, which
// comes from the file's metadata. A clip shot last year lands a year down the grid and an
// automation tapping "the newest" picks something else. So the copy sent to the phone carries
// today's date: photos are re-encoded without their old metadata, and videos have the dates in
// their header rewritten in place (same size, nothing re-encoded).
const MP4_EPOCH_OFFSET = 2082844800; // seconds from 1904-01-01 (MP4) to 1970-01-01

function walkBoxes(buf, start, end, visit) {
    let p = start;
    while (p + 8 <= end) {
        let size = buf.readUInt32BE(p);
        const type = buf.toString('latin1', p + 4, p + 8);
        let header = 8;
        if (size === 1) {
            size = Number(buf.readBigUInt64BE(p + 8));
            header = 16;
        } else if (size === 0) size = end - p;
        if (size < header || p + size > end) break;
        visit(type, p, header, size);
        p += size;
    }
}

function patchMoov(moov) {
    const now = BigInt(Math.floor(Date.now() / 1000) + MP4_EPOCH_OFFSET);
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta', 'ilst', 'edts', 'minf']);
    const visit = (type, at, header, size) => {
        if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
            const v = at + header; // version (1 byte) + flags (3 bytes), then the dates
            if (moov[v] === 1) {
                moov.writeBigUInt64BE(now, v + 4);
                moov.writeBigUInt64BE(now, v + 12);
            } else {
                moov.writeUInt32BE(Number(now & 0xffffffffn), v + 4);
                moov.writeUInt32BE(Number(now & 0xffffffffn), v + 8);
            }
        } else if (CONTAINERS.has(type)) walkBoxes(moov, at + header, at + size, visit);
        else if (type === 'meta') walkBoxes(moov, at + header + 4, at + size, visit); // meta has version/flags first
    };
    walkBoxes(moov, 0, moov.length, visit);
    // Apple's own date tags (com.apple.quicktime.creationdate, ©day) are text like
    // 2024-05-01T10:00:00+0100, and Photos prefers them. Overwrite each with now, same length.
    const text = moov.toString('latin1');
    const stamp = new Date().toISOString().slice(0, 19);
    for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:?\d{2}|Z)?/g)) {
        const zone = m[1] ? (m[1] === 'Z' ? 'Z' : m[1].includes(':') ? '+00:00' : '+0000') : '';
        moov.write(stamp + zone, m.index, 'latin1');
    }
}

/** Rewrites a copied MP4/MOV's dates to now, in place. Returns false if it isn't an MP4. */
function freshenVideo(file) {
    const fd = fs.openSync(file, 'r+');
    try {
        const total = fs.fstatSync(fd).size;
        const head = Buffer.alloc(16);
        let p = 0;
        while (p + 8 <= total) {
            fs.readSync(fd, head, 0, 16, p);
            let size = head.readUInt32BE(0);
            const type = head.toString('latin1', 4, 8);
            if (size === 1) size = Number(head.readBigUInt64BE(8));
            else if (size === 0) size = total - p;
            if (size < 8) return false;
            if (type === 'moov') {
                if (size > 64 * 1024 * 1024) return false; // not a real header
                const moov = Buffer.alloc(size);
                fs.readSync(fd, moov, 0, size, p);
                patchMoov(moov);
                fs.writeSync(fd, moov, 0, size, p);
                return true;
            }
            p += size;
        }
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

/** Copies of the files to send, dated today. Returns their paths (HEIC becomes JPEG). */
async function freshCopies(names, log = () => {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-send-'));
    const files = [];
    for (const name of names) {
        const src = filePath(name);
        const ext = path.extname(name).toLowerCase();
        let target = path.join(dir, name);
        try {
            if (kind(name) === 'video') {
                fs.copyFileSync(src, target);
                if (!freshenVideo(target)) log(`${name}: couldn't read its header, so its own date stays`);
            } else if (ext === '.gif') {
                fs.copyFileSync(src, target); // GIFs carry no capture date
            } else {
                if (ext === '.heic') target = target.replace(/\.heic$/i, '.jpg');
                const format = { '.png': 'png', '.webp': 'webp' }[ext] || 'jpeg';
                // sharp drops metadata unless asked to keep it; rotate() bakes in the orientation first.
                await sharp(src)
                    .rotate()
                    .toFormat(format, format === 'jpeg' ? { quality: 95 } : {})
                    .toFile(target);
            }
        } catch (e) {
            log(`${name}: couldn't set today's date (${e.message}); sending it as it is`);
            fs.copyFileSync(src, target);
        }
        files.push(target);
    }
    return { dir, files };
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
// Straight into Photos through Market's own control app (controlapp/FBMarketCommands.m): no
// screens, a second or two per file. Returns false if this phone's control app is the stock
// build, so the caller uses the Files route. The first time, iOS asks "Allow Market to add to
// your Photos?"; this taps Allow.
async function saveDirect(ctx, names) {
    let access;
    try {
        access = await ctx.photosAccess();
    } catch (e) {
        if (/unhandled endpoint|unknown command|404/i.test(e.message)) {
            ctx.log('This phone has the older control app; saving through Files (reinstall Market on it to skip that)');
            return false;
        }
        throw e;
    }
    if (access === 'asking') {
        ctx.log('Allowing Market to add to Photos (first time only)');
        const allow = await ctx.waitForText('Allow', 10000).catch(() => null);
        if (allow) await ctx.tap(allow.x, allow.y);
        await ctx.sleep(1000);
        access = await ctx.photosAccess();
    }
    if (access !== 'authorized' && access !== 'limited')
        throw new Error(
            'Market is not allowed to add to Photos. Settings → Privacy & Security → Photos → Market → Add Photos Only.',
        );
    for (const name of names) {
        const t0 = Date.now();
        await ctx.saveToPhotosDirect(name);
        ctx.log(`${name} is in Photos (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    return true;
}

// Saves one file that's already in Documents/Market into Photos: opens it straight in
// Quick Look by its own link, then Share → Save Image/Video.
async function saveToPhotos(ctx, name, containerPath) {
    ctx.log(`Saving ${name} to Photos`);
    await ctx.openUrl(`shareddocuments://${containerPath}/Documents/Market/${encodeURIComponent(name)}`);
    await ctx.sleepRandom(1500, 2200);
    // Quick Look opens with its toolbar hidden; a tap brings it back.
    if (!(await ctx.hasText('Share').catch(() => false))) {
        await ctx.tapPct(0.5, 0.42);
        await ctx.sleepRandom(600, 900);
    }
    await ctx.waitForText('Share', 10000);
    await ctx.tapText('Share');
    const saveLabel = kind(name) === 'video' ? 'Save Video' : 'Save Image';
    await ctx.waitForText(saveLabel, 10000);
    await ctx.tapText(saveLabel);
    // The sheet closes once Photos has it; videos take a moment longer to copy.
    const end = Date.now() + 30000;
    while ((await ctx.hasText(saveLabel).catch(() => false)) && Date.now() < end) await ctx.sleep(800);
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
        ctx.log(`Copying ${names.length} file${names.length === 1 ? '' : 's'} to the phone, dated today`);
        const fresh = await freshCopies(names, ctx.log);
        const sentNames = fresh.files.map((f) => path.basename(f));
        try {
            await helper(['push', ctx.device.udid, bundleId, ...fresh.files]);
        } finally {
            fs.rmSync(fresh.dir, { recursive: true, force: true });
        }
        ctx.log("Copied. They're in Files → On My iPhone → Market");
        if (!p.saveToPhotos) return;

        const info = await helper(['container', ctx.device.udid, bundleId]);
        if (!info.fileSharing) {
            ctx.log('To save into Photos automatically, reinstall the control app once (Reinstall on the phone card).');
            throw new Error(
                'Copied, but the control app is an older build without file sharing; reinstall it once from the phone card',
            );
        }
        // Market's own control app saves straight into Photos with nothing on screen.
        if (await saveDirect(ctx, sentNames)) return;

        for (const name of sentNames) {
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

module.exports = { list, save, remove, filePath, send, sendAutomation, freshenVideo, LIBRARY };
