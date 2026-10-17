'use client';
// Built-in sideloading: the Apple ID sign-in in Setup, the 2FA code dialog (shown wherever you are
// when Apple asks), and the Install button and progress on a phone that needs the control app.
import { Button, Spinner } from '@heroui/react';
import { Download, LogOut } from 'lucide-react';
import { useState } from 'react';
import { type Device, post, type TwoFactorQuestion } from '@/lib/api';
import { useAction, useStore } from '@/lib/store';
import { TextInput } from './ui';

/** Sign in once with the Apple ID that signs the control app. */
export function AppleIdPanel() {
    const { sideload, reloadSideload } = useStore();
    const act = useAction();
    const [appleId, setAppleId] = useState('');
    const [password, setPassword] = useState('');
    if (!sideload?.available) return null;

    const signingIn = sideload.job?.kind === 'login';
    const signIn = async () => {
        if (!appleId.trim() || !password) return;
        const p = act(() => post('/sideload/sign-in', { appleId, password }), 'Signed in with your Apple ID');
        setTimeout(reloadSideload, 300); // show the progress (and any 2FA question) right away
        if (await p) setPassword('');
        reloadSideload();
    };

    if (sideload.appleId)
        return (
            <div className="row">
                <div className="grow">
                    <div>Signed in as {sideload.appleId}</div>
                    <div className="small muted">
                        Install from each phone's card. Plugged-in phones are re-signed a day before their 7 days run
                        out.
                    </div>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => act(() => post('/sideload/sign-out')).then(reloadSideload)}
                >
                    <LogOut size={14} />
                    Sign out
                </Button>
            </div>
        );

    return (
        <div className="col" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 8 }}>
                <TextInput
                    className="grow"
                    type="email"
                    value={appleId}
                    onChange={setAppleId}
                    placeholder="Apple ID email"
                    isDisabled={signingIn}
                />
                <TextInput
                    className="grow"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Password"
                    onEnter={signIn}
                    isDisabled={signingIn}
                />
                <Button variant="primary" isDisabled={signingIn || !appleId.trim() || !password} onPress={signIn}>
                    {signingIn ? <Spinner size="sm" color="current" /> : null}
                    {signingIn ? sideload.job?.step : 'Sign in'}
                </Button>
            </div>
            <span className="small muted">
                Use a spare free Apple ID. Market signs in to Apple from this PC only; the password is kept in Windows'
                Credential Manager so phones can be re-signed every week without asking.
            </span>
            {sideload.lastError?.kind === 'login' && (
                <span className="small" style={{ color: 'var(--red)' }}>
                    {sideload.lastError.message}
                </span>
            )}
        </div>
    );
}

/** Apple's 2FA question, whenever the helper is waiting for it. */
export function TwoFactorDialog() {
    const { sideload, reloadSideload } = useStore();
    const act = useAction();
    const [code, setCode] = useState('');
    const q: TwoFactorQuestion | null | undefined = sideload?.job?.twoFactor;
    if (!q) return null;

    const answer = async (response: unknown) => {
        await act(() => post('/sideload/two-factor', { response }));
        setCode('');
        reloadSideload();
    };
    const submit = () => {
        const digits = code.replace(/\D/g, '');
        if (digits.length === 6) answer({ SubmitCode: digits });
    };
    const sentTo = q.sms
        ? q.numbers.find((n) => n.id === q.selectedNumberId)?.numberWithDialCode || 'your phone number'
        : 'your Apple devices';

    return (
        <div className="sheet" style={{ zIndex: 60 }}>
            <div className="dialog">
                <h3>Apple sign-in code</h3>
                <p className="dim">
                    {q.unknown
                        ? 'That code method failed. Pick where Apple should send a new code.'
                        : `Enter the 6-digit code Apple sent to ${sentTo}.`}
                </p>
                {q.lastError && (
                    <span className="small" style={{ color: 'var(--red)' }}>
                        {q.lastError}
                    </span>
                )}
                <TextInput value={code} onChange={setCode} placeholder="123456" onEnter={submit} autoFocus mono />
                <div className="row wrap" style={{ gap: 6 }}>
                    {(q.sms || q.unknown) && (
                        <Button size="sm" variant="ghost" onPress={() => answer('SendToDevices')}>
                            Send to my devices
                        </Button>
                    )}
                    {q.numbers
                        .filter((n) => n.id !== q.selectedNumberId || q.unknown)
                        .map((n) => (
                            <Button key={n.id} size="sm" variant="ghost" onPress={() => answer({ SendSms: n.id })}>
                                Text {n.numberWithDialCode}
                            </Button>
                        ))}
                    {!q.unknown && (
                        <Button size="sm" variant="ghost" onPress={() => answer('ResendCode')}>
                            Resend
                        </Button>
                    )}
                </div>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button variant="ghost" onPress={() => answer('Abort')}>
                        Cancel
                    </Button>
                    <Button variant="primary" isDisabled={code.replace(/\D/g, '').length !== 6} onPress={submit}>
                        Continue
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** On a phone that needs the control app: install it, or show how that's going. */
export function SideloadButton({ device, label = 'Install' }: { device: Device; label?: string }) {
    const { sideload, reloadSideload, go } = useStore();
    const act = useAction();
    if (!sideload?.available) return null;

    const job = sideload.job?.udid === device.udid ? sideload.job : null;
    if (job)
        return (
            <span className="row" style={{ justifyContent: 'center' }}>
                <Spinner size="sm" color="current" />
                <span className="mono small">
                    {job.step}
                    {job.percent != null && job.percent > 0 ? ` ${job.percent}%` : ''}
                </span>
            </span>
        );
    if (sideload.queued.includes(device.udid))
        return <span className="mono small muted">Waiting for the phone before it…</span>;

    const failed = sideload.lastError?.udid === device.udid ? sideload.lastError.message : '';
    return (
        <>
            <Button
                size="sm"
                variant="primary"
                onPress={() =>
                    sideload.appleId
                        ? act(() => post('/sideload/install', { udid: device.udid })).then(reloadSideload)
                        : go('setup')
                }
            >
                <Download size={14} />
                {sideload.appleId ? label : 'Sign in to install'}
            </Button>
            {failed && (
                <span className="small" style={{ color: 'var(--red)' }}>
                    {failed}
                </span>
            )}
        </>
    );
}
