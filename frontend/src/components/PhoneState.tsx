'use client';
// What a phone shows when it isn't live: one plain status, not a tech checklist.
import { Button, Spinner } from '@heroui/react';
import { RotateCw } from 'lucide-react';
import { type Device, post } from '@/lib/api';
import { phoneCopy } from '@/lib/phoneCopy';
import { useAction, useStore } from '@/lib/store';
import { SideloadButton } from './Sideload';

export function PhoneState({ device, compact = false }: { device: Device; compact?: boolean }) {
    const act = useAction();
    const { sideload } = useStore();
    const d = device;
    const installing = d.status !== 'ready' && (sideload?.job?.udid === d.udid || !!sideload?.queued.includes(d.udid));
    const copy = phoneCopy(d, installing);
    const needsApp = d.action?.kind === 'install' || d.action?.kind === 'resign' || installing;
    const canRetry = d.status === 'error';

    if (compact) {
        if (d.status === 'ready') return null;
        return (
            <div className={`setup-state tone-${copy.tone}`} onClick={(e) => e.stopPropagation()}>
                {copy.tone === 'progress' && <Spinner size="sm" color="current" />}
                <div className="grow">
                    <div className="setup-state-title">{copy.title}</div>
                    {copy.detail && <p className="small dim">{copy.detail}</p>}
                </div>
                {needsApp && <SideloadButton device={d} label={d.action?.kind === 'resign' ? 'Renew' : 'Install'} />}
                {canRetry && (
                    <Button size="sm" variant="secondary" onPress={() => act(() => post(`/devices/${d.udid}/connect`))}>
                        <RotateCw size={14} />
                        Try again
                    </Button>
                )}
            </div>
        );
    }

    return (
        <div className={`screen-state tone-${copy.tone}`} onClick={(e) => e.stopPropagation()}>
            {copy.tone === 'progress' && <Spinner size="sm" color="current" />}
            <h4>{copy.title}</h4>
            {copy.detail && <p>{copy.detail}</p>}
            {needsApp && (
                <div className="col" style={{ alignItems: 'center', gap: 6 }}>
                    <SideloadButton
                        device={d}
                        label={installing ? undefined : d.action?.kind === 'resign' ? 'Renew' : 'Install'}
                    />
                </div>
            )}
            {canRetry && (
                <>
                    <SideloadButton device={d} label="Reinstall" />
                    <Button size="sm" variant="secondary" onPress={() => act(() => post(`/devices/${d.udid}/connect`))}>
                        <RotateCw size={14} />
                        Try again
                    </Button>
                </>
            )}
        </div>
    );
}
