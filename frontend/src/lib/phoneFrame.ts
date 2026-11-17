// What each iPhone looks like around its screen, worked out from the model code the phone
// reports ("iPhone11,8"). Three body styles cover every iPhone: a home button with a chin,
// a notch, or a Dynamic Island. All sizes are fractions of the screen's width, so the frame
// scales with whatever size the live view is drawn at.
//
// Screen corner radius and cutout sizes are Apple's own, in points over the screen's width in
// points (iPhone X: 39 pt corners and a 209 x 30 pt notch on a 375 pt screen). The edge around
// the screen is drawn a little slimmer than the real phone so the screen gets the room.
export type FrameKind = 'home' | 'notch' | 'island' | 'plain';

export interface FrameSpec {
    kind: FrameKind;
    /** Body edge beside the screen, metal rim included. */
    bezel: number;
    /** Body above and below the screen (the forehead and chin on home-button phones). */
    cap: number;
    /** Corner radius of the screen itself; the body's is this plus the bezel. */
    screenRadius: number;
    /** Width and height of the notch or Dynamic Island. */
    cutout: number;
    cutoutHeight: number;
    /** Screen width / height, used until the phone reports its real size. */
    ratio: number;
}

const TALL = 9 / 19.5;

// iPhone 6 to 8, SE 2 and SE 3: square screen, forehead and chin, round home button.
const HOME: FrameSpec = {
    kind: 'home',
    bezel: 0.045,
    cap: 0.24,
    screenRadius: 0,
    cutout: 0,
    cutoutHeight: 0,
    ratio: 9 / 16,
};
// X, XS, 11 Pro, 12: 209 x 30 pt notch on a 375 pt screen, 39 pt corners.
const NOTCH_WIDE: FrameSpec = {
    kind: 'notch',
    bezel: 0.024,
    cap: 0.024,
    screenRadius: 0.105,
    cutout: 0.557,
    cutoutHeight: 0.08,
    ratio: TALL,
};
// XR and 11: the same notch on an LCD, which needs a visibly thicker edge.
const NOTCH_LCD: FrameSpec = { ...NOTCH_WIDE, bezel: 0.034, cap: 0.034, screenRadius: 0.1 };
// 13, 14 and 16e: the notch narrowed to 162 x 33 pt on a 390 pt screen, 47 pt corners.
const NOTCH_SMALL: FrameSpec = { ...NOTCH_WIDE, screenRadius: 0.121, cutout: 0.415, cutoutHeight: 0.085 };
// 14 Pro and every model from the 15 on: 126 x 37 pt island on a 393 pt screen, 55 pt corners.
const ISLAND: FrameSpec = {
    kind: 'island',
    bezel: 0.02,
    cap: 0.02,
    screenRadius: 0.14,
    cutout: 0.32,
    cutoutHeight: 0.095,
    ratio: TALL,
};
const PLAIN: FrameSpec = {
    kind: 'plain',
    bezel: 0.03,
    cap: 0.03,
    screenRadius: 0.05,
    cutout: 0,
    cutoutHeight: 0,
    ratio: TALL,
};

export function frameFor(model: string): FrameSpec {
    const m = /^iPhone(\d+),(\d+)$/.exec(model || '');
    if (!m) return PLAIN; // iPad, iPod, or not known yet
    const major = Number(m[1]);
    const code = `${major},${Number(m[2])}`;

    if (major < 10 || ['10,1', '10,2', '10,4', '10,5', '12,8', '14,6'].includes(code)) return HOME;

    if (['15,2', '15,3', '15,4', '15,5'].includes(code)) return ISLAND;
    if (major >= 16 && code !== '17,5') return ISLAND;

    if (code === '11,8' || code === '12,1') return NOTCH_LCD;
    if (major <= 13) return NOTCH_WIDE;
    return NOTCH_SMALL;
}
