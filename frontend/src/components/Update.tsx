'use client';
// Updates from the repo's GitHub Releases: the notice at the top of every page and the
// Version row in Setup. Updating restarts Market, so the page waits for it and reloads.
import { Button } from '@heroui/react';
import { ArrowUpCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { get, post, type UpdateInfo } from '@/lib/api';
import { useAction } from '@/lib/store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Asks the local backend (which checks GitHub every 5 minutes), so polling often is cheap.
function useUpdate(every = 30 * 1000) {
    const [info, setInfo] = useState<UpdateInfo | null>(null);
    const reload = useCallback(
        () =>
            get<UpdateInfo>('/update')
                .then(setInfo)
                .catch(() => {}),
        [],
    );
    useEffect(() => {
        reload();
        const t = setInterval(reload, every);
        return () => clearInterval(t);
    }, [reload, every]);
    return { info, setInfo, reload };
}

/** Waits for Market to come back after an update, then reloads the page. */
async function waitForRestart(from: string) {
    let wentDown = false;
    for (let i = 0; i < 400; i++) {
        await sleep(3000);
        try {
            const u = await get<UpdateInfo>('/update');
            if (u.version !== from || wentDown) return window.location.reload();
        } catch {
            wentDown = true;
        }
    }
}

export function UpdateNotice() {
    const { info } = useUpdate();
    const [updating, setUpdating] = useState('');
    const [error, setError] = useState('');

    if (updating)
        return (
            <div className="notice info">
                <RefreshCw className="spin" />
                <span className="grow">
                    Updating to {updating}. Market restarts by itself, and this page reloads when it's back (usually a
                    minute or two).
                </span>
            </div>
        );
    if (!info?.available || !info.latest) return null;

    const latest = info.latest;
    const failed = info.last && !info.last.ok && info.last.to === latest.version ? info.last.error : '';
    const update = async () => {
        setError('');
        try {
            await post('/update');
            setUpdating(latest.version);
            waitForRestart(info.version);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <div className="notice info">
            <ArrowUpCircle />
            <span className="grow">
                Market {latest.version} is out (you have {info.version}).
                {(error || failed) && (
                    <span className="block small">{error || `The last try didn't work: ${failed}`}</span>
                )}
                {!info.canApply && !error && (
                    <span className="block small">To update, close Market and start it again with npm start.</span>
                )}
            </span>
            <Button size="sm" variant="ghost" onPress={() => window.open(latest.url, '_blank', 'noopener')}>
                <ExternalLink size={14} />
                What's new
            </Button>
            {info.canApply && (
                <Button size="sm" variant="primary" onPress={update}>
                    Update
                </Button>
            )}
        </div>
    );
}

/** The installed version, in the sidebar footer. */
export function VersionTag() {
    const { info } = useUpdate();
    return info ? <span className="small dim">Market v{info.version}</span> : null;
}

export function VersionRow() {
    const { info, setInfo } = useUpdate();
    const act = useAction();
    const [checking, setChecking] = useState(false);
    if (!info) return null;

    const check = async () => {
        setChecking(true);
        const u = await act(() => post<UpdateInfo>('/update/check'));
        if (u) setInfo(u);
        setChecking(false);
    };
    const state = info.error
        ? `Couldn't check for updates: ${info.error}`
        : info.available && info.latest
          ? `${info.latest.version} is available`
          : info.latest
            ? 'Up to date'
            : info.notFound && !info.hasToken
              ? 'No releases found. If the repo is private, add "updateToken" to config.json in the data folder.'
              : 'No releases published yet';

    return (
        <div className="row">
            <div className="grow">
                <div>Version {info.version}</div>
                <div className="small muted">{state}</div>
            </div>
            <Button size="sm" variant="secondary" isDisabled={checking || !info.repo} onPress={check}>
                <RefreshCw size={14} className={checking ? 'spin' : undefined} />
                Check for updates
            </Button>
        </div>
    );
}
