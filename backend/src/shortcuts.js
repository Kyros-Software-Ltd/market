// Straight to a screen inside TikTok or Instagram, without searching or tapping through menus.
// Each shortcut is the app's own link (its URL scheme), so it works the same on every iOS
// version, including iOS 27 where home-screen search no longer shows app shortcuts.
//
// Every link here was opened on an iOS 18.7 and an iOS 27.0 iPhone (TikTok 47.1, Instagram 456)
// and landed on the screen named. Links the apps ignore or that broke were left out:
//   TikTok: notice, chat, im, profile, user/profile (own), friends, live, studio, favorite, wallet
//   Instagram: reels, notifications, library, direct_v2, archive, edit_profile, reels_camera
// TikTok has no link for your own profile, so that one opens the feed and taps the Profile tab.
const TIKTOK = 'com.zhiliaoapp.musically';
const INSTAGRAM = 'com.burbn.instagram';

/** param: what the link needs filled in, e.g. a username. */
const SHORTCUTS = [
    { id: 'tiktok.feed', app: 'TikTok', bundleId: TIKTOK, name: 'Home feed', url: 'snssdk1233://feed?refer=web' },
    {
        id: 'tiktok.following',
        app: 'TikTok',
        bundleId: TIKTOK,
        name: 'Following feed',
        url: 'snssdk1233://feed?tab=following',
    },
    { id: 'tiktok.inbox', app: 'TikTok', bundleId: TIKTOK, name: 'Inbox', url: 'snssdk1233://inbox' },
    { id: 'tiktok.search', app: 'TikTok', bundleId: TIKTOK, name: 'Search', url: 'snssdk1233://search' },
    {
        id: 'tiktok.search_for',
        app: 'TikTok',
        bundleId: TIKTOK,
        name: 'Search for…',
        url: 'snssdk1233://search?keyword={query}',
        param: { key: 'query', label: 'Search for' },
    },
    { id: 'tiktok.camera', app: 'TikTok', bundleId: TIKTOK, name: 'Camera', url: 'snssdk1233://openRecord' },
    { id: 'tiktok.shop', app: 'TikTok', bundleId: TIKTOK, name: 'Shop', url: 'snssdk1233://shop' },
    { id: 'tiktok.settings', app: 'TikTok', bundleId: TIKTOK, name: 'Settings', url: 'snssdk1233://setting' },
    {
        id: 'tiktok.profile',
        app: 'TikTok',
        bundleId: TIKTOK,
        name: 'My profile',
        url: 'snssdk1233://feed?refer=web',
        // The Profile tab, bottom right; same place on every iPhone size.
        thenTap: { x: 0.9, y: 0.93 },
    },
    {
        id: 'tiktok.user',
        app: 'TikTok',
        bundleId: TIKTOK,
        name: 'User by id…',
        url: 'snssdk1233://user/profile/{id}',
        param: { key: 'id', label: 'User id (the number, not the @name)' },
    },
    {
        id: 'tiktok.video',
        app: 'TikTok',
        bundleId: TIKTOK,
        name: 'Video by id…',
        url: 'snssdk1233://aweme/detail/{id}',
        param: { key: 'id', label: 'Video id (the number at the end of its link)' },
    },

    { id: 'instagram.feed', app: 'Instagram', bundleId: INSTAGRAM, name: 'Home feed', url: 'instagram://app' },
    { id: 'instagram.reels', app: 'Instagram', bundleId: INSTAGRAM, name: 'Reels', url: 'instagram://reels_home' },
    {
        id: 'instagram.explore',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'Explore and search',
        url: 'instagram://explore',
    },
    {
        id: 'instagram.messages',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'Messages',
        url: 'instagram://direct-inbox',
    },
    {
        id: 'instagram.new_message',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'New message',
        url: 'instagram://direct-new',
    },
    { id: 'instagram.activity', app: 'Instagram', bundleId: INSTAGRAM, name: 'Notifications', url: 'instagram://news' },
    { id: 'instagram.profile', app: 'Instagram', bundleId: INSTAGRAM, name: 'My profile', url: 'instagram://profile' },
    { id: 'instagram.camera', app: 'Instagram', bundleId: INSTAGRAM, name: 'Camera', url: 'instagram://camera' },
    {
        id: 'instagram.story',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'Story camera',
        url: 'instagram://story-camera',
    },
    { id: 'instagram.saved', app: 'Instagram', bundleId: INSTAGRAM, name: 'Saved', url: 'instagram://saved' },
    {
        id: 'instagram.your_activity',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'Your activity',
        url: 'instagram://your_activity',
    },
    { id: 'instagram.settings', app: 'Instagram', bundleId: INSTAGRAM, name: 'Settings', url: 'instagram://settings' },
    {
        id: 'instagram.user',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'User…',
        url: 'instagram://user?username={username}',
        param: { key: 'username', label: 'Username (without @)' },
    },
    {
        id: 'instagram.tag',
        app: 'Instagram',
        bundleId: INSTAGRAM,
        name: 'Hashtag…',
        url: 'instagram://tag?name={tag}',
        param: { key: 'tag', label: 'Hashtag (without #)' },
    },
];

function find(id) {
    const s = SHORTCUTS.find((x) => x.id === id);
    if (!s) throw new Error(`No shortcut "${id}". Known: ${SHORTCUTS.map((x) => x.id).join(', ')}`);
    return s;
}

/** The link to open, with the shortcut's value filled in. */
function urlFor(shortcut, args = {}) {
    if (!shortcut.param) return shortcut.url;
    const raw = String(args[shortcut.param.key] ?? args.value ?? '')
        .trim()
        .replace(/^[@#]/, '');
    if (!raw) throw new Error(`${shortcut.app} "${shortcut.name}" needs: ${shortcut.param.label}`);
    return shortcut.url.replace(`{${shortcut.param.key}}`, encodeURIComponent(raw));
}

module.exports = { SHORTCUTS, find, urlFor };
