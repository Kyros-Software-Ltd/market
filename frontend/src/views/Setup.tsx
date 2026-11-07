'use client';
import { Button, Card, Table } from '@heroui/react';
import { Cable, Check as CheckIcon, ChevronDown, Download, FolderOpen, Smartphone, Wifi } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { AccountRow } from '@/components/Account';
import { PhoneState } from '@/components/PhoneState';
import { AppleIdPanel } from '@/components/Sideload';
import { VersionRow } from '@/components/Update';
import { Panel, SelectField, Toggle } from '@/components/ui';
import { type Device, del, get, post, type SetupInfo } from '@/lib/api';
import { modelName } from '@/lib/format';
import { phoneCopy } from '@/lib/phoneCopy';
import { useAction, useStore } from '@/lib/store';

const CONNECTION_OPTIONS = [
    { key: 'usb', label: 'Cable only' },
    { key: 'wifi', label: 'Cable + Wi‑Fi' },
];

function connectionText(d: Device) {
    if (d.wifiMissing) return 'Waiting on Wi‑Fi — keep it unlocked on this network.';
    if (d.canUnplug) return 'Ready for Wi‑Fi. You can unplug now.';
    if (d.mode !== 'wifi') return d.online ? 'On cable' : 'Not connected';
    if (d.connection === 'wifi') return 'On Wi‑Fi';
    if (d.connection === 'usb') return 'On cable · will use Wi‑Fi when unplugged';
    return 'Looking for this phone on Wi‑Fi…';
}

function ConnectionPicker({ device, compact }: { device: Device; compact?: boolean }) {
    const act = useAction();
    const [busy, setBusy] = useState(false);
    async function change(mode: string) {
        if (mode === device.mode) return;
        setBusy(true);
        await act(
            () => post(`/devices/${device.udid}/connection`, { mode }),
            mode === 'wifi' ? `${device.name} can use Wi‑Fi` : `${device.name} is cable only`,
        );
        setBusy(false);
    }
    return (
        <div style={{ width: compact ? 148 : 168 }} onClick={(e) => e.stopPropagation()}>
            <SelectField
                label={compact ? undefined : 'Connection'}
                value={device.mode}
                onChange={change}
                options={CONNECTION_OPTIONS}
                isDisabled={busy}
            />
        </div>
    );
}

function FoundOnWifi() {
    const act = useAction();
    const [found, setFound] = useState<{ udid: string; name?: string; model?: string; iosVersion?: string }[]>([]);
    useEffect(() => {
        const load = () =>
            get<typeof found>('/wifi/found')
                .then(setFound)
                .catch(() => {});
        load();
        const t = setInterval(load, 10000);
        return () => clearInterval(t);
    }, []);
    if (!found.length) return null;
    return (
        <div className="col" style={{ gap: 8, marginTop: 6 }}>
            <span className="field-label">Also on this Wi‑Fi</span>
            {found.map((p) => (
                <Card key={p.udid} variant="secondary" className="panel">
                    <div className="row" style={{ padding: '12px 14px' }}>
                        <span className="grow" style={{ fontWeight: 500 }}>
                            {p.name || 'iPhone'}
                            {p.model && (
                                <span className="muted" style={{ fontWeight: 400 }}>
                                    {' '}
                                    · {modelName(p.model)}
                                </span>
                            )}
                        </span>
                        <Button
                            size="sm"
                            variant="secondary"
                            onPress={async () => {
                                if (
                                    await act(
                                        () => post(`/devices/${p.udid}/connection`, { mode: 'wifi' }),
                                        `${p.name || 'Phone'} will connect over Wi‑Fi`,
                                    )
                                )
                                    setFound((f) => f.filter((x) => x.udid !== p.udid));
                            }}
                        >
                            Add over Wi‑Fi
                        </Button>
                    </div>
                </Card>
            ))}
        </div>
    );
}

export function WifiAdapterFix() {
    const act = useAction();
    const [needed, setNeeded] = useState(false);
    useEffect(() => {
        const load = () =>
            get<{ needed: boolean }>('/netfix')
                .then((r) => setNeeded(r.needed))
                .catch(() => {});
        load();
        const t = setInterval(load, 10000);
        return () => clearInterval(t);
    }, []);
    if (!needed) return null;
    return (
        <Card variant="secondary" className="panel notice-card">
            <div className="row" style={{ padding: '12px 14px', gap: 12 }}>
                <span className="grow small dim">
                    A Windows Apple USB adapter can drop Wi‑Fi phones when another phone is plugged in. Market can switch
                    it off.
                </span>
                <Button
                    size="sm"
                    variant="secondary"
                    onPress={async () => {
                        if (await act(() => post('/netfix', {}), 'Network adapter fixed')) setNeeded(false);
                    }}
                >
                    Fix
                </Button>
            </div>
        </Card>
    );
}

