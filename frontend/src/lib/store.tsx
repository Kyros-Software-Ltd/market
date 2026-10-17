'use client';
// Live app state: polls /api/status and /api/setup and shares them, plus navigation
// (each page is a Next.js route). Toasts go through Sonner.
import { usePathname, useRouter } from 'next/navigation';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { toast as sonner } from 'sonner';
import { get, type SetupInfo, type SideloadInfo, type Status } from './api';

export type Page = 'home' | 'phones' | 'media' | 'automations' | 'schedules' | 'claude' | 'setup';

export const PAGE_PATH: Record<Page, string> = {
    home: '/',
    phones: '/phones',
    media: '/media',
    automations: '/automations',
    schedules: '/schedules',
    claude: '/claude',
    setup: '/setup',
};

const pageFromPath = (path: string): Page =>
    (Object.entries(PAGE_PATH).find(([, p]) => p !== '/' && path.startsWith(p))?.[0] as Page) || 'home';

interface Store {
    status: Status;
    connected: boolean;
    refresh: () => void;
    setup: SetupInfo | null;
    reloadSetup: () => Promise<void>;
    sideload: SideloadInfo | null;
    reloadSideload: () => void;
    page: Page;
    go: (page: Page) => void;
    focus: string | null;
    setFocus: (udid: string | null) => void;
    selected: Set<string>;
    setSelected: (s: Set<string>) => void;
    toast: (text: string, error?: boolean) => void;
}

const empty: Status = { devices: [], jobs: [], usbError: '', activity: [] };
const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [status, setStatus] = useState<Status>(empty);
    const [connected, setConnected] = useState(true);
    const [setup, setSetup] = useState<SetupInfo | null>(null);
    const [focus, setFocus] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const refresh = useCallback(() => {
        get<Status>('/status')
            .then((s) => {
                setStatus(s);
                setConnected(true);
            })
            .catch(() => setConnected(false));
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 1200);
        return () => clearInterval(t);
    }, [refresh]);

    const reloadSetup = useCallback(
        () =>
            get<SetupInfo>('/setup')
                .then(setSetup)
                .catch(() => {}),
        [],
    );
    useEffect(() => {
        reloadSetup();
        const t = setInterval(reloadSetup, 8000);
        return () => clearInterval(t);
    }, [reloadSetup]);

    // Built-in sideloading: polled often while something is running so progress and 2FA show quickly.
    const [sideload, setSideload] = useState<SideloadInfo | null>(null);
    const reloadSideload = useCallback(() => {
        get<SideloadInfo>('/sideload')
            .then(setSideload)
            .catch(() => {});
    }, []);
    const sideloadBusy = !!sideload?.job || !!sideload?.queued.length;
    useEffect(() => {
        reloadSideload();
        const t = setInterval(reloadSideload, sideloadBusy ? 1500 : 10000);
        return () => clearInterval(t);
    }, [reloadSideload, sideloadBusy]);

    // Drop selections for phones that are no longer ready.
    useEffect(() => {
        const ready = new Set(status.devices.filter((d) => d.status === 'ready').map((d) => d.udid));
        if ([...selected].some((u) => !ready.has(u))) setSelected(new Set([...selected].filter((u) => ready.has(u))));
    }, [status, selected]);

    const toast = useCallback((text: string, error?: boolean) => {
        if (error) sonner.error(text);
        else sonner.success(text);
    }, []);

    const page = pageFromPath(pathname || '/');
    const go = useCallback((p: Page) => router.push(PAGE_PATH[p]), [router]);

    const value = useMemo<Store>(
        () => ({
            status,
            connected,
            refresh,
            setup,
            reloadSetup,
            sideload,
            reloadSideload,
            page,
            go,
            focus,
            setFocus,
            selected,
            setSelected,
            toast,
        }),
        [status, connected, refresh, setup, reloadSetup, sideload, reloadSideload, page, go, focus, selected, toast],
    );

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
    const s = useContext(Ctx);
    if (!s) throw new Error('useStore outside StoreProvider');
    return s;
}

/** Runs an async action and turns failures into an error toast. */
export function useAction() {
    const { toast, refresh } = useStore();
    return useCallback(
        async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
            try {
                const out = await fn();
                if (success) toast(success);
                refresh();
                return out;
            } catch (e) {
                toast((e as Error).message, true);
                return undefined;
            }
        },
        [toast, refresh],
    );
}
