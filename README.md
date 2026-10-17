# Market

A Windows app for running your iPhones from your browser: see them live, control them with the mouse, send them photos and videos from your PC, automate them, and let Claude drive them. You don't need a Mac or a jailbreak.

## Install and run

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

`npm start` builds the dashboard the first time, starts the backend and the dashboard, and opens **http://localhost:4100** in your browser. Close the terminal (or press Ctrl+C) to stop Market. Running `npm start` again while it's already running just opens the browser.

## First run

The app opens on **Setup** and walks you through three things:

1. **Apple USB driver.** If it's missing, the app links to the free **Apple Devices** app in the Microsoft Store (iTunes works too).
2. **Control app, installed with Sideloadly.** Each phone runs a small control app (WebDriverAgent, shown on the phone as "Market"). Install [Sideloadly](https://sideloadly.io) (it needs the website versions of iTunes and iCloud, not the Microsoft Store ones). Click **WDA.ipa** in Setup. In Sideloadly, pick the phone, type a **spare free Apple ID**, drag `WDA.ipa` onto the IPA icon and click **Start**. It takes about 2 minutes per phone. Turn on **automatic refresh** in Sideloadly's advanced options so it re-signs the phones by itself.
3. **Phones.** Plug each one in with a data cable and unlock it. The app then:
   - asks the phone to trust the PC (tap **Trust**)
   - notices the control app and shows the Developer Mode switch, then tells you to turn it on (one restart)
   - tells you to trust your Apple ID once in **Settings → General → VPN & Device Management**
   - mounts the developer image (installing the iOS 17+ helper itself if needed) and starts the live screen

Each step that needs you shows the exact steps on the phone's card. The app re-checks every few seconds, so it carries on as soon as you've done it.

**After setup, you only need to plug the phones in.** A free Apple ID signature lasts 7 days. Each phone shows a countdown ("expires in 3d") that turns amber in the last day and a half. With Sideloadly's automatic refresh on, it resets by itself. Otherwise reinstall `WDA.ipa` on that phone in Sideloadly. If one expires anyway, the card says so and the phone picks up again as soon as you re-sign it.

**Wi-Fi:** in **Setup → Phones**, set a phone to **USB + Wi-Fi** while it's plugged in. It then uses the cable when plugged in and Wi-Fi when not. Phones this PC already trusts that are on your Wi-Fi show under **Found on Wi-Fi**. A phone must be plugged in once to trust the PC (Apple's rule). The live view over Wi-Fi depends on the phone's signal: 5 GHz and the screen on work best.

Tips: on each phone, set **Auto-Lock → Never** and turn on **Do Not Disturb**. In **Setup → Options**, turn on **Start with Windows** to have Market start in the background when you sign in, so schedules keep running; open http://localhost:4100 to see it.

## Pages

| Page | What it's for |
|---|---|
| **Home** | Phones at a glance, what's running, the next scheduled run and recent activity. |
| **Phones** | Live screens. Click one to control it (click = tap, drag = swipe, hold = long-press, wheel = scroll, type, open apps, record a flow). Select several to act on all of them at once. |
| **Media** | Drop photos and videos from the PC into the library, pick phones and send. Each file lands in the phone's Photos app, ready to post. |
| **Automations** | Run scripts and flows on any phones, edit flows, and see the job history. |
| **Schedules** | Run an automation every day at set times. Each phone starts at its own random moment. |
| **Claude** | Connect Claude Desktop with one click, or copy the Claude Code command. A live feed shows everything Claude does. |
| **Setup** | Apple driver, Sideloadly and WDA.ipa, each phone's progress, and Start with Windows. |

## Sending media

On the **Media** page, drop videos or photos in, select them, pick phones and click **Send**. For each phone Market:

1. copies the files over USB into the control app's folder (on the phone: **Files → On My iPhone → Market**)
2. opens that folder in Files on the phone and uses **Share → Save Video / Save Image**, so the file lands in Photos

Step 2 needs the control app built with file sharing on. If you installed `WDA.ipa` before version 1.1, click **WDA.ipa** in Setup and reinstall it once with Sideloadly. If step 2 can't finish, the job says so and the file is still waiting in Files for you to save. Turn **Save to Photos** off to only copy files into Files.

## Claude

