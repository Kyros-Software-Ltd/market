'use client';
import { Button, Table } from '@heroui/react';
import { Copy, Link2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ActivityTable, TableSection } from '@/components/common';
import { Panel, StatusChip } from '@/components/ui';
import { type ClaudeInfo, get, post } from '@/lib/api';
import { ClaudeCodeIcon, GhostIcon } from '@/lib/icons';
import { useAction, useStore } from '@/lib/store';

const PROMPTS = [
    'Look at all my phones and tell me what each one is showing.',
    'Open TikTok on phone 1 and scroll the For You feed for 5 minutes like a real person. Like 2 videos that fit a fitness niche.',
    "On every phone, open Instagram and check for new DMs. Summarise them; don't reply.",
    'Send clip1.mp4 from the media library to every phone.',
    'Build a flow called "tiktok-warmup-short" that watches 15 videos with random watch times, likes about 1 in 8, then goes home. Schedule it on all phones at 09:00, 14:00 and 21:00.',
];

export function ClaudePage() {
    const { status, toast } = useStore();
    const act = useAction();
    const [info, setInfo] = useState<ClaudeInfo | null>(null);
    const load = useCallback(
        () =>
            get<ClaudeInfo>('/claude')
                .then(setInfo)
                .catch(() => {}),
        [],
    );
    useEffect(() => {
        load();
    }, [load]);

    const copy = (text: string) =>
        navigator.clipboard.writeText(text).then(
            () => toast('Copied'),
            () => toast('Could not copy', true),
        );
    const connected = info?.desktopConfigs.some((c) => c.connected);
    const feed = status.activity
        .filter((a) => a.actor === 'claude')
        .slice(-60)
        .reverse();

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Claude</h1>
                </div>
            </div>

            <div className="grid-2" style={{ gridTemplateColumns: 'minmax(320px, 440px) minmax(0, 1fr)' }}>
                <div className="stack">
                    <Panel
                        title="Claude Desktop"
                        icon={<GhostIcon width={14} height={14} />}
                        actions={connected && <StatusChip status="ready">connected</StatusChip>}
                    >
                        <div className="col" style={{ gap: 12 }}>
                            <p className="dim">
                                {connected
                                    ? 'Connected. Restart Claude Desktop if you just did this.'
                                    : 'One click adds the phone tools. Your other settings are kept and backed up.'}
                            </p>
                            <div>
                                <Button
                                    variant="primary"
                                    onPress={() =>
                                        act(
                                            () => post('/claude/connect-desktop'),
                                            'Added. Quit Claude Desktop from the tray and reopen it.',
                                        ).then(load)
                                    }
                                >
                                    <Link2 size={15} />
                                    {connected ? 'Reconnect' : 'Connect'} Claude Desktop
                                </Button>
                            </div>
                        </div>
                    </Panel>
                    <Panel title="Claude Code" icon={<ClaudeCodeIcon width={14} height={14} />}>
                        <div className="col" style={{ gap: 12 }}>
                            <p className="dim">Run once to add the phone tools to Claude Code everywhere:</p>
                            <div className="code">{info?.claudeCodeCommand || '…'}</div>
                            <div>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onPress={() => info && copy(info.claudeCodeCommand)}
                                >
                                    <Copy size={14} />
                                    Copy
                                </Button>
                            </div>
                        </div>
                    </Panel>
                    <TableSection title="Try asking">
                        <Table>
                            <Table.ScrollContainer>
                                <Table.Content
                                    aria-label="Things to ask Claude"
                                    onRowAction={(key) => copy(String(key))}
                                >
                                    <Table.Header>
                                        <Table.Column isRowHeader>Prompt</Table.Column>
                                        <Table.Column aria-label="Copy"> </Table.Column>
                                    </Table.Header>
                                    <Table.Body>
                                        {PROMPTS.map((p) => (
                                            <Table.Row key={p} id={p} className="clickable">
                                                <Table.Cell>
                                                    <span className="small dim" style={{ whiteSpace: 'normal' }}>
                                                        {p}
                                                    </span>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                                                        <Copy size={13} className="muted" />
                                                    </div>
                                                </Table.Cell>
                                            </Table.Row>
                                        ))}
                                    </Table.Body>
                                </Table.Content>
                            </Table.ScrollContainer>
                        </Table>
                    </TableSection>
                </div>

                <TableSection title="What Claude is doing" icon={<ClaudeCodeIcon width={14} height={14} />}>
                    <ActivityTable
                        items={feed}
                        empty="Once connected, every look, tap and swipe Claude makes shows up here live."
                    />
                </TableSection>
            </div>
        </>
    );
}
