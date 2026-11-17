'use client';
// Draws the phone's body around its live screen: metal rim, glass edge, corner radius, notch or
// Dynamic Island or home button, and the side buttons, all picked from the phone's model
// (lib/phoneFrame.ts).
import type { CSSProperties, ReactNode } from 'react';
import type { Device } from '@/lib/api';
import { frameFor } from '@/lib/phoneFrame';

export function DeviceFrame({ device, children }: { device: Device; children: ReactNode }) {
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
            <span className="device-btn vol-up" />
            <span className="device-btn vol-down" />
            <span className="device-btn power" />
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
