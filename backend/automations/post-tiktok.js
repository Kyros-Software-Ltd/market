// Post to TikTok: sends a photo or video from the Media library into the phone's Photos
// (dated today, so it is the newest item), then uploads it through TikTok's own screens with a
// caption and posts it, or saves it to Drafts.
//
// How it finds the right file: TikTok's upload picker lists Photos oldest first and opens at
// the bottom, so the newest item is the last tile, and where that is depends on how many items
// the phone has. ctx.newestInPicker() finds it on the screenshot, and for photos also checks it
// looks like the file that was sent. Leave "Media" empty to post whatever is newest already.
//
// Screens, as mapped on iOS 27 with TikTok 47:
//   camera (snssdk1233://openRecord) → Upload → Videos/Photos tab → newest tile (opens a preview)
//   → Next → edit screen → Next (never "Your Story": that posts a story straight away)
//   → caption screen, then Post or Drafts. Videos get "Add description...", photos get
//   "Add a catchy title" and a longer description box.

const TIKTOK = 'com.zhiliaoapp.musically';
// The caption box's placeholder, by layout; the first one found is used.
const DESCRIPTION = ['Add description', 'Writing a long description', 'description'];
// Waits up to ms for a label; the element, or null if it never showed.
const waitFor = (ctx, text, ms) =>
    ctx.waitForText(text, ms).catch((e) => {
        if (/Stopped/.test(e.message)) throw e;
        return null;
    });

module.exports = {
    name: 'Post to TikTok',
    description: 'Sends a photo or video to the phone, then uploads it to TikTok with a caption.',
    params: [
        {
            key: 'media',
            label: 'Media (from the Media library; empty = newest on the phone)',
            type: 'media',
            default: '',
        },
        {
            key: 'kind',
            label: 'Type (when Media is empty)',
            type: 'select',
            options: ['video', 'photo'],
            default: 'video',
        },
        { key: 'caption', label: 'Caption (hashtags included)', type: 'text', default: '' },
        { key: 'finish', label: 'When done', type: 'select', options: ['post', 'drafts'], default: 'post' },
        { key: 'startDelayMax', label: 'Random start delay up to (s)', type: 'number', default: 0 },
    ],

    async run(ctx, p) {
        if (p.startDelayMax > 0) await ctx.sleepRandom(0, p.startDelayMax * 1000);

        const media = String(p.media || '').trim();
        let kind = p.kind === 'photo' ? 'photo' : 'video';
        if (media) {
            if (/\.(jpe?g|png|heic|gif|webp)$/i.test(media)) kind = 'photo';
            if (/\.(mp4|mov|m4v)$/i.test(media)) kind = 'video';
            await ctx.sendMedia([media]);
        }

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

        const tile = await ctx.newestInPicker({ media });
        await ctx.tapPct(tile.x, tile.y);

        // Preview, then the edit screen. Match "Next" exactly so "Your Story" is never tapped.
        await ctx.waitForText('Next', 20000);
        await ctx.tapText('Next');
        ctx.log('Next on the preview');
        await ctx.sleepRandom(1200, 1800);
        // The edit screen ignores Next while a video is still loading, so keep at it until the
        // caption screen (it has Drafts) shows up.
        for (let i = 0; ; i++) {
            await ctx.waitForText('Next', 20000);
            await ctx.sleepRandom(600, 1000);
            await ctx.tapText('Next');
            const drafts = await waitFor(ctx, 'Drafts', 6000);
            if (drafts) break;
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