Claude gets these tools:

- **See and control:** `look` (screenshot plus the labelled buttons on screen and their positions), `tap` (by position or label), `swipe`, `type_text`, `press_button`, `open_app` / `close_app` / `list_apps`
- **Media:** `list_media`, `send_media`
- **Automations:** `list_automations`, `run_automation`, `list_jobs`, `stop_jobs`, `save_flow` / `get_flow`
- **Schedules:** `list_schedules`, `save_schedule`, `delete_schedule`

If Market isn't running, Claude starts it in the background. Phones Claude is touching are outlined in orange. Claude is told never to type passwords, payment details or 2FA codes.

Try: *"Look at all my phones and tell me what each is showing."* · *"Send clip1.mp4 to every phone."* · *"Build a flow that watches 15 Reels and likes about 1 in 8, and schedule it on all phones at 09:00, 14:00 and 21:00."*

## Automations

Your automations live in `%APPDATA%\Market\automations` (**Automations → Folder**). The examples are copied there on first run.

**Flows (`.json`), no code needed.** Record them on a phone, click **New flow**, or ask Claude. Coordinates are fractions of the screen (0–1), and taps and waits get random jitter automatically.

```json
{ "name": "TikTok quick scroll", "steps": [
  { "do": "launch", "bundleId": "com.zhiliaoapp.musically" },
  { "do": "waitRandom", "minMs": 3000, "maxMs": 6000 },
  { "do": "scroll", "direction": "up" },
  { "do": "doubletap", "x": 0.5, "y": 0.45, "chance": 0.2 },
  { "do": "tapText", "text": "Not now", "optional": true },
  { "do": "home" } ] }
```

Steps: `launch`, `terminate`, `tap`, `doubletap`, `longpress`, `swipe`, `scroll`, `tapText`, `waitForText`, `type`, `home`, `wait`, `waitRandom`, `log`. Add `"chance": 0.3` to any step to run it only some of the time.

**Scripts (`.js`), for logic.** See [`automations/warmup.js`](automations/warmup.js). `ctx` provides:

- **Apps:** `launch`, `terminate`, `home`, `openUrl`
- **Touch:** `tapPct`, `doubleTapPct`, `longPressPct`, `swipePct`, `scrollFeed`, plus `tap` / `longPress` / `swipe` in screen points
- **Reading the screen:** `tapText`, `tapTextIfPresent`, `hasText`, `waitForText`, `elements`
- **Typing:** `type`
- **Timing and randomness:** `sleep`, `sleepRandom`, `rand`, `chance`
- **Inspecting and logging:** `screenshot`, `log`

In busy video apps (TikTok, Reels) the screen is only read a few levels deep so taps stay fast, which means the like, comment, save and share buttons on a video aren't found by name. Tap them by position.

## Project layout

```
backend/            Phone engine (Node): go-ios, WebDriverAgent, setup, controls, media,
  src/              automations, scheduler, Wi-Fi (usbmux proxy), updates, local API on :4000
  src/py/           Python helpers (pymobiledevice3): media transfer, Wi-Fi switch
  mcp/              Claude's tools (MCP server)
  automations/      Example automations copied to the user's folder on first run
  config.json       Ports, WebDriverAgent and stream settings
frontend/           Dashboard: Next.js + HeroUI on :4100, /api proxied to the backend
  src/app/          Routes (/, /phones, /media, /automations, /schedules, /claude, /setup)
  src/views/        The pages
  src/components/   Shell, phone control, live screen, HeroUI wrappers
  src/lib/          API client, app state, icons
scripts/start.js    Starts both, opens the browser and applies updates
scripts/package.js  Builds the packaged app (the zip on AffRev)
.github/workflows/  Release: publishes a GitHub Release for each version tag
```

## How it works

```
Dashboard (Next.js) ── Backend ── go-ios ── USB / Wi-Fi ── iPhone ── WebDriverAgent
      │                                          ▲
Claude ┘ via backend/mcp/phones-mcp.js          Sideloadly installs it (free Apple ID)
```

These open-source tools do the heavy lifting:

