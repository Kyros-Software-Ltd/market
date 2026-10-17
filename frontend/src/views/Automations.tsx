'use client';
import { Button, Table } from '@heroui/react';
import { CalendarPlus, FileCode2, FolderOpen, Pencil, Play, Plus, ScrollText, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, EmptyCard, ParamsForm, PhonePicker, TableSection } from '@/components/common';
import { usePrompt } from '@/components/Prompt';
import { Panel, StatusChip, TextBox } from '@/components/ui';
import { type Automation, del, get, type Job, post } from '@/lib/api';
import { ago, slug } from '@/lib/format';
import { FlowIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

const NEW_FLOW_STEPS = [
    { do: 'launch', bundleId: 'com.zhiliaoapp.musically' },
    { do: 'waitRandom', minMs: 3000, maxMs: 6000 },
    { do: 'scroll', direction: 'up' },
    { do: 'waitRandom', minMs: 4000, maxMs: 12000 },
    { do: 'doubletap', x: 0.5, y: 0.45, chance: 0.2 },
    { do: 'home' },
];

const BY: Record<string, string> = { you: 'you', claude: 'Claude', schedule: 'schedule' };

export function AutomationsPage() {
    const { status, selected, go } = useStore();
    const act = useAction();
    const ask = usePrompt();
    const [list, setList] = useState<Automation[]>([]);
    const [id, setId] = useState<string | null>(null);
    const [params, setParams] = useState<Record<string, unknown>>({});
    const [phones, setPhones] = useState<string[]>([...selected]);
    const [editing, setEditing] = useState<string | null>(null);
    const [logJob, setLogJob] = useState<number | null>(null);

    const load = useCallback(
        () =>
            get<Automation[]>('/automations')
                .then((l) => {
                    setList(l);
                    setId((cur) => (cur && l.some((a) => a.id === cur) ? cur : (l.find((a) => !a.broken)?.id ?? null)));
                })
                .catch(() => {}),
        [],
    );
    useEffect(() => {
        load();
    }, [load]);

    const a = list.find((x) => x.id === id);
    // biome-ignore lint/correctness/useExhaustiveDependencies: clear the form whenever a different automation is picked
    useEffect(() => {
        setParams({});
        setEditing(null);
    }, [id]);

    async function run() {
        if (!a) return;
        const jobs = await act(() => post<Job[]>(`/automations/${a.id}/run`, { udids: phones, params }));
        if (jobs) setPhones([]);
    }

    async function newFlow() {
        const name = await ask({ title: 'New flow', value: 'New flow', placeholder: 'Flow name', confirm: 'Create' });
        if (!name) return;
        const fid = slug(name);
        if (
            await act(() =>
                post(`/flows/${fid}`, { name, description: 'Edit the steps to make it yours', steps: NEW_FLOW_STEPS }),
            )
        ) {
            await load();
            setId(fid);
            openEditor(fid);
        }
    }

    async function openEditor(fid: string) {
        const flow = await act(() => get(`/flows/${fid}`));
        if (flow) setEditing(JSON.stringify(flow, null, 2));
    }

    async function saveFlow() {
        if (!a || editing === null) return;
        let flow: unknown;
        try {
            flow = JSON.parse(editing);
        } catch (e) {
            return act(() => Promise.reject(new Error(`Not valid JSON: ${(e as Error).message}`)));
        }
        if (await act(() => post(`/flows/${a.id}`, flow), 'Saved')) load();
    }

    async function removeFlow() {
        if (!a || !window.confirm(`Delete "${a.name}"?`)) return;
        await act(() => del(`/flows/${a.id}`));
        load();
    }

    const jobs = status.jobs.filter((j) => j.automationId !== 'send-media');
    const shownLog = status.jobs.find((j) => j.id === logJob);

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Automations</h1>
                </div>
                <div className="actions">
                    <Button variant="ghost" onPress={() => act(() => post('/open-folder', { which: 'automations' }))}>
                        <FolderOpen size={15} />
                        Folder
                    </Button>
                    <Button variant="secondary" onPress={newFlow}>
                        <Plus size={15} />
                        New flow
                    </Button>
                </div>
            </div>

            <div className="grid-2" style={{ gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)' }}>
                <Panel title="Library" icon={<FlowIcon width={14} height={14} />} padded={false}>
                    {list.length ? (
                        <div className="list">
                            {list.map((x) => (
                                <button
                                    type="button"
                                    key={x.id}
                                    className={`list-item ${x.id === id ? 'active' : ''}`}
                                    style={{ opacity: x.broken ? 0.5 : 1 }}
                                    onClick={() => setId(x.id)}
                                >
                                    <span className="row" style={{ gap: 8 }}>
                                        {x.kind === 'flow' ? (
                                            <FlowIcon width={14} height={14} className="muted" />
                                        ) : (
                                            <FileCode2 size={14} className="muted" />
                                        )}
                                        <span className="ellipsis grow" style={{ fontWeight: 500 }}>
                                            {x.name}
                                        </span>
                                        <span className="kind">{x.kind}</span>
                                    </span>
                                    {x.description && <span className="small muted ellipsis">{x.description}</span>}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <Empty icon={<FlowIcon />} title="No automations" />
                    )}
                </Panel>

                <div className="stack">
                    {a ? (
                        <Panel title={a.name} actions={<span className="mono muted">{a.id}</span>}>
                            <div className="col" style={{ gap: 18 }}>
                                {a.description && <p className="dim">{a.description}</p>}
                                <ParamsForm automation={a} values={params} onChange={setParams} />
                                <div>
                                    <div className="field-label">Phones</div>
                                    <PhonePicker devices={status.devices} value={phones} onChange={setPhones} />
                                </div>
                                <div className="row wrap">
                                    <Button variant="primary" isDisabled={!phones.length || a.broken} onPress={run}>
                                        <Play size={15} />
                                        Run now
                                    </Button>
                                    <Button variant="secondary" onPress={() => go('schedules')}>
                                        <CalendarPlus size={15} />
                                        Schedule
                                    </Button>
                                    {a.kind === 'flow' && (
                                        <Button
                                            variant="secondary"
                                            onPress={() => (editing === null ? openEditor(a.id) : setEditing(null))}
                                        >
                                            <Pencil size={15} />
                                            {editing === null ? 'Edit steps' : 'Close editor'}
                                        </Button>
                                    )}
                                    <span className="grow" />
                                    {a.kind === 'flow' && (
                                        <Button variant="danger-soft" onPress={removeFlow}>
                                            <Trash2 size={15} />
                                            Delete
                                        </Button>
                                    )}
                                </div>
                                {editing !== null && (
                                    <div className="col">
                                        <p className="small muted">
                                            JSON steps. Coordinates are fractions of the screen (0–1). Steps: launch,
                                            terminate, tap, doubletap, longpress, swipe, drag, scroll, tapText,
                                            waitForText, type, home, wait, waitRandom, log. Add{' '}
                                            <span className="mono">"chance": 0.3</span> to run a step only sometimes.
                                        </p>
                                        <TextBox value={editing} onChange={setEditing} rows={18} label="Flow steps" />
                                        <div>
                                            <Button variant="primary" onPress={saveFlow}>
                                                Save steps
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </Panel>
                    ) : (
                        <Panel>
                            <Empty icon={<FlowIcon />} title="Pick an automation" />
                        </Panel>
                    )}

                    <TableSection
                        title="Jobs"
                        actions={
                            <>
                                <Button size="sm" variant="ghost" onPress={() => act(() => post('/jobs/clear'))}>
                                    Clear finished
                                </Button>
                                <Button
                                    size="sm"
                                    variant="danger-soft"
                                    onPress={() => act(() => post('/jobs/stop-all'))}
                                >
                                    <Square size={11} fill="currentColor" />
                                    Stop all
                                </Button>
                            </>
                        }
                    >
                        {jobs.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content aria-label="Jobs">
                                        <Table.Header>
                                            <Table.Column isRowHeader>Automation</Table.Column>
                                            <Table.Column>Phone</Table.Column>
                                            <Table.Column>Status</Table.Column>
                                            <Table.Column>Started</Table.Column>
                                            <Table.Column aria-label="Actions"> </Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {jobs.map((j) => (
                                                <Table.Row key={j.id} id={String(j.id)}>
                                                    <Table.Cell>
                                                        <div style={{ fontWeight: 500 }}>{j.automationName}</div>
                                                        {j.error && (
                                                            <div
                                                                className="small"
                                                                style={{ color: 'var(--red)', whiteSpace: 'normal' }}
                                                            >
                                                                {j.error}
                                                            </div>
                                                        )}
                                                    </Table.Cell>
                                                    <Table.Cell>{j.deviceName}</Table.Cell>
                                                    <Table.Cell>
                                                        <StatusChip status={j.status} pulse={j.status === 'running'}>
                                                            {j.status}
                                                        </StatusChip>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono muted">
                                                            {ago(j.startedAt)} · {BY[j.trigger] || 'you'}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onPress={() => setLogJob(j.id)}
                                                            >
                                                                <ScrollText size={14} />
                                                                Log
                                                            </Button>
                                                            {j.status === 'running' && (
                                                                <Button
                                                                    size="sm"
                                                                    variant="danger-soft"
                                                                    onPress={() =>
                                                                        act(() => post(`/jobs/${j.id}/stop`))
                                                                    }
                                                                >
                                                                    Stop
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </Table.Body>
                                    </Table.Content>
                                </Table.ScrollContainer>
                            </Table>
                        ) : (
                            <EmptyCard icon={<FlowIcon />} title="No jobs yet" />
                        )}
                    </TableSection>
                </div>
            </div>

            {shownLog && (
                <div
                    className="sheet"
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) setLogJob(null);
                    }}
                >
                    <div className="dialog wide">
                        <div className="row">
                            <h3 className="grow">
                                {shownLog.automationName}{' '}
                                <span className="dim" style={{ fontWeight: 400 }}>
                                    on {shownLog.deviceName}
                                </span>
                            </h3>
                            <StatusChip status={shownLog.status}>{shownLog.status}</StatusChip>
                        </div>
                        <pre className="logs" style={{ maxHeight: '60vh' }}>
                            {shownLog.logs.join('\n')}
                        </pre>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                            <Button variant="secondary" onPress={() => setLogJob(null)}>
                                Close
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
