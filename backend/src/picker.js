// Finds the newest item in an app's photo picker by looking at the screen.
//
// TikTok's upload picker (and Instagram's) is a 3-column grid of the phone's Photos, oldest
// first, opened scrolled to the bottom: the newest item is the last tile, and where that tile
// sits depends on how many items there are (the last row can hold 1, 2 or 3). The tiles aren't
// in the screen's accessibility tree, so this reads the screenshot: the last row that has
// anything in it, the last filled tile in it. Given the file that was sent, it also compares
// the candidate tiles with it and picks the closest, so an unexpected newest item is caught.
const sharp = require('sharp');

const SIZE = 12; // tiles and the reference are compared as 12x12 thumbnails
// Average colour difference (0-255) above which a tile isn't the sent photo. The sent photo
// measured 4; unrelated photos 50-70.
const MAX_MISMATCH = 25;

/** The picker sheet's own colour, sampled from its header, right of the album name. Empty grid
 *  slots are this colour (TikTok's dark sheet: 18,18,18). */
async function background(img, pw, ph) {
    const { data } = await img
        .clone()
        .extract({ left: Math.round(pw * 0.96), top: Math.round(ph * 0.075), width: 4, height: 4 })
        .raw()
        .toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
}

async function thumb(input, region) {
    let s = sharp(input);
    if (region) s = s.extract(region);
    const { data } = await s
        .resize(SIZE, SIZE, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return data;
}

function stats(data) {
    const n = data.length / 3;
    const mean = [0, 0, 0];
    for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) mean[c] += data[i + c] / n;
    let v = 0;
    for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) v += (data[i + c] - mean[c]) ** 2 / (n * 3);
    return { mean, sd: Math.sqrt(v) };
}

// The sent photo, cropped the way a picker tile shows it: the centre square (tiles are square,
// aspect-filled), then the same inset the tile reading uses, so like is compared with like.
const INSET = 0.18;
async function referenceThumb(file) {
    const { width, height } = await sharp(file).rotate().metadata();
    const side = Math.min(width, height);
    const cut = side * INSET;
    return thumb(await sharp(file).rotate().toBuffer(), {
        left: Math.round((width - side) / 2 + cut),
        top: Math.round((height - side) / 2 + cut),
        width: Math.round(side - 2 * cut),
        height: Math.round(side - 2 * cut),
    });
}

const distance = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length; // average difference per colour channel, 0-255
};

/**
 * @param {string} png base64 screenshot
 * @param {{ gridBottom?: number, columns?: number, reference?: string }} opts
 *   gridBottom: where the grid ends, as a fraction of the screen height (above the picker's
 *   bottom bar); reference: path of the photo that was sent, to check the tile against.
 * @returns {Promise<{ x: number, y: number, match?: number, checked: number }>} centre as fractions
 */
async function newestTile(png, { gridBottom = 0.897, columns = 3, reference } = {}) {
    const buf = Buffer.from(png, 'base64');
    const img = sharp(buf);
    const { width: pw, height: ph } = await img.metadata();
    const tile = pw / columns;
    const bottom = gridBottom * ph;
    const bg = await background(img, pw, ph);
    const ref = reference ? await referenceThumb(reference) : null;

    // Newest first: last row right to left, then the row above.
    const candidates = [];
    for (let row = 0; row < 2; row++) {
        const top = bottom - tile * (row + 1);
        if (top < ph * 0.15) break;
        for (let col = columns - 1; col >= 0; col--) {
            // Inset so the selection circle, the duration label and the gaps don't count.
            const inset = tile * INSET;
            const region = {
                left: Math.round(col * tile + inset),
                top: Math.round(top + inset),
                width: Math.round(tile - 2 * inset),
                height: Math.round(tile - 2 * inset),
            };
            const t = await thumb(buf, region);
            const { mean, sd } = stats(t);
            const empty = sd < 6 && mean.every((m, c) => Math.abs(m - bg[c]) < 18);
            if (empty) continue;
            candidates.push({
                x: (col * tile + tile / 2) / pw,
                y: (top + tile / 2) / ph,
                match: ref ? distance(t, ref) : undefined,
            });
        }
    }
    if (!candidates.length) throw new Error('No photos or videos in the picker');
    if (!ref) return { ...candidates[0], checked: candidates.length };
    // The newest tile that looks like the sent file; tiles are square crops, so allow some slack.
    const best = candidates.reduce((a, b) => (b.match < a.match ? b : a));
    if (best.match > MAX_MISMATCH)
        throw new Error(
            `The photo that was sent isn't among the newest in the picker (closest differs by ${Math.round(best.match)})`,
        );
    const pick = candidates[0].match <= best.match + 6 ? candidates[0] : best;
    return { ...pick, checked: candidates.length };
}

/**
 * The newest `count` tiles, oldest of them first (the order they were saved, so the order a
 * carousel should be ticked in), with where to tap each one's select circle.
 * references: paths of the photos that were sent, in the same order, to check each tile.
 * @returns {Promise<Array<{ x, y, circle: { x, y }, match?: number }>>} fractions of the screen
 */
async function newestTiles(png, { count, gridBottom = 0.897, columns = 3, references = [] } = {}) {
    const buf = Buffer.from(png, 'base64');
    const img = sharp(buf);
    const { width: pw, height: ph } = await img.metadata();
    const tile = pw / columns;
    const bottom = gridBottom * ph;
    const bg = await background(img, pw, ph);

    // Newest first: last row right to left, then the rows above, until enough are found.
    const found = [];
    for (let row = 0; found.length < count; row++) {
        const top = bottom - tile * (row + 1);
        if (top < ph * 0.17) break; // under the tabs: would need scrolling
        for (let col = columns - 1; col >= 0 && found.length < count; col--) {
            const inset = tile * INSET;
            const t = await thumb(buf, {
                left: Math.round(col * tile + inset),
                top: Math.round(top + inset),
                width: Math.round(tile - 2 * inset),
                height: Math.round(tile - 2 * inset),
            });
            const { mean, sd } = stats(t);
            if (sd < 6 && mean.every((m, c) => Math.abs(m - bg[c]) < 18)) continue; // empty slot
            found.push({
                x: (col * tile + tile / 2) / pw,
                y: (top + tile / 2) / ph,
                // The select circle sits in each tile's top-right corner.
                circle: { x: (col * tile + tile * 0.87) / pw, y: (top + tile * 0.13) / ph },
                thumb: t,
            });
        }
    }
    if (found.length < count)
        throw new Error(`Only ${found.length} of the ${count} newest items fit on the picker's screen`);
    const tiles = found.reverse(); // oldest of them first
    for (const [i, ref] of references.entries()) {
        if (!ref || !tiles[i]) continue;
        tiles[i].match = distance(tiles[i].thumb, await referenceThumb(ref));
        if (tiles[i].match > MAX_MISMATCH)
            throw new Error(
                `Picker tile ${i + 1} doesn't look like photo ${i + 1} that was sent (differs by ${Math.round(tiles[i].match)})`,
            );
    }
    return tiles.map(({ thumb: _t, ...rest }) => rest);
}

module.exports = { newestTile, newestTiles };
