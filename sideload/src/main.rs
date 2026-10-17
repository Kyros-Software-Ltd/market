//! market-sideload: signs WDA.ipa with a free Apple ID and installs it on an iPhone, so Market
//! doesn't need Sideloadly. Built on isideload. Market (backend/src/sideload.js) runs it once per
//! install and talks to it in JSON lines:
//!   stdin   {"password": "..."}                   first line; "" uses the password saved with --remember
//!           {"twoFactor": <TwoFactorCallbackResponse>}   each answer to a 2FA prompt
//!   stdout  {"event":"status","text":...}  {"event":"twoFactor","params":...}  {"event":"progress","percent":...}
//!           {"event":"done","bundleId":...}  {"event":"error","message":...}
//! Logs go to stderr.
//!
//!   market-sideload login   --apple-id <email> --data <dir> [--anisette <url>] [--remember]
//!   market-sideload install --apple-id <email> --data <dir> --ipa <file> --udid <udid> [--anisette <url>] [--remember]
//!   market-sideload forget  --apple-id <email>
//!   market-sideload inspect --ipa <file>           shows the bundle IDs after the PlugIns fix (no Apple sign-in)
//!
//! Sign-in uses anisette from iCloud for Windows (local_anisette.rs, via the 32-bit market-anisette
//! helper next to this program) when it's there, otherwise the anisette server; --anisette-source
//! server forces the server.
//!
//! The phone is reached through usbmuxd at USBMUXD_SOCKET_ADDRESS (Market's proxy). The anisette
//! state and the signing certificate are kept in --data; the password, when remembered, in the
//! Windows Credential Manager.

mod local_anisette;

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use idevice::usbmuxd::UsbmuxdAddr;
use isideload::{
    anisette::{
        AnisetteClientInfo, AnisetteDataResponse, AnisetteProvider,
        remote_v3::RemoteV3AnisetteProvider,
    },
    auth::{
        apple_account::{AppleAccount, TwoFactorCallbackParams, TwoFactorCallbackResponse},
        grandslam::GrandSlam,
    },
    dev::developer_session::DeveloperSession,
    sideload::{SideloaderBuilder, TeamSelection, builder::MaxCertsBehavior},
    util::{callbacks::MaxCertsCallbackBox, fs_storage::FsStorage},
};
use local_anisette::LocalAnisette;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::{Mutex, mpsc},
};

const KEYRING_SERVICE: &str = "Market Apple ID";

/// The public anisette servers compute their data with Apple's Android code (from Apple Music for
/// Android) but describe the client as a Mac. Since Apple's October 2026 checks that mismatch gets
/// sign-ins refused ("This action cannot be completed at this time", -80045), so describe the client
/// as the Android device it really is. Opt-in with --client-info android: so far Apple answers that
/// with 503 too, so the default keeps the server's own description.
struct AndroidClientInfo(RemoteV3AnisetteProvider);

#[async_trait::async_trait]
impl AnisetteProvider for AndroidClientInfo {
    async fn get_anisette_data(&self) -> Result<AnisetteDataResponse, rootcause::Report> {
        self.0.get_anisette_data().await
    }

    async fn resync(&self, sim: &str) -> Result<AnisetteDataResponse, rootcause::Report> {
        self.0.resync(sim).await
    }

    async fn get_client_info(&self) -> Result<AnisetteClientInfo, rootcause::Report> {
        Ok(AnisetteClientInfo {
            client_info:
                "<Pixel 7> <Android;14;UQ1A.240205.002> <com.apple.AuthKit/1 (com.apple.akd/1.0)>"
                    .to_string(),
            user_agent: "akd/1.0 CFNetwork/808.1.4".to_string(),
        })
    }

    async fn provision(
        &mut self,
        gs: &Arc<GrandSlam>,
        force_reset: bool,
    ) -> Result<(), rootcause::Report> {
        self.0.provision(gs, force_reset).await
    }
}

fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn status(text: &str) {
    emit(json!({ "event": "status", "text": text }));
}

/// isideload's errors are trees of "● cause" lines with source paths; keep the deepest cause, which
/// is the one that says what went wrong (e.g. Apple's "Your account information was entered incorrectly").
fn readable(message: &str) -> String {
    let causes: Vec<&str> = message
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix('●'))
        .map(str::trim)
        .collect();
    let Some(deepest) = causes.last() else {
        return message.trim().to_string();
    };
    let deepest = deepest
        .strip_prefix("Auth error ")
        .map_or(*deepest, |rest| {
            rest.split_once(": ").map_or(rest, |(_, m)| m)
        });
    match message
        .lines()
        .next()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('●'))
    {
        Some(lead) => format!("{}: {deepest}", lead.trim_end_matches(':')),
        None => deepest.to_string(),
    }
}

fn fail(message: impl std::fmt::Display) -> ! {
    emit(json!({ "event": "error", "message": readable(&message.to_string()) }));
    std::process::exit(1);
}

fn parse_args() -> (String, HashMap<String, String>) {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let mut flags = HashMap::new();
    let mut key: Option<String> = None;
    for arg in args {
        if let Some(name) = arg.strip_prefix("--") {
            if let Some(k) = key.replace(name.to_string()) {
                flags.insert(k, String::new()); // a flag without a value
            }
        } else if let Some(k) = key.take() {
            flags.insert(k, arg);
        }
    }
    if let Some(k) = key {
        flags.insert(k, String::new());
    }
    (command, flags)
}

/// Unpacks the IPA and returns its .app folder.
fn unpack(ipa: &Path, into: &Path) -> Result<PathBuf, String> {
    let file =
        std::fs::File::open(ipa).map_err(|e| format!("Can't open {}: {e}", ipa.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("{} isn't an IPA: {e}", ipa.display()))?;
    let _ = std::fs::remove_dir_all(into);
    zip.extract(into)
        .map_err(|e| format!("Can't unpack the IPA: {e}"))?;
    std::fs::read_dir(into.join("Payload"))
        .map_err(|_| "The IPA has no Payload folder".to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "app"))
        .ok_or_else(|| "The IPA has no app inside".to_string())
}

fn bundle_id(info: &Path) -> Result<(plist::Dictionary, String), String> {
    let dict = plist::Value::from_file(info)
        .map_err(|e| format!("Can't read {}: {e}", info.display()))?
        .into_dictionary()
        .ok_or("Info.plist isn't a dictionary")?;
    let id = dict
        .get("CFBundleIdentifier")
        .and_then(|v| v.as_string())
        .unwrap_or("")
        .to_string();
    Ok((dict, id))
}

/// isideload needs every bundle in PlugIns to be named under the app's own ID. WebDriverAgent's
/// test bundle (com.facebook.WebDriverAgentRunner) isn't, so rename it under the runner's ID.
fn fix_plugin_ids(app: &Path) -> Result<(), String> {
    let (_, main_id) = bundle_id(&app.join("Info.plist"))?;
    let Ok(plugins) = std::fs::read_dir(app.join("PlugIns")) else {
        return Ok(());
    };
    for plugin in plugins.filter_map(Result::ok).map(|e| e.path()) {
        let info = plugin.join("Info.plist");
        if !info.exists() {
            continue;
        }
        let (mut dict, id) = bundle_id(&info)?;
        if id.starts_with(&format!("{main_id}.")) {
            continue;
        }
        let suffix = plugin
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("plugin");
        dict.insert(
            "CFBundleIdentifier".into(),
            format!("{main_id}.{suffix}").into(),
        );
        plist::Value::Dictionary(dict)
            .to_file_xml(&info)
            .map_err(|e| format!("Can't write {}: {e}", info.display()))?;
    }
    Ok(())
}

