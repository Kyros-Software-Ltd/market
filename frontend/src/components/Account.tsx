'use client';
// AffRev sign-in. The packaged app only runs for a signed-in AffRev account, so until then the
// whole dashboard is replaced by the sign-in screen. Signing in goes to affrev.com in this tab and
// comes back through /api/account/callback.
import { Button } from '@heroui/react';
import { LogIn } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type AccountInfo, get, post } from '@/lib/api';
import { useAction } from '@/lib/store';

function useAccount() {
    const [info, setInfo] = useState<AccountInfo | null>(null);
    const reload = useCallback(
        () =>
            get<AccountInfo>('/account')
                .then(setInfo)
                .catch(() => {}),
        [],
    );
    const locked = !!info?.required && !info.signedIn;
    useEffect(() => {
        reload();
        const t = setInterval(reload, locked ? 5000 : 60000);
        return () => clearInterval(t);
    }, [reload, locked]);
    return { info, reload };
}

async function signIn() {
    const { url } = await post<{ url: string }>('/account/sign-in', { origin: window.location.origin });
    window.location.href = url;
}

export function SignInGate({ children }: { children: ReactNode }) {
    const { info } = useAccount();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // AffRev sends errors back as ?signin_error=…
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const e = params.get('signin_error');
        if (e) {
            setError(e);
            window.history.replaceState(null, '', window.location.pathname);
        }
    }, []);

    if (!info?.required || info.signedIn) return <>{children}</>;

    const start = async () => {
        setBusy(true);
        setError('');
        try {
            await signIn();
        } catch (e) {
            setError((e as Error).message);
            setBusy(false);
        }
    };

    return (
        <div className="signin">
            <div className="signin-card">
                <img src="/icon.png" alt="" />
                <h1>Sign in to Market</h1>
                <p className="muted">
                    Market is free with an AffRev account. Sign in once on this PC and it stays signed in.
                </p>
                <Button variant="primary" fullWidth isDisabled={busy} onPress={start}>
                    <LogIn size={16} />
                    {busy ? 'Opening AffRev…' : 'Sign in with AffRev'}
                </Button>
                {(error || info.error) && (
                    <span className="small" style={{ color: 'var(--red)' }}>
                        {error || `Couldn't reach AffRev: ${info.error}`}
                    </span>
                )}
                <span className="small muted">
                    No account?{' '}
                    <a href={`${info.affrevUrl}/login`} target="_blank" rel="noopener noreferrer">
                        Create one on affrev.com
                    </a>
                </span>
            </div>
        </div>
    );
}

/** The AffRev account row in Setup → Options. */
export function AccountRow() {
    const { info, reload } = useAccount();
    const act = useAction();
    if (!info || (!info.required && !info.signedIn)) return null;

    return (
        <div className="row">
            <div className="grow">
                <div>AffRev account</div>
                <div className="small muted">{info.user ? info.user.email : 'Not signed in'}</div>
            </div>
            {info.signedIn ? (
                <Button
                    size="sm"
                    variant="secondary"
                    onPress={async () => {
                        await act(() => post('/account/sign-out'));
                        reload();
                    }}
                >
                    Sign out
                </Button>
            ) : (
                <Button size="sm" variant="secondary" onPress={() => act(signIn)}>
                    Sign in
                </Button>
            )}
        </div>
    );
}
