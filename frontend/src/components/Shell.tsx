'use client';
// The app frame around every page: sidebar, notices, the phone control sheet and toasts.
import { Button } from '@heroui/react';
import { CircleX } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { PhoneControl } from '@/components/PhoneControl';
import { PromptProvider } from '@/components/Prompt';
import { UpdateNotice } from '@/components/Update';
import { CalendarIcon, ClaudeCodeIcon, FlowIcon, FolderOpenIcon, HomeIcon, PhoneIcon, SetupIcon } from '@/lib/icons';
import { type Page, StoreProvider, useStore } from '@/lib/store';

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
    { page: 'home', label: 'Home', icon: <HomeIcon /> },
    { page: 'phones', label: 'Phones', icon: <PhoneIcon /> },
    { page: 'media', label: 'Media', icon: <FolderOpenIcon /> },
    { page: 'automations', label: 'Automations', icon: <FlowIcon /> },
    { page: 'schedules', label: 'Schedules', icon: <CalendarIcon /> },
    { page: 'claude', label: 'Claude', icon: <ClaudeCodeIcon /> },
];

export function Shell({ children }: { children: ReactNode }) {
    return (
        <StoreProvider>
            <PromptProvider>
                <Frame>{children}</Frame>
            </PromptProvider>
        </StoreProvider>
    );
}

function Frame({ children }: { children: ReactNode }) {
    const { page, go, status, connected, focus, setup } = useStore();

    // Opening Market on Home before it's set up goes straight to Setup.
    const [firstRoute, setFirstRoute] = useState(false);
    useEffect(() => {
        if (setup && !firstRoute) {
            setFirstRoute(true);
            if (page === 'home' && (!setup.usbOk || !setup.wdaIpa)) go('setup');
        }
    }, [setup, firstRoute, go, page]);

    const ready = status.devices.filter((d) => d.status === 'ready').length;
    const running = status.jobs.filter((j) => j.status === 'running').length;
    const needsSetup =
        (setup && !setup.usbOk) || status.devices.some((d) => d.status === 'action' || d.status === 'error');
    const claudeActive = status.activity.some((a) => a.actor === 'claude' && Date.now() - a.at < 15000);

    return (
        <div className="app">
            <aside className="sidebar dark" data-theme="dark">
                {/* Wordmark in the full sidebar; the square icon when the sidebar is narrow. */}
                <div className="brand">
                    <img className="brand-full" src="/white-webview.svg" alt="Market" />
                    <img className="brand-thin" src="/icon.png" alt="" />
                </div>
                <nav className="nav">
                    {NAV.map((n) => (
                        <Button
                            key={n.page}
                            variant="ghost"
                            fullWidth
                            className={`nav-item ${page === n.page ? 'active' : ''}`}
                            onPress={() => go(n.page)}
                        >
                            {n.icon}
                            <span>{n.label}</span>
                            {n.page === 'phones' && status.devices.length > 0 && (
                                <span className="nav-count">
                                    {ready}/{status.devices.length}
                                </span>
                            )}
                            {n.page === 'automations' && running > 0 && <span className="nav-count">{running}</span>}
                            {n.page === 'claude' && claudeActive && (
                                <span className="nav-alert pulse" style={{ background: 'var(--claude)' }} />
                            )}
                        </Button>
                    ))}
                    <div className="nav-label">System</div>
                    <Button
                        variant="ghost"
                        fullWidth
                        className={`nav-item ${page === 'setup' ? 'active' : ''}`}
                        onPress={() => go('setup')}
                    >
                        <SetupIcon />
                        <span>Setup</span>
                        {needsSetup && <span className="nav-alert" />}
                    </Button>
                </nav>
                <div className="sidebar-foot">
                    <span className="row small dim">
                        <span className={`dot ${connected ? 'ready' : 'error'}`} />
                        {connected ? 'Engine running' : 'Engine offline'}
                    </span>
                    <a
                        className="sponsor"
                        href="https://affrev.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Sponsored by AffRev"
                    >
                        <span>Sponsored by</span>
                        <img src="/affrev.svg" alt="AffRev" />
                    </a>
                </div>
            </aside>

            <main>
                <div className="page">
                    <div className="page-inner">
                        <UpdateNotice />
                        {status.usbError && (
                            <div className="notice">
                                <CircleX />
                                <span className="grow">
                                    Windows can't talk to iPhones yet: the Apple USB driver is missing.
                                </span>
                                <Button size="sm" variant="secondary" onPress={() => go('setup')}>
                                    Open setup
                                </Button>
                            </div>
                        )}
                        {children}
                    </div>
                </div>
            </main>

            {focus && <PhoneControl udid={focus} />}

            <Toaster position="bottom-right" richColors closeButton duration={4500} />
        </div>
    );
}
