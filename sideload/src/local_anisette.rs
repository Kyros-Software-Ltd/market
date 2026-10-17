//! Anisette from iCloud for Windows, the way AltServer signs in: market-anisette
//! (sideload/anisette, 32-bit like iCloud's AOSKit.dll) asks Apple's own code on this PC for the
//! machine ID and one-time password. Apple has been refusing many sign-ins that use the public
//! anisette servers since October 2026, but accepts these.
//!
//! The data really comes from iCloud for Windows, so the client is described as that (the same
//! description the anisette servers use), with a device ID kept per PC and the local user ID
//! derived from it, as AltServer does.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::prelude::*;
use isideload::{
    anisette::{AnisetteClientInfo, AnisetteData, AnisetteDataResponse, AnisetteProvider},
    auth::grandslam::GrandSlam,
};
use rootcause::{Report, prelude::*};

const CLIENT_INFO: &str =
    "<PC> <Windows;6.2(0,0);9200> <com.apple.AuthKit/1 (com.apple.iCloud/7.21)>";
const USER_AGENT: &str = "akd/1.0 CFNetwork/808.1.4";
const ROUTING_INFO: &str = "17106176";

pub struct LocalAnisette {
    exe: PathBuf,
    device_id: String,
}

impl LocalAnisette {
    /// The helper next to this program, or in a source checkout its own build output.
    pub fn find_helper() -> Option<PathBuf> {
        let me = std::env::current_exe().ok()?;
        let dir = me.parent()?;
        [
            dir.join("market-anisette.exe"),
            dir.join("../../anisette/target/i686-pc-windows-msvc/release/market-anisette.exe"),
        ]
        .into_iter()
        .find(|p| p.exists())
    }

    /// `data` keeps this PC's device ID, so Apple sees the same device every time.
    pub fn new(exe: PathBuf, data: &Path) -> Result<Self, Report> {
        let file = data.join("local-anisette-device-id");
        let device_id = match std::fs::read_to_string(&file) {
            Ok(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => {
                let id = uuid::Uuid::new_v4().to_string().to_uppercase();
                std::fs::create_dir_all(data).context("Failed to create the data folder")?;
                std::fs::write(&file, &id).context("Failed to save the device ID")?;
                id
            }
        };
        Ok(LocalAnisette { exe, device_id })
    }

    fn run_helper(&self) -> Result<(String, String), Report> {
        let out = std::process::Command::new(&self.exe)
            .output()
            .context("Failed to run market-anisette")?;
        let line = String::from_utf8_lossy(&out.stdout);
        let json: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| {
            report!(
                "market-anisette printed something unexpected: {}",
                line.trim()
            )
        })?;
        if let Some(error) = json.get("error").and_then(|e| e.as_str()) {
            bail!("{error}");
        }
        let field = |k: &str| json.get(k).and_then(|v| v.as_str()).map(str::to_string);
        match (field("machineId"), field("otp")) {
            (Some(machine_id), Some(otp)) => Ok((machine_id, otp)),
            _ => bail!("market-anisette returned no headers"),
        }
    }
}

#[async_trait::async_trait]
impl AnisetteProvider for LocalAnisette {
    async fn get_anisette_data(&self) -> Result<AnisetteDataResponse, Report> {
        let (machine_id, otp) = self.run_helper()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let extra = vec![
            (
                "X-Apple-I-MD-LU".to_string(),
                BASE64_STANDARD.encode(&self.device_id),
            ),
            ("X-Apple-I-MD-RINFO".to_string(), ROUTING_INFO.to_string()),
            ("X-Apple-I-Client-Time".to_string(), iso8601(now)),
            ("X-Apple-Locale".to_string(), "en_US".to_string()),
            ("X-Apple-I-TimeZone".to_string(), "UTC".to_string()),
        ];
        Ok(AnisetteDataResponse::Data(AnisetteData::new(
            machine_id,
            otp,
            self.device_id.clone(),
            CLIENT_INFO.to_string(),
            extra,
        )))
    }

    async fn get_client_info(&self) -> Result<AnisetteClientInfo, Report> {
        Ok(AnisetteClientInfo {
            client_info: CLIENT_INFO.to_string(),
            user_agent: USER_AGENT.to_string(),
        })
    }

    async fn provision(&mut self, _gs: &Arc<GrandSlam>, _force_reset: bool) -> Result<(), Report> {
        Ok(()) // iCloud provisions this PC itself
    }
}

/// Seconds since 1970 as 2026-10-17T12:00:00Z, without pulling in a date library.
fn iso8601(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
