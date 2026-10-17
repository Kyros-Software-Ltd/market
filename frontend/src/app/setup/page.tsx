'use client';
import { useStore } from '@/lib/store';
import { SetupPage } from '@/views/Setup';

export default function Page() {
    const { setup, reloadSetup } = useStore();
    return <SetupPage setup={setup} reload={reloadSetup} />;
}
