'use client';
import { Button, Card } from '@heroui/react';
import { Cable, Check as CheckIcon, Download, FolderOpen, Smartphone, Wifi } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { AccountRow } from '@/components/Account';
import { StatusBadge } from '@/components/common';
import { PhoneState } from '@/components/PhoneState';
import { AppleIdPanel } from '@/components/Sideload';
import { VersionRow } from '@/components/Update';
import { Panel, SelectField, Toggle } from '@/components/ui';
import { type Device, get, post, type SetupInfo } from '@/lib/api';
import { modelName } from '@/lib/format';
import { useAction, useStore } from '@/lib/store';

const CONNECTION_OPTIONS = [
    { key: 'usb', label: 'USB only' },
    { key: 'wifi', label: 'USB + Wi-Fi' },
];

function connectionText(d: Device) {
    if (d.mode !== 'wifi') return d.online ? 'Connected by USB' : 'Not connected';
    if (d.connection === 'wifi') return 'Connected over Wi-Fi';
    if (d.connection === 'usb') return 'Connected by USB · uses Wi-Fi when unplugged';
    return 'Waiting for it on Wi-Fi (same network as this PC, unlocked)';
}

// USB only, or USB + Wi-Fi. Turning Wi-Fi on happens on the phone itself, over the cable.
function ConnectionPicker({ device }: { device: Device }) {
    const act = useAction();
    const [busy, setBusy] = useState(false);
    async function change(mode: string) {
        if (mode === device.mode) return;
        setBusy(true);
        await act(
            () => post(`/devices/${device.udid}/connection`, { mode }),
            mode === 'wifi' ? `${device.name} can now connect over Wi-Fi` : `${device.name} is USB only`,
        );
        setBusy(false);
    }
    return (
        <div style={{ width: 150 }}>
            <SelectField
                label="Connection"
                value={device.mode}
                onChange={change}
                options={CONNECTION_OPTIONS}
                isDisabled={busy}
            />
        </div>
    );
}

// Phones this PC already trusts that are on the Wi-Fi but not set up for it here.
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
            <span className="field-label">Found on Wi-Fi</span>
            {found.map((p) => (
                <Card key={p.udid} variant="secondary" className="panel">
                    <div className="row" style={{ padding: '9px 12px' }}>
                        <span className="grow" style={{ fontWeight: 500 }}>
                            {p.name || p.udid.slice(0, 8)}{' '}
                            {p.model && (
                                <span className="mono muted">
                                    {modelName(p.model)} · iOS {p.iosVersion}
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
                                        `${p.name || 'Phone'} will connect over Wi-Fi`,
                                    )
                                )
                                    setFound((f) => f.filter((x) => x.udid !== p.udid));
                            }}
                        >
                            Connect over Wi-Fi
                        </Button>
                    </div>
                </Card>
            ))}
        </div>
    );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
    return (
        <Card className={`panel step ${done ? 'done' : ''}`}>
            <div className="step-num">{done ? <CheckIcon strokeWidth={3} /> : n}</div>
            <div className="grow">
                <h3>{title}</h3>
                {children}
            </div>
        </Card>
    );
}

// Opens a web page in the normal browser (the app hands window.open off to it).
const openExternal = (url: string) => window.open(url, '_blank', 'noopener');

export function SetupPage({ setup }: { setup: SetupInfo | null }) {
    const { status, sideload } = useStore();
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

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Setup</h1>
                </div>
            </div>

            <div className="steps">
                <Step n={1} done={!!s?.usbOk} title="Apple USB driver">
                    <p className="dim">
                        {s?.usbOk
                            ? 'Installed. Windows can talk to iPhones.'
                            : "Windows needs Apple's USB driver. Install the free Apple Devices app (or iTunes), then reopen Market."}
                    </p>
                    {s && !s.usbOk && (
                        <Button
                            size="sm"
                            variant="secondary"
                            className="mt-2.5"
                            onPress={() => openExternal('https://apps.microsoft.com/detail/9np83lwlpz9k')}
                        >
                            <Download size={14} />
                            Apple Devices
                        </Button>
                    )}
                </Step>

                <Step n={2} done={!!sideload?.appleId && phonesHaveApp} title="Control app">
                    <p className="dim">
                        Each phone runs a small control app (WebDriverAgent, shown as "Market"), signed with a spare
                        free Apple ID. Sign in here, then click Install on each phone; about a minute per phone.
                        Plugged-in phones are re-signed by themselves before their 7 days run out.
                    </p>
                    <div className="mt-2.5">
                        {sideload?.available ? (
                            <AppleIdPanel />
                        ) : (
                            <span className="small" style={{ color: 'var(--red)' }}>
                                This copy of Market is missing its sideloading helper. Download Market again from
                                affrev.com.
                            </span>
                        )}
                    </div>
                </Step>

                <Step n={3} done={allReady} title="Phones">
                    <p className="dim">
                        Plug each iPhone in and unlock it; each card below says exactly what to tap. Set Auto-Lock to
                        Never and turn on Do Not Disturb. To go cable-free, set a phone to USB + Wi-Fi while it's
                        plugged in: after that it connects over Wi-Fi whenever it's unplugged.
                    </p>
                    <div className="col" style={{ marginTop: 12, gap: 8 }}>
                        {status.devices.length ? (
                            status.devices.map((d) => (
                                <div key={d.udid} className="setup-phone">
                                    <div className="setup-phone-row">
                                        <div className="setup-phone-icon">
                                            <Smartphone size={18} />
                                        </div>
                                        <div className="setup-phone-info">
                                            <div className="row" style={{ gap: 8 }}>
                                                <span className="ellipsis" style={{ fontWeight: 600 }}>
                                                    {d.name}
                                                </span>
                                                <StatusBadge device={d} />
                                            </div>
                                            <span className="mono muted ellipsis">
                                                {modelName(d.model)} · iOS {d.iosVersion}
                                            </span>
                                            <span className="small dim row" style={{ gap: 6 }}>
                                                {d.connection === 'wifi' ? <Wifi size={12} /> : <Cable size={12} />}
                                                {connectionText(d)}
                                            </span>
                                        </div>
                                        <ConnectionPicker device={d} />
                                    </div>
                                    {d.status !== 'ready' && (
                                        <div style={{ borderTop: '1px solid var(--border)' }}>
                                            <PhoneState device={d} compact />
                                        </div>
                                    )}
                                </div>
                            ))
                        ) : (
                            <span className="small muted">No phones connected yet.</span>
                        )}
                        <FoundOnWifi />
                    </div>
                </Step>

                <Panel title="Options">
                    <div className="col" style={{ gap: 14 }}>
                        {desktop && openAtLogin !== null && (
                            <div className="row">
                                <div className="grow">
                                    <div>Start with Windows</div>
                                    <div className="small muted">
                                        Runs in the tray so schedules keep going after a reboot.
                                    </div>
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
                            <span className="grow mono muted ellipsis">{s?.dataDir}</span>
                            <Button
                                size="sm"
                                variant="secondary"
                                onPress={() => act(() => post('/open-folder', { which: 'data' }))}
                            >
                                <FolderOpen size={14} />
                                Data folder
                            </Button>
                        </div>
                        {s?.helper === 'installing' && <span className="mono muted">iOS helper: {s.helperStep}</span>}
                        {s?.helper === 'error' && (
                            <span className="mono" style={{ color: 'var(--red)' }}>
                                iOS helper failed: {s.helperError}
                            </span>
                        )}
                    </div>
                </Panel>
            </div>
        </>
    );
}
