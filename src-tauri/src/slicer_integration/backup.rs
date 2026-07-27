//! Timestamped, checksummed backups of slicer files before installation,
//! with verified restore. Backups live in PerfectFit's own app-data folder:
//!
//! {app_data}/slicer-backups/{slicer-id}/{backup-id}/
//!     manifest.json
//!     files/0.json, 1.info, …
//!
//! Restore only ever writes back to the exact original paths recorded in the
//! manifest, re-validated against the slicer data roots at restore time.

use super::{iso_from_unix, now_unix, security};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    pub original_path: String,
    pub backup_path: Option<String>,
    pub checksum_sha256: Option<String>,
    pub existed_before: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBackupManifest {
    pub backup_id: String,
    pub slicer_id: String,
    pub slicer_version: Option<String>,
    pub created_at: String,
    pub installed_profile_name: String,
    pub perfect_fit_project_id: String,
    pub files: Vec<BackupFileEntry>,
    pub backup_root: String,
}

#[derive(Serialize)]
pub struct RawBackupSummary {
    pub backup_id: String,
    pub slicer_id: String,
    pub created_at: String,
    pub installed_profile_name: String,
    pub perfectfit_project_id: String,
    pub file_count: usize,
    pub backup_root: String,
}

pub fn backups_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?
        .join("slicer-backups");
    Ok(dir)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Read failed {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(format!("{:x}", h.finalize()))
}

// ---------------------------------------------------------------------------
// Durability barriers. Backup and install both depend on "the copy that
// survives a crash", so the barriers live next to the backup code whose whole
// job is to guarantee one.
// ---------------------------------------------------------------------------

