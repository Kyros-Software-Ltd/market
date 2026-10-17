# Vendored crates

`isideload/` is isideload 0.4.6 by Nicholas Sharp (MIT License, https://github.com/nab138/isideload),
copied from crates.io with one change in `src/anisette/mod.rs` and `src/anisette/remote_v3/mod.rs`:
`AnisetteData::new` and extra headers, so anisette from iCloud for Windows (`../src/local_anisette.rs`)
can be used. `Cargo.toml` points at it with `[patch.crates-io]`; drop the patch once isideload offers
a way to supply anisette data from outside.

A second change in `src/sideload/bundle.rs`: only `.appex` PlugIns are treated as app extensions
(own app ID and profile). Other PlugIns, like WebDriverAgent's `.xctest`, are signed like frameworks
and keep their bundle IDs; otherwise the phone refuses to load the test bundle (XCTest error 103).