fn need(flags: &HashMap<String, String>, key: &str) -> String {
    flags
        .get(key)
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| fail(format!("--{key} is required")))
}

/// Signs in to Apple (asking Market for 2FA codes when Apple wants one) and opens the developer account.
async fn sign_in(flags: &HashMap<String, String>) -> DeveloperSession {
    let apple_id = need(flags, "apple-id");
    let data = PathBuf::from(need(flags, "data"));
    let remember = flags.contains_key("remember");

    // Everything Market sends on stdin goes through this channel: the password, then 2FA answers.
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(v);
            }
        }
    });
    let rx = Arc::new(Mutex::new(rx));

    let first = rx.lock().await.recv().await.unwrap_or(Value::Null);
    let keyring = keyring::Entry::new(KEYRING_SERVICE, &apple_id).unwrap_or_else(|e| fail(e));
    let password = match first
        .get("password")
        .and_then(|p| p.as_str())
        .filter(|p| !p.is_empty())
    {
        Some(p) => p.to_string(),
        None => keyring.get_password().unwrap_or_else(|_| {
            fail("No saved password for this Apple ID. Sign in again in Setup.")
        }),
    };

    let mut anisette = RemoteV3AnisetteProvider::default()
        .unwrap_or_else(|e| fail(e))
        .set_storage(Box::new(FsStorage::new(data.join("anisette"))));
    if let Some(url) = flags.get("anisette").filter(|u| !u.is_empty()) {
        anisette = anisette.set_url(url);
    }
    let android = flags.get("client-info").is_some_and(|v| v == "android");
    if android {
        // Apple's provisioning service still wants the server's own (Mac) description, so set up
        // this PC's anisette identity with that first; only the sign-in uses the Android one.
        status("Preparing the sign-in…");
        let info = anisette.get_client_info().await.unwrap_or_else(|e| fail(e));
        let gs = GrandSlam::new(info, false, None)
            .await
            .unwrap_or_else(|e| fail(e));
        anisette
            .provision(&Arc::new(gs), false)
            .await
            .unwrap_or_else(|e| fail(format!("Couldn't set up the sign-in: {e}")));
    }

    status("Signing in to Apple…");
    let two_factor = {
        let rx = rx.clone();
        move |params: TwoFactorCallbackParams| {
            let rx = rx.clone();
            async move {
                emit(json!({ "event": "twoFactor", "params": params }));
                let answer = rx.lock().await.recv().await.unwrap_or(Value::Null);
                let response = answer
                    .get("twoFactor")
                    .cloned()
                    .and_then(|v| serde_json::from_value::<TwoFactorCallbackResponse>(v).ok())
                    .unwrap_or(TwoFactorCallbackResponse::Abort);
                Ok(response)
            }
        }
    };
    // Anisette from iCloud for Windows when it's installed (what Apple currently accepts), unless
    // --anisette-source server asks for the anisette server instead.
    let local = flags
        .get("anisette-source")
        .is_none_or(|v| v != "server")
        .then(LocalAnisette::find_helper)
        .flatten();
    let builder = AppleAccount::builder(&apple_id);
    let builder = if let Some(exe) = local {
        status("Signing in to Apple (with iCloud for Windows)…");
        builder.anisette_provider(LocalAnisette::new(exe, &data).unwrap_or_else(|e| fail(e)))
    } else if android {
        builder.anisette_provider(AndroidClientInfo(anisette))
    } else {
        builder.anisette_provider(anisette)
    };
    let mut account: AppleAccount = builder
        .login(&password, two_factor)
        .await
        .unwrap_or_else(|e| fail(format!("Apple sign-in failed: {e}")));
    if remember && let Err(e) = keyring.set_password(&password) {
        eprintln!("Couldn't save the password: {e}");
    }

    DeveloperSession::from_account(&mut account)
        .await
        .unwrap_or_else(|e| fail(format!("Couldn't open the developer account: {e}")))
}

