import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = {
    title: 'Market',
    description: 'Control, automate and let Claude drive your iPhones from Windows.',
    icons: { icon: '/icon.png' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" data-theme="light" suppressHydrationWarning>
            <body>
                <Shell>{children}</Shell>
            </body>
        </html>
    );
}
