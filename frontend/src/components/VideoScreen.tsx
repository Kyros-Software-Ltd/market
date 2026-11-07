'use client';
// The live screen of a phone on Apple's own services (iOS 27): HEVC video decoded in the
// browser, up to 60 fps. Frames arrive as [4-byte length][type][data], where type is
// 0 = keyframe, 1 = delta, 2 = keyframe after a dropped stream (start the decoder again).
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ScreenProps } from './LiveScreen';

const KEY = 0;
const RESET_KEY = 2;
const FRAME_US = 16666;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// When the picture moves fast the phone shrinks it into the top-left of the frame and fills
// the rest with flat gray. Find that area so it can be stretched back to full size.
const PROBE_H = 96;
const isPadding = (d: Uint8ClampedArray, i: number) =>
    Math.abs(d[i] - 128) < 8 && Math.abs(d[i + 1] - 128) < 8 && Math.abs(d[i + 2] - 128) < 8;

function contentArea(frame: VideoFrame, probe: CanvasRenderingContext2D) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const pw = Math.max(8, Math.round((PROBE_H * w) / h));
    const full = { w, h };
    probe.canvas.width = pw;
    probe.canvas.height = PROBE_H;
    probe.drawImage(frame, 0, 0, pw, PROBE_H);
    const d = probe.getImageData(0, 0, pw, PROBE_H).data;
    const at = (x: number, y: number) => (y * pw + x) * 4;
    // The bottom-right corner is only gray while the picture is shrunk.
    if (!isPadding(d, at(pw - 1, PROBE_H - 1))) return full;
    let right = pw;
    while (right > 0 && Array.from({ length: PROBE_H }, (_, y) => y).every((y) => isPadding(d, at(right - 1, y))))
        right--;
    let bottom = PROBE_H;
    while (bottom > 0 && Array.from({ length: pw }, (_, x) => x).every((x) => isPadding(d, at(x, bottom - 1))))
        bottom--;
    if (right < pw * 0.2 || bottom < PROBE_H * 0.2) return full;
    return { w: Math.round((right / pw) * w), h: Math.round((bottom / PROBE_H) * h) };
}

export const VideoScreen = forwardRef<HTMLCanvasElement, ScreenProps>(function VideoScreen(
    { udid, onFps, ...rest },
    ref,
) {
    const canvas = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => canvas.current!, []);
    const fpsCb = useRef(onFps);
    fpsCb.current = onFps;

    useEffect(() => {
        const ctx = canvas.current!.getContext('2d', { alpha: false })!;
        const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        let stopped = false;
        let pending: VideoFrame | null = null; // newest decoded frame, not yet painted
        let raf = 0;
        let decoder: VideoDecoder | null = null;
        let abort: AbortController | null = null;
        let painted = 0;
        const fpsTimer = setInterval(() => {
            fpsCb.current?.(painted);
            painted = 0;
        }, 1000);

        const paint = () => {
            raf = 0;
            const f = pending;
            const c = canvas.current;
            pending = null;
            if (!f) return;
            if (c) {
                // Keep the first size: the phone's frame height wobbles by a few pixels.
                if (c.width === 1 || c.width > c.height !== f.displayWidth > f.displayHeight) {
                    c.width = f.displayWidth;
                    c.height = f.displayHeight;
                }
                const area = contentArea(f, probe);
                ctx.drawImage(f, 0, 0, area.w, area.h, 0, 0, c.width, c.height);
                painted++;
            }
            f.close();
        };

        const onFrame = (frame: VideoFrame) => {
            if (stopped) return frame.close();
            pending?.close(); // a slow moment skips ahead instead of building up lag
            pending = frame;
            if (!raf) raf = requestAnimationFrame(paint);
        };

        async function readCodec(): Promise<VideoDecoderConfig> {
            const res = await fetch(`/api/devices/${udid}/codec`, { signal: abort!.signal, cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            const { codec, description } = await res.json();
            return {
                codec,
                description: Uint8Array.from(atob(description), (c) => c.charCodeAt(0)),
                optimizeForLatency: true,
            };
        }

        async function run() {
            let retry = 500;
            while (!stopped) {
                abort = new AbortController();
                try {
                    const config = await readCodec();
                    const res = await fetch(`/api/devices/${udid}/video`, { signal: abort.signal, cache: 'no-store' });
                    if (!res.ok || !res.body) throw new Error(String(res.status));
                    const start = () => {
                        if (decoder && decoder.state !== 'closed') decoder.close();
                        decoder = new VideoDecoder({ output: onFrame, error: () => {} });
                        decoder.configure(config);
                    };
                    const reader = res.body.getReader();
                    let buf = new Uint8Array(0);
                    let timestamp = 0;
                    let ready = false; // wait for a keyframe after (re)starting the decoder
                    retry = 500;
                    while (!stopped) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        const joined = new Uint8Array(buf.length + value.length);
                        joined.set(buf);
                        joined.set(value, buf.length);
                        buf = joined;
                        while (buf.length >= 4) {
                            const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
                            if (buf.length < 4 + len) break;
                            const type = buf[4];
                            const data = buf.slice(5, 4 + len);
                            buf = buf.subarray(4 + len);
                            const key = type === KEY || type === RESET_KEY;
                            if (type === RESET_KEY || !decoder || decoder.state !== 'configured') {
                                start();
                                ready = false;
                            }
                            if (key) ready = true;
                            if (!ready) continue;
                            decoder!.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
                            timestamp += FRAME_US;
                        }
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
            if (decoder && decoder.state !== 'closed') decoder.close();
        };
    }, [udid]);

    return <canvas ref={canvas} width={1} height={1} {...rest} />;
});
