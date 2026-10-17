'use client';
import { useStore } from '@/lib/store';
import { HomePage } from '@/views/Home';

export default function Page() {
    const { setup } = useStore();
    return <HomePage setup={setup} />;
}
