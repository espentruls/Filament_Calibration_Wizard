//! Slicer profile integration — native side.
//!
//! Narrowly-scoped commands for detecting supported slicers, scanning their
//! filament presets read-only, and installing generated presets with backup,
//! atomic writes, verification, and rollback. All paths are validated in
//! `security`; the frontend can never write arbitrary files.
//!
//! Verified slicer data (folder names, executables, process names) comes from
//! docs/SLICER_PROFILE_RESEARCH.md. Do not add entries without verification.

pub mod backup;
pub mod discovery;
pub mod filesystem;
pub mod install;
pub mod processes;
pub mod security;

/// Static, verified detection data for ONE INSTALL FLAVOUR of a slicer.
///
/// A slicer FAMILY (`id`, e.g. "bambu") can be installed in several flavours —
/// release, beta, nightly, a rebranded fork — each with its own data directory.
/// `variant_id` names the flavour; `id` stays the family key.
///
/// A row may only be added after the data directory, the config file name, the
/// executable path and the process image name have been read off a real
/// installation, with the date recorded in docs/SLICER_PROFILE_RESEARCH.md.
/// A flavour that shares its executable with a sibling must never be admitted
/// on executable presence alone — see `discovery::detect_in_root`.
pub struct SlicerVariant {
    /// Unique flavour key, e.g. "bambu-beta". Used only to resolve paths.
    pub variant_id: &'static str,
    /// FAMILY key — the preset-format / adapter key shared by every flavour.
    ///
    /// This is what crosses the wire as `slicer_id` and what the TypeScript
    /// `IntegrationSlicerId` union contains. Never make it flavour-specific:
    /// the frontend compares it to string literals in the Bambu
    /// extruder-variant legend guards (the per-nozzle slot invariant), and a
    /// new id would make every one of those comparisons silently false.
    pub id: &'static str,
    /// Flavour-specific display name, e.g. "Bambu Studio (Beta)".
    pub display_name: &'static str,
    /// Folder under %APPDATA% (Windows) / ~/Library/Application Support (macOS).
    pub data_dir_name: &'static str,
    /// Config file NAME inside the data directory. NOT derivable from
    /// `data_dir_name`: Bambu Studio Beta keeps `BambuStudio.conf` inside
    /// `BambuStudioBeta\` (read off a real install 2026-08-01). Deriving it
    /// would leave the config unread, which makes the active preset folder
    /// fall back to "default" and targets the wrong account directory.
    pub conf_file_name: &'static str,
    /// Executable candidates relative to the program-files root (Windows).
    pub windows_exe_candidates: &'static [&'static str],
    /// App bundle candidates under /Applications (macOS).
    pub macos_app_candidates: &'static [&'static str],
    /// Process image names for running-detection (case-insensitive).
    pub process_names: &'static [&'static str],
    /// The flavour used when nothing narrows the family down.
    pub is_default: bool,
}

/// Kept as an alias so the two names read the same in older call sites.
pub type SlicerDescriptor = SlicerVariant;

