'use client';
// Draws the phone's body around its live screen: metal rim, glass edge, corner radius, notch or
// Dynamic Island or home button, and the side buttons, all picked from the phone's model
// (lib/phoneFrame.ts).
import type { CSSProperties, PointerEvent as RPointerEvent, ReactNode } from 'react';
import type { Device } from '@/lib/api';
import { frameFor } from '@/lib/phoneFrame';

export type HardwareButton = 'vol-up' | 'vol-down' | 'power';

export function DeviceFrame({
    device,
    children,
    onHardware,
}: {
    device: Device;
    children: ReactNode;
    /** Volume repeats while held; power locks on press. Omit to keep the buttons decorative. */
    onHardware?: (button: HardwareButton, phase: 'down' | 'up') => void;
}) {
    const spec = frameFor(device.model);
    const size = device.size;
    const ratio = size?.width && size?.height ? size.width / size.height : spec.ratio;

    // Work in units where the screen is 100 wide, then express everything as a share of the
    // body's width, which is what the stylesheet's container units (cqw) measure.
    const bodyW = 100 + 2 * spec.bezel * 100;
    const bodyH = 100 / ratio + 2 * spec.cap * 100;
    const cqw = (fractionOfScreen: number) => ((fractionOfScreen * 100) / bodyW) * 100;

    const style = {
        aspectRatio: `${bodyW} / ${bodyH}`,
        '--bezel': cqw(spec.bezel),
        '--cap': cqw(spec.cap),
        '--screen-radius': cqw(spec.screenRadius),
        // The body's corners run parallel to the screen's, one bezel further out.
        '--radius': cqw(spec.kind === 'home' ? 0.15 : spec.screenRadius + spec.bezel),
        '--cutout': cqw(spec.cutout),
        '--cutout-h': cqw(spec.cutoutHeight),
    } as CSSProperties;

    return (
        <div className={`device ${spec.kind}`} style={style}>
            <span className="device-btn mute" />
            <HardwareKey id="vol-up" label="Volume up" className="device-btn vol-up" onHardware={onHardware} />
            <HardwareKey id="vol-down" label="Volume down" className="device-btn vol-down" onHardware={onHardware} />
            <HardwareKey id="power" label="Power" className="device-btn power" onHardware={onHardware} />
            <div className="device-body">
                {spec.kind === 'home' && (
                    <span className="device-forehead">
                        <i className="device-lens" />
                        <i className="device-speaker" />
                    </span>
                )}
                <div className="device-screen">
                    {children}
                    {spec.kind === 'notch' && (
                        <span className="device-notch">
                            <i className="device-speaker" />
                            <i className="device-lens" />
                        </span>
                    )}
                    {spec.kind === 'island' && (
                        <span className="device-island">
                            <i className="device-lens" />
                        </span>
                    )}
                </div>
                {spec.kind === 'home' && <span className="device-home" />}
            </div>
        </div>
    );
}

function HardwareKey({
    id,
    label,
    className,
    onHardware,
}: {
    id: HardwareButton;
    label: string;
    className: string;
    onHardware?: (button: HardwareButton, phase: 'down' | 'up') => void;
}) {
    if (!onHardware) return <span className={className} />;

    const down = (el: HTMLButtonElement) => {
        if (el.classList.contains('down')) return;
        el.classList.add('down');
        onHardware(id, 'down');
    };
    const up = (el: HTMLButtonElement) => {
        if (!el.classList.contains('down')) return;
        el.classList.remove('down');
        onHardware(id, 'up');
    };

    return (
        <button
            type="button"
            className={className}
            aria-label={label}
            onPointerDown={(e: RPointerEvent<HTMLButtonElement>) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                down(e.currentTarget);
            }}
            onPointerUp={(e) => up(e.currentTarget)}
            onPointerCancel={(e) => up(e.currentTarget)}
            onKeyDown={(e) => {
                if (e.repeat) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                down(e.currentTarget);
            }}
            onKeyUp={(e) => {
                if (e.key === 'Enter' || e.key === ' ') up(e.currentTarget);
            }}
            onBlur={(e) => up(e.currentTarget)}
        />
    );
}
