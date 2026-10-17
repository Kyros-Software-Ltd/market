'use client';
// What a phone shows when it isn't streaming: progress, what you need to do, or the error.
import { Button, Spinner } from '@heroui/react';
import { ExternalLink, FileDown, RotateCw } from 'lucide-react';
import { type Device, post } from '@/lib/api';
import { statusLabel } from '@/lib/format';
import { useAction } from '@/lib/store';

export function PhoneState({ device, compact = false }: { device: Device; compact?: boolean }) {
    const act = useAction();
    const d = device;

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
        const sideloadly = d.action.kind === 'install' || d.action.kind === 'resign';
        return (
            <div className="screen-state warn" onClick={(e) => e.stopPropagation()}>
                <h4>{d.action.title}</h4>
                <p>{d.action.text}</p>
                {sideloadly && (
                    <div className="row wrap" style={{ justifyContent: 'center' }}>
                        <Button size="sm" variant="primary" onPress={() => act(() => post('/setup/open-sideloadly'))}>
                            <ExternalLink size={14} />
                            Sideloadly
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onPress={() => act(() => post('/setup/wda-ipa'), 'WDA.ipa is selected in Explorer')}
                        >
                            <FileDown size={14} />
                            WDA.ipa
                        </Button>
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