/// Flush a file's bytes to stable storage. Opened for write because Windows
/// only honours FlushFileBuffers on a handle with write access.
pub fn sync_file(path: &Path) -> Result<(), String> {
    let f = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("Cannot open {} to flush it: {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("Flush to disk failed for {}: {e}", path.display()))
}

/// Copy a file and flush the copy to stable storage before returning, through
/// a handle this process created — so the flush can never be refused because
/// the source file happens to be read-only, and the copy's bytes are on disk
/// rather than merely in the page cache when this returns.
pub fn copy_durable(src: &Path, dest: &Path) -> Result<(), String> {
    let mut input =
        std::fs::File::open(src).map_err(|e| format!("Read failed {}: {e}", src.display()))?;
    let mut output =
        std::fs::File::create(dest).map_err(|e| format!("Write failed {}: {e}", dest.display()))?;
    std::io::copy(&mut input, &mut output)
        .map_err(|e| format!("Copy {} to {} failed: {e}", src.display(), dest.display()))?;
    output
        .sync_all()
        .map_err(|e| format!("Flush to disk failed for {}: {e}", dest.display()))
}

/// Flush a directory's own entries (create/rename/unlink) to stable storage.
///
/// Unix: opening the directory and `fsync`-ing it is the documented way to
/// make a directory entry durable. Windows: there is no user-mode equivalent
/// (a directory handle cannot even be obtained through `std::fs::File`), and
/// NTFS records directory-entry changes in its metadata journal, which it
/// commits in order — so on that platform the guarantee rests on the file-data
/// flushes plus that journal, and this call is a deliberate no-op.
pub fn sync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let d = std::fs::File::open(dir)
            .map_err(|e| format!("Cannot open {} to flush it: {e}", dir.display()))?;
        d.sync_all()
            .map_err(|e| format!("Flush to disk failed for {}: {e}", dir.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// How many ids are tried before a backup gives up claiming a directory.
const MAX_BACKUP_ID_ATTEMPTS: u32 = 512;

/// Claim a backup directory that no other backup can be using, and return its
/// id and path.
///
/// The directory — not the clock — is the uniqueness gate: `create_dir` fails
/// with `AlreadyExists` when the path is taken, so two backups made inside the
/// same second, or by two processes at once, can never land on the same id and
/// overwrite each other's contents. (`create_dir_all` would silently succeed
/// on an existing directory, which is exactly how a backup used to eat the
/// previous one.) The loop is bounded so a permanently blocked directory
/// reports an error instead of spinning.
fn claim_backup_dir(slicer_root: &Path, now: u64) -> Result<(String, PathBuf), String> {
    std::fs::create_dir_all(slicer_root)
        .map_err(|e| format!("Cannot create backup dir {}: {e}", slicer_root.display()))?;
    let pid = std::process::id();
    for attempt in 0..MAX_BACKUP_ID_ATTEMPTS {
        let backup_id = if attempt == 0 {
            format!("{now}-{pid}")
        } else {
            format!("{now}-{pid}-{attempt}")
        };
        let root = slicer_root.join(&backup_id);
        match std::fs::create_dir(&root) {
            Ok(()) => return Ok((backup_id, root)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot create backup dir {}: {e}", root.display())),
        }
    }
    Err(format!(
        "Cannot claim a unique backup directory under {} after {MAX_BACKUP_ID_ATTEMPTS} attempts — nothing was backed up.",
        slicer_root.display()
    ))
}

/// Create and verify a backup covering `paths` (files that are about to be
/// created or replaced). Files that do not exist yet are recorded with
/// `existed_before: false` so restore knows to delete them.
/// `all_backups_root` is injected so integration tests can use a temp dir.
pub fn create_backup(
    all_backups_root: &Path,
    slicer_id: &str,
    slicer_version: Option<String>,
    profile_name: &str,
    project_id: &str,
    paths: &[PathBuf],
) -> Result<ProfileBackupManifest, String> {
    let now = now_unix();
    let (backup_id, root) = claim_backup_dir(&all_backups_root.join(slicer_id), now)?;
    let files_dir = root.join("files");
    std::fs::create_dir(&files_dir).map_err(|e| format!("Cannot create backup dir: {e}"))?;

    let mut entries = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        if p.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_ascii_lowercase();
            let dest = files_dir.join(format!("{i}.{ext}"));
            // The install that follows destroys the original, so the copy has
            // to be on stable storage — not just in the page cache — before
            // this function reports success.
            copy_durable(p, &dest)
                .map_err(|e| format!("Backup copy failed for {}: {e}", p.display()))?;
            let src_sum = sha256_file(p)?;
            let dest_sum = sha256_file(&dest)?;
            if src_sum != dest_sum {
                return Err(format!("Backup verification failed for {}", p.display()));
            }
            entries.push(BackupFileEntry {
                original_path: p.display().to_string(),
                backup_path: Some(dest.display().to_string()),
                checksum_sha256: Some(src_sum),
                existed_before: true,
            });
        } else {
            entries.push(BackupFileEntry {
                original_path: p.display().to_string(),
                backup_path: None,
                checksum_sha256: None,
                existed_before: false,
            });
        }
    }

    let manifest = ProfileBackupManifest {
        backup_id: backup_id.clone(),
        slicer_id: slicer_id.to_string(),
        slicer_version,
        created_at: iso_from_unix(now),
        installed_profile_name: profile_name.to_string(),
        perfect_fit_project_id: project_id.to_string(),
        files: entries,
        backup_root: root.display().to_string(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Manifest serialize failed: {e}"))?;
    let manifest_path = root.join("manifest.json");
    std::fs::write(&manifest_path, &manifest_json)
        .map_err(|e| format!("Manifest write failed: {e}"))?;
    // Copies first, then the index that points at them, then the directory
    // entries: a crash can therefore leave copies without a manifest (an
    // ignored, incomplete backup) but never a manifest promising copies that
    // are not there.
    sync_file(&manifest_path)?;
    sync_dir(&files_dir)?;
    sync_dir(&root)?;
    // Verify the manifest is readable back.
    let reread = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Manifest re-read failed: {e}"))?;
    serde_json::from_str::<ProfileBackupManifest>(&reread)
        .map_err(|e| format!("Manifest re-parse failed: {e}"))?;
    Ok(manifest)
}

/// Subdirectories of a user account dir that hold user-editable presets.
const PRESET_LIBRARY_DIRS: &[&str] = &["filament", "machine", "process"];

/// Largest file included in a library snapshot (a preset is a few KB).
const MAX_SNAPSHOT_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Hard cap so a misconfigured directory can never balloon a snapshot.
const MAX_SNAPSHOT_FILES: usize = 5000;

/// Collect every preset file (.json/.info) directly inside the account's
/// filament/, machine/ and process/ dirs. Non-recursive: base/ caches and
/// other subdirectories are slicer-managed, not user-edited.
pub fn user_preset_files(user_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for sub in PRESET_LIBRARY_DIRS {
        let dir = user_dir.join(sub);
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if security::validate_preset_extension(name).is_err() {
                continue;
            }
            if std::fs::metadata(&p)
                .map(|m| m.len() > MAX_SNAPSHOT_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            out.push(p);
        }
    }
    out.sort();
    out
}

/// Snapshot an entire user preset library into the regular backup system.
/// Produces the same manifest format as install backups, so listing, restore,
/// and delete work unchanged. `label` fills the manifest's profile-name slot
/// shown in the backups list.
pub fn snapshot_user_presets_core(
    all_backups_root: &Path,
    slicer_id: &str,
    label: &str,
    project_id: &str,
    user_dir: &Path,
) -> Result<ProfileBackupManifest, String> {
    let files = user_preset_files(user_dir);
    if files.is_empty() {
        return Err(format!(
            "No user preset files found under {} — nothing to back up.",
            user_dir.display()
        ));
    }
    if files.len() > MAX_SNAPSHOT_FILES {
        return Err(format!(
            "Refusing to snapshot {} files (limit {MAX_SNAPSHOT_FILES}) — this does not look like a preset library.",
            files.len()
        ));
    }
    create_backup(all_backups_root, slicer_id, None, label, project_id, &files)
}

/// Back up a slicer account's whole user preset library (filament, machine,
/// process presets) before the user starts editing profiles. Read-only with
/// respect to slicer data; writes only into PerfectFit's backup folder.
#[tauri::command]
pub fn backup_slicer_user_presets(
    app: tauri::AppHandle,
    slicer_id: String,
    account_id: String,
    project_id: String,
) -> Result<RawBackupSummary, String> {
    security::validate_component(&account_id)?;
    let slicer = super::descriptor(&slicer_id)?;
    let data_root = security::platform_data_root()?;
    let slicer_root = data_root.join(slicer.data_dir_name);
    let user_dir = slicer_root.join("user").join(&account_id);
    if !user_dir.is_dir() {
        return Err(format!("USER_DATA_NOT_FOUND: {}", user_dir.display()));
    }
    security::ensure_under(&slicer_root, &user_dir)?;
    let backups_root = backups_root(&app)?;
    let label = format!("Preset library snapshot ({account_id})");
    let m = snapshot_user_presets_core(&backups_root, &slicer_id, &label, &project_id, &user_dir)?;
    Ok(RawBackupSummary {
        backup_id: m.backup_id,
        slicer_id: m.slicer_id,
        created_at: m.created_at,
        installed_profile_name: m.installed_profile_name,
        perfectfit_project_id: m.perfect_fit_project_id,
        file_count: m.files.len(),
        backup_root: m.backup_root,
    })
}

fn load_manifest(app: &tauri::AppHandle, backup_id: &str) -> Result<ProfileBackupManifest, String> {
    security::validate_component(backup_id)?;
    let root = backups_root(app)?;
    for slicer_dir in std::fs::read_dir(&root)
        .map_err(|e| format!("No backups found: {e}"))?
        .flatten()
    {
        let candidate = slicer_dir.path().join(backup_id).join("manifest.json");
        if candidate.is_file() {
            let raw = std::fs::read_to_string(&candidate)
                .map_err(|e| format!("Manifest read failed: {e}"))?;
            return serde_json::from_str(&raw).map_err(|e| format!("Manifest parse failed: {e}"));
        }
    }
    Err(format!("Backup {backup_id} not found"))
}

/// A restore that stopped part-way, carrying exactly what it had already done.
/// A half-restored preset library is the user's problem to finish by hand, so
/// the record of it is never discarded — it travels on the error.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    /// Why the restore stopped.
    pub message: String,
    /// Files already put back to their backed-up contents.
    pub restored_files: Vec<String>,
    /// Files already removed because the backup recorded them as not existing.
    pub deleted_files: Vec<String>,
    /// Files the restore never got to, starting with the one that failed.
    pub pending_files: Vec<String>,
}

impl std::fmt::Display for RestoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if self.restored_files.is_empty() && self.deleted_files.is_empty() {
            write!(f, "\nNothing was changed — the restore stopped before it wrote anything.")?;
        } else {
            write!(f, "\nThe restore stopped part-way. Already reverted to the backed-up version:")?;
            for p in &self.restored_files {
                write!(f, "\n  restored {p}")?;
            }
            for p in &self.deleted_files {
                write!(f, "\n  removed {p}")?;
            }
        }
        if !self.pending_files.is_empty() {
            write!(f, "\nNot reverted (still as they were before this restore):")?;
            for p in &self.pending_files {
                write!(f, "\n  {p}")?;
            }
        }
        Ok(())
    }
}

/// Build the failure record for the entry at `index`: everything from there on
/// is untouched by this restore.
fn stop_restore(
    manifest: &ProfileBackupManifest,
    index: usize,
    restored: &[String],
    deleted: &[String],
    message: String,
) -> RestoreFailure {
    RestoreFailure {
        message,
        restored_files: restored.to_vec(),
        deleted_files: deleted.to_vec(),
        pending_files: manifest.files[index..]
            .iter()
            .map(|e| e.original_path.clone())
            .collect(),
    }
}

/// Restore a backup: copy back every file that existed before (after checksum
/// verification of the backed-up copy) and delete files that did not exist.
/// Original paths are re-validated against `allowed_root` (the slicer's data
/// directory in production; a temp directory in integration tests).
///
/// Either every entry is reverted, or the restore stops at the first failure
/// and reports precisely which files it had already changed — it never
/// continues past an error and never leaves a silent mixed state.
pub fn restore_backup_inner(
    manifest: &ProfileBackupManifest,
    allowed_root: &Path,
) -> Result<(Vec<String>, Vec<String>), RestoreFailure> {
    let mut restored: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    for (i, f) in manifest.files.iter().enumerate() {
        let stop = |message: String, restored: &[String], deleted: &[String]| {
            stop_restore(manifest, i, restored, deleted, message)
        };
        let original = PathBuf::from(&f.original_path);
        if let Err(e) = security::ensure_target_under(allowed_root, &original) {
            return Err(stop(e, &restored, &deleted));
        }
        if let Err(e) = security::validate_preset_extension(
            original.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        ) {
            return Err(stop(e, &restored, &deleted));
        }
        if f.existed_before {
            let Some(backup_path) = f.backup_path.as_ref() else {
                return Err(stop(
                    "Manifest entry missing backup path".to_string(),
                    &restored,
                    &deleted,
                ));
            };
            let bp = PathBuf::from(backup_path);
            let sum = match sha256_file(&bp) {
                Ok(s) => s,
                Err(e) => return Err(stop(e, &restored, &deleted)),
            };
            if Some(&sum) != f.checksum_sha256.as_ref() {
                return Err(stop(
                    format!(
                        "Backup file checksum mismatch for {} — refusing to restore corrupted data",
                        bp.display()
                    ),
                    &restored,
                    &deleted,
                ));
            }
            // A restore is itself a recovery step, so it is written durably:
            // a crash straight after must not undo what the user was just
            // told had been put back.
            if let Err(e) = copy_durable(&bp, &original) {
                return Err(stop(
                    format!("Restore copy failed for {}: {e}", original.display()),
                    &restored,
                    &deleted,
                ));
            }
            let restored_sum = match sha256_file(&original) {
                Ok(s) => s,
                Err(e) => return Err(stop(e, &restored, &deleted)),
            };
            if restored_sum != sum {
                return Err(stop(
                    format!("Restore verification failed for {}", original.display()),
                    &restored,
                    &deleted,
                ));
            }
            restored.push(f.original_path.clone());
        } else if original.is_file() {
            if let Err(e) = std::fs::remove_file(&original) {
                return Err(stop(
                    format!("Restore delete failed for {}: {e}", original.display()),
                    &restored,
                    &deleted,
                ));
            }
            deleted.push(f.original_path.clone());
        }
    }
    Ok((restored, deleted))
}

#[derive(Serialize)]
pub struct RestoreResult {
    pub restored_files: Vec<String>,
    pub deleted_files: Vec<String>,
}

#[tauri::command]
pub fn list_profile_backups(app: tauri::AppHandle) -> Result<Vec<RawBackupSummary>, String> {
    let root = backups_root(&app)?;
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(out);
    };
    for slicer_dir in rd.flatten() {
        let Ok(inner) = std::fs::read_dir(slicer_dir.path()) else {
            continue;
        };
        for b in inner.flatten() {
            let manifest_path = b.path().join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
                if let Ok(m) = serde_json::from_str::<ProfileBackupManifest>(&raw) {
                    out.push(RawBackupSummary {
                        backup_id: m.backup_id,
                        slicer_id: m.slicer_id,
                        created_at: m.created_at,
                        installed_profile_name: m.installed_profile_name,
                        perfectfit_project_id: m.perfect_fit_project_id,
                        file_count: m.files.len(),
                        backup_root: m.backup_root,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn get_profile_backup_manifest(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<ProfileBackupManifest, String> {
    load_manifest(&app, &backup_id)
}

#[tauri::command]
pub fn restore_profile_backup(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<RestoreResult, String> {
    let manifest = load_manifest(&app, &backup_id)?;
    let data_root = security::platform_data_root()?;
    let slicer = super::descriptor(&manifest.slicer_id)?;
    let allowed_root = data_root.join(slicer.data_dir_name);
    // The failure text carries the reverted-so-far list, so a part-way restore
    // reaches the user as an actionable report instead of a bare error.
    let (restored_files, deleted_files) =
        restore_backup_inner(&manifest, &allowed_root).map_err(|f| f.to_string())?;
    Ok(RestoreResult {
        restored_files,
        deleted_files,
    })
}

#[tauri::command]
pub fn delete_profile_backup(app: tauri::AppHandle, backup_id: String) -> Result<(), String> {
    security::validate_component(&backup_id)?;
    let root = backups_root(&app)?;
    for slicer_dir in std::fs::read_dir(&root)
        .map_err(|e| format!("No backups found: {e}"))?
        .flatten()
    {
        let dir = slicer_dir.path().join(&backup_id);
        if dir.join("manifest.json").is_file() {
            security::ensure_under(&root, &dir)?;
            std::fs::remove_dir_all(&dir).map_err(|e| format!("Delete failed: {e}"))?;
            return Ok(());
        }
    }
    Err(format!("Backup {backup_id} not found"))
}

#[tauri::command]
pub fn open_backup_directory(app: tauri::AppHandle, backup_id: String) -> Result<(), String> {
    let manifest = load_manifest(&app, &backup_id)?;
    let root = backups_root(&app)?;
    super::processes::open_directory_checked(Path::new(&manifest.backup_root), &[root])
}

// ---------------------------------------------------------------------------
// Integration tests — always temp directories, never real slicer data.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    struct TempUserRoot(PathBuf);
    impl TempUserRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "perfectfit-snapshot-test-{tag}-{}-{}",
                std::process::id(),
                super::super::now_unix()
            ));
            std::fs::create_dir_all(dir.join("user/default/filament/base")).unwrap();
            std::fs::create_dir_all(dir.join("user/default/machine")).unwrap();
            std::fs::create_dir_all(dir.join("user/default/process")).unwrap();
            std::fs::create_dir_all(dir.join("backups")).unwrap();
            TempUserRoot(dir)
        }
        fn user_dir(&self) -> PathBuf {
            self.0.join("user/default")
        }
        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }
    }
    impl Drop for TempUserRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn snapshot(t: &TempUserRoot) -> Result<ProfileBackupManifest, String> {
        snapshot_user_presets_core(
            &t.backups(),
            "orca",
            "Preset library snapshot (default)",
            "proj-1",
            &t.user_dir(),
        )
    }

    #[test]
    fn snapshot_covers_filament_machine_process_and_skips_caches() {
        let t = TempUserRoot::new("scope");
        let u = t.user_dir();
        std::fs::write(u.join("filament/My PLA.json"), "{\"a\":1}").unwrap();
        std::fs::write(u.join("filament/My PLA.info"), "sync_info =\n").unwrap();
        std::fs::write(u.join("machine/My Printer.json"), "{\"b\":2}").unwrap();
        std::fs::write(u.join("process/0.20 Standard.json"), "{\"c\":3}").unwrap();
        // Must be ignored: base/ cache, non-preset extensions.
        std::fs::write(u.join("filament/base/Cloud PLA.json"), "{\"cache\":true}").unwrap();
        std::fs::write(u.join("filament/notes.txt"), "not a preset").unwrap();

        let m = snapshot(&t).unwrap();
        assert_eq!(m.files.len(), 4, "filament json+info, machine, process");
        assert!(m.files.iter().all(|f| f.existed_before));
        for f in &m.files {
            assert!(!f.original_path.contains("base"), "cache leaked into snapshot: {}", f.original_path);
            assert!(!f.original_path.ends_with(".txt"));
        }
    }

    #[test]
    fn snapshot_restore_round_trip_recovers_edited_and_deleted_presets() {
        let t = TempUserRoot::new("roundtrip");
        let u = t.user_dir();
        let filament = u.join("filament/My PLA.json");
        let machine = u.join("machine/My Printer.json");
        std::fs::write(&filament, "{\"flow\":\"0.98\"}").unwrap();
        std::fs::write(&machine, "{\"retract\":\"0.8\"}").unwrap();

        let m = snapshot(&t).unwrap();

        // Simulate what a calibration session can do: edit one file, delete another.
        std::fs::write(&filament, "{\"flow\":\"1.15\"}").unwrap();
        std::fs::remove_file(&machine).unwrap();

        let (restored, deleted) = restore_backup_inner(&m, &t.0).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(deleted.is_empty());
        assert_eq!(std::fs::read_to_string(&filament).unwrap(), "{\"flow\":\"0.98\"}");
        assert_eq!(std::fs::read_to_string(&machine).unwrap(), "{\"retract\":\"0.8\"}");
    }

    #[test]
    fn back_to_back_backups_never_overwrite_each_other() {
        let t = TempUserRoot::new("collide");
        let u = t.user_dir();
        let filament = u.join("filament/My PLA.json");
        std::fs::write(&filament, "{\"flow\":\"0.98\"}").unwrap();
        let first = snapshot(&t).unwrap();
        // Same second, same process — the clock cannot tell these apart.
        std::fs::write(&filament, "{\"flow\":\"1.15\"}").unwrap();
        let second = snapshot(&t).unwrap();

        assert_ne!(first.backup_id, second.backup_id, "two backups shared one id");
        assert_ne!(first.backup_root, second.backup_root);

        // Both are on disk, each describing itself.
        for m in [&first, &second] {
            let manifest_path = PathBuf::from(&m.backup_root).join("manifest.json");
            assert!(manifest_path.is_file(), "missing manifest for {}", m.backup_id);
            let on_disk: ProfileBackupManifest =
                serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
            assert_eq!(on_disk.backup_id, m.backup_id);
        }

        // Each still holds exactly the bytes it captured, checksum intact.
        let captured = |m: &ProfileBackupManifest| {
            let f = &m.files[0];
            let bp = f.backup_path.clone().expect("file was backed up");
            assert_eq!(
                sha256_file(Path::new(&bp)).unwrap(),
                *f.checksum_sha256.as_ref().unwrap(),
                "backup copy no longer matches its manifest checksum"
            );
            std::fs::read_to_string(&bp).unwrap()
        };
        assert_eq!(captured(&first), "{\"flow\":\"0.98\"}");
        assert_eq!(captured(&second), "{\"flow\":\"1.15\"}");
    }

    #[test]
    fn a_backup_id_another_process_already_claimed_is_never_reused() {
        let t = TempUserRoot::new("taken");
        let u = t.user_dir();
        std::fs::write(u.join("filament/My PLA.json"), "{\"flow\":\"0.98\"}").unwrap();
        // Stand-in for a backup another process claimed during this second.
        let taken = t
            .backups()
            .join("orca")
            .join(format!("{}-{}", now_unix(), std::process::id()));
        std::fs::create_dir_all(taken.join("files")).unwrap();
        std::fs::write(taken.join("manifest.json"), "{\"other\":\"process\"}").unwrap();

        let m = snapshot(&t).unwrap();
        assert_ne!(PathBuf::from(&m.backup_root), taken, "claimed a taken directory");
        assert_eq!(
            std::fs::read_to_string(taken.join("manifest.json")).unwrap(),
            "{\"other\":\"process\"}",
            "the other process's backup was overwritten"
        );
    }

    #[test]
    fn a_mid_restore_failure_reports_what_was_already_reverted() {
        let t = TempUserRoot::new("partial");
        let u = t.user_dir();
        let filament = u.join("filament/My PLA.json");
        let machine = u.join("machine/My Printer.json");
        std::fs::write(&filament, "{\"flow\":\"0.98\"}").unwrap();
        std::fs::write(&machine, "{\"retract\":\"0.8\"}").unwrap();
        let m = snapshot(&t).unwrap();

        // Both live files drift; the machine backup copy is damaged, so the
        // restore can revert the filament preset but not the machine one.
        std::fs::write(&filament, "{\"flow\":\"1.15\"}").unwrap();
        std::fs::write(&machine, "{\"retract\":\"9.9\"}").unwrap();
        let machine_backup = m
            .files
            .iter()
            .find(|f| f.original_path.contains("My Printer"))
            .unwrap()
            .backup_path
            .clone()
            .unwrap();
        std::fs::write(&machine_backup, "corrupted").unwrap();

        let failure = restore_backup_inner(&m, &t.0).expect_err("restore must fail");
        // It stopped at the bad entry instead of continuing.
        assert_eq!(std::fs::read_to_string(&machine).unwrap(), "{\"retract\":\"9.9\"}");
        // …but it *had* already reverted the filament preset, and must say so.
        assert_eq!(std::fs::read_to_string(&filament).unwrap(), "{\"flow\":\"0.98\"}");
        let msg = failure.to_string();
        assert!(msg.contains("checksum mismatch"), "{msg}");
        assert!(
            msg.contains("My PLA.json"),
            "a half-finished restore must name what it already reverted: {msg}"
        );
        // The same record is available structurally, not just as prose.
        let recorded = |needle: &str| {
            m.files
                .iter()
                .find(|f| f.original_path.contains(needle))
                .unwrap()
                .original_path
                .clone()
        };
        assert_eq!(
            failure.restored_files,
            vec![recorded("My PLA.json")],
            "reverted files must be reported exactly"
        );
        assert!(failure.deleted_files.is_empty());
        assert_eq!(
            failure.pending_files,
            vec![recorded("My Printer.json")],
            "files left alone must be reported exactly"
        );
    }

    #[test]
    fn a_restore_that_fails_on_its_first_file_reports_that_nothing_changed() {
        let t = TempUserRoot::new("nothing");
        let u = t.user_dir();
        let filament = u.join("filament/My PLA.json");
        std::fs::write(&filament, "{\"flow\":\"0.98\"}").unwrap();
        let m = snapshot(&t).unwrap();
        std::fs::write(&filament, "{\"flow\":\"1.15\"}").unwrap();
        std::fs::write(m.files[0].backup_path.as_ref().unwrap(), "corrupted").unwrap();

        let failure = restore_backup_inner(&m, &t.0).expect_err("restore must fail");
        assert!(failure.restored_files.is_empty());
        assert!(failure.deleted_files.is_empty());
        assert_eq!(failure.pending_files, vec![m.files[0].original_path.clone()]);
        assert!(
            failure.to_string().contains("Nothing was changed"),
            "{failure}"
        );
        // The live file is untouched — the restore never wrote corrupted data.
        assert_eq!(std::fs::read_to_string(&filament).unwrap(), "{\"flow\":\"1.15\"}");
    }

    #[test]
    fn empty_library_is_an_error_and_creates_no_backup() {
        let t = TempUserRoot::new("empty");
        let err = snapshot(&t).err().expect("empty library must not snapshot");
        assert!(err.contains("nothing to back up"), "{err}");
        assert_eq!(std::fs::read_dir(t.backups()).unwrap().count(), 0);
    }

    #[test]
    fn oversized_files_are_skipped() {
        let t = TempUserRoot::new("oversize");
        let u = t.user_dir();
        std::fs::write(u.join("filament/ok.json"), "{}").unwrap();
        std::fs::write(
            u.join("filament/huge.json"),
            vec![b' '; (MAX_SNAPSHOT_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        let m = snapshot(&t).unwrap();
        assert_eq!(m.files.len(), 1);
        assert!(m.files[0].original_path.ends_with("ok.json"));
    }
}
