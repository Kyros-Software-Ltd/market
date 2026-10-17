// Typed access to the app's local API (served by src/server/index.js).

export type DeviceStatus = 'idle' | 'starting' | 'action' | 'ready' | 'error' | 'offline' | 'stopped';
export type Actor = 'you' | 'claude' | 'automation';

export interface Activity {
    at: number;
    udid: string;
    phone: string;
    actor: Actor;
    text: string;
}

export interface Device {
    udid: string;
    name: string;
    model: string;
    iosVersion: string;
    online: boolean;
    status: DeviceStatus;
    step: string;
    action: { kind: string; title: string; text: string } | null;
    error: string;
    mjpegPort?: number;
    connection: 'usb' | 'wifi' | null; // how it's connected right now
    mode: 'usb' | 'wifi'; // Setup choice: USB only, or USB + Wi-Fi (cable first)
    size?: { width: number; height: number };
    lastActivity: Activity | null;
    expiresAt: number | null;
    resignSoon: boolean;
}

export interface Job {
    id: number;
    automationId: string;
    automationName: string;
    udid: string;
    deviceName: string;
    status: 'running' | 'done' | 'stopped' | 'failed';
    trigger: 'you' | 'claude' | 'schedule';
    startedAt: number;
    endedAt: number | null;
    error: string;
    logs: string[];
}

export interface Param {
    key: string;
    label: string;
    type: 'text' | 'number' | 'checkbox' | 'select';
    default?: unknown;
    options?: string[];
}

export interface Automation {
    id: string;
    kind: 'script' | 'flow';
    name: string;
    description?: string;
    params: Param[];
    broken?: boolean;
    steps?: unknown[];
}

export interface Schedule {
    id: string;
    name: string;
    automationId: string;
    phones: 'all' | string[];
    params: Record<string, unknown>;
    times: string[];
    windowMinutes: number;
    days: number[];
    enabled: boolean;
    next: number | null;
}

export interface MediaItem {
    name: string;
    type: 'video' | 'image';
    size: number;
    addedAt: number;
}

export interface Status {
    devices: Device[];
    jobs: Job[];
    usbError: string;
    activity: Activity[];
}

export interface SetupInfo {
    sideloadly: boolean;
    wdaIpa: boolean;
    wdaBuilding: string;
    wdaError: string;
    helper: string;
    helperStep: string;
    helperError: string;
    dataDir: string;
    usbOk: boolean;
    usbError: string;
}

export interface ClaudeInfo {
    claudeCodeCommand: string;
    desktopConfigs: { file: string; connected: boolean }[];
    activity: Activity[];
}

export interface UpdateInfo {
    version: string;
    repo: string | null;
    latest: { version: string; tag: string; notes: string; url: string; publishedAt: number | null } | null;
    available: boolean;
    checkedAt: number;
    error: string;
    notFound: boolean; // no releases yet, or a private repo without a token
    hasToken: boolean;
    canApply: boolean;
    last: { from: string; to: string; ok: boolean; error: string; at: number } | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
    return json as T;
}

export const get = <T>(path: string) => request<T>('GET', path);
export const post = <T = unknown>(path: string, body: unknown = {}) => request<T>('POST', path, body);
export const del = <T = unknown>(path: string) => request<T>('DELETE', path);

/** Sends one control action (tap, swipe, home, …) to one or more phones. */
export const control = (action: string, udids: string[], args: Record<string, unknown> = {}) =>
    post(`/control/${action}`, { udids, ...args });

/** Uploads a file into the media library; the file is the raw request body. */
export async function uploadMedia(file: File): Promise<{ name: string }> {
    const res = await fetch(`/api/media?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}

export const mediaUrl = (name: string) => `/api/media/file/${encodeURIComponent(name)}`;
