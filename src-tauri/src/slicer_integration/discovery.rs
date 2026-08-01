//! Read-only detection of installed slicers: install flavours (release, beta),
//! data directories, versions, active preset folder, user-data locations, and
//! executables.
//!
//! A slicer FAMILY (`slicer_id`, e.g. "bambu") can be installed in several
//! FLAVOURS (`variant_id`, e.g. "bambu" and "bambu-beta"), each with its own
//! data directory. Every flavour that is present is reported separately and
//! nothing here silently picks one: writing a calibrated preset into an install
//! the user is not running is the same class of error as writing it to the
//! wrong nozzle.
//!
//! Detection is split so it can be tested: `detect_in_root` takes the data root
//! and the program roots, and the Tauri command is a thin wrapper that supplies
//! the real ones. Tests build synthetic trees under the OS temp directory and
//! never read or write a real slicer configuration.

use super::{security, SlicerVariant, SLICER_VARIANTS};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct RawUserDataLocation {
    pub account_id: String,
    pub path: String,
    pub active: bool,
    pub filament_profile_count: usize,
}

#[derive(Serialize, Clone)]
pub struct RawDetectedSlicer {
    /// Family key — unchanged wire meaning ("bambu" for release AND beta).
    pub slicer_id: String,
    /// Install flavour key, e.g. "bambu-beta". Address writes with this.
    pub variant_id: String,
    /// Flavour display name, e.g. "Bambu Studio (Beta)".
    pub variant_label: String,
    pub is_default_variant: bool,
    pub data_dir: Option<String>,
    pub conf_version: Option<String>,
    /// Last-write time of this flavour's config file (unix seconds). The only
    /// dependency-free signal for which install the user actually runs.
    pub conf_modified_at: Option<u64>,
    pub preset_folder: Option<String>,
    /// `app.sync_user_preset` from the config — preset cloud sync is on.
    pub sync_user_preset: Option<bool>,
    /// Flavour label of a sibling install whose config was written more
    /// recently. Set means: this is probably not the install being used.
    pub superseded_by: Option<String>,
    pub executable_path: Option<String>,
    pub user_locations: Vec<RawUserDataLocation>,
    pub notes: Vec<String>,
}

struct ConfInfo {
    version: Option<String>,
    preset_folder: Option<String>,
    sync_user_preset: Option<bool>,
    modified_at: Option<u64>,
    /// False when the config could not be read or parsed — the active preset
    /// folder is then UNKNOWN and must not fall back to "default".
    readable: bool,
    notes: Vec<String>,
}

/// `sync_user_preset` is stored as the string "True"/"False" in a real Bambu
/// Studio config; accept a JSON bool too rather than assume.
fn as_bool(v: &serde_json::Value) -> Option<bool> {
    if let Some(b) = v.as_bool() {
        return Some(b);
    }
    match v.as_str()?.to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// Parse a slicer config (JSON followed by a `# MD5 checksum` line) and extract
/// `app.version`, `app.preset_folder` and `app.sync_user_preset`.
///
/// The file NAME comes from the variant, never from the directory name: Bambu
/// Studio Beta stores `BambuStudio.conf` inside `BambuStudioBeta\`. Strictly
/// read-only.
fn read_conf(data_dir: &Path, conf_file_name: &str) -> ConfInfo {
    let mut notes = Vec::new();
    let conf_path = data_dir.join(conf_file_name);
    let modified_at = std::fs::metadata(&conf_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let raw = match std::fs::read_to_string(&conf_path) {
        Ok(r) => r,
        Err(_) => {
            notes.push(format!("Config file not readable: {}", conf_path.display()));
            return ConfInfo {
                version: None,
                preset_folder: None,
                sync_user_preset: None,
                modified_at,
                readable: false,
                notes,
            };
        }
    };
    let body = raw.split("# MD5 checksum").next().unwrap_or("");
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => {
            let app = &v["app"];
            ConfInfo {
                version: app["version"].as_str().map(|s| s.to_string()),
                preset_folder: app["preset_folder"].as_str().map(|s| s.to_string()),
                sync_user_preset: as_bool(&app["sync_user_preset"]),
                modified_at,
                readable: true,
                notes,
            }
        }
        Err(e) => {
            notes.push(format!("Config parse failed: {e}"));
            ConfInfo {
                version: None,
                preset_folder: None,
                sync_user_preset: None,
                modified_at,
                readable: false,
                notes,
            }
        }
    }
}

fn count_filament_presets(user_dir: &Path) -> usize {
    let filament = user_dir.join("filament");
    match std::fs::read_dir(&filament) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| {
                e.path().is_file()
                    && e.file_name()
                        .to_str()
                        .map(|n| n.to_ascii_lowercase().ends_with(".json"))
                        .unwrap_or(false)
            })
            .count(),
        Err(_) => 0,
    }
}

