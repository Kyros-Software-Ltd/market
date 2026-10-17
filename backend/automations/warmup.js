// Account warmup: open a short-video / feed app and browse it like a person would,
// with randomised watch times, occasional scroll-backs and breaks.
// Copy this file to make your own automation; every .js file in this folder shows up in the app.

const APPS = {
    tiktok: 'com.zhiliaoapp.musically',
    instagram: 'com.burbn.instagram',
    youtube: 'com.google.ios.youtube',
    snapchat: 'com.toyopagroup.picaboo',
    facebook: 'com.facebook.Facebook',
    x: 'com.atebits.Tweetie2',
};

module.exports = {
    name: 'Warmup: browse feed',
    description: 'Opens the app and scrolls the feed with human-like, randomised timing.',
    params: [
        { key: 'app', label: 'App', type: 'select', options: Object.keys(APPS), default: 'tiktok' },
        { key: 'customBundleId', label: 'Custom bundle id (overrides App)', type: 'text', default: '' },
        { key: 'minutes', label: 'Session length (minutes)', type: 'number', default: 15 },
        { key: 'minWatch', label: 'Min watch per post (s)', type: 'number', default: 3 },
        { key: 'maxWatch', label: 'Max watch per post (s)', type: 'number', default: 18 },
        { key: 'longWatchChance', label: 'Chance to watch a post fully (0-1)', type: 'number', default: 0.15 },
        { key: 'likeChance', label: 'Chance to like a post (0-1)', type: 'number', default: 0.05 },
        { key: 'startDelayMax', label: 'Random start delay up to (s)', type: 'number', default: 30 },
        { key: 'closeWhenDone', label: 'Close app when done', type: 'checkbox', default: true },
    ],

    async run(ctx, p) {
        const bundleId = p.customBundleId.trim() || APPS[p.app];

        // Stagger phones so a whole fleet doesn't act in lockstep.
        if (p.startDelayMax > 0) await ctx.sleepRandom(0, p.startDelayMax * 1000);

        ctx.log(`Opening ${bundleId}`);
        await ctx.launch(bundleId);
        await ctx.sleepRandom(4000, 8000);

        const endAt = Date.now() + p.minutes * 60 * 1000;
        let posts = 0;

        while (Date.now() < endAt) {
            const watchSec = ctx.chance(p.longWatchChance)
                ? ctx.rand(p.maxWatch, p.maxWatch * 2.5)
                : ctx.rand(p.minWatch, p.maxWatch);
            await ctx.sleep(watchSec * 1000);

            // Double-tap likes on TikTok, Instagram Reels and most short-video feeds.
            if (ctx.chance(p.likeChance)) {
                await ctx.doubleTapPct(ctx.rand(0.35, 0.65), ctx.rand(0.35, 0.55));
                ctx.log('Liked a post');
                await ctx.sleepRandom(800, 2500);
            }

            if (ctx.chance(0.05)) {
                ctx.log('Scrolling back up');
                await ctx.scrollFeed('down');
                await ctx.sleepRandom(2000, 6000);
            }

            await ctx.scrollFeed('up');
            posts++;

            if (posts % 10 === 0) ctx.log(`Viewed ${posts} posts`);

            // Short "put the phone down" break now and then.
            if (ctx.chance(0.03)) {
                const pause = ctx.rand(20, 60);
                ctx.log(`Taking a ${Math.round(pause)}s break`);
                await ctx.sleep(pause * 1000);
            }
        }

        ctx.log(`Session complete: ${posts} posts viewed`);
        if (p.closeWhenDone) {
            await ctx.terminate(bundleId).catch(() => {});
            await ctx.home();
        }
    },
};
