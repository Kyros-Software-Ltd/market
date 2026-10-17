//! market-anisette: asks iCloud for Windows for Apple's anisette headers (machine ID and one-time
//! password), the way AltServer does. Since October 2026 Apple refuses many sign-ins
//! that use the public anisette servers, but accepts these, made by Apple's own code on this PC.
//!
//! iCloud's AOSKit.dll is 32-bit only, so this is a separate 32-bit program
//! (cargo build --release --target i686-pc-windows-msvc). market-sideload runs it whenever it needs
//! fresh headers. It prints one JSON line: {"machineId": "...", "otp": "..."} or {"error": "..."}.
//!
//! It loads objc.dll and Foundation.dll from "Apple Application Support" and AOSKit.dll from
//! "Internet Services" (both under Common Files\Apple, installed with iTunes and iCloud from
//! apple.com), then calls [AOSUtilities retrieveOTPHeadersForDSID:@"-2"].

use std::{
    ffi::{CStr, CString, OsStr, c_char, c_void},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};

type Id = *mut c_void;
type Sel = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn SetCurrentDirectoryW(path: *const u16) -> i32;
    fn SetDllDirectoryW(path: *const u16) -> i32;
    fn GetLastError() -> u32;
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

fn fail(message: &str) -> ! {
    println!("{{\"error\":{}}}", json_string(message));
    std::process::exit(1);
}

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn apple_folder() -> PathBuf {
    if let Some(dir) = std::env::args().nth(1) {
        return PathBuf::from(dir); // market-anisette <Apple folder>, for unusual installs
    }
    let common = std::env::var_os("CommonProgramFiles(x86)")
        .or_else(|| std::env::var_os("CommonProgramFiles"))
        .unwrap_or_else(|| r"C:\Program Files (x86)\Common Files".into());
    Path::new(&common).join("Apple")
}

unsafe fn load(path: &Path) -> *mut c_void {
    let module = unsafe { LoadLibraryW(wide(path.as_os_str()).as_ptr()) };
    if module.is_null() {
        let code = unsafe { GetLastError() };
        fail(&format!("Couldn't load {} (Windows error {code}). Reinstall iCloud from apple.com.", path.display()));
    }
    module
}

fn main() {
    let apple = apple_folder();
    let support = apple.join("Apple Application Support");
    let services = apple.join("Internet Services");
    for (path, what) in [
        (support.join("objc.dll"), "iTunes or iCloud"),
        (support.join("Foundation.dll"), "iTunes or iCloud"),
        (services.join("AOSKit.dll"), "iCloud"),
    ] {
        if !path.exists() {
            fail(&format!("{} is missing. Install {what} from apple.com (not the Microsoft Store version).", path.display()));
        }
    }

    unsafe {
        // Apple's DLLs load each other by name from these folders.
        let mut search = std::env::var_os("PATH").unwrap_or_default();
        search = [support.as_os_str(), services.as_os_str(), &search].join(OsStr::new(";"));
        std::env::set_var("PATH", &search);
        SetDllDirectoryW(wide(support.as_os_str()).as_ptr());
        SetCurrentDirectoryW(wide(support.as_os_str()).as_ptr());

        let objc = load(&support.join("objc.dll"));
        load(&support.join("Foundation.dll"));
        load(&services.join("AOSKit.dll"));

        let symbol = |name: &str| {
            let c = CString::new(name).unwrap();
            let f = GetProcAddress(objc, c.as_ptr());
            if f.is_null() {
                fail(&format!("objc.dll has no {name}; reinstall iCloud from apple.com."));
            }
            f
        };
        let get_class: extern "C" fn(*const c_char) -> Id = std::mem::transmute(symbol("objc_getClass"));
        let sel: extern "C" fn(*const c_char) -> Sel = std::mem::transmute(symbol("sel_registerName"));
        let msg_send = symbol("objc_msgSend");
        let send_id: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(msg_send);
        let send_cstr: extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute(msg_send);
        let send_utf8: extern "C" fn(Id, Sel) -> *const c_char = std::mem::transmute(msg_send);

        let cstr = |s: &str| CString::new(s).unwrap();
        let ns_string_class = get_class(cstr("NSString").as_ptr());
        let make = |s: &str| send_cstr(ns_string_class, sel(cstr("stringWithUTF8String:").as_ptr()), cstr(s).as_ptr());
        let text = |obj: Id| -> String {
            if obj.is_null() {
                return String::new();
            }
            let description = send_id(obj, sel(cstr("description").as_ptr()), std::ptr::null_mut());
            let p = send_utf8(description, sel(cstr("UTF8String").as_ptr()));
            if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
        };

        let utilities = get_class(cstr("AOSUtilities").as_ptr());
        if utilities.is_null() {
            fail("AOSKit.dll has no AOSUtilities; this iCloud version isn't supported.");
        }
        let headers = send_id(utilities, sel(cstr("retrieveOTPHeadersForDSID:").as_ptr()), make("-2"));
        if headers.is_null() {
            fail("iCloud returned no anisette headers.");
        }
        let object_for_key = sel(cstr("objectForKey:").as_ptr());
        let machine_id = text(send_id(headers, object_for_key, make("X-Apple-MD-M")));
        let otp = text(send_id(headers, object_for_key, make("X-Apple-MD")));
        if machine_id.is_empty() || otp.is_empty() {
            fail("iCloud returned empty anisette headers.");
        }
        println!("{{\"machineId\":{},\"otp\":{}}}", json_string(&machine_id), json_string(&otp));
    }
}