pub const SLICER_VARIANTS: &[SlicerVariant] = &[
    SlicerVariant {
        variant_id: "orca",
        id: "orca",
        display_name: "Orca Slicer",
        data_dir_name: "OrcaSlicer",
        conf_file_name: "OrcaSlicer.conf",
        windows_exe_candidates: &["OrcaSlicer\\orca-slicer.exe"],
        macos_app_candidates: &["OrcaSlicer.app"],
        process_names: &["orca-slicer.exe", "OrcaSlicer"],
        is_default: true,
    },
    SlicerVariant {
        variant_id: "bambu",
        id: "bambu",
        display_name: "Bambu Studio",
        data_dir_name: "BambuStudio",
        conf_file_name: "BambuStudio.conf",
        windows_exe_candidates: &["Bambu Studio\\bambu-studio.exe"],
        macos_app_candidates: &["BambuStudio.app"],
        process_names: &["bambu-studio.exe", "BambuStudio"],
        is_default: true,
    },
    // Bambu Studio Beta. Verified 2026-08-01 by read-only inspection of a real
    // install: data dir %APPDATA%\BambuStudioBeta, config BambuStudio.conf
    // (app.version 02.08.01.55, app.preset_folder 1234567890,
    // app.sync_user_preset True), executable C:\Program Files\Bambu
    // Studio\bambu-studio.exe with FileVersion 02.08.01.55 and image name
    // bambu-studio.exe — i.e. the Beta REPLACED the release binary in the same
    // folder and shares both the path and the process name. The exe is
    // therefore useless as a flavour discriminator; only the data directory
    // distinguishes the two.
    //
    // The shared process name means the running-slicer refusal already covers
    // this flavour, and refusing on any match is the conservative answer while
    // one binary serves both.
    SlicerVariant {
        variant_id: "bambu-beta",
        id: "bambu",
        display_name: "Bambu Studio (Beta)",
        data_dir_name: "BambuStudioBeta",
        conf_file_name: "BambuStudio.conf",
        windows_exe_candidates: &["Bambu Studio\\bambu-studio.exe"],
        // UNVERIFIED on macOS — no macOS machine was available to read the
        // Beta's Application Support folder or bundle name. Left empty rather
        // than guessed; detection there falls back to the data directory.
        macos_app_candidates: &[],
        process_names: &["bambu-studio.exe", "BambuStudio"],
        is_default: false,
    },
    SlicerVariant {
        variant_id: "snapmaker-orca",
        id: "snapmaker-orca",
        display_name: "Snapmaker Orca",
        data_dir_name: "Snapmaker_Orca",
        conf_file_name: "Snapmaker_Orca.conf",
        windows_exe_candidates: &["Snapmaker_Orca\\snapmaker-orca.exe"],
        macos_app_candidates: &["Snapmaker Orca.app", "Snapmaker_Orca.app"],
        process_names: &["snapmaker-orca.exe", "Snapmaker Orca"],
        is_default: true,
    },
    SlicerVariant {
        variant_id: "elegoo",
        id: "elegoo",
        display_name: "ElegooSlicer",
        data_dir_name: "ElegooSlicer",
        conf_file_name: "ElegooSlicer.conf",
        windows_exe_candidates: &["ElegooSlicer\\elegoo-slicer.exe"],
        macos_app_candidates: &["ElegooSlicer.app"],
        process_names: &["elegoo-slicer.exe", "ElegooSlicer"],
        is_default: true,
    },
    SlicerVariant {
        variant_id: "flash-studio",
        id: "flash-studio",
        display_name: "Flash Studio (Orca-Flashforge)",
        data_dir_name: "Orca-Flashforge",
        conf_file_name: "Orca-Flashforge.conf",
        windows_exe_candidates: &[
            "Flashforge\\Orca-Flashforge\\flash studio.exe",
            "Flashforge\\Orca-Flashforge\\Orca-Flashforge.exe",
        ],
        macos_app_candidates: &["Orca-Flashforge.app", "Flash Studio.app"],
        process_names: &["flash studio.exe", "Orca-Flashforge.exe", "Orca-Flashforge"],
        is_default: true,
    },
];

/// Every install flavour of one slicer family, in registry order.
pub fn variants_for(slicer_id: &str) -> Vec<&'static SlicerVariant> {
    SLICER_VARIANTS.iter().filter(|v| v.id == slicer_id).collect()
}

/// Family ids in registry order, each listed once.
pub fn slicer_families() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for v in SLICER_VARIANTS {
        if !out.contains(&v.id) {
            out.push(v.id);
        }
    }
    out
}

pub fn variant(variant_id: &str) -> Result<&'static SlicerVariant, String> {
    SLICER_VARIANTS
        .iter()
        .find(|v| v.variant_id == variant_id)
        .ok_or_else(|| format!("Unknown slicer variant id: {variant_id}"))
}

/// The flavour used when the caller names only the family.
pub fn default_variant_for(slicer_id: &str) -> Result<&'static SlicerVariant, String> {
    let vs = variants_for(slicer_id);
    vs.iter()
        .find(|v| v.is_default)
        .or_else(|| vs.first())
        .copied()
        .ok_or_else(|| format!("Unknown slicer id: {slicer_id}"))
}

/// Family-level descriptor (the default flavour). Callers that need a specific
/// install flavour must go through `discovery`, which resolves by data
/// directory rather than guessing.
pub fn descriptor(slicer_id: &str) -> Result<&'static SlicerVariant, String> {
    default_variant_for(slicer_id)
}

/// Resolve a flavour from a family id plus an optional flavour id. A flavour id
/// that belongs to a different family is rejected rather than followed — it
/// would point the write at another slicer's directory.
pub fn resolve_variant(
    slicer_id: &str,
    variant_id: Option<&str>,
) -> Result<&'static SlicerVariant, String> {
    match variant_id.filter(|s| !s.is_empty()) {
        None => default_variant_for(slicer_id),
        Some(vid) => {
            let v = variant(vid)?;
            if v.id != slicer_id {
                return Err(format!(
                    "Slicer variant {vid} belongs to {}, not {slicer_id}",
                    v.id
                ));
            }
            Ok(v)
        }
    }
}

/// Process image names for EVERY flavour of a family, de-duplicated.
///
/// Running-detection is family-wide on purpose: the flavours of one family can
/// share a binary (Bambu Studio and its Beta do), and a preset write must be
/// refused while any of them is open.
pub fn family_process_names(slicer_id: &str) -> Result<Vec<&'static str>, String> {
    let vs = variants_for(slicer_id);
    if vs.is_empty() {
        return Err(format!("Unknown slicer id: {slicer_id}"));
    }
    let mut out: Vec<&'static str> = Vec::new();
    for v in vs {
        for n in v.process_names {
            if !out.contains(n) {
                out.push(n);
            }
        }
    }
    Ok(out)
}

/// Format a unix timestamp (seconds) as an ISO-8601 UTC string without
/// pulling in a date crate. Standard civil-from-days algorithm.
pub fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
