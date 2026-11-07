import type { Device } from '@/lib/api';

export type PhoneTone = 'neutral' | 'progress' | 'wait' | 'error';

export type PhoneCopy = {
    title: string;
    detail?: string;
    tone: PhoneTone;
};

/** Collapse backend steps / action kinds into one plain message. */
export function phoneCopy(d: Device, installing = false): PhoneCopy {
    if (installing) {
        return {
            title: 'Installing Market',
            detail: 'Keep the phone unlocked. This takes about a minute.',
            tone: 'progress',
        };
    }

    if (d.status === 'ready') {
        return { title: 'Ready', tone: 'neutral' };
    }

    if (d.status === 'offline' || d.status === 'stopped') {
        return {
            title: d.status === 'stopped' ? 'Stopped' : 'Away',
            detail: 'Plug in or wake the phone on Wi‑Fi to continue.',
            tone: 'neutral',
        };
    }

    if (d.status === 'error') {
        return {
            title: 'Couldn’t connect',
            detail: plainError(d.error) || 'Try again with the phone unlocked.',
            tone: 'error',
        };
    }

    if (d.status === 'action' && d.action) {
        return actionCopy(d.action.kind, d.name, d.action.text);
    }

    if (d.status === 'starting' || d.status === 'idle') {
        return {
            title: 'Setting up',
            detail: 'Keep the phone unlocked — Market finishes this on its own.',
            tone: 'progress',
        };
    }

    return { title: 'Waiting', tone: 'neutral' };
}

function actionCopy(kind: string, name: string, fallback: string): PhoneCopy {
    switch (kind) {
        case 'trust':
            return {
                title: 'Trust this PC',
                detail: `Unlock ${name}, tap Trust This Computer, then enter the passcode.`,
                tone: 'wait',
            };
        case 'install':
            return {
                title: 'Install Market',
                detail: 'Sign in with your Apple ID in Setup, then install on this phone.',
                tone: 'wait',
            };
        case 'resign':
            return {
                title: 'Renew Market',
                detail: 'Free Apple IDs expire every 7 days. Install again to renew.',
                tone: 'wait',
            };
        case 'devmode':
            return {
                title: 'Turn on Developer Mode',
                detail: 'Settings → Privacy & Security → Developer Mode → On, then restart.',
                tone: 'wait',
            };
        case 'trust-developer':
            return {
                title: 'Trust the Market app',
                detail: 'Settings → General → VPN & Device Management → your Apple ID → Trust.',
                tone: 'wait',
            };
        case 'unlock':
            return {
                title: 'Unlock the phone',
                detail: `Unlock ${name} so setup can continue.`,
                tone: 'wait',
            };
        default:
            return {
                title: 'Needs a moment on the phone',
                detail: plainError(fallback) || 'Follow the prompt on the phone, then wait.',
                tone: 'wait',
            };
    }
}

/** Strip stack traces / service jargon from error strings shown in the UI. */
function plainError(msg?: string | null) {
    if (!msg) return '';
    let s = String(msg).trim();
    s = s.replace(/\bDeviceKit\b/gi, 'Market');
    s = s.replace(/\bpmd3\b/gi, '');
    s = s.replace(/\bgo-ios\b/gi, '');
    s = s.replace(/\bXCUITest\b/gi, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    if (s.length > 160) s = `${s.slice(0, 157)}…`;
    return s;
}
