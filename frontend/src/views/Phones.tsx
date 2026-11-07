'use client';
import { Button, Card, Dropdown, Label } from '@heroui/react';
import { AppWindow, ArrowUp, Bot, MoreHorizontal, Pencil, Plug, Power, PowerOff, Sun } from 'lucide-react';
import { type Key, useEffect, useState } from 'react';
import { Empty, FpsChip } from '@/components/common';
import { LiveScreen } from '@/components/LiveScreen';
import { PhoneState } from '@/components/PhoneState';
import { TextInput } from '@/components/ui';
import { control, type Device, get, post } from '@/lib/api';
import { ClaudeCodeIcon, HomeIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

export function PhonesPage() {
    const { status, toast } = useStore();
    const [apps, setApps] = useState<{ bundleId: string; name: string }[]>([]);
    const ready = status.devices.filter((d) => d.status === 'ready');
    const targets = ready.map((d) => d.udid);

    // The app list comes from the first ready phone; most farms run the same apps on every phone.
    const firstReady = ready[0]?.udid;
    useEffect(() => {
        if (firstReady)
            get<{ bundleId: string; name: string }[]>(`/devices/${firstReady}/apps`)
                .then(setApps)
                .catch(() => {});
    }, [firstReady]);

    const bulk = (action: string, args: Record<string, unknown> = {}) => {
        if (!targets.length) return;
        control(action, targets, args).catch((e: Error) => toast(e.message, true));
    };

    function onAction(key: Key) {
        const id = String(key);
        if (id === 'home') bulk('home');
        else if (id === 'wake') bulk('unlock');
        else if (id === 'scroll') bulk('swipe', { x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, ms: 280 });
        else if (id.startsWith('app:')) bulk('launch', { bundleId: id.slice(4) });
    }

    return (
        <>
            <div className="page-head">
                <div className="row" style={{ gap: 2, alignItems: 'center' }}>
                    <h1>Phones</h1>
                    {status.devices.length > 0 && (
                        <Dropdown>
                            <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label="Actions for all phones"
                                isDisabled={!targets.length}
                            >
                                <MoreHorizontal size={18} />
                            </Button>
                            <Dropdown.Popover className="phones-actions-pop min-w-48">
                                <Dropdown.Menu onAction={onAction} disabledKeys={apps.length ? [] : ['open-app']}>
                                    <Dropdown.Item id="home" textValue="Home">
                                        <HomeIcon width={15} height={15} />
                                        <Label>Home</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item id="wake" textValue="Wake">
                                        <Sun size={15} />
                                        <Label>Wake</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item id="scroll" textValue="Scroll">
                                        <ArrowUp size={15} />
                                        <Label>Scroll</Label>
                                    </Dropdown.Item>
                                    <Dropdown.SubmenuTrigger>
                                        <Dropdown.Item id="open-app" textValue="Open app">
                                            <AppWindow size={15} />
                                            <Label>Open app</Label>
                                            <Dropdown.SubmenuIndicator />
                                        </Dropdown.Item>
                                        <Dropdown.Popover className="phones-actions-pop max-h-80 min-w-52">
                                            <Dropdown.Menu onAction={onAction}>
                                                {apps.map((a) => (
                                                    <Dropdown.Item
                                                        key={a.bundleId}
                                                        id={`app:${a.bundleId}`}
                                                        textValue={a.name}
                                                    >
                                                        <Label>{a.name}</Label>
                                                    </Dropdown.Item>
                                                ))}
                                            </Dropdown.Menu>
                                        </Dropdown.Popover>
                                    </Dropdown.SubmenuTrigger>
                                </Dropdown.Menu>
                            </Dropdown.Popover>
                        </Dropdown>
                    )}
                </div>
            </div>

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
    const { status, setFocus, focus } = useStore();
    const act = useAction();
    const live = d.status === 'ready';
    const [fps, setFps] = useState<number | null>(null);
    const fresh = d.lastActivity && Date.now() - d.lastActivity.at < 6000 ? d.lastActivity : null;
    const job = status.jobs.find((j) => j.udid === d.udid && j.status === 'running');
    const connected = d.status === 'ready' || d.status === 'starting';

    // Inline rename: the name turns into a field; Enter saves, Escape or clicking away cancels.
    const [draft, setDraft] = useState<string | null>(null);
    async function saveName() {
        const name = (draft || '').trim();
        setDraft(null);
        if (name && name !== d.name) await act(() => post(`/devices/${d.udid}/rename`, { name }), `Renamed to ${name}`);
    }

    return (
        <Card
            className={`panel phone ${focus === d.udid ? 'focused' : ''} ${fresh?.actor === 'claude' ? 'claude' : ''}`}
        >
            <div className="phone-head">
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
                {d.online ? (
                    <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={connected ? 'Disconnect' : 'Connect'}
                        onPress={() => act(() => post(`/devices/${d.udid}/${connected ? 'disconnect' : 'connect'}`))}
                    >
                        {connected ? <PowerOff size={14} /> : <Power size={14} />}
                    </Button>
                ) : null}
            </div>
            <div className="screen dark" data-theme="dark" onClick={() => setFocus(d.udid)}>
                {live ? <LiveScreen udid={d.udid} profile="grid" onFps={setFps} /> : <PhoneState device={d} />}
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
