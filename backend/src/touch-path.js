// Finger-like movement for swipes and drags: the path bows to one side and speeds up or slows
// down instead of being a straight line at constant speed.
//
// The control app gets slower with every point on the path. Measured on an iPhone XR for a
// 300 ms swipe: 18 points (one per screen frame) took 4-9 s, 4 points 2 s, 3 points 1.4 s,
// 1 point 1.2 s. Three points keep the bow and the change of speed for most of that saving.
const MAX_POINTS = 3;
const POINT_MS = 100; // shorter moves get fewer points

const rand = (min, max) => min + Math.random() * (max - min);

/** How long a tap stays down: never the same twice. */
const tapHoldMs = () => Math.round(rand(55, 115));

/**
 * Points from just after (x1, y1) to exactly (x2, y2), each with `dt`, the ms since the one
 * before. `flick` leaves the finger still moving at the end, so lists keep their momentum;
 * without it the move settles to a stop, as when placing a dragged item.
 */
function humanPath(x1, y1, x2, y2, durationMs, { flick = true } = {}) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.min(MAX_POINTS, Math.round(durationMs / POINT_MS)));

    const power = rand(1.3, 1.7);
    const ease = flick ? (t) => t ** power : (t) => t * t * (3 - 2 * t);

    // Sideways bow, peaking a little before or after the middle, on a random side.
    const bow = length < 6 ? 0 : length * rand(0.02, 0.07) * (Math.random() < 0.5 ? -1 : 1);
    const skew = rand(0.8, 1.25);
    const nx = length ? -dy / length : 0;
    const ny = length ? dx / length : 0;

    const points = [];
    let elapsed = 0;
    for (let i = 1; i <= steps; i++) {
        const s = i === steps ? 1 : ease(i / steps);
        const off = bow * Math.sin(Math.PI * s ** skew);
        const at = Math.round((i * durationMs) / steps);
        points.push({ x: x1 + dx * s + nx * off, y: y1 + dy * s + ny * off, dt: at - elapsed });
        elapsed = at;
    }
    return points;
}

module.exports = { humanPath, tapHoldMs, rand };
