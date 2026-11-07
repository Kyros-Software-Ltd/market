'use client';
import { Button } from '@heroui/react';
import {
    AppWindow,
    Camera,
    Circle,
    CornerDownLeft,
    Lock,
    PanelLeft,
    PanelRight,
    Pencil,
    Send,
    Square,
    Sun,
    Volume1,
    Volume2,
    X,
} from 'lucide-react';
// Full-size control of one phone: click = tap, drag = swipe, hold = long-press (sent as soon as
// you've held still for HOLD_MS), hold then drag = drag (moving an app icon), wheel = scroll.
// With the panel open, the PC keyboard types into the focused field on the phone.
import { type MouseEvent as RMouseEvent, type WheelEvent as RWheelEvent, useEffect, useRef, useState } from 'react';
import { control, get, post } from '@/lib/api';
import { modelName, slug } from '@/lib/format';
import { HomeIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';
import { Feed, FpsChip, StatusBadge } from './common';
import { LiveScreen } from './LiveScreen';
import { PhoneState } from './PhoneState';
import { usePrompt } from './Prompt';
import { ActionMenu, Panel, TextInput, Toggle } from './ui';

type Step = Record<string, unknown>;
interface Press {
    x: number;
    y: number;
    px: number;
    py: number;
    t: number;
    held: boolean; // the long-press has gone to the phone
    movedAt: number; // when the mouse left the start point, after the hold
    timer: ReturnType<typeof setTimeout>;
    ring: HTMLDivElement;
}

const HOLD_MS = 500;
const STILL_PX = 12; // a hand on a mouse wobbles a little; this much still counts as holding still

// Which side the panel docks to; remembered between visits.
function useDockSide() {
    const [side, setSide] = useState<'left' | 'right'>('right');
    useEffect(() => {
        try {
            if (localStorage.getItem('market.dock') === 'left') setSide('left');
        } catch {}
    }, []);
    const flip = () => {
        const next = side === 'right' ? 'left' : 'right';
        setSide(next);
        try {
            localStorage.setItem('market.dock', next);
        } catch {}
    };
    return [side, flip] as const;
}

export function PhoneControl({ udid }: { udid: string }) {
    const [side, flipSide] = useDockSide();
    const { status, setFocus, toast } = useStore();
    const act = useAction();
    const ask = usePrompt();
    const device = status.devices.find((d) => d.udid === udid);
    const imgRef = useRef<HTMLCanvasElement>(null);
    const screenRef = useRef<HTMLDivElement>(null);
    const press = useRef<Press | null>(null);
    const wheelAt = useRef(0);
    const [mirror, setMirror] = useState(false);
    const [fps, setFps] = useState<number | null>(null);
    const [text, setText] = useState('');
    const [submit, setSubmit] = useState(false);
    const [apps, setApps] = useState<{ bundleId: string; name: string }[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [rec, setRec] = useState<{ steps: Step[]; last: number } | null>(null);
    const recRef = useRef(rec);
    recRef.current = rec;

    const ready = device?.status === 'ready';

    useEffect(() => {
        if (ready)
            get<{ bundleId: string; name: string }[]>(`/devices/${udid}/apps`)
                .then(setApps)
                .catch(() => {});
    }, [udid, ready]);

    useEffect(() => {
        const load = () =>
            get<{ logs: string[] }>(`/devices/${udid}/logs`)
                .then((r) => setLogs(r.logs.slice(-120)))
                .catch(() => {});
        load();
        const t = setInterval(load, 2500);
        return () => clearInterval(t);
    }, [udid]);

    // Defined early so the keyboard listener can call it; body filled below once helpers exist.
    const sendRef = useRef<(action: string, args?: Record<string, unknown>) => void>(() => {});

    // PC keyboard → phone when the dock is open (and you're not typing in a Market field).
    useEffect(() => {
        if (!ready) return;
        let pending = '';
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            if (!pending) return;
            const chunk = pending;
            pending = '';
            sendRef.current('type', { text: chunk });
        };
        const named: Record<string, string> = {
            Enter: 'return',
            Backspace: 'backspace',
            Delete: 'forwarddelete',
            Tab: 'tab',
            ArrowUp: 'up',
            ArrowDown: 'down',
            ArrowLeft: 'left',
            ArrowRight: 'right',
            Home: 'home',
            End: 'end',
            PageUp: 'pageup',
            PageDown: 'pagedown',
        };
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t) {
                const tag = t.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
                    if (e.key === 'Escape') close();
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const special = named[e.key];
            if (special) {
                e.preventDefault();
                flush();
                sendRef.current('keys', { keys: [{ key: special, modifiers: e.shiftKey ? ['shift'] : [] }] });
                return;
            }
            if (e.key.length === 1) {
                e.preventDefault();
                pending += e.key;
                if (flushTimer) clearTimeout(flushTimer);
                flushTimer = setTimeout(flush, 40);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            if (flushTimer) clearTimeout(flushTimer);
            if (pending) sendRef.current('type', { text: pending });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, udid]);

    if (!device) return null;

    const others = () =>
        status.devices.filter((d) => d.udid !== udid && d.status === 'ready').map((d) => d.udid);
    const targets = () => (mirror ? [udid, ...others()] : [udid]);

    // Each action you do while recording becomes a step, with the pause before it kept as a wait.
    function record(action: string, args: Step) {
        const r = recRef.current;
        if (!r) return;
        const map: Record<string, () => Step> = {
            tap: () => ({ do: 'tap', x: args.x, y: args.y }),
            longpress: () => ({ do: 'longpress', x: args.x, y: args.y, ms: args.ms }),
            swipe: () => ({ do: 'swipe', x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, ms: args.ms }),
            drag: () => ({
                do: 'drag',
                x1: args.x1,
                y1: args.y1,
                x2: args.x2,
                y2: args.y2,
                hold: args.hold,
                ms: args.ms,
            }),
            type: () => ({ do: 'type', text: args.text, ...(args.submit ? { submit: true } : {}) }),
            launch: () => ({ do: 'launch', bundleId: args.bundleId }),
            home: () => ({ do: 'home' }),
        };
        if (!map[action]) return;
        const now = Date.now();
        const gap = Math.min(30000, now - r.last);
        const steps = [...r.steps];
        if (steps.length && gap > 300) steps.push({ do: 'wait', ms: Math.round(gap / 100) * 100 });
        steps.push(map[action]());
        setRec({ steps, last: now });
    }

    function send(action: string, args: Step = {}) {
        record(action, args);
        control(action, targets(), args).catch((e: Error) => toast(e.message, true));
    }
    sendRef.current = send;

    // Mouse position as 0-1 fractions of the phone screen, allowing for letterboxing.
    function toFraction(e: { clientX: number; clientY: number }) {
        const img = imgRef.current!;
        const r = img.getBoundingClientRect();
        const ratio = img.width > 1 ? img.width / img.height : 9 / 19.5;
        let w = r.width,
            h = r.height;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        const left = r.left + (r.width - w) / 2;
        const top = r.top + (r.height - h) / 2;
        const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
        return { x: clamp((e.clientX - left) / w), y: clamp((e.clientY - top) / h) };
    }

    function ripple(e: RMouseEvent) {
        const box = screenRef.current!.getBoundingClientRect();
        const dot = document.createElement('div');
        dot.className = 'ripple';
        dot.style.left = `${e.clientX - box.left}px`;
        dot.style.top = `${e.clientY - box.top}px`;
        screenRef.current!.appendChild(dot);
        setTimeout(() => dot.remove(), 450);
    }

    // A ring under the pointer that fills while you hold, so you can see a hold is coming.
    function holdRing(e: RMouseEvent) {
        const box = screenRef.current!.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.className = 'hold-ring';
        ring.style.left = `${e.clientX - box.left}px`;
        ring.style.top = `${e.clientY - box.top}px`;
        ring.style.animationDuration = `${HOLD_MS}ms`;
        screenRef.current!.appendChild(ring);
        return ring;
    }

    function onDown(e: RMouseEvent) {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = toFraction(e);
        const p: Press = {
            ...start,
            px: e.clientX,
            py: e.clientY,
            t: Date.now(),
            held: false,
            movedAt: 0,
            ring: holdRing(e),
            // Held still long enough: press on the phone now, while you're still holding.
            timer: setTimeout(() => {
                if (press.current !== p) return;
                p.held = true;
                p.ring.classList.add('held');
                // Short hold — DeviceKit pauses the live stream for the whole longpress.
                send('longpress', { x: start.x, y: start.y, ms: 450 });
            }, HOLD_MS),
        };
        press.current = p;
    }

    function onMove(e: RMouseEvent) {
        const p = press.current;
        if (!p || Math.hypot(e.clientX - p.px, e.clientY - p.py) < STILL_PX) return;
        if (!p.held) {
            clearTimeout(p.timer); // moving before the hold makes it a swipe
            p.ring.remove();
        } else if (!p.movedAt) {
            p.movedAt = Date.now();
        }
    }

    function onUp(e: RMouseEvent) {
        const p = press.current;
        press.current = null;
        if (!p) return;
        clearTimeout(p.timer);
        p.ring.remove();
        ripple(e);
        const end = toFraction(e);
        const moved = Math.hypot(e.clientX - p.px, e.clientY - p.py) >= STILL_PX;
        if (p.held) {
            // The long-press already happened; dragging after it picks the thing up and moves it.
            if (moved) {
                send('drag', { x1: p.x, y1: p.y, x2: end.x, y2: end.y, hold: 400, ms: 180 });
            }
        } else if (moved) {
            // Cap duration: mouse-drag time used to be sent as-is (up to 1s) and froze MJPEG.
            send('swipe', { x1: p.x, y1: p.y, x2: end.x, y2: end.y, ms: 160 });
        } else {
            send('tap', { x: p.x, y: p.y });
        }
    }

    function onWheel(e: RWheelEvent) {
        if (Date.now() - wheelAt.current < 400 || Math.abs(e.deltaY) < 4) return;
        wheelAt.current = Date.now();
        send(
            'swipe',
            e.deltaY > 0
                ? { x1: 0.5, y1: 0.72, x2: 0.5, y2: 0.3, ms: 140 }
                : { x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.72, ms: 140 },
        );
    }

    async function stopRecording() {
        const r = rec;
        setRec(null);
        if (!r?.steps.length) return;
        const name = await ask({
            title: `Save these ${r.steps.length} steps as an automation`,
            value: 'My flow',
            placeholder: 'Automation name',
        });
        if (!name) return;
        await act(
            () =>
                post(`/flows/${slug(name)}`, {
                    name,
                    description: `Recorded on ${device!.name} ${new Date().toLocaleDateString()}`,
                    steps: r.steps,
                }),
            `Saved "${name}" to Automations`,
        );
    }

    async function rename() {
        const name = await ask({ title: 'Rename phone', value: device!.name, placeholder: 'Phone name' });
        if (name && name !== device!.name) act(() => post(`/devices/${udid}/rename`, { name }), `Renamed to ${name}`);
    }

    function close() {
        if (rec) stopRecording();
        setFocus(null);
    }

    const mine = status.activity
        .filter((a) => a.udid === udid)
        .slice(-20)
        .reverse();
    const recCount = rec ? rec.steps.filter((s) => s.do !== 'wait').length : 0;

    function screenshot() {
        const a = document.createElement('a');
        a.href = `/api/devices/${udid}/screenshot`;
        a.download = `${device!.name}-${Date.now()}.png`;
        a.click();
    }

    function sendText() {
        if (!text) return;
        send('type', { text, submit });
        setText('');
    }

    return (
        <aside className={`dock ${side}`}>
            <div className="dock-body">
                <div className="control-screen dark" data-theme="dark" ref={screenRef} onWheel={onWheel}>
                    {ready ? (
                        <LiveScreen
                            ref={imgRef}
                            udid={device.udid}
                            profile="focus"
                            onFps={setFps}
                            onMouseDown={onDown}
                            onMouseMove={onMove}
                            onMouseUp={onUp}
                            onMouseLeave={(e) => {
                                if (press.current) onUp(e);
                            }}
                        />
                    ) : (
                        <PhoneState device={device} />
                    )}
                    {ready && <FpsChip fps={fps} />}
                    {rec && (
                        <div className="rec">
                            <Circle size={8} fill="currentColor" />
                            REC · {recCount}
                        </div>
                    )}
                </div>

                <div className="control-side">
                    <div className="dock-head">
                        <div className="grow">
                            <div className="row" style={{ gap: 4 }}>
                                <h2 className="ellipsis">{device.name}</h2>
                                <Button isIconOnly size="sm" variant="ghost" aria-label="Rename phone" onPress={rename}>
                                    <Pencil size={13} />
                                </Button>
                            </div>
                            <div className="dock-sub">
                                {modelName(device.model)} · iOS {device.iosVersion}
                            </div>
                        </div>
                        <StatusBadge device={device} />
                        <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={side === 'right' ? 'Move panel to the left' : 'Move panel to the right'}
                            onPress={flipSide}
                        >
                            {side === 'right' ? <PanelLeft size={16} /> : <PanelRight size={16} />}
                        </Button>
                        <Button isIconOnly size="sm" variant="ghost" aria-label="Close" onPress={close}>
                            <X size={16} />
                        </Button>
                    </div>

                    <div className="quick-actions">
                        {[
                            { label: 'Home', icon: <HomeIcon width={16} height={16} />, run: () => send('home') },
                            { label: 'Wake', icon: <Sun size={16} />, run: () => send('unlock') },
                            { label: 'Lock', icon: <Lock size={16} />, run: () => send('lock') },
                            { label: 'Volume down', icon: <Volume1 size={16} />, run: () => send('volumeDown') },
                            { label: 'Volume up', icon: <Volume2 size={16} />, run: () => send('volumeUp') },
                            { label: 'Screenshot', icon: <Camera size={16} />, run: screenshot },
                        ].map((b) => (
                            <Button
                                key={b.label}
                                isIconOnly
                                variant="secondary"
                                aria-label={b.label}
                                onPress={b.run}
                                isDisabled={!ready}
                            >
                                {b.icon}
                            </Button>
                        ))}
                    </div>

                    <div className="row">
                        <TextInput
                            value={text}
                            onChange={setText}
                            placeholder={ready ? 'Type here or use your keyboard…' : 'Phone not ready'}
                            isDisabled={!ready}
                            onEnter={sendText}
                        />
                        <Button
                            isIconOnly
                            size="md"
                            variant={submit ? 'primary' : 'secondary'}
                            aria-label={submit ? 'Return after send is on' : 'Return after send is off'}
                            onPress={() => setSubmit(!submit)}
                            isDisabled={!ready}
                        >
                            <CornerDownLeft size={15} />
                        </Button>
                        <Button
                            isIconOnly
                            size="md"
                            variant="primary"
                            aria-label="Send text to phone"
                            onPress={sendText}
                            isDisabled={!ready || !text}
                        >
                            <Send size={15} />
                        </Button>
                    </div>

                    <div className="pair">
                        <ActionMenu
                            label="Open app"
                            icon={<AppWindow size={15} />}
                            isDisabled={!ready}
                            items={apps.map((a) => ({ key: a.bundleId, label: a.name }))}
                            onAction={(bundleId) => send('launch', { bundleId })}
                        />

                        {rec ? (
                            <Button variant="danger-soft" fullWidth onPress={stopRecording}>
                                <Square size={12} fill="currentColor" />
                                Stop and save recording
                            </Button>
                        ) : (
                            <Button
                                variant="secondary"
                                fullWidth
                                onPress={() => setRec({ steps: [], last: Date.now() })}
                                isDisabled={!ready}
                            >
                                <Circle size={12} fill="var(--red)" color="var(--red)" />
                                Record
                            </Button>
                        )}
                    </div>

                    <details className="more">
                        <summary>More</summary>
                        <div className="col" style={{ gap: 16 }}>
                            <div className="row">
                                <span className="grow">
                                    Mirror to other ready phones ({others().length})
                                </span>
                                <Toggle
                                    isSelected={mirror}
                                    onChange={setMirror}
                                    label="Mirror to other ready phones"
                                    isDisabled={!others().length}
                                />
                            </div>
                            <div>
                                <div className="section-title">Recent activity</div>
                                <Panel padded={false}>
                                    <Feed items={mine} empty="Nothing yet." />
                                </Panel>
                            </div>
                            <div>
                                <div className="section-title">Connection log</div>
                                <pre className="logs">{logs.join('\n')}</pre>
                            </div>
                        </div>
                    </details>
                </div>
            </div>
        </aside>
    );
}