type StepState = 'done' | 'current' | 'todo';

function Step({
    n,
    state,
    title,
    summary,
    children,
}: {
    n: number;
    state: StepState;
    title: string;
    summary: string;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(state !== 'done');
    const last = useRef(state);
    useEffect(() => {
        if (last.current !== state) {
            last.current = state;
            setOpen(state !== 'done');
        }
    }, [state]);
    return (
        <Card className={`panel step ${state}`}>
            <div className="step-num">{state === 'done' ? <CheckIcon strokeWidth={3} /> : n}</div>
            <div className="grow">
                <div className="row" style={{ minHeight: 28 }}>
                    <h3 className="grow" style={{ margin: 0 }}>
                        {title}
                    </h3>
                    {state === 'done' && (
                        <Button size="sm" variant="ghost" aria-expanded={open} onPress={() => setOpen((v) => !v)}>
                            {open ? 'Hide' : 'Show'}
                            <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
                        </Button>
                    )}
                </div>
                {state === 'done' && !open && <p className="dim">{summary}</p>}
                {open && <div className="step-body">{children}</div>}
            </div>
        </Card>
    );
}

function Progress({ done, next, onFinish }: { done: boolean[]; next: string; onFinish: () => void }) {
    const count = done.filter(Boolean).length;
    const finished = count === done.length;
    return (
        <div className="setup-progress">
            <div
                className="setup-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={done.length}
                aria-valuenow={count}
            >
                {done.map((d, i) => (
                    <span key={i} className={d ? 'on' : ''} />
                ))}
            </div>
            <div className="row">
                <div className="grow">
                    <div style={{ fontWeight: 600 }}>{finished ? 'You’re ready' : `${count} of ${done.length} complete`}</div>
                    <div className="small dim">{finished ? 'Open Phones to start controlling.' : next}</div>
                </div>
                {finished && (
                    <Button size="sm" variant="primary" onPress={onFinish}>
                        Go to Phones
                    </Button>
                )}
            </div>
        </div>
    );
}

type PhoneFilter = 'attention' | 'ready' | 'all';

function needsAttention(d: Device) {
    return d.status !== 'ready';
}

function PhoneOnboardList({ devices }: { devices: Device[] }) {
    const act = useAction();
    const attention = useMemo(() => devices.filter(needsAttention), [devices]);
    const ready = useMemo(() => devices.filter((d) => d.status === 'ready'), [devices]);
    const usbOnly = useMemo(() => devices.filter((d) => d.mode !== 'wifi'), [devices]);
    const [filter, setFilter] = useState<PhoneFilter>(attention.length ? 'attention' : 'all');
    const [openId, setOpenId] = useState<string | null>(null);
    const [bulkBusy, setBulkBusy] = useState(false);

    useEffect(() => {
        if (filter === 'attention' && !attention.length) setFilter(ready.length ? 'ready' : 'all');
    }, [attention.length, ready.length, filter]);

    const shown =
        filter === 'attention' ? attention : filter === 'ready' ? ready : devices;
    const open = shown.find((d) => d.udid === openId) ?? null;

    async function enableWifiAll() {
        setBulkBusy(true);
        await act(async () => {
            for (const d of usbOnly) {
                await post(`/devices/${d.udid}/connection`, { mode: 'wifi' });
            }
            return usbOnly.length;
        }, `Wi‑Fi enabled on ${usbOnly.length} phone${usbOnly.length === 1 ? '' : 's'}`);
        setBulkBusy(false);
    }

    return (
        <div className="setup-phones">
            <div className="setup-phones-toolbar">
                <span className="setup-phones-summary">
                    {ready.length} ready
                    {attention.length ? ` · ${attention.length} need attention` : ''}
                    {` · ${devices.length} total`}
                </span>
                {attention.length > 0 && (
                    <button
                        type="button"
                        className="setup-filter"
                        aria-pressed={filter === 'attention'}
                        onClick={() => setFilter('attention')}
                    >
                        Needs attention
                    </button>
                )}
                {ready.length > 0 && (
                    <button
                        type="button"
                        className="setup-filter"
                        aria-pressed={filter === 'ready'}
                        onClick={() => setFilter('ready')}
                    >
                        Ready
                    </button>
                )}
                <button
                    type="button"
                    className="setup-filter"
                    aria-pressed={filter === 'all'}
                    onClick={() => setFilter('all')}
                >
                    All
                </button>
                {usbOnly.length > 0 && (
                    <Button size="sm" variant="secondary" isDisabled={bulkBusy} onPress={enableWifiAll}>
                        <Wifi size={14} />
                        Wi‑Fi on all
                    </Button>
                )}
            </div>

            {shown.length ? (
                <>
                    <Table className="striped-table">
                        <Table.ScrollContainer>
                            <Table.Content
                                aria-label="Phones"
                                onRowAction={(key) => {
                                    const id = String(key);
                                    const d = shown.find((x) => x.udid === id);
                                    if (!d || d.status === 'ready') {
                                        setOpenId(null);
                                        return;
                                    }
                                    setOpenId((cur) => (cur === id ? null : id));
                                }}
                            >
                                <Table.Header>
                                    <Table.Column isRowHeader>Phone</Table.Column>
                                    <Table.Column>Model</Table.Column>
                                    <Table.Column>Link</Table.Column>
                                    <Table.Column>Connection</Table.Column>
                                    <Table.Column>Status</Table.Column>
                                    <Table.Column aria-label="Actions"> </Table.Column>
                                </Table.Header>
                                <Table.Body>
                                    {shown.map((d) => {
                                        const copy = phoneCopy(d);
                                        return (
                                            <Table.Row
                                                key={d.udid}
                                                id={d.udid}
                                                className={d.status === 'ready' ? undefined : 'clickable'}
                                            >
                                                <Table.Cell>
                                                    <div className="ellipsis" style={{ fontWeight: 500 }}>
                                                        {d.name}
                                                    </div>
                                                    <div className="small muted ellipsis">{connectionText(d)}</div>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <span className="small dim">
                                                        {modelName(d.model)}
                                                        {d.iosVersion ? ` · ${d.iosVersion}` : ''}
                                                    </span>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <span className="row muted" style={{ gap: 6 }}>
                                                        {d.connection === 'wifi' ? (
                                                            <Wifi size={14} />
                                                        ) : (
                                                            <Cable size={14} />
                                                        )}
                                                        {d.connection === 'wifi' ? 'Wi‑Fi' : d.connection === 'usb' ? 'Cable' : '—'}
                                                    </span>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <ConnectionPicker device={d} compact />
                                                </Table.Cell>
                                                <Table.Cell>
                                                    {d.status === 'ready' ? (
                                                        <span className="setup-pill ok">Ready</span>
                                                    ) : (
                                                        <span className={`setup-pill ${copy.tone}`}>{copy.title}</span>
                                                    )}
                                                </Table.Cell>
                                                <Table.Cell>
                                                    {!d.online && (
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            onPress={() =>
                                                                act(() => del(`/devices/${d.udid}`), `Removed ${d.name}`)
                                                            }
                                                        >
                                                            Remove
                                                        </Button>
                                                    )}
                                                </Table.Cell>
                                            </Table.Row>
                                        );
                                    })}
                                </Table.Body>
                            </Table.Content>
                        </Table.ScrollContainer>
                    </Table>
                    {open && (
                        <div className="setup-phone-detail">
                            <PhoneState device={open} compact />
                        </div>
                    )}
                </>
            ) : (
                <div className="setup-empty">
                    <Smartphone size={22} />
                    <div>
                        <div style={{ fontWeight: 600 }}>
                            {filter === 'attention' ? 'Nothing needs attention' : 'No phones in this view'}
                        </div>
                        <div className="small dim">Switch filter or plug another phone in.</div>
                    </div>
                </div>
            )}
        </div>
    );
}

const openExternal = (url: string) => window.open(url, '_blank', 'noopener');

export function SetupPage({ setup }: { setup: SetupInfo | null }) {
    const { status, sideload, go } = useStore();
    const act = useAction();
    const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);
    const [desktop, setDesktop] = useState(false);

    useEffect(() => {
        get<{ desktop: boolean; openAtLogin: boolean }>('/settings')
            .then((s) => {
                setDesktop(s.desktop);
                setOpenAtLogin(s.openAtLogin);
            })
            .catch(() => {});
    }, []);

    const s = setup;
    const phonesHaveApp =
        status.devices.length > 0 &&
        status.devices.every((d) => !(d.status === 'action' && d.action?.kind === 'install'));
    const allReady = status.devices.length > 0 && status.devices.every((d) => d.status === 'ready');

    const usbDone = !!s?.usbOk;
    const appDone = !!sideload?.appleId && phonesHaveApp;
    const flags = [usbDone, appDone, allReady];
    const firstOpen = flags.findIndex((x) => !x);
    const stateOf = (i: number): StepState => (flags[i] ? 'done' : i === firstOpen ? 'current' : 'todo');
    const nextText = [
        'Install the Apple driver so Windows can see iPhones.',
        'Sign in with a spare Apple ID, then install Market on each phone.',
        'Plug in a phone, unlock it, and finish any prompts on the screen.',
    ][Math.max(0, firstOpen)];

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Get started</h1>
                    <p>Three steps to connect your first iPhone. Finished steps tuck away.</p>
                </div>
            </div>

            <div className="steps">
                <Progress done={flags} next={nextText} onFinish={() => go('phones')} />

                <Step
                    n={1}
                    state={stateOf(0)}
                    title="Connect Windows to iPhone"
                    summary="Apple’s USB driver is installed."
                >
                    <p className="dim">
                        {usbDone
                            ? 'Windows can talk to iPhones.'
                            : 'Install the free Apple Devices app from Microsoft, then reopen Market.'}
                    </p>
                    {s && !s.usbOk && (
                        <Button
                            size="sm"
                            variant="primary"
                            className="mt-2.5"
                            onPress={() => openExternal('https://apps.microsoft.com/detail/9np83lwlpz9k')}
                        >
                            <Download size={14} />
                            Get Apple Devices
                        </Button>
                    )}
                </Step>

                <Step
                    n={2}
                    state={stateOf(1)}
                    title="Sign in & install Market"
                    summary={
                        sideload?.appleId
                            ? `Signed in as ${sideload.appleId}. Install on each phone below.`
                            : 'Sign in with a spare Apple ID.'
                    }
                >
                    <p className="dim">
                        Use a spare free Apple ID (not your main one). Market installs a small app on each phone so this
                        PC can control it.
                    </p>
                    <div className="mt-2.5">
                        {sideload?.available ? (
                            <AppleIdPanel />
                        ) : (
                            <span className="small" style={{ color: 'var(--red)' }}>
                                This copy of Market is missing its install helper. Download Market again from affrev.com.
                            </span>
                        )}
                    </div>
                </Step>

                <Step
                    n={3}
                    state={stateOf(2)}
                    title="Add your phones"
                    summary={
                        status.devices.length
                            ? `${status.devices.filter((d) => d.status === 'ready').length} of ${status.devices.length} ready.`
                            : 'Waiting for a phone.'
                    }
                >
                    <div className="onboard-tips">
                        <div className="onboard-tip">
                            <span className="onboard-tip-n">1</span>
                            <span>Plug in with a data cable and unlock the phone.</span>
                        </div>
                        <div className="onboard-tip">
                            <span className="onboard-tip-n">2</span>
                            <span>Tap Trust This Computer when asked.</span>
                        </div>
                        <div className="onboard-tip">
                            <span className="onboard-tip-n">3</span>
                            <span>Install Market on the phone, then trust it under Settings if prompted.</span>
                        </div>
                    </div>
                    <p className="small muted" style={{ marginTop: 12 }}>
                        For wireless use, choose Cable + Wi‑Fi while plugged in. After that you can unplug.
                    </p>
                    {status.devices.length ? (
                        <PhoneOnboardList devices={status.devices} />
                    ) : (
                        <div className="setup-empty" style={{ marginTop: 16 }}>
                            <Smartphone size={22} />
                            <div>
                                <div style={{ fontWeight: 600 }}>No phones yet</div>
                                <div className="small dim">Plug one in — it shows up here automatically.</div>
                            </div>
                        </div>
                    )}
                    <FoundOnWifi />
                </Step>

                <Panel title="Preferences">
                    <div className="col" style={{ gap: 14 }}>
                        {desktop && openAtLogin !== null && (
                            <div className="row">
                                <div className="grow">
                                    <div>Start with Windows</div>
                                    <div className="small muted">Keeps schedules running after a reboot.</div>
                                </div>
                                <Toggle
                                    isSelected={openAtLogin}
                                    label="Start with Windows"
                                    onChange={(v) => {
                                        setOpenAtLogin(v);
                                        act(() => post('/settings', { openAtLogin: v }));
                                    }}
                                />
                            </div>
                        )}
                        <AccountRow />
                        <VersionRow />
                        <div className="row">
                            <span className="grow small muted ellipsis">{s?.dataDir}</span>
                            <Button
                                size="sm"
                                variant="secondary"
                                onPress={() => act(() => post('/open-folder', { which: 'data' }))}
                            >
                                <FolderOpen size={14} />
                                Data folder
                            </Button>
                        </div>
                        {s?.helper === 'installing' && (
                            <span className="small muted">Preparing tools… {s.helperStep}</span>
                        )}
                        {s?.helper === 'error' && (
                            <span className="small" style={{ color: 'var(--red)' }}>
                                Couldn’t prepare tools: {s.helperError}
                            </span>
                        )}
                    </div>
                </Panel>
            </div>
        </>
    );
}
