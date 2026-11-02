'use client';
// What a phone shows when it isn't streaming: progress, what you need to do, or the error.
import { Button, Spinner } from '@heroui/react';
import { RotateCw } from 'lucide-react';
import { type Device, post } from '@/lib/api';
import { statusLabel } from '@/lib/format';
import { useAction, useStore } from '@/lib/store';
import { SideloadButton } from './Sideload';

export function PhoneState({ device, compact = false }: { device: Device; compact?: boolean }) {
    const act = useAction();
    const { sideload } = useStore();
    const d = device;

    // While the control app is being put on the phone, show that, whatever state the phone is in.
    const installing = d.status !== 'ready' && (sideload?.job?.udid === d.udid || !!sideload?.queued.includes(d.udid));
    if (installing)
        return compact ? (
            <div className="setup-state">
                <div className="grow">
                    <div className="setup-state-title">Installing the control app</div>
                    <p className="small dim">Keep the phone unlocked.</p>
                </div>
                <SideloadButton device={d} />
            </div>
        ) : (
            <div className="screen-state">
                <h4>Installing the control app</h4>
                <SideloadButton device={d} />
            </div>
        );

    // In Setup the state is one row: what's wrong on the left, what to press on the right.
    if (compact && d.status !== 'ready') {
        if (d.status === 'starting')
            return (
                <div className="setup-state">
                    <Spinner size="sm" color="current" />
                    <span className="grow dim">{d.step || 'Setting up'}…</span>
                </div>
            );
        if (d.status === 'action' && d.action) {
            const needsApp = d.action.kind === 'install' || d.action.kind === 'resign';
            const short =
                d.action.kind === 'install'
                    ? 'Not on this phone yet. Install it with your Apple ID.'
                    : d.action.kind === 'resign'
                      ? 'It expired. Re-sign it with your Apple ID.'
                      : d.action.text;
            return (
                <div className="setup-state" onClick={(e) => e.stopPropagation()}>
                    <div className="grow">
                        <div className="setup-state-title">{d.action.title}</div>
                        <p className="small dim">{short}</p>
                    </div>
                    {needsApp && (
                        <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                            <SideloadButton device={d} />
                        </div>
                    )}
                </div>
            );
        }
        if (d.status === 'error')
            return (
                <div className="setup-state" onClick={(e) => e.stopPropagation()}>
                    <div className="grow">
                        <div className="setup-state-title">Couldn't connect</div>
                        <p className="small dim">{d.error}</p>
                    </div>
                    <SideloadButton device={d} label="Reinstall" />
                    <Button size="sm" variant="secondary" onPress={() => act(() => post(`/devices/${d.udid}/connect`))}>
                        <RotateCw size={14} />
                        Try again
                    </Button>
                </div>
            );
    }

    if (d.status === 'ready') {
        return (
            <div className="screen-state">
                <p>{compact ? 'Ready' : 'Live view paused'}</p>
            </div>
        );
    }
    if (d.status === 'starting') {
        return (
            <div className="screen-state">
                <Spinner size="sm" color="current" />
                <p className="mono">{d.step || 'Setting up'}…</p>
            </div>
        );
    }
    if (d.status === 'action' && d.action) {
        const needsApp = d.action.kind === 'install' || d.action.kind === 'resign';
        return (
            <div className="screen-state warn" onClick={(e) => e.stopPropagation()}>
                <h4>{d.action.title}</h4>
                <p>{d.action.text}</p>
                {needsApp && (
                    <div className="col" style={{ alignItems: 'center', gap: 6 }}>
                        <SideloadButton device={d} />
                    </div>
                )}
                <span className="mono muted small">re-checking automatically</span>
            </div>
        );
    }
    if (d.status === 'error') {
        return (
            <div className="screen-state bad" onClick={(e) => e.stopPropagation()}>
                <h4>Couldn't connect</h4>
                <p className="mono small">{d.error}</p>
                {/* The control app may be broken or from another Apple ID; reinstalling usually fixes that. */}
                <SideloadButton device={d} label="Reinstall control app" />
                <Button size="sm" variant="secondary" onPress={() => act(() => post(`/devices/${d.udid}/connect`))}>
                    <RotateCw size={14} />
                    Try again
                </Button>
            </div>
        );
    }
    return (
        <div className="screen-state">
            <p className="mono">{statusLabel[d.status]}</p>
        </div>
    );
}
