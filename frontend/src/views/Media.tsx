'use client';
import { Button, Card, Table } from '@heroui/react';
import { Film, FolderOpen, Image as ImageIcon, Inbox, Send, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, EmptyCard, PhonePicker, TableSection } from '@/components/common';
import { Check, Panel, TextInput } from '@/components/ui';
import { del, get, type MediaItem, mediaUrl, post, uploadMedia } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { useAction, useStore } from '@/lib/store';

export function MediaPage() {
    const { status, toast } = useStore();
    const act = useAction();
    const [items, setItems] = useState<MediaItem[]>([]);
    const [picked, setPicked] = useState<string[]>([]);
    const [phones, setPhones] = useState<string[]>([]);
    const [caption, setCaption] = useState('');
    const [over, setOver] = useState(false);
    const [uploading, setUploading] = useState(0);
    const input = useRef<HTMLInputElement>(null);

    const load = useCallback(
        () =>
            get<MediaItem[]>('/media')
                .then(setItems)
                .catch(() => {}),
        [],
    );
    useEffect(() => {
        load();
    }, [load]);

    async function add(files: FileList | File[]) {
        const list = [...files];
        setUploading(list.length);
        for (const f of list) {
            try {
                await uploadMedia(f);
            } catch (e) {
                toast(`${f.name}: ${(e as Error).message}`, true);
            }
            setUploading((n) => n - 1);
        }
        load();
    }

    const toggle = (name: string, on = !picked.includes(name)) =>
        setPicked((p) => (on ? [...p.filter((n) => n !== name), name] : p.filter((n) => n !== name)));

    // What the ticked files make: one video, or photos as a carousel in the order ticked.
    const pickedItems = picked.map((n) => items.find((m) => m.name === n)).filter(Boolean) as MediaItem[];
    const videos = pickedItems.filter((m) => m.type === 'video').length;
    const postProblem = !picked.length
        ? 'Tick a video, or the photos for a carousel'
        : videos && picked.length > 1
          ? 'One video on its own, or only photos'
          : picked.length > 12
            ? 'Up to 12 photos per carousel'
            : '';
    const what = videos
        ? 'Video'
        : picked.length > 1
          ? `Carousel · ${picked.length} photos, in the order ticked`
          : 'Photo';
    const phoneCount = `${phones.length} phone${phones.length === 1 ? '' : 's'}`;

    async function postTo(finish: 'post' | 'drafts') {
        const jobs = await act(() => post<unknown[]>('/media/post', { names: picked, udids: phones, caption, finish }));
        if (jobs)
            toast(
                finish === 'post' ? `Posting to TikTok on ${phoneCount}` : `Saving to TikTok drafts on ${phoneCount}`,
            );
    }

    async function send() {
        const jobs = await act(() =>
            post<unknown[]>('/media/send', { names: picked, udids: phones, saveToPhotos: true }),
        );
        if (jobs) toast(`Sending ${picked.length} file${picked.length === 1 ? '' : 's'} to Photos on ${phoneCount}`);
    }

    async function remove(name: string) {
        if (!window.confirm(`Delete ${name} from the library? It stays on any phone it was sent to.`)) return;
        await act(() => del(`/media/${encodeURIComponent(name)}`));
        setPicked((p) => p.filter((n) => n !== name));
        load();
    }

    const sends = status.jobs
        .filter((j) => j.automationId === 'send-media' || j.automationId === 'post-tiktok')
        .slice(0, 8);

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Media</h1>
                </div>
                <div className="actions">
                    <Button variant="ghost" onPress={() => act(() => post('/open-media-folder'))}>
                        <FolderOpen size={15} />
                        Folder
                    </Button>
                    <Button variant="secondary" onPress={() => input.current?.click()}>
                        <Upload size={15} />
                        Add files
                    </Button>
                </div>
            </div>

            <input
                ref={input}
                type="file"
                multiple
                accept="video/*,image/*"
                className="hidden"
                onChange={(e) => {
                    if (e.target.files) add(e.target.files);
                    e.target.value = '';
                }}
            />

            <div className="grid-2">
                <div className="stack">
                    <div
                        className={`dropzone ${over ? 'over' : ''}`}
                        onClick={() => input.current?.click()}
                        onDragOver={(e) => {
                            e.preventDefault();
                            setOver(true);
                        }}
                        onDragLeave={() => setOver(false)}
                        onDrop={(e) => {
                            e.preventDefault();
                            setOver(false);
                            add(e.dataTransfer.files);
                        }}
                    >
                        <Upload />
                        <div>
                            {uploading
                                ? `Adding ${uploading} file${uploading === 1 ? '' : 's'}…`
                                : 'Drop videos or photos here, or click to browse'}
                        </div>
                        <div className="mono muted small">mp4 · mov · jpg · png · heic</div>
                    </div>

                    {items.length ? (
                        <div className="media-grid">
                            {items.map((m) => (
                                <Card
                                    key={m.name}
                                    className={`panel media-item ${picked.includes(m.name) ? 'selected' : ''}`}
                                    onClick={() => toggle(m.name)}
                                >
                                    <div className="media-thumb">
                                        {m.type === 'video' ? (
                                            <video src={`${mediaUrl(m.name)}#t=0.5`} muted preload="metadata" />
                                        ) : (
                                            <img src={mediaUrl(m.name)} alt="" loading="lazy" />
                                        )}
                                    </div>
                                    <div className="media-check" onClick={(e) => e.stopPropagation()}>
                                        <Check
                                            isSelected={picked.includes(m.name)}
                                            onChange={(v) => toggle(m.name, v)}
                                        />
                                    </div>
                                    {picked.includes(m.name) && (
                                        <span className="media-order">{picked.indexOf(m.name) + 1}</span>
                                    )}
                                    <span className="media-kind pill" style={{ height: 20, padding: '0 6px' }}>
                                        {m.type === 'video' ? <Film size={12} /> : <ImageIcon size={12} />}
                                    </span>
                                    <div className="media-meta">
                                        <span className="ellipsis small" title={m.name}>
                                            {m.name}
                                        </span>
                                        <div className="row">
                                            <span className="mono muted grow">{bytes(m.size)}</span>
                                            <span onClick={(e) => e.stopPropagation()}>
                                                <Button
                                                    isIconOnly
                                                    size="sm"
                                                    variant="ghost"
                                                    aria-label="Delete"
                                                    onPress={() => remove(m.name)}
                                                >
                                                    <Trash2 size={14} />
                                                </Button>
                                            </span>
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    ) : (
                        <Card className="panel">
                            <Empty icon={<Film />} title="Library is empty">
                                Add the videos you want to post.
                            </Empty>
                        </Card>
                    )}
                </div>

                <div className="stack">
                    <Panel title="Post to TikTok" icon={<Send size={14} />}>
                        <div className="col" style={{ gap: 18 }}>
                            <div className="row">
                                <span className="grow">
                                    {picked.length ? what : 'Tick files on the left'}
                                    {postProblem && picked.length > 0 && (
                                        <div className="small" style={{ color: 'var(--danger)' }}>
                                            {postProblem}
                                        </div>
                                    )}
                                </span>
                                {picked.length > 0 && (
                                    <Button size="sm" variant="ghost" onPress={() => setPicked([])}>
                                        Clear
                                    </Button>
                                )}
                            </div>
                            <TextInput
                                label="Caption"
                                value={caption}
                                onChange={setCaption}
                                placeholder="Words and #hashtags"
                            />
                            <div>
                                <div className="field-label">Phones</div>
                                <PhonePicker devices={status.devices} value={phones} onChange={setPhones} />
                            </div>
                            <div className="pair">
                                <Button
                                    variant="primary"
                                    isDisabled={!!postProblem || !phones.length}
                                    onPress={() => postTo('post')}
                                >
                                    <Send size={15} />
                                    Post
                                </Button>
                                <Button
                                    variant="secondary"
                                    isDisabled={!!postProblem || !phones.length}
                                    onPress={() => postTo('drafts')}
                                >
                                    <Inbox size={15} />
                                    Save to Drafts
                                </Button>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                isDisabled={!picked.length || !phones.length}
                                onPress={send}
                            >
                                Just send to Photos
                            </Button>
                        </div>
                    </Panel>

                    <TableSection title="Recent" icon={<Send size={14} />}>
                        {sends.length ? (
                            <Table>
                                <Table.ScrollContainer>
                                    <Table.Content aria-label="Recent posts and sends">
                                        <Table.Header>
                                            <Table.Column isRowHeader>Phone</Table.Column>
                                            <Table.Column>What</Table.Column>
                                            <Table.Column>Result</Table.Column>
                                            <Table.Column>When</Table.Column>
                                        </Table.Header>
                                        <Table.Body>
                                            {sends.map((j) => (
                                                <Table.Row key={j.id} id={String(j.id)}>
                                                    <Table.Cell>
                                                        <span className="row">
                                                            <span
                                                                className={`dot ${j.status} ${j.status === 'running' ? 'pulse' : ''}`}
                                                            />
                                                            {j.deviceName}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="small">
                                                            {j.automationId === 'post-tiktok' ? 'TikTok post' : 'Send'}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="small dim" style={{ whiteSpace: 'normal' }}>
                                                            {j.error || j.logs.at(-1)?.replace(/^\S+ \S* ?/, '')}
                                                        </span>
                                                    </Table.Cell>
                                                    <Table.Cell>
                                                        <span className="mono muted">{ago(j.startedAt)}</span>
                                                    </Table.Cell>
                                                </Table.Row>
                                            ))}
                                        </Table.Body>
                                    </Table.Content>
                                </Table.ScrollContainer>
                            </Table>
                        ) : (
                            <EmptyCard icon={<Send />} title="Nothing posted or sent yet" />
                        )}
                    </TableSection>
                </div>
            </div>
        </>
    );
}
