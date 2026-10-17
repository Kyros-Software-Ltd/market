import { type NextRequest, NextResponse } from 'next/server';

// Only answer requests addressed to this PC. A website can point its own domain at 127.0.0.1
// (DNS rebinding) and then read and control Market from your browser; its Host header gives it away.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function proxy(req: NextRequest) {
    let hostname = '';
    try {
        hostname = new URL(`http://${req.headers.get('host') ?? ''}`).hostname;
    } catch {}
    if (LOCAL.has(hostname)) return NextResponse.next();
    return new NextResponse('Market only answers requests to localhost.', { status: 403 });
}