- [go-ios](https://github.com/danielpaulus/go-ios) handles USB, the iOS 17+ tunnel, the developer image and starting WebDriverAgent.
- [WebDriverAgent](https://github.com/appium/WebDriverAgent) streams the screen and performs touches. The app downloads it from Appium's releases and packages `WDA.ipa` with file sharing switched on.
- [Sideloadly](https://sideloadly.io) (separate) signs `WDA.ipa` with your Apple ID, installs it and can refresh it automatically.
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) copies media to the phones and mounts the developer image on iOS 17+ when go-ios can't. The app installs it the first time it's needed.

Data lives in `%APPDATA%\Market`, moved over automatically from the old `Marketing Phones` folder: phone names, automations, schedules, job history, the media library, `WDA.ipa` and each phone's control-app countdown. The app never sees your Apple ID; only Sideloadly does.

## Development

```bash
npm install
npm run dev        # backend + dashboard with hot reload, opens the browser
npm start          # production: builds the dashboard if needed
npm run build      # rebuild the dashboard after changing frontend/
npm run typecheck  # TypeScript check of the dashboard
npm run backend    # backend only (API on :4000)
```

## Updates

Market checks for a new version every 5 minutes. When there's one, a banner shows at the top of every page: click **Update** and Market downloads it, reinstalls its packages, rebuilds the dashboard and restarts, and the page reloads by itself. Your phones, automations, schedules and media are in the data folder, so updates don't touch them. **Setup → Options** shows your version and has **Check for updates**.

Updating needs Market to have been started with `npm start` (or Start with Windows). If you installed with `git clone`, Market fast-forwards to the new release's tag, so keep your own changes on a separate branch.

### The packaged app (AffRev)

People who aren't developers get Market from **affrev.com/dashboard/market**: a zip with the built app, a copy of Node and no source code. They unzip it, double-click **Start Market**, and sign in with their AffRev account (free). The packaged app stays locked until someone signs in, and it gets its updates from AffRev instead of GitHub. Signed-in PCs are listed on that AffRev page, where each one can be signed out.

Every release builds that zip (`scripts/package.js`, on Windows) and uploads it to AffRev's private R2 bucket. That needs these secrets in the repo (**Settings → Secrets and variables → Actions**): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `MARKET_R2_BUCKET`. AffRev reads the same bucket through its `MARKET_R2_BUCKET` setting. Copies run from the source (`npm start`) don't need a sign-in; set `MARKET_REQUIRE_SIGNIN=1` to try the sign-in screen.

### Updates from a private repo

GitHub only shows a private repo's releases to someone with access, so each install needs a read-only token:

1. On GitHub, open **Settings → Developer settings → Fine-grained tokens → Generate new token**.
2. Set **Resource owner** to the organisation, **Repository access** to *Only select repositories* → this repo, and under **Permissions** give **Contents** *Read-only*. Nothing else.
3. Put it in `config.json` in Market's data folder (`%APPDATA%Market`, **Setup → Data folder**), creating the file if needed:

   ```json
   { "updateToken": "github_pat_…" }
   ```

Market picks it up at its next check (**Setup → Check for updates** to check now). The token can only read this repo's code, which the install already has. Don't commit it to the repo. If the organisation requires approval for fine-grained tokens, an owner approves it under **Organisation settings → Personal access tokens**. Tokens expire, so make a new one before the date you chose; Setup says when the token is refused.

### Publishing an update

Push to `main`. The Release workflow bumps the patch version (2.0.1 → 2.0.2), commits that back to `main` as "Release v2.0.2", tags it and publishes a GitHub Release with notes made from the commits. Every running Market shows it within about 5 minutes. Pushes that only change docs (`*.md`, LICENSE, NOTICE) or workflows don't make a release.

Because the workflow adds a commit to `main`, pull before you push again (GitHub Desktop asks you to fetch first).

For a minor or major version, bump it yourself, and the workflow releases that commit as it is:

```bash
npm version minor
git push --follow-tags
```

## License

Market is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Kyros Software Ltd.

You can use, change and share it, including commercially, as long as you keep the copyright notices and the [NOTICE](NOTICE) file and say what you changed. It comes with no warranty, and Kyros Software Ltd isn't liable for how it's used.

The name "Market" and its logo aren't covered by the license. If you publish a fork, give it a different name and logo, and don't present it as the official Market.

Market isn't affiliated with or endorsed by Apple. iPhone and iOS are trademarks of Apple Inc.
