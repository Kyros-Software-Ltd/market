// Simplest possible automation: open an app, wait, go home. Good template to copy.
module.exports = {
    name: 'Open app',
    description: 'Launches an app by bundle id, keeps it open for a while, then returns home.',
    params: [
        { key: 'bundleId', label: 'Bundle id', type: 'text', default: 'com.apple.mobilesafari' },
        { key: 'seconds', label: 'Keep open (s)', type: 'number', default: 10 },
    ],

    async run(ctx, p) {
        ctx.log(`Launching ${p.bundleId}`);
        await ctx.launch(p.bundleId);
        await ctx.sleep(p.seconds * 1000);
        await ctx.home();
    },
};