/// List the preset-shaped account directories under `user/` and mark the one
/// the config names as active.
///
/// No location is marked active when the config could not be read, or when it
/// names a preset folder that is not there. The previous silent fallback to
/// "default" is what turns a config-read failure into a write aimed at an empty
/// folder that the running slicer never reads.
fn find_user_locations(
    data_dir: &Path,
    conf: &ConfInfo,
    notes: &mut Vec<String>,
) -> Vec<RawUserDataLocation> {
    let user_root = data_dir.join("user");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&user_root) else {
        return out;
    };
    // A config that was read but leaves `preset_folder` empty means the local,
    // non-cloud folder — verified on a real signed-out Bambu Studio install.
    let active_id: Option<String> = if !conf.readable {
        None
    } else {
        match conf.preset_folder.as_deref() {
            None => None,
            Some("") => Some("default".to_string()),
            Some(id) => Some(id.to_string()),
        }
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Some(name) = p.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        // Only preset-shaped account dirs (they contain a filament/ or machine/ dir).
        if !p.join("filament").is_dir() && !p.join("machine").is_dir() {
            continue;
        }
        out.push(RawUserDataLocation {
            active: active_id.as_deref() == Some(name.as_str()),
            filament_profile_count: count_filament_presets(&p),
            path: p.display().to_string(),
            account_id: name,
        });
    }
    match &active_id {
        None => {
            if !out.is_empty() {
                notes.push(
                    "This install's config could not be read, so there is no way to tell which preset folder it uses. None is marked active — pick the folder you actually use."
                        .into(),
                );
            }
        }
        Some(id) => {
            if !out.iter().any(|l| l.active) && !out.is_empty() {
                notes.push(format!(
                    "The config names preset folder “{id}”, but no preset directory with that name was found here. No location is marked active — pick the folder you actually use."
                ));
            }
        }
    }
    // Active first, then by profile count.
    out.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then(b.filament_profile_count.cmp(&a.filament_profile_count))
    });
    out
}

