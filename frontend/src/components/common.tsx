'use client';
// Small shared pieces used across pages.
import { Card, Table } from '@heroui/react';
import { Bot, Hand, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Activity, Automation, Device, Param } from '@/lib/api';
import { actorLabel, ago, statusLabel } from '@/lib/format';
import { ClaudeCodeIcon } from '@/lib/icons';
import { Check, SelectField, StatusChip, TextInput } from './ui';

export function StatusBadge({ device }: { device: Device }) {
    return (
        <StatusChip status={device.status} pulse={device.status === 'starting'}>
            {statusLabel[device.status]}
        </StatusChip>
    );
}

export function ActorIcon({ actor }: { actor: Activity['actor'] }) {
    if (actor === 'claude') return <ClaudeCodeIcon width={13} height={13} />;
    if (actor === 'automation') return <Bot size={13} />;
    return <Hand size={13} />;
}

export function Feed({ items, empty }: { items: Activity[]; empty: string }) {
    if (!items.length)
        return (
            <div className="empty small">
                <Inbox />
                <div>{empty}</div>
            </div>
        );
    return (
        <div className="feed">
            {items.map((a) => (
                <div className="feed-row" key={`${a.at}-${a.udid}-${a.text}`}>
                    <span className="who">
                        <ActorIcon actor={a.actor} />
                        {actorLabel[a.actor]}
                    </span>
                    <span className="ellipsis">
                        <span className="dim">{a.phone}</span> &nbsp;{a.text}
                    </span>
                    <span className="when">{ago(a.at)}</span>
                </div>
            ))}
        </div>
    );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
    return (
        <div className="empty">
            {icon}
            <h3>{title}</h3>
            {children && <div>{children}</div>}
        </div>
    );
}

/** Form fields for an automation's parameters. */
export function ParamsForm({
    automation,
    values,
    onChange,
}: {
    automation: Automation;
    values: Record<string, unknown>;
    onChange: (v: Record<string, unknown>) => void;
}) {
    if (!automation.params.length) return null;
    const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
    const val = (p: Param) => values[p.key] ?? p.default ?? '';
    return (
        <div className="params">
            {automation.params.map((p) => {
                if (p.type === 'checkbox') {
                    return (
                        <div key={p.key} style={{ paddingBottom: 6 }}>
                            <Check isSelected={Boolean(val(p))} onChange={(v) => set(p.key, v)}>
                                {p.label}
                            </Check>
                        </div>
                    );
                }
                if (p.type === 'select') {
                    return (
                        <SelectField
                            key={p.key}
                            label={p.label}
                            value={String(val(p))}
                            onChange={(v) => set(p.key, v)}
                            options={(p.options || []).map((o) => ({ key: o, label: o }))}
                        />
                    );
                }
                return (
                    <TextInput
                        key={p.key}
                        label={p.label}
                        type={p.type === 'number' ? 'number' : 'text'}
                        value={String(val(p))}
                        onChange={(v) => set(p.key, v)}
                    />
                );
            })}
        </div>
    );
}

/** Checkbox list of phones, with "all". */
export function PhonePicker({
    devices,
    value,
    onChange,
    onlyReady = true,
}: {
    devices: Device[];
    value: string[];
    onChange: (v: string[]) => void;
    onlyReady?: boolean;
}) {
    const list = onlyReady ? devices.filter((d) => d.status === 'ready') : devices;
    if (!list.length)
        return <span className="small muted">{onlyReady ? 'No phones ready yet.' : 'No phones connected yet.'}</span>;
    const all = list.every((d) => value.includes(d.udid));
    return (
        <div className="row wrap" style={{ gap: '8px 16px' }}>
            <Check isSelected={all} onChange={(v) => onChange(v ? list.map((d) => d.udid) : [])}>
                All
            </Check>
            {list.map((d) => (
                <Check
                    key={d.udid}
                    isSelected={value.includes(d.udid)}
                    onChange={(v) => onChange(v ? [...value, d.udid] : value.filter((u) => u !== d.udid))}
                >
                    {d.name}
                </Check>
            ))}
        </div>
    );
}

/** Live view frame rate, shown on a phone's screen. Turns red when it's choppy. */
export function FpsChip({ fps }: { fps: number | null }) {
    if (fps === null) return null;
    return (
        <span className={`fps-chip ${fps < 5 ? 'low' : ''}`} title="Frames per second in the live view">
            {fps} fps
        </span>
    );
}

/** A titled HeroUI table that isn't inside a panel, so it keeps HeroUI's own look. */
export function TableSection({
    title,
    icon,
    actions,
    children,
}: {
    title: ReactNode;
    icon?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="table-section">
            <div className="section-head">
                {icon}
                <h3 className="grow">{title}</h3>
                {actions}
            </div>
            {children}
        </section>
    );
}

/** What a TableSection shows when there's nothing to list. */
export function EmptyCard({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
    return (
        <Card className="panel">
            <Empty icon={icon} title={title}>
                {children}
            </Empty>
        </Card>
    );
}

/** Recent taps, swipes and automation steps as a HeroUI table (newest first). */
export function ActivityTable({ items, empty }: { items: Activity[]; empty: string }) {
    if (!items.length)
        return (
            <EmptyCard icon={<Inbox />} title="No activity yet">
                {empty}
            </EmptyCard>
        );
    return (
        <Table>
            <Table.ScrollContainer>
                <Table.Content aria-label="Activity">
                    <Table.Header>
                        <Table.Column isRowHeader>What</Table.Column>
                        <Table.Column>Phone</Table.Column>
                        <Table.Column>By</Table.Column>
                        <Table.Column>When</Table.Column>
                    </Table.Header>
                    <Table.Body>
                        {items.map((a) => (
                            <Table.Row key={`${a.at}-${a.udid}-${a.text}`} id={`${a.at}-${a.udid}-${a.text}`}>
                                <Table.Cell>
                                    <span className="ellipsis" style={{ display: 'block', maxWidth: 360 }}>
                                        {a.text}
                                    </span>
                                </Table.Cell>
                                <Table.Cell>
                                    <span className="dim">{a.phone}</span>
                                </Table.Cell>
                                <Table.Cell>
                                    <span className="row muted" style={{ gap: 6 }}>
                                        <ActorIcon actor={a.actor} />
                                        {actorLabel[a.actor]}
                                    </span>
                                </Table.Cell>
                                <Table.Cell>
                                    <span className="mono muted">{ago(a.at)}</span>
                                </Table.Cell>
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Content>
            </Table.ScrollContainer>
        </Table>
    );
}
