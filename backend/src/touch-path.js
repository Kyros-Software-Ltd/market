// Finger-like movement for swipes and drags. A software swipe is a straight line at constant
// speed with events on a fixed clock; a thumb bows to one side, speeds up or slows down, and
// the screen samples it about every 16.67 ms. Every engine's client builds its moves from here.
const FRAME_MS = 1000 / 60;

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
    const steps = Math.max(2, Math.round(durationMs / FRAME_MS));

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
