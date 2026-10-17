'use client';
import { Button, Card } from '@heroui/react';
import { AppWindow, ArrowUp, Bot, Pencil, Plug, Power, PowerOff, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, FpsChip, StatusBadge } from '@/components/common';
import { LiveScreen } from '@/components/LiveScreen';
import { PhoneState } from '@/components/PhoneState';
import { ActionMenu, Check, TextInput } from '@/components/ui';
import { control, type Device, get, post } from '@/lib/api';
import { ClaudeCodeIcon, HomeIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

export function PhonesPage() {
    const { status, selected, setSelected, toast } = useStore();
    const [apps, setApps] = useState<{ bundleId: string; name: string }[]>([]);
    const ready = status.devices.filter((d) => d.status === 'ready');
    const sel = [...selected];

    // The app list comes from the first ready phone; most farms run the same apps on every phone.
    const firstReady = ready[0]?.udid;
    useEffect(() => {
        if (firstReady)
            get<{ bundleId: string; name: string }[]>(`/devices/${firstReady}/apps`)
                .then(setApps)
                .catch(() => {});
    }, [firstReady]);

    const bulk = (action: string, args: Record<string, unknown> = {}) =>
        control(action, sel, args).catch((e: Error) => toast(e.message, true));

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Phones</h1>
                </div>
            </div>

            {status.devices.length > 0 && (
                <div className="bar">
                    <Check
                        isSelected={ready.length > 0 && sel.length === ready.length}
                        onChange={(v) => setSelected(new Set(v ? ready.map((d) => d.udid) : []))}
                    >
                        Select all
                    </Check>
                    <span className="mono muted">{sel.length ? `${sel.length} selected` : ''}</span>
                    <span className="grow" />
                    <Button size="sm" variant="secondary" isDisabled={!sel.length} onPress={() => bulk('home')}>
                        <HomeIcon width={14} height={14} />
                        Home
                    </Button>
                    <Button size="sm" variant="secondary" isDisabled={!sel.length} onPress={() => bulk('unlock')}>
                        <Sun size={14} />
                        Wake
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!sel.length}
                        onPress={() => bulk('swipe', { x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, ms: 280 })}
                    >
                        <ArrowUp size={14} />
                        Scroll
                    </Button>
                    <div className="sep" />
                    <ActionMenu
                        label="Open app"
                        icon={<AppWindow size={14} />}
                        isDisabled={!sel.length}
                        items={apps.map((a) => ({ key: a.bundleId, label: a.name }))}
                        onAction={(bundleId) => bulk('launch', { bundleId })}
                    />
                </div>
            )}

            {status.devices.length ? (
                <div className="phones">
                    {status.devices.map((d) => (
                        <PhoneCard key={d.udid} device={d} />
                    ))}
                </div>
            ) : (
                <Card className="panel">
                    <Empty icon={<Plug />} title="No iPhones detected">
                        Plug a phone in with a data cable, unlock it and tap Trust This Computer. Phones set to USB +
                        Wi-Fi in Setup show up here without the cable.
                    </Empty>
                </Card>
            )}
        </>
    );
}

function PhoneCard({ device: d }: { device: Device }) {
    const { status, selected, setSelected, setFocus, focus } = useStore();
    const act = useAction();
    const isSelected = selected.has(d.udid);
    const live = d.status === 'ready';
    const [fps, setFps] = useState<number | null>(null);
    const fresh = d.lastActivity && Date.now() - d.lastActivity.at < 6000 ? d.lastActivity : null;
    const job = status.jobs.find((j) => j.udid === d.udid && j.status === 'running');
    const connected = d.status === 'ready' || d.status === 'starting';

    function toggle(on: boolean) {
        const next = new Set(selected);
        if (on) next.add(d.udid);
        else next.delete(d.udid);
        setSelected(next);
    }

    // Inline rename: the name turns into a field; Enter saves, Escape or clicking away cancels.
    const [draft, setDraft] = useState<string | null>(null);
    async function saveName() {
        const name = (draft || '').trim();
        setDraft(null);
        if (name && name !== d.name) await act(() => post(`/devices/${d.udid}/rename`, { name }), `Renamed to ${name}`);
    }

    return (
        <Card
            className={`panel phone ${isSelected ? 'selected' : ''} ${focus === d.udid ? 'focused' : ''} ${fresh?.actor === 'claude' ? 'claude' : ''}`}
        >
            <div className="phone-head">
                <Check isSelected={isSelected} isDisabled={d.status !== 'ready'} onChange={toggle} />
                {draft === null ? (
                    <>
                        <span
                            className="phone-name ellipsis"
                            title="Double-click to rename"
                            onDoubleClick={() => setDraft(d.name)}
                        >
                            {d.name}
                        </span>
                        <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label="Rename phone"
                            className="rename-btn"
                            onPress={() => setDraft(d.name)}
                        >
                            <Pencil size={13} />
                        </Button>
                    </>
                ) : (
                    <div
                        className="grow"
                        onBlur={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDraft(null);
                        }}
                    >
                        <TextInput
                            value={draft}
                            onChange={setDraft}
                            onEnter={saveName}
                            onEscape={() => setDraft(null)}
                            autoFocus
                            placeholder="Phone name"
                        />
                    </div>
                )}
                <StatusBadge device={d} />
                {d.online && (
                    <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={connected ? 'Disconnect' : 'Connect'}
                        onPress={() => act(() => post(`/devices/${d.udid}/${connected ? 'disconnect' : 'connect'}`))}
                    >
                        {connected ? <PowerOff size={14} /> : <Power size={14} />}
                    </Button>
                )}
            </div>
            <div className="screen dark" data-theme="dark" onClick={() => setFocus(d.udid)}>
                {live ? <LiveScreen udid={d.udid} onFps={setFps} /> : <PhoneState device={d} />}
                {live && <FpsChip fps={fps} />}
                {job && (
                    <div className="overlay-chip top">
                        <Bot />
                        {job.automationName}
                    </div>
                )}
                {fresh && (
                    <div className={`overlay-chip bottom ${fresh.actor === 'claude' ? 'claude' : ''}`}>
                        {fresh.actor === 'claude' ? <ClaudeCodeIcon /> : <Bot />}
                        <span className="ellipsis">{fresh.text}</span>
                    </div>
                )}
            </div>
        </Card>
    );
}
