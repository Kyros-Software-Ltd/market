import type { Actor, Device } from './api';

export function ago(t: number) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString();
}

export function bytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const statusLabel: Record<Device['status'], string> = {
    idle: 'waiting',
    starting: 'setting up',
    action: 'needs you',
    ready: 'ready',
    error: 'error',
    offline: 'unplugged',
    stopped: 'stopped',
};

export const actorLabel: Record<Actor, string> = { you: 'You', claude: 'Claude', automation: 'Automation' };

// Apple's model codes ("iPhone11,2") are what the phone reports; show friendlier names for common ones.
const MODELS: Record<string, string> = {
    'iPhone10,3': 'iPhone X',
    'iPhone10,6': 'iPhone X',
    'iPhone11,2': 'iPhone XS',
    'iPhone11,4': 'iPhone XS Max',
    'iPhone11,6': 'iPhone XS Max',
    'iPhone11,8': 'iPhone XR',
    'iPhone12,1': 'iPhone 11',
    'iPhone12,3': 'iPhone 11 Pro',
    'iPhone12,5': 'iPhone 11 Pro Max',
    'iPhone13,2': 'iPhone 12',
    'iPhone14,5': 'iPhone 13',
    'iPhone14,7': 'iPhone 14',
    'iPhone15,2': 'iPhone 14 Pro',
    'iPhone15,4': 'iPhone 15',
    'iPhone16,1': 'iPhone 15 Pro',
    'iPhone17,3': 'iPhone 16',
};
export const modelName = (code: string) => MODELS[code] || code;

export function renewText(d: Device) {
    if (!d.expiresAt) return '';
    const left = d.expiresAt - Date.now();
    if (left <= 0) return 'expired';
    if (left < 86400000) return 'expires today';
    return `expires in ${Math.round(left / 86400000)}d`;
}

export const slug = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `flow-${Date.now()}`;
