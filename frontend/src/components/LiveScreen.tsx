'use client';
// Live phone screen via DeviceKit / legacy WDA MJPEG.
// Decoded off the main thread; only the newest frame is painted each refresh.
// `profile` picks stream load: grid is light (many phones), focus is high fps (one phone).
import { forwardRef, type HTMLAttributes, useEffect, useImperativeHandle, useRef } from 'react';

export type StreamProfile = 'grid' | 'focus';

export type ScreenProps = HTMLAttributes<HTMLCanvasElement> & {
    udid: string;
    /** Called once a second with the frames actually painted in that second. */
    onFps?: (fps: number) => void;
    /** grid = many cards; focus = control panel. Defaults to focus. */
    profile?: StreamProfile;
};

/** Hint only — backend hub uses the phone's configured stream. Kept light for heavy apps (X, TikTok). */
const PROFILE_QS: Record<StreamProfile, string> = {
    grid: 'fps=12&quality=24&scale=32',
    focus: 'fps=24&quality=28&scale=36',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const find = (b: Uint8Array, len: number, x: number, y: number, from: number) => {
    for (let i = from; i < len - 1; i++) if (b[i] === x && b[i + 1] === y) return i;
    return -1;
};

export const LiveScreen = forwardRef<HTMLCanvasElement, ScreenProps>(function LiveScreen(
    { udid, onFps, profile = 'focus', ...rest },
    ref,
) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => canvas.current!, []);
    const fpsCb = useRef(onFps);
    fpsCb.current = onFps;

    useEffect(() => {
        const ctx = canvas.current!.getContext('2d', { alpha: false })!;
        let stopped = false;
        let pending: ImageBitmap | null = null;
        let latest: Blob | null = null;
        let decoding = false;
        let raf = 0;
        let abort: AbortController | null = null;
        let painted = 0;
        const fpsTimer = setInterval(() => {
            fpsCb.current?.(painted);
            painted = 0;
        }, 1000);

        const paint = () => {
            raf = 0;
            const f = pending;
            if (!f) return;
            pending = null;
            const c = canvas.current;
            if (c) {
                if (c.width !== f.width || c.height !== f.height) {
                    c.width = f.width;
                    c.height = f.height;
                }
                ctx.drawImage(f, 0, 0);
                painted++;
            }
            f.close();
        };

        const decode = async () => {
            if (decoding) return;
            decoding = true;
            while (latest && !stopped) {
                const blob = latest;
                latest = null;
                try {
                    const bmp = await createImageBitmap(blob);
                    if (stopped) {
                        bmp.close();
                        break;
                    }
                    pending?.close();
                    pending = bmp;
                    if (!raf) raf = requestAnimationFrame(paint);
                } catch {
                    /* corrupt frame */
                }
            }
            decoding = false;
        };

        async function run() {
            let retry = 200;
            const qs = PROFILE_QS[profile] || PROFILE_QS.focus;
            while (!stopped) {
                abort = new AbortController();
                try {
                    const res = await fetch(`/api/devices/${udid}/stream?${qs}`, {
                        signal: abort.signal,
                        cache: 'no-store',
                    });
                    // Only nudge a reconnect when the phone is not streaming yet — a 502 is often
                    // a brief hub blip; forcing /connect tears DeviceKit down and freezes at 0 fps.
                    if (res.status === 409) {
                        try {
                            await fetch(`/api/devices/${udid}/connect`, { method: 'POST', cache: 'no-store' });
                        } catch {
                            /* already connecting */
                        }
                    }
                    if (!res.ok || !res.body) throw new Error(String(res.status));
                    const reader = res.body.getReader();
                    // Growable buffer — avoid allocating a new Uint8Array on every TCP chunk.
                    let buf = new Uint8Array(256 * 1024);
                    let len = 0;
                    const maxBuf = 2 * 1024 * 1024;
                    retry = 200;
                    while (!stopped) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (len + value.length > buf.length) {
                            const next = new Uint8Array(Math.min(maxBuf, Math.max(buf.length * 2, len + value.length)));
                            next.set(buf.subarray(0, len));
                            buf = next;
                        }
                        // Heavy apps (X) can stall mid-JPEG; drop a runaway buffer so we resync.
                        if (len + value.length > maxBuf) {
                            len = 0;
                        }
                        buf.set(value.subarray(0, Math.min(value.length, buf.length - len)), len);
                        len += Math.min(value.length, buf.length - len);
                        for (;;) {
                            const start = find(buf, len, 0xff, 0xd8, 0);
                            if (start < 0) {
                                // Keep the last byte in case a marker is split across chunks.
                                if (len > 1) {
                                    buf[0] = buf[len - 1];
                                    len = 1;
                                }
                                break;
                            }
                            if (start > 0) {
                                buf.copyWithin(0, start, len);
                                len -= start;
                            }
                            const end = find(buf, len, 0xff, 0xd9, 2);
                            if (end < 0) break;
                            latest = new Blob([buf.slice(0, end + 2)], { type: 'image/jpeg' });
                            buf.copyWithin(0, end + 2, len);
                            len -= end + 2;
                            decode();
                        }
                    }
                } catch {
                    /* stream dropped */
                }
                if (stopped) break;
                await sleep(retry);
                retry = Math.min(retry * 1.5, 1500);
            }
        }
        run();

        return () => {
            stopped = true;
            clearInterval(fpsTimer);
            abort?.abort();
            if (raf) cancelAnimationFrame(raf);
            pending?.close();
        };
    }, [udid, profile]);

    return <canvas ref={canvas} width={1} height={1} {...rest} />;
});
