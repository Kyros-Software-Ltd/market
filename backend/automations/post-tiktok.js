// Post to TikTok: one video, or several photos as a carousel (in the order given), with a caption.
// Sends the files from the Media library into the phone's Photos first (dated now, so they are
// the newest items), then uploads them through TikTok's own screens, then posts or saves to Drafts.
// The easy way to run it is the Media page: tick files, write the caption, press Post.
//
// How it finds the right files: TikTok's upload picker lists Photos oldest first and opens at
// the bottom, so what was just sent is the last tiles, in the order sent. Where they sit depends
// on how many items the phone has, so they're found on the screenshot (picker.js), and photos
// are checked against the files that were sent before anything is tapped.
//
// Screens, as mapped on iOS 27 with TikTok 47:
//   camera (snssdk1233://openRecord) → Upload → Videos/Photos tab
//   one video:  tap it (opens a preview) → Next
//   carousel:   tick each photo's circle in order → Next
//   → edit screen → Next (never "Your Story": that posts a story straight away)
//   → caption screen → Post or Drafts.

const TIKTOK = 'com.zhiliaoapp.musically';
// The caption box's placeholder, by layout; the first one found is used.
const DESCRIPTION = ['Add description', 'Writing a long description', 'description'];
const MAX_PHOTOS = 12; // what fits on the picker's screen without scrolling
const isVideo = (name) => /\.(mp4|mov|m4v)$/i.test(name);

// Waits up to ms for a label; the element, or null if it never showed.
const waitFor = (ctx, text, ms) =>
    ctx.waitForText(text, ms).catch((e) => {
        if (/Stopped/.test(e.message)) throw e;
        return null;
    });

// The Media page sends a list; the Automations form sends one name, or one per line.
const mediaList = (value) =>
    (Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
        .map((n) => String(n).trim())
        .filter(Boolean);

module.exports = {
    name: 'Post to TikTok',
    description: 'One video, or several photos as a carousel, from the Media library, with a caption.',
    params: [
        { key: 'media', label: 'Media (one video, or photos for a carousel)', type: 'media', default: '' },
        { key: 'caption', label: 'Caption (hashtags included)', type: 'text', default: '' },
        { key: 'finish', label: 'When done', type: 'select', options: ['post', 'drafts'], default: 'post' },
        { key: 'startDelayMax', label: 'Random start delay up to (s)', type: 'number', default: 0 },
    ],

    async run(ctx, p) {
        const names = mediaList(p.media);
        if (!names.length) throw new Error('Pick a video, or the photos for a carousel');
        const videos = names.filter(isVideo);
        if (videos.length && names.length > 1)
            throw new Error('Post one video on its own, or only photos for a carousel');
        if (names.length > MAX_PHOTOS) throw new Error(`Up to ${MAX_PHOTOS} photos per carousel for now`);
        const kind = videos.length ? 'video' : 'photo';
        const carousel = kind === 'photo' && names.length > 1;

        if (p.startDelayMax > 0) await ctx.sleepRandom(0, p.startDelayMax * 1000);
        // One at a time and in order, so they're dated in order and sit in the picker that way.
        await ctx.sendMedia(names);

        // Start from a fresh TikTok so no half-finished upload from earlier is in the way.
        await ctx.terminate(TIKTOK).catch(() => {});
        await ctx.sleepRandom(800, 1500);
        ctx.log('Opening the TikTok camera');
        await ctx.goTo('tiktok.camera');
        await ctx.waitForText('Upload', 20000);
        await ctx.sleepRandom(800, 1200);

        // The camera ignores taps for a moment while it starts up, so try Upload a few times.
        const tab = kind === 'photo' ? 'Photos' : 'Videos';
        for (let i = 0; ; i++) {
            await ctx.tapText('Upload');
            if (await waitFor(ctx, tab, 3000)) break;
            if (i >= 2) throw new Error("TikTok's upload picker didn't open");
        }
        await ctx.tapText(tab);
        await ctx.sleepRandom(1000, 1400);

        const tiles = await ctx.newestInPickerMany(names);
        if (carousel) {
            ctx.log(`Ticking ${tiles.length} photos in order`);
            for (const t of tiles) {
                await ctx.tapPct(t.circle.x, t.circle.y);
                await ctx.sleepRandom(350, 700);
            }
            await ctx.sleepRandom(600, 1000);
            await ctx.tapText('Next'); // the picker's own Next
        } else {
            await ctx.tapPct(tiles[0].x, tiles[0].y); // opens a preview of it
            await ctx.waitForText('Next', 20000);
            await ctx.tapText('Next');
        }
        ctx.log(carousel ? 'Carousel picked' : `Picked the ${kind}`);
        await ctx.sleepRandom(1200, 1800);

        // The edit screen ignores Next while a video is still loading, so keep at it until the
        // caption screen (it has Drafts) shows up. Match "Next" exactly so "Your Story" is never tapped.
        for (let i = 0; ; i++) {
            await ctx.waitForText('Next', 20000);
            await ctx.sleepRandom(600, 1000);
            await ctx.tapText('Next');
            if (await waitFor(ctx, 'Drafts', 6000)) break;
            if (i >= 3) throw new Error("TikTok's edit screen didn't move on to the caption screen");
            ctx.log('Edit screen still loading; tapping Next again');
        }
        ctx.log('On the caption screen');

        const button = p.finish === 'drafts' ? 'Drafts' : 'Post';
        if (p.caption) {
            let box = null;
            for (const label of DESCRIPTION) if (!box) box = await ctx.findText(label);
            if (!box) throw new Error("Couldn't find TikTok's caption box");
            await ctx.tap(box.x, box.y);
            await ctx.sleepRandom(250, 450);
            await ctx.type(p.caption);
            await ctx.sleepRandom(300, 500);
            // The keyboard hides Drafts and Post. Back closes it: on photo posts it shuts the
            // caption editor; on video posts it goes back to the edit screen, and Next there
            // returns to the caption screen with the caption kept.
            const back = await ctx.findText('Back');
            if (back) await ctx.tap(back.x, back.y);
            if (!(await waitFor(ctx, 'Drafts', 2000))) {
                await ctx.waitForText('Next', 10000);
                await ctx.tapText('Next');
            }
        }

        await ctx.waitForText(button, 15000);
        await ctx.tapText(button);
        ctx.log(button === 'Post' ? 'Posted; TikTok uploads it in the background' : 'Saved to Drafts');
        await ctx.sleepRandom(4000, 7000);
    },
};
