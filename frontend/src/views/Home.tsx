'use client';
import { Button, Card, Table } from '@heroui/react';
import { Activity as ActivityIcon, Cable, ChevronRight, Play, Plug, Upload, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ActivityTable, EmptyCard, StatusBadge, TableSection } from '@/components/common';
import { get, type MediaItem, post, type Schedule, type SetupInfo } from '@/lib/api';
import { ago, bytes, modelName, renewText } from '@/lib/format';
import { CalendarIcon, ClaudeCodeIcon, FlowIcon, FolderOpenIcon, PhoneIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

export function HomePage({ setup }: { setup: SetupInfo | null }) {
    const { status, go, setFocus, sideload } = useStore();
    const act = useAction();
    const [schedules, setSchedules] = useState<Schedule[]>([]);
    const [media, setMedia] = useState<MediaItem[]>([]);

    useEffect(() => {
        get<{ schedules: Schedule[] }>('/schedules')
            .then((r) => setSchedules(r.schedules))
            .catch(() => {});
        get<MediaItem[]>('/media')
            .then(setMedia)
            .catch(() => {});
    }, []);

    const devices = status.devices;
    const ready = devices.filter((d) => d.status === 'ready');
    const waiting = devices.filter((d) => d.status === 'action' || d.status === 'error');
    const running = status.jobs.filter((j) => j.status === 'running');
    const today = new Date().setHours(0, 0, 0, 0);
    const claudeToday = status.activity.filter((a) => a.actor === 'claude' && a.at >= today).length;
    const next = schedules.filter((s) => s.next).sort((a, b) => a.next! - b.next!)[0];

    const systemRows = [
        { part: 'USB driver', value: setup ? (setup.usbOk ? 'OK' : 'Missing') : '…', bad: !!setup && !setup.usbOk },
        {
            part: 'Apple ID',
            value: sideload ? sideload.appleId || 'Not signed in' : '…',
            bad: !!sideload && !sideload.appleId,
        },
        { part: 'iOS helper', value: setup?.helper || '…', bad: false },
    ];

    const stats = [
        {
            icon: <PhoneIcon />,
            label: 'Phones',
            value: (
                <>
                    {ready.length}
                    <small> / {devices.length}</small>
                </>
            ),
            sub: waiting.length ? `${waiting.length} waiting on you` : 'ready to control',
        },
        {
            icon: <FlowIcon />,
            label: 'Running',
            value: running.length,
            sub: running[0] ? `${running[0].automationName} on ${running[0].deviceName}` : 'no automations running',
        },
        {
            icon: <CalendarIcon />,
            label: 'Next run',
            value: next?.next
                ? new Date(next.next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '—',
            sub: next ? next.name : 'nothing scheduled',
        },
        { icon: <ClaudeCodeIcon />, label: 'Claude today', value: claudeToday, sub: 'actions on your phones' },
    ];

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Home</h1>
                    <p>
                        {devices.length
                            ? `${ready.length} of ${devices.length} phones ready${waiting.length ? `, ${waiting.length} need${waiting.length === 1 ? 's' : ''} attention` : ''}.`
                            : 'Plug in a phone to get started.'}
                    </p>
                </div>
                <div className="actions">
                    <Button variant="secondary" onPress={() => go('media')}>
                        <Upload size={15} />
                        Send media
                    </Button>
                    <Button variant="primary" onPress={() => go('automations')}>
                        <Play size={15} />
                        Run automation
                    </Button>
                </div>
            </div>

            <div className="stats">
                {stats.map((s) => (
                    <Card key={s.label} className="panel stat">
                        <div className="stat-label">
                            {s.icon}
                            {s.label}
                        </div>
                        <div className="stat-value">{s.value}</div>
                        <div className="stat-sub ellipsis">{s.sub}</div>
                    </Card>
                ))}
            </div>

            <div className="grid-2">
                <div className="stack">
                    <TableSection
                        title="Phones"
                        icon={<PhoneIcon width={14} height={14} />}
                        actions={
                            <Button size="sm" variant="ghost" onPress={() => go('phones')}>
                                Open
                                <ChevronRight size={14} />
                            </Button>
                        }
                    >
                        {devices.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content
                                        aria-label="Phones"
                                        onRowAction={(udid) => {
                                            const d = devices.find((x) => x.udid === udid);
                                            if (d?.status === 'ready') setFocus(d.udid);
                                            else go('setup');
                                        }}
                                    >
                                        <Table.Header>
                                            <Table.Column isRowHeader>Phone</Table.Column>
                                            <Table.Column>Connection</Table.Column>
                                            <Table.Column>Model</Table.Column>
                                            <Table.Column>Control app</Table.Column>
                                            <Table.Column>Status</Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {devices.map((d) => (
                                                <Table.Row key={d.udid} id={d.udid} className="clickable">
                                                    <Table.Cell>
                                                        <div style={{ fontWeight: 500 }}>{d.name}</div>
                                                        {d.status !== 'ready' && (
                                                            <div className="small muted ellipsis">
                                                                {d.status === 'starting'
                                                                    ? d.step
                                                                    : d.action?.title || d.error}
                                                            </div>
                                                        )}
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="row muted" style={{ gap: 6 }}>
                                                            {d.connection === 'wifi' ? (
                                                                <>
                                                                    <Wifi size={14} />
                                                                    Wi-Fi
                                                                </>
                                                            ) : d.connection === 'usb' ? (
                                                                <>
                                                                    <Cable size={14} />
                                                                    USB
                                                                </>
                                                            ) : (
                                                                '—'
                                                            )}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono">
                                                            {modelName(d.model)} · iOS {d.iosVersion}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span
                                                            className="mono"
                                                            style={{
                                                                color: d.resignSoon ? 'var(--amber)' : 'var(--faint)',
                                                            }}
                                                        >
                                                            {renewText(d) || '—'}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <StatusBadge device={d} />
                                                    </Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </Table.Body>
                                    </Table.Content>
                                </Table.ScrollContainer>
                            </Table>
                        ) : (
                            <EmptyCard icon={<Plug />} title="No phones yet">
                                Plug an iPhone in with a data cable and unlock it.
                            </EmptyCard>
                        )}
                    </TableSection>

                    <TableSection title="Activity" icon={<ActivityIcon size={14} />}>
                        <ActivityTable
                            items={status.activity.slice(-12).reverse()}
                            empty="Taps, swipes and automation steps show up here."
                        />
                    </TableSection>
                </div>

                <div className="stack">
                    <TableSection title="Running now" icon={<FlowIcon width={14} height={14} />}>
                        {running.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content aria-label="Running now">
                                        <Table.Header>
                                            <Table.Column isRowHeader>Automation</Table.Column>
                                            <Table.Column>Phone</Table.Column>
                                            <Table.Column>Started</Table.Column>
                                            <Table.Column aria-label="Stop"> </Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {running.map((j) => (
                                                <Table.Row key={j.id} id={String(j.id)}>
                                                    <Table.Cell>
                                                        <span className="row" style={{ gap: 8, fontWeight: 500 }}>
                                                            <span className="dot running pulse" />
                                                            {j.automationName}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>{j.deviceName}</Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono muted">{ago(j.startedAt)}</span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                                                            <Button
                                                                size="sm"
                                                                variant="danger-soft"
                                                                onPress={() => act(() => post(`/jobs/${j.id}/stop`))}
                                                            >
                                                                Stop
                                                            </Button>
                                                        </div>
                                                    </Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </Table.Body>
                                    </Table.Content>
                                </Table.ScrollContainer>
                            </Table>
                        ) : (
                            <EmptyCard icon={<FlowIcon />} title="Nothing running">
                                Start an automation or ask Claude.
                            </EmptyCard>
                        )}
                    </TableSection>

                    <TableSection
                        title="Media library"
                        icon={<FolderOpenIcon width={14} height={14} />}
                        actions={
                            <>
                                <span className="mono muted small">
                                    {media.length} files · {media.filter((m) => m.type === 'video').length} videos
                                </span>
                                <Button size="sm" variant="ghost" onPress={() => go('media')}>
                                    Open
                                    <ChevronRight size={14} />
                                </Button>
                            </>
                        }
                    >
                        {media.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content aria-label="Latest media" onRowAction={() => go('media')}>
                                        <Table.Header>
                                            <Table.Column isRowHeader>Latest files</Table.Column>
                                            <Table.Column>Type</Table.Column>
                                            <Table.Column>Size</Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {media.slice(0, 5).map((m) => (
                                                <Table.Row key={m.name} id={m.name} className="clickable">
                                                    <Table.Cell>
                                                        <span
                                                            className="ellipsis"
                                                            style={{ display: 'block', maxWidth: 220, fontWeight: 500 }}
                                                        >
                                                            {m.name}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="muted">
                                                            {m.type === 'video' ? 'Video' : 'Image'}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono muted">{bytes(m.size)}</span>
                                                    </Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </Table.Body>
                                    </Table.Content>
                                </Table.ScrollContainer>
                            </Table>
                        ) : (
                            <EmptyCard icon={<FolderOpenIcon />} title="No media yet">
                                Add photos and videos on the Media page.
                            </EmptyCard>
                        )}
                    </TableSection>

                    <TableSection title="System">
                        <Table>
                            <Table.ScrollContainer>
                                <Table.Content aria-label="System">
                                    <Table.Header>
                                        <Table.Column isRowHeader>Part</Table.Column>
                                        <Table.Column>Status</Table.Column>
                                    </Table.Header>
                                    <Table.Body>
                                        {systemRows.map((r) => (
                                            <Table.Row key={r.part} id={r.part}>
                                                <Table.Cell>
                                                    <span style={{ fontWeight: 500 }}>{r.part}</span>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <span
                                                        className="mono"
                                                        style={{ color: r.bad ? 'var(--amber)' : 'var(--faint)' }}
                                                    >
                                                        {r.value}
                                                    </span>
                                                </Table.Cell>
                                            </Table.Row>
                                        ))}
                                    </Table.Body>
                                </Table.Content>
                            </Table.ScrollContainer>
                        </Table>
                    </TableSection>
                </div>
            </div>
        </>
    );
}
