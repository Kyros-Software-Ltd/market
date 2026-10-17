'use client';
import { Button, Table } from '@heroui/react';
import { Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { EmptyCard, ParamsForm, PhonePicker, TableSection } from '@/components/common';
import { Check, Panel, SelectField, TextInput, Toggle } from '@/components/ui';
import { type Automation, del, get, post, type Schedule } from '@/lib/api';
import { CalendarIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Form {
    id?: string;
    name: string;
    automationId: string;
    params: Record<string, unknown>;
    times: string;
    windowMinutes: string;
    days: number[];
    allPhones: boolean;
    phones: string[];
}

const blank = (automationId = ''): Form => ({
    name: '',
    automationId,
    params: {},
    times: '',
    windowMinutes: '30',
    days: [0, 1, 2, 3, 4, 5, 6],
    allPhones: true,
    phones: [],
});

export function SchedulesPage() {
    const { status } = useStore();
    const act = useAction();
    const [autos, setAutos] = useState<Automation[]>([]);
    const [list, setList] = useState<Schedule[]>([]);
    const [log, setLog] = useState<{ at: number; text: string }[]>([]);
    const [form, setForm] = useState<Form>(blank());

    const load = useCallback(
        () =>
            get<{ schedules: Schedule[]; log: { at: number; text: string }[] }>('/schedules')
                .then((r) => {
                    setList(r.schedules);
                    setLog(r.log);
                })
                .catch(() => {}),
        [],
    );

    useEffect(() => {
        get<Automation[]>('/automations')
            .then((a) => {
                setAutos(a);
                setForm((f) => (f.automationId ? f : { ...f, automationId: a.find((x) => !x.broken)?.id || '' }));
            })
            .catch(() => {});
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
    }, [load]);

    const auto = autos.find((a) => a.id === form.automationId);
    const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

    async function save() {
        const body = {
            id: form.id,
            name: form.name.trim() || auto?.name,
            automationId: form.automationId,
            params: form.params,
            times: form.times.split(/[,\s]+/).filter(Boolean),
            windowMinutes: Number(form.windowMinutes) || 0,
            days: form.days,
            phones: form.allPhones ? 'all' : form.phones,
        };
        if (await act(() => post('/schedules', body), 'Schedule saved')) {
            setForm(blank(form.automationId));
            load();
        }
    }

    function edit(s: Schedule) {
        setForm({
            id: s.id,
            name: s.name,
            automationId: s.automationId,
            params: s.params,
            times: s.times.join(', '),
            windowMinutes: String(s.windowMinutes),
            days: s.days,
            allPhones: s.phones === 'all',
            phones: s.phones === 'all' ? [] : s.phones,
        });
    }

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Schedules</h1>
                    <p>
                        Run automations at set times. Each phone starts at its own random moment inside the window. Keep
                        Market running (it can live in the tray).
                    </p>
                </div>
            </div>

            <div className="grid-2" style={{ gridTemplateColumns: 'minmax(300px, 400px) minmax(0, 1fr)' }}>
                <Panel
                    title={form.id ? `Edit ${form.name}` : 'New schedule'}
                    icon={<CalendarIcon width={14} height={14} />}
                >
                    <div className="col" style={{ gap: 16 }}>
                        <TextInput
                            label="Name"
                            value={form.name}
                            placeholder="Morning warmup"
                            onChange={(name) => set({ name })}
                        />
                        <SelectField
                            label="Automation"
                            value={form.automationId || null}
                            onChange={(automationId) => set({ automationId, params: {} })}
                            options={autos.filter((a) => !a.broken).map((a) => ({ key: a.id, label: a.name }))}
                            placeholder="Pick an automation"
                        />
                        {auto && (
                            <ParamsForm automation={auto} values={form.params} onChange={(params) => set({ params })} />
                        )}
                        <TextInput
                            label="Times (24h)"
                            mono
                            value={form.times}
                            placeholder="09:00, 13:30, 20:15"
                            onChange={(times) => set({ times })}
                        />
                        <TextInput
                            label="Random spread after each time (minutes)"
                            type="number"
                            value={form.windowMinutes}
                            onChange={(windowMinutes) => set({ windowMinutes })}
                        />
                        <div>
                            <div className="field-label">Days</div>
                            <div className="row" style={{ gap: 4 }}>
                                {DAYS.map((d, i) => {
                                    const on = form.days.includes(i);
                                    return (
                                        <Button
                                            key={d}
                                            size="sm"
                                            variant={on ? 'secondary' : 'ghost'}
                                            className="min-w-0 px-2.5"
                                            onPress={() =>
                                                set({
                                                    days: on
                                                        ? form.days.filter((x) => x !== i)
                                                        : [...form.days, i].sort(),
                                                })
                                            }
                                        >
                                            {d}
                                        </Button>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="col" style={{ gap: 10 }}>
                            <div className="field-label" style={{ margin: 0 }}>
                                Phones
                            </div>
                            <Check isSelected={form.allPhones} onChange={(allPhones) => set({ allPhones })}>
                                All phones
                            </Check>
                            {!form.allPhones && (
                                <PhonePicker
                                    devices={status.devices}
                                    value={form.phones}
                                    onChange={(phones) => set({ phones })}
                                    onlyReady={false}
                                />
                            )}
                        </div>
                        <div className="row">
                            <Button variant="primary" onPress={save}>
                                Save schedule
                            </Button>
                            {form.id && (
                                <Button variant="ghost" onPress={() => setForm(blank(form.automationId))}>
                                    Cancel
                                </Button>
                            )}
                        </div>
                    </div>
                </Panel>

                <div className="stack">
                    <TableSection title="Schedules" icon={<CalendarIcon width={14} height={14} />}>
                        {list.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content aria-label="Schedules">
                                        <Table.Header>
                                            <Table.Column isRowHeader>Name</Table.Column>
                                            <Table.Column>Times</Table.Column>
                                            <Table.Column>Next run</Table.Column>
                                            <Table.Column aria-label="Actions"> </Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {list.map((s) => (
                                                <Table.Row
                                                    key={s.id}
                                                    id={s.id}
                                                    className={s.enabled ? undefined : 'opacity-50'}
                                                >
                                                    <Table.Cell>
                                                        <div style={{ fontWeight: 500 }}>{s.name}</div>
                                                        <div className="small muted">
                                                            {autos.find((a) => a.id === s.automationId)?.name ||
                                                                s.automationId}{' '}
                                                            ·{' '}
                                                            {s.phones === 'all'
                                                                ? 'all phones'
                                                                : `${s.phones.length} phones`}{' '}
                                                            ·{' '}
                                                            {s.days.length === 7
                                                                ? 'daily'
                                                                : s.days.map((d) => DAYS[d]).join(' ')}
                                                        </div>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono">{s.times.join(' ')}</span>
                                                        <span className="mono muted"> +{s.windowMinutes}m</span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono small">
                                                            {s.next
                                                                ? new Date(s.next).toLocaleString([], {
                                                                      weekday: 'short',
                                                                      hour: '2-digit',
                                                                      minute: '2-digit',
                                                                  })
                                                                : '—'}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                                                            <Toggle
                                                                isSelected={s.enabled}
                                                                label={`${s.name} enabled`}
                                                                onChange={(enabled) => {
                                                                    act(() =>
                                                                        post('/schedules', { ...s, enabled }),
                                                                    ).then(load);
                                                                }}
                                                            />
                                                            <Button
                                                                isIconOnly
                                                                size="sm"
                                                                variant="ghost"
                                                                aria-label="Edit"
                                                                onPress={() => edit(s)}
                                                            >
                                                                <Pencil size={14} />
                                                            </Button>
                                                            <Button
                                                                isIconOnly
                                                                size="sm"
                                                                variant="ghost"
                                                                aria-label="Delete"
                                                                onPress={() => {
                                                                    if (window.confirm(`Delete "${s.name}"?`))
                                                                        act(() => del(`/schedules/${s.id}`)).then(load);
                                                                }}
                                                            >
                                                                <Trash2 size={14} />
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
                            <EmptyCard icon={<CalendarIcon />} title="No schedules yet">
                                Create one, or ask Claude: "warm up all phones on TikTok three times a day".
                            </EmptyCard>
                        )}
                    </TableSection>
                    <Panel title="Scheduler log">
                        <pre className="logs">
                            {log.length
                                ? log
                                      .slice()
                                      .reverse()
                                      .map((l) => `${new Date(l.at).toLocaleString()}  ${l.text}`)
                                      .join('\n')
                                : 'Nothing has run yet.'}
                        </pre>
                    </Panel>
                </div>
            </div>
        </>
    );
}
