'use client';
// A phone's live screen over USB. Reads the control app's MJPEG stream itself, decodes
// frames off the main thread and paints only the newest one each display refresh, so it
// never flashes half-drawn frames or falls behind like a plain <img> showing the stream.
import { forwardRef, type HTMLAttributes, useEffect, useImperativeHandle, useRef } from 'react';

type Props = HTMLAttributes<HTMLCanvasElement> & {
    udid: string;
    /** Called once a second with the frames actually painted in that second. */
    onFps?: (fps: number) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

const find = (b: Uint8Array, x: number, y: number, from: number) => {
    for (let i = from; i < b.length - 1; i++) if (b[i] === x && b[i + 1] === y) return i;
    return -1;
};

export const LiveScreen = forwardRef<HTMLCanvasElement, Props>(function LiveScreen({ udid, onFps, ...rest }, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => canvas.current!, []);
    const fpsCb = useRef(onFps);
    fpsCb.current = onFps;

    useEffect(() => {
        const ctx = canvas.current!.getContext('2d', { alpha: false })!;
        let stopped = false;
        let pending: ImageBitmap | null = null; // newest decoded frame, not yet painted
        let latest: Blob | null = null; // newest received frame, waiting to decode
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

        // Decode one frame at a time; frames that arrive meanwhile replace each other, so a
        // slow moment skips ahead instead of building up lag.
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
                    /* corrupt frame: skip */
                }
            }
            decoding = false;
        };

        async function run() {
            let retry = 500;
            while (!stopped) {
                abort = new AbortController();
                try {
                    const res = await fetch(`/api/devices/${udid}/stream`, { signal: abort.signal, cache: 'no-store' });
                    if (!res.ok || !res.body) throw new Error(String(res.status));
                    const reader = res.body.getReader();
                    let buf: Uint8Array = new Uint8Array(0);
                    retry = 500;
                    while (!stopped) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buf = concat(buf, value);
                        // Pull out every complete JPEG (FFD8 … FFD9) in the buffer.
                        for (;;) {
                            const start = find(buf, 0xff, 0xd8, 0);
                            if (start < 0) {
                                buf = buf.slice(Math.max(0, buf.length - 1));
                                break;
                            }
                            const end = find(buf, 0xff, 0xd9, start + 2);
                            if (end < 0) {
                                buf = buf.slice(start);
                                break;
                            }
                            latest = new Blob([buf.slice(start, end + 2)], { type: 'image/jpeg' });
                            buf = buf.slice(end + 2);
                        }
                        decode();
                    }
                } catch {
                    /* stream dropped or phone restarting */
                }
                if (stopped) break;
                await sleep(retry);
                retry = Math.min(retry * 2, 4000);
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
    }, [udid]);

    return <canvas ref={canvas} width={1} height={1} {...rest} />;
});