fn find_executable(program_roots: &[PathBuf], v: &SlicerVariant) -> Option<PathBuf> {
    let _ = v; // each cfg branch uses one candidate list
    for root in program_roots {
        #[cfg(target_os = "windows")]
        for cand in v.windows_exe_candidates {
            let p = root.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
        #[cfg(target_os = "macos")]
        for cand in v.macos_app_candidates {
            let p = root.join(cand);
            if p.exists() {
                return Some(p);
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = &root;
        }
    }
    None
}

fn build_row(
    data_root: &Path,
    program_roots: &[PathBuf],
    v: &'static SlicerVariant,
) -> RawDetectedSlicer {
    let data_dir = data_root.join(v.data_dir_name);
    let conf = read_conf(&data_dir, v.conf_file_name);
    let mut notes = conf.notes.clone();
    let user_locations = find_user_locations(&data_dir, &conf, &mut notes);
    RawDetectedSlicer {
        slicer_id: v.id.to_string(),
        variant_id: v.variant_id.to_string(),
        variant_label: v.display_name.to_string(),
        is_default_variant: v.is_default,
        data_dir: Some(data_dir.display().to_string()),
        conf_version: conf.version,
        conf_modified_at: conf.modified_at,
        preset_folder: conf.preset_folder,
        sync_user_preset: conf.sync_user_preset,
        superseded_by: None,
        executable_path: find_executable(program_roots, v).map(|p| p.display().to_string()),
        user_locations,
        notes,
    }
}

/// Detect every installed slicer flavour under an explicit data root.
///
/// Two rules keep this honest:
///
/// 1. A flavour is reported because its DATA DIRECTORY exists. An
///    executable-only entry is emitted at most once per family, for the default
///    flavour, and only when no flavour of that family has a data directory.
///    Bambu Studio and its Beta share one binary at one path, so admitting a
///    flavour on executable presence would conjure a phantom install of
///    whichever one is not actually there.
/// 2. When a family has more than one flavour installed, the rows are ordered
///    by config write time (most recently used first) and the older ones carry
///    a note naming the newer sibling. Nothing is hidden — genuine side-by-side
///    setups stay visible — but the default pick is the install being used.
pub fn detect_in_root(data_root: &Path, program_roots: &[PathBuf]) -> Vec<RawDetectedSlicer> {
    let mut result = Vec::new();
    for family in super::slicer_families() {
        let variants: Vec<&'static SlicerVariant> = SLICER_VARIANTS
            .iter()
            .filter(|v| v.id == family)
            .collect();
        let present: Vec<&'static SlicerVariant> = variants
            .iter()
            .copied()
            .filter(|v| data_root.join(v.data_dir_name).is_dir())
            .collect();

        if present.is_empty() {
            // Executable but no data directory: one entry for the family.
            let default = variants
                .iter()
                .copied()
                .find(|v| v.is_default)
                .or_else(|| variants.first().copied());
            let Some(v) = default else { continue };
            let Some(exe) = find_executable(program_roots, v) else {
                continue;
            };
            result.push(RawDetectedSlicer {
                slicer_id: v.id.to_string(),
                variant_id: v.variant_id.to_string(),
                variant_label: v.display_name.to_string(),
                is_default_variant: v.is_default,
                data_dir: None,
                conf_version: None,
                conf_modified_at: None,
                preset_folder: None,
                sync_user_preset: None,
                superseded_by: None,
                executable_path: Some(exe.display().to_string()),
                user_locations: Vec::new(),
                notes: vec![
                    "Data directory not found; the slicer may never have been started.".into(),
                ],
            });
            continue;
        }

        let mut rows: Vec<RawDetectedSlicer> = present
            .iter()
            .map(|v| build_row(data_root, program_roots, v))
            .collect();
        // Most recently used first. Rows with no readable config sort last —
        // an unknown timestamp is not evidence of recency.
        rows.sort_by(|a, b| b.conf_modified_at.cmp(&a.conf_modified_at));
        if rows.len() > 1 {
            let newest_label = rows[0].variant_label.clone();
            let newest_at = rows[0].conf_modified_at;
            for row in rows.iter_mut().skip(1) {
                if newest_at.is_none() || row.conf_modified_at >= newest_at {
                    continue; // no evidence either way; do not claim one
                }
                let when = newest_at
                    .map(|t| super::iso_from_unix(t)[..10].to_string())
                    .unwrap_or_else(|| "a later date".into());
                row.superseded_by = Some(newest_label.clone());
                row.notes.push(format!(
                    "{newest_label} was used more recently ({when}). A preset written into this folder will not appear in that install."
                ));
            }
        }
        result.extend(rows);
    }
    result
}

#[tauri::command]
pub fn detect_supported_slicers() -> Result<Vec<RawDetectedSlicer>, String> {
    let data_root = security::platform_data_root()?;
    Ok(detect_in_root(&data_root, &security::program_roots()))
}

// ---------------------------------------------------------------------------
// Path resolution — every write destination in the app resolves through here.
// ---------------------------------------------------------------------------

/// The data directory of one install flavour.
pub fn variant_data_dir(variant: &SlicerVariant) -> Result<PathBuf, String> {
    Ok(security::platform_data_root()?.join(variant.data_dir_name))
}

/// True when `path` lives inside `root`. Walks up to the nearest existing
/// ancestor first, so a destination that does not exist yet still resolves.
fn contains_path(root: &Path, path: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }
    let mut probe = path;
    loop {
        if probe.exists() {
            break;
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => return false,
        }
    }
    security::ensure_under(root, probe).is_ok()
}

/// The data directory of the install flavour that owns `path`.
///
/// Used where a path is already fixed — a backup manifest's original files, a
/// resolved preset directory — and the allowed root has to match the flavour it
/// came from rather than the family default. Resolving it to the default
/// flavour instead is what makes a rollback into a beta install get rejected as
/// an escape from the release directory.
pub fn variant_root_for_path(slicer_id: &str, path: &Path) -> Result<PathBuf, String> {
    let data_root = security::platform_data_root()?;
    for v in super::variants_for(slicer_id) {
        let root = data_root.join(v.data_dir_name);
        if contains_path(&root, path) {
            return Ok(root);
        }
    }
    Err(format!(
        "{} is not inside any known {slicer_id} data directory",
        path.display()
    ))
}

/// Resolve `<data>/user/<account_id>/<leaf>` for a slicer family.
///
/// With a flavour id the answer is exact. Without one, the family's flavours
/// are searched and the directory is returned ONLY when exactly one flavour has
/// it. Two flavours both holding an account of the same name (both Bambu
/// Studio installs have a `default`) is ambiguous, and guessing there would
/// write a calibrated preset into an install the user never chose — so it is
/// refused, with both candidates named.
fn resolve_user_leaf(
    slicer_id: &str,
    variant_id: Option<&str>,
    account_id: &str,
    leaf: &str,
) -> Result<PathBuf, String> {
    security::validate_component(account_id)?;
    let data_root = security::platform_data_root()?;

    if let Some(vid) = variant_id.filter(|s| !s.is_empty()) {
        let v = super::resolve_variant(slicer_id, Some(vid))?;
        let root = data_root.join(v.data_dir_name);
        let dir = root.join("user").join(account_id).join(leaf);
        if !dir.is_dir() {
            return Err(format!("USER_DATA_NOT_FOUND: {}", dir.display()));
        }
        security::ensure_under(&root, &dir)?;
        return Ok(dir);
    }

    let mut matches: Vec<(&'static SlicerVariant, PathBuf, PathBuf)> = Vec::new();
    for v in super::variants_for(slicer_id) {
        let root = data_root.join(v.data_dir_name);
        let dir = root.join("user").join(account_id).join(leaf);
        if dir.is_dir() {
            matches.push((v, root, dir));
        }
    }
    match matches.len() {
        0 => {
            let v = super::default_variant_for(slicer_id)?;
            Err(format!(
                "USER_DATA_NOT_FOUND: {}",
                data_root
                    .join(v.data_dir_name)
                    .join("user")
                    .join(account_id)
                    .join(leaf)
                    .display()
            ))
        }
        1 => {
            let (_, root, dir) = &matches[0];
            security::ensure_under(root, dir)?;
            Ok(dir.clone())
        }
        _ => {
            let listed = matches
                .iter()
                .map(|(v, _, d)| format!("{} ({})", d.display(), v.display_name))
                .collect::<Vec<_>>()
                .join("; ");
            Err(format!(
                "AMBIGUOUS_INSTALL: more than one {slicer_id} install has a “{account_id}” preset folder — {listed}. Choose the install explicitly — this is not guessed."
            ))
        }
    }
}

/// Resolve and validate the filament directory for a slicer family, an optional
/// install flavour, and an account id.
pub fn filament_dir(
    slicer_id: &str,
    variant_id: Option<&str>,
    account_id: &str,
) -> Result<PathBuf, String> {
    resolve_user_leaf(slicer_id, variant_id, account_id, "filament")
}

/// Resolve and validate an account's whole user preset directory (filament,
/// machine and process presets) for a library snapshot.
pub fn user_dir(
    slicer_id: &str,
    variant_id: Option<&str>,
    account_id: &str,
) -> Result<PathBuf, String> {
    security::validate_component(account_id)?;
    let data_root = security::platform_data_root()?;

    if let Some(vid) = variant_id.filter(|s| !s.is_empty()) {
        let v = super::resolve_variant(slicer_id, Some(vid))?;
        let root = data_root.join(v.data_dir_name);
        let dir = root.join("user").join(account_id);
        if !dir.is_dir() {
            return Err(format!("USER_DATA_NOT_FOUND: {}", dir.display()));
        }
        security::ensure_under(&root, &dir)?;
        return Ok(dir);
    }

    let mut matches: Vec<(&'static SlicerVariant, PathBuf, PathBuf)> = Vec::new();
    for v in super::variants_for(slicer_id) {
        let root = data_root.join(v.data_dir_name);
        let dir = root.join("user").join(account_id);
        if dir.is_dir() {
            matches.push((v, root, dir));
        }
    }
    match matches.len() {
        0 => {
            let v = super::default_variant_for(slicer_id)?;
            Err(format!(
                "USER_DATA_NOT_FOUND: {}",
                data_root
                    .join(v.data_dir_name)
                    .join("user")
                    .join(account_id)
                    .display()
            ))
        }
        1 => {
            let (_, root, dir) = &matches[0];
            security::ensure_under(root, dir)?;
            Ok(dir.clone())
        }
        _ => {
            let listed = matches
                .iter()
                .map(|(v, _, d)| format!("{} ({})", d.display(), v.display_name))
                .collect::<Vec<_>>()
                .join("; ");
            Err(format!(
                "AMBIGUOUS_INSTALL: more than one {slicer_id} install has a “{account_id}” preset folder — {listed}. Choose the install explicitly — this is not guessed."
            ))
        }
    }
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub platform: String,
    pub os_version: String,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    PlatformInfo {
        platform: platform.to_string(),
        os_version: std::env::consts::OS.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests — synthetic trees under the OS temp directory only. The shapes below
// mirror what was read (read-only) off a real machine on 2026-08-01: a stale
// Bambu Studio release directory (config version 02.07.01.62, empty
// preset_folder, empty user/default) beside a live Bambu Studio Beta directory
// (BambuStudio.conf inside BambuStudioBeta\, version 02.08.01.55,
// preset_folder 2572316032, sync_user_preset True).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir();
            let dir = base.join(format!(
                "trim-discovery-{tag}-{}-{}",
                std::process::id(),
                super::super::now_unix()
            ));
            // Never let a test be handed a root outside the temp directory.
            assert!(
                dir.starts_with(&base),
                "test root must live under the OS temp directory"
            );
            std::fs::create_dir_all(&dir).unwrap();
            TempRoot(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_conf(data_dir: &Path, file_name: &str, body: &str) {
        std::fs::create_dir_all(data_dir).unwrap();
        std::fs::write(
            data_dir.join(file_name),
            format!("{body}\n# MD5 checksum 0\n"),
        )
        .unwrap();
    }

    fn make_account(data_dir: &Path, account: &str, filament_presets: usize) {
        let f = data_dir.join("user").join(account).join("filament");
        std::fs::create_dir_all(&f).unwrap();
        for i in 0..filament_presets {
            std::fs::write(f.join(format!("preset-{i}.json")), "{}").unwrap();
        }
    }

    /// Release: stale, signed out, empty local folder.
    fn make_release(root: &Path) -> PathBuf {
        let dir = root.join("BambuStudio");
        write_conf(
            &dir,
            "BambuStudio.conf",
            r#"{"app":{"version":"02.07.01.62","preset_folder":"","sync_user_preset":"False"}}"#,
        );
        make_account(&dir, "default", 0);
        dir
    }

    /// Beta: live, signed in, config named BambuStudio.conf inside BambuStudioBeta\.
    fn make_beta(root: &Path) -> PathBuf {
        let dir = root.join("BambuStudioBeta");
        write_conf(
            &dir,
            "BambuStudio.conf",
            r#"{"app":{"version":"02.08.01.55","preset_folder":"2572316032","sync_user_preset":"True"}}"#,
        );
        make_account(&dir, "2572316032", 3);
        make_account(&dir, "default", 0);
        dir
    }

    fn bambu_rows(rows: &[RawDetectedSlicer]) -> Vec<&RawDetectedSlicer> {
        rows.iter().filter(|r| r.slicer_id == "bambu").collect()
    }

    #[test]
    fn reports_both_bambu_flavours_with_the_family_id_unchanged() {
        let t = TempRoot::new("both");
        make_release(t.path());
        make_beta(t.path());
        let rows = detect_in_root(t.path(), &[]);
        let bambu = bambu_rows(&rows);
        assert_eq!(bambu.len(), 2, "both flavours must be reported");
        // The family key never becomes flavour-specific: the frontend compares
        // it to the literal "bambu" in the per-nozzle slot guards.
        for r in &bambu {
            assert_eq!(r.slicer_id, "bambu");
        }
        let ids: Vec<&str> = bambu.iter().map(|r| r.variant_id.as_str()).collect();
        assert!(ids.contains(&"bambu"));
        assert!(ids.contains(&"bambu-beta"));
    }

    #[test]
    fn beta_config_is_read_from_bambustudio_conf_inside_bambustudiobeta() {
        // This is the assertion that fails if the config file name is ever
        // derived from the data directory name again.
        let t = TempRoot::new("confname");
        make_beta(t.path());
        let rows = detect_in_root(t.path(), &[]);
        let beta = rows
            .iter()
            .find(|r| r.variant_id == "bambu-beta")
            .expect("beta must be detected");
        assert_eq!(beta.conf_version.as_deref(), Some("02.08.01.55"));
        assert_eq!(beta.preset_folder.as_deref(), Some("2572316032"));
        assert_eq!(beta.sync_user_preset, Some(true));
    }

    #[test]
    fn beta_active_location_is_the_account_folder_not_default() {
        let t = TempRoot::new("account");
        make_beta(t.path());
        let rows = detect_in_root(t.path(), &[]);
        let beta = rows.iter().find(|r| r.variant_id == "bambu-beta").unwrap();
        let active: Vec<&RawUserDataLocation> =
            beta.user_locations.iter().filter(|l| l.active).collect();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].account_id, "2572316032");
        assert_eq!(active[0].filament_profile_count, 3);
        // …and the empty local folder is offered but never marked active.
        let default = beta
            .user_locations
            .iter()
            .find(|l| l.account_id == "default")
            .unwrap();
        assert!(!default.active);
        assert_eq!(default.filament_profile_count, 0);
    }

    #[test]
    fn release_active_location_is_default_when_preset_folder_is_empty() {
        let t = TempRoot::new("release");
        make_release(t.path());
        let rows = detect_in_root(t.path(), &[]);
        let rel = rows.iter().find(|r| r.variant_id == "bambu").unwrap();
        assert_eq!(rel.conf_version.as_deref(), Some("02.07.01.62"));
        assert_eq!(rel.sync_user_preset, Some(false));
        let active = rel.user_locations.iter().find(|l| l.active).unwrap();
        assert_eq!(active.account_id, "default");
        assert_eq!(active.filament_profile_count, 0);
    }

    #[test]
    fn the_more_recently_used_install_is_listed_first_and_the_other_is_flagged() {
        let t = TempRoot::new("recency");
        let release = make_release(t.path());
        make_beta(t.path());
        // The 14-day gap observed on the machine this was written against
        // (release config last written 2026-07-18, beta config 2026-08-01).
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(14 * 86_400);
        set_mtime(&release.join("BambuStudio.conf"), older);
        let rows = detect_in_root(t.path(), &[]);
        let bambu = bambu_rows(&rows);
        assert_eq!(bambu[0].variant_id, "bambu-beta", "newest config first");
        assert_eq!(bambu[1].variant_id, "bambu");
        assert_eq!(
            bambu[1].superseded_by.as_deref(),
            Some("Bambu Studio (Beta)")
        );
        assert!(bambu[1]
            .notes
            .iter()
            .any(|n| n.contains("will not appear in that install")));
        // The install that IS being used carries no such warning.
        assert!(bambu[0].superseded_by.is_none());
        // Neither is hidden — a genuine side-by-side setup stays selectable.
        assert_eq!(bambu.len(), 2);
    }

    /// Set a file's modification time without pulling in a date crate.
    fn set_mtime(path: &Path, when: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }

    #[test]
    fn a_shared_executable_never_conjures_a_second_install() {
        // Bambu Studio and its Beta list the same executable path. With only
        // the release data directory present exactly one install may appear.
        let t = TempRoot::new("sharedexe");
        make_release(t.path());
        let programs = t.path().join("Programs");
        std::fs::create_dir_all(programs.join("Bambu Studio")).unwrap();
        std::fs::write(programs.join("Bambu Studio").join("bambu-studio.exe"), b"x").unwrap();
        let rows = detect_in_root(t.path(), std::slice::from_ref(&programs));
        assert_eq!(bambu_rows(&rows).len(), 1);
        assert_eq!(bambu_rows(&rows)[0].variant_id, "bambu");
    }

    #[test]
    fn an_executable_with_no_data_directory_reports_one_default_flavour() {
        let t = TempRoot::new("exeonly");
        let programs = t.path().join("Programs");
        std::fs::create_dir_all(programs.join("Bambu Studio")).unwrap();
        std::fs::write(programs.join("Bambu Studio").join("bambu-studio.exe"), b"x").unwrap();
        let rows = detect_in_root(t.path(), std::slice::from_ref(&programs));
        let bambu = bambu_rows(&rows);
        // On platforms where executable probing is not implemented there is
        // nothing to report; where it is, it must be exactly one entry.
        if cfg!(any(target_os = "windows", target_os = "macos")) && !bambu.is_empty() {
            assert_eq!(bambu.len(), 1);
            assert!(bambu[0].is_default_variant);
            assert!(bambu[0].data_dir.is_none());
            assert!(bambu[0]
                .notes
                .iter()
                .any(|n| n.contains("Data directory not found")));
        }
    }

    #[test]
    fn a_missing_preset_folder_leaves_nothing_active_and_says_so() {
        let t = TempRoot::new("missingfolder");
        let dir = t.path().join("BambuStudio");
        write_conf(
            &dir,
            "BambuStudio.conf",
            r#"{"app":{"version":"02.07.01.62","preset_folder":"9999999999","sync_user_preset":"True"}}"#,
        );
        make_account(&dir, "default", 2);
        let rows = detect_in_root(t.path(), &[]);
        let rel = rows.iter().find(|r| r.variant_id == "bambu").unwrap();
        assert!(
            rel.user_locations.iter().all(|l| !l.active),
            "no location may be guessed active"
        );
        assert!(rel.notes.iter().any(|n| n.contains("9999999999")));
    }

    #[test]
    fn an_unreadable_config_does_not_fall_back_to_default() {
        let t = TempRoot::new("noconf");
        let dir = t.path().join("BambuStudio");
        make_account(&dir, "default", 1);
        make_account(&dir, "1234", 5);
        let rows = detect_in_root(t.path(), &[]);
        let rel = rows.iter().find(|r| r.variant_id == "bambu").unwrap();
        assert!(rel.conf_version.is_none());
        assert!(rel.user_locations.iter().all(|l| !l.active));
        assert!(rel
            .notes
            .iter()
            .any(|n| n.contains("config could not be read")));
    }

    #[test]
    fn other_families_are_unaffected_by_the_variant_split() {
        let t = TempRoot::new("orca");
        let dir = t.path().join("OrcaSlicer");
        write_conf(
            &dir,
            "OrcaSlicer.conf",
            r#"{"app":{"version":"2.4.2","preset_folder":"default"}}"#,
        );
        make_account(&dir, "default", 4);
        let rows = detect_in_root(t.path(), &[]);
        let orca: Vec<&RawDetectedSlicer> =
            rows.iter().filter(|r| r.slicer_id == "orca").collect();
        assert_eq!(orca.len(), 1);
        assert_eq!(orca[0].variant_id, "orca");
        assert!(orca[0].is_default_variant);
        assert!(orca[0].superseded_by.is_none());
        assert!(orca[0].user_locations.iter().any(|l| l.active));
    }

    #[test]
    fn every_family_has_exactly_one_default_flavour() {
        for family in super::super::slicer_families() {
            let defaults = super::super::variants_for(family)
                .iter()
                .filter(|v| v.is_default)
                .count();
            assert_eq!(defaults, 1, "family {family} must have one default flavour");
        }
    }

    #[test]
    fn flavour_ids_are_unique_and_resolve_to_their_own_family() {
        let mut seen: Vec<&str> = Vec::new();
        for v in SLICER_VARIANTS {
            assert!(!seen.contains(&v.variant_id), "duplicate {}", v.variant_id);
            seen.push(v.variant_id);
            assert_eq!(super::super::variant(v.variant_id).unwrap().id, v.id);
            assert_eq!(
                super::super::resolve_variant(v.id, Some(v.variant_id))
                    .unwrap()
                    .variant_id,
                v.variant_id
            );
        }
        // A flavour of another family is rejected, not followed.
        assert!(super::super::resolve_variant("orca", Some("bambu-beta")).is_err());
    }

    #[test]
    fn running_detection_covers_every_flavour_of_a_family() {
        let names = super::super::family_process_names("bambu").unwrap();
        // Verified 2026-08-01: the Beta replaced the release binary in the same
        // folder and runs under the same image name.
        assert!(names.contains(&"bambu-studio.exe"));
        for v in super::super::variants_for("bambu") {
            for n in v.process_names {
                assert!(names.contains(n), "{n} missing from the family union");
            }
        }
    }
}

#[cfg(test)]
mod manual_probe {
    // One-off supervised probe (cargo test -- --ignored). Read-only.
    #[test]
    #[ignore]
    fn probe_real_detection() {
        let out = super::detect_supported_slicers().unwrap();
        for s in &out {
            println!(
                "{} [{}] | v={:?} | conf_mtime={:?} | exe={:?} | preset_folder={:?} | sync={:?} | superseded_by={:?}",
                s.slicer_id,
                s.variant_id,
                s.conf_version,
                s.conf_modified_at,
                s.executable_path.is_some(),
                s.preset_folder,
                s.sync_user_preset,
                s.superseded_by
            );
            for l in &s.user_locations {
                println!(
                    "   loc {} active={} presets={}",
                    l.account_id, l.active, l.filament_profile_count
                );
            }
            for n in &s.notes {
                println!("   note: {n}");
            }
        }
        assert!(!out.is_empty());
    }

    /// Scan through the flavour resolution against whatever install this
    /// machine has. Read-only. Env: PROBE_SLICER, PROBE_ACCOUNT, PROBE_VARIANT
    /// (optional). Defaults to the elegoo/default pair used when this probe was
    /// written.
    #[test]
    #[ignore]
    fn probe_real_scan() {
        let slicer = std::env::var("PROBE_SLICER").unwrap_or_else(|_| "elegoo".into());
        let account = std::env::var("PROBE_ACCOUNT").unwrap_or_else(|_| "default".into());
        let variant = std::env::var("PROBE_VARIANT").ok();
        let files = crate::slicer_integration::filesystem::scan_slicer_profiles(
            slicer.clone(),
            account.clone(),
            variant.clone(),
        )
        .unwrap();
        let user = files.iter().filter(|f| f.dir_kind == "user").count();
        let base = files.iter().filter(|f| f.dir_kind == "user_base").count();
        let system = files.iter().filter(|f| f.dir_kind == "system").count();
        let manifests: Vec<&str> = files
            .iter()
            .filter(|f| f.dir_kind == "vendor_manifest")
            .map(|f| f.path.as_str())
            .collect();
        println!(
            "{slicer} [{variant:?}] {account} scan: user={user} base={base} system={system} manifests={manifests:?}"
        );
        assert!(user > 0);
    }
}
