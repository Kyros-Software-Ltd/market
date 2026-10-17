import type { NextConfig } from 'next';

// The backend (backend/src/index.js) serves the API on 127.0.0.1:4000; the dashboard
// reaches it same-origin through /api, including the phones' live screen streams.
const BACKEND = process.env.MARKET_BACKEND || 'http://127.0.0.1:4000';

const config: NextConfig = {
    async rewrites() {
        return [{ source: '/api/:path*', destination: `${BACKEND}/api/:path*` }];
    },
    experimental: {
        // Building WDA.ipa, sending media or mounting a developer image can take minutes.
        proxyTimeout: 10 * 60 * 1000,
    },
    devIndicators: false,
};

export default config;