async fn install(flags: HashMap<String, String>) {
    let apple_id = need(&flags, "apple-id");
    let ipa = PathBuf::from(need(&flags, "ipa"));
    let udid = need(&flags, "udid");
    let data = PathBuf::from(need(&flags, "data"));
    let session = sign_in(&flags).await;

    status("Preparing the app…");
    let work = std::env::temp_dir().join(format!("market-sideload-{}", std::process::id()));
    let app = unpack(&ipa, &work).unwrap_or_else(|e| fail(e));
    fix_plugin_ids(&app).unwrap_or_else(|e| fail(e));
    let (_, main_id) = bundle_id(&app.join("Info.plist")).unwrap_or_else(|e| fail(e));

    status("Connecting to the phone…");
    let addr = UsbmuxdAddr::from_env_var()
        .unwrap_or_else(|e| fail(format!("Bad USBMUXD_SOCKET_ADDRESS: {e}")));
    let mut mux = addr
        .connect(0)
        .await
        .unwrap_or_else(|e| fail(format!("Can't reach the phone service: {e}")));
    let device = mux
        .get_devices()
        .await
        .unwrap_or_else(|e| fail(e))
        .into_iter()
        .find(|d| d.udid == udid)
        .unwrap_or_else(|| fail("The phone isn't connected. Plug it in and unlock it."));
    let provider = device.to_provider(addr, "market-sideload");

    let mut sideloader = SideloaderBuilder::new(session, apple_id.clone())
        .team_selection(TeamSelection::First)
        // A free account has a couple of signing certificates; replace an old one when they're used up.
        .max_certs_behavior(MaxCertsBehavior::<MaxCertsCallbackBox>::Revoke)
        .storage(Box::new(FsStorage::new(data.join("certs"))))
        .machine_name("Market".to_string())
        .build();

    status("Signing and installing…");
    let progress = |p: f32| {
        emit(json!({ "event": "progress", "percent": (p * 100.0).round() }));
        std::future::ready(())
    };
    sideloader
        .install_app(&provider, app, false, Some(progress), None)
        .await
        .unwrap_or_else(|e| fail(format!("Install failed: {e}")));
    let _ = std::fs::remove_dir_all(&work);

    let team = sideloader.get_team().await.unwrap_or_else(|e| fail(e));
    emit(
        json!({ "event": "done", "bundleId": format!("{main_id}.{}", team.team_id), "teamId": team.team_id }),
    );
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = isideload::init();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let (command, flags) = parse_args();
    match command.as_str() {
        "login" => {
            sign_in(&flags).await;
            emit(json!({ "event": "done" }));
        }
        "install" => install(flags).await,
        "inspect" => {
            let work = std::env::temp_dir().join(format!("market-sideload-{}", std::process::id()));
            let app =
                unpack(&PathBuf::from(need(&flags, "ipa")), &work).unwrap_or_else(|e| fail(e));
            fix_plugin_ids(&app).unwrap_or_else(|e| fail(e));
            let mut ids = vec![
                bundle_id(&app.join("Info.plist"))
                    .unwrap_or_else(|e| fail(e))
                    .1,
            ];
            for plugin in std::fs::read_dir(app.join("PlugIns"))
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
            {
                if let Ok((_, id)) = bundle_id(&plugin.path().join("Info.plist")) {
                    ids.push(id);
                }
            }
            let _ = std::fs::remove_dir_all(&work);
            emit(json!({ "event": "done", "bundleIds": ids }));
        }
        "forget" => {
            let apple_id = flags
                .get("apple-id")
                .cloned()
                .unwrap_or_else(|| fail("--apple-id is required"));
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &apple_id) {
                let _ = entry.delete_credential();
            }
            emit(json!({ "event": "done" }));
        }
        _ => fail("Usage: market-sideload login|install|forget --apple-id <email> ..."),
    }
}
