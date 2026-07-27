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

/// Resolve one backup by its TRUE identity: the `(slicer_id, backup_id)` pair.
///
/// A backup id is unique only inside one slicer's folder — `claim_backup_dir`
/// takes its uniqueness from `create_dir` under `<backups>/<slicer_id>/`, and
/// the id itself is `{unix-seconds}-{pid}[-{retry}]`, so two slicers backed up
/// in the same second (which is what "Back up all detected slicers" does, every
/// time) mint the SAME id. Resolving an id by scanning every slicer directory
/// therefore returned whichever one `read_dir` happened to list first, and a
/// restore aimed at one slicer rewrote another slicer's live preset library.
///
/// The pair is already stored in every manifest, already returned in
/// `RawBackupSummary`, and already on screen in the Settings table, so nothing
/// new has to be remembered — and the on-disk layout is unchanged, so backups
/// already on users' disks keep resolving.
pub fn load_manifest_at(
    backups_root: &Path,
    slicer_id: &str,
    backup_id: &str,
) -> Result<ProfileBackupManifest, String> {
    super::descriptor(slicer_id)?;
    security::validate_component(backup_id)?;
    let dir = backups_root.join(slicer_id).join(backup_id);
    let path = dir.join("manifest.json");
    // Existence first, so a missing backup reads as "not found" rather than as
    // a canonicalization error. `validate_component` has already rejected any
    // traversing id; `ensure_under` is the belt to that braces.
    if !path.is_file() {
        return Err(format!("Backup {backup_id} not found for {slicer_id}"));
    }
    security::ensure_under(backups_root, &dir)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Manifest read failed: {e}"))?;
    let manifest: ProfileBackupManifest =
        serde_json::from_str(&raw).map_err(|e| format!("Manifest parse failed: {e}"))?;
    // The manifest names the slicer whose data the restore will overwrite. If
    // it disagrees with the folder it was found in, something rewrote it by
    // hand — refuse rather than let it redirect the write.
    if manifest.slicer_id != slicer_id {
        return Err(format!(
            "Backup {backup_id} is filed under {slicer_id} but its manifest claims {} — refusing to use it.",
            manifest.slicer_id
        ));
    }
    Ok(manifest)
}

fn load_manifest(
    app: &tauri::AppHandle,
    slicer_id: &str,
    backup_id: &str,
) -> Result<ProfileBackupManifest, String> {
    load_manifest_at(&backups_root(app)?, slicer_id, backup_id)
}

/// Delete one backup, addressed by the same `(slicer_id, backup_id)` pair as
/// `load_manifest_at` — deleting the first id-match across all slicers destroyed
/// a different slicer's snapshot while leaving the one the user aimed at.
pub fn delete_backup_at(
    backups_root: &Path,
    slicer_id: &str,
    backup_id: &str,
) -> Result<(), String> {
    super::descriptor(slicer_id)?;
    security::validate_component(backup_id)?;
    let dir = backups_root.join(slicer_id).join(backup_id);
    if !dir.join("manifest.json").is_file() {
        return Err(format!("Backup {backup_id} not found for {slicer_id}"));
    }
    security::ensure_under(backups_root, &dir)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Delete failed: {e}"))
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

/// Inventory every backup under `backups_root`.
///
/// The `(slicer_id, backup_id)` a row carries is the one taken from the
/// DIRECTORIES the backup was found in — never the pair its manifest claims.
/// This listing is the only place the UI gets the pair it later hands to
/// restore and delete, so a manifest that names a different slicer (a folder
/// copied off another machine, a hand-edited file in PerfectFit's own app data)
/// would otherwise hand back an address that resolves inside ANOTHER slicer's
/// folder — where a colliding id really does exist — and `load_manifest_at`'s
/// mismatch guard would never fire, because the manifest it then read agrees
/// with itself. Addressing by the on-disk path keeps that door shut: the
/// tampered row resolves to its own directory and is refused there.
pub fn list_backups_at(backups_root: &Path) -> Vec<RawBackupSummary> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(backups_root) else {
        return out;
    };
    for slicer_dir in rd.flatten() {
        let Some(slicer_id) = slicer_dir.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(inner) = std::fs::read_dir(slicer_dir.path()) else {
            continue;
        };
        for b in inner.flatten() {
            let Some(backup_id) = b.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let manifest_path = b.path().join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
                if let Ok(m) = serde_json::from_str::<ProfileBackupManifest>(&raw) {
                    out.push(RawBackupSummary {
                        backup_id,
                        slicer_id: slicer_id.clone(),
                        created_at: m.created_at,
                        installed_profile_name: m.installed_profile_name,
                        perfectfit_project_id: m.perfect_fit_project_id,
                        file_count: m.files.len(),
                        // Where it actually is now, not where it was written:
                        // an app-data folder that has since moved leaves the
                        // manifest's own copy of this path pointing at nothing.
                        backup_root: b.path().display().to_string(),
                    });
                }
            }
        }
    }
    sort_backups_newest_first(&mut out);
    out
}

#[tauri::command]
pub fn list_profile_backups(app: tauri::AppHandle) -> Result<Vec<RawBackupSummary>, String> {
    Ok(list_backups_at(&backups_root(&app)?))
}

/// Ordering key parsed out of a backup id: `{unix-seconds}-{pid}[-{retry}]`,
/// as `claim_backup_dir` writes it. `None` for an id this app did not write.
///
/// `retry` is monotonic within one second for one process — it only increments
/// because the previous directory was already claimed — so it is exactly the
/// order the backups were made in.
fn backup_id_order(backup_id: &str) -> Option<(u64, u32, u32)> {
    let mut parts = backup_id.split('-');
    let secs: u64 = parts.next()?.parse().ok()?;
    let pid: u32 = parts.next()?.parse().ok()?;
    let retry: u32 = match parts.next() {
        Some(r) => r.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None; // more segments than the scheme has — do not guess
    }
    Some((secs, retry, pid))
}

/// Newest first, under a TOTAL order.
///
/// `created_at` has second resolution and the collision fix deliberately lets
/// several backups share one second, so the timestamp alone leaves their order
/// undefined — whatever `read_dir` happened to return. In Settings → Slicer
/// profile backups that is the list the user picks a snapshot to restore from,
/// so "which of these is the newest" has to be answerable. The id's monotonic
/// retry counter breaks the tie; ids that do not match the scheme sort last
/// within their second, by id, so the order is still repeatable.
fn sort_backups_newest_first(out: &mut [RawBackupSummary]) {
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            // `Option::None` orders below `Some`, and this comparison is
            // reversed, so unparseable ids fall to the back of their group.
            .then_with(|| backup_id_order(&b.backup_id).cmp(&backup_id_order(&a.backup_id)))
            .then_with(|| a.backup_id.cmp(&b.backup_id))
            // Two slicers backed up in the same second share every key above —
            // ids are unique only within one slicer's folder. Without this the
            // two rows the user picks between stay in arbitrary read_dir order.
            .then_with(|| a.slicer_id.cmp(&b.slicer_id))
    });
}

#[tauri::command]
pub fn get_profile_backup_manifest(
    app: tauri::AppHandle,
    slicer_id: String,
    backup_id: String,
) -> Result<ProfileBackupManifest, String> {
    load_manifest(&app, &slicer_id, &backup_id)
}

#[tauri::command]
pub fn restore_profile_backup(
    app: tauri::AppHandle,
    slicer_id: String,
    backup_id: String,
) -> Result<RestoreResult, String> {
    let manifest = load_manifest(&app, &slicer_id, &backup_id)?;
    let data_root = security::platform_data_root()?;
    let slicer = super::descriptor(&manifest.slicer_id)?;
    // A restore rewrites the very files an open slicer holds open and rewrites
    // again when it exits. `install_generated_profile` already refuses to run in
    // that state; prose in a confirm dialog is not the same guarantee, and a
    // locked file stops the restore part-way through the library.
    if super::processes::is_slicer_running(&manifest.slicer_id)? {
        return Err(format!(
            "SLICER_RUNNING: Close {} before restoring — it holds preset files open and rewrites them when it exits.",
            slicer.display_name
        ));
    }
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
pub fn delete_profile_backup(
    app: tauri::AppHandle,
    slicer_id: String,
    backup_id: String,
) -> Result<(), String> {
    delete_backup_at(&backups_root(&app)?, &slicer_id, &backup_id)
}

#[tauri::command]
pub fn open_backup_directory(
    app: tauri::AppHandle,
    slicer_id: String,
    backup_id: String,
) -> Result<(), String> {
    let root = backups_root(&app)?;
    // Validates the pair — and refuses a manifest that claims a different
    // slicer — before anything is opened.
    load_manifest_at(&root, &slicer_id, &backup_id)?;
    // The directory the pair addresses, not the path the manifest records:
    // that copy is stale the moment the app-data folder moves, and it is the
    // one field of the manifest that can point at a different slicer's backup.
    let dir = root.join(&slicer_id).join(&backup_id);
    super::processes::open_directory_checked(&dir, &[root])
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

    // -----------------------------------------------------------------------
    // Cross-slicer addressing.
    //
    // "Back up all detected slicers" snapshots every slicer in one pass, inside
    // the same second, and a backup id is unique only within one slicer's
    // folder — so the ids genuinely collide across slicers on a real install.
    // Everything that resolves a backup must therefore address the
    // (slicer_id, backup_id) PAIR, or a restore aimed at one slicer silently
    // rewrites another slicer's live preset library and reports success.
    // -----------------------------------------------------------------------

    /// Two slicer libraries under one backups root, snapshotted back to back.
    /// Returns (backups_root_holder, orca_manifest, bambu_manifest, orca_file,
    /// bambu_file), each library holding one filament preset.
    fn two_slicer_libraries(
        tag: &str,
    ) -> (
        TempUserRoot,
        TempUserRoot,
        ProfileBackupManifest,
        ProfileBackupManifest,
    ) {
        let orca = TempUserRoot::new(&format!("{tag}-orca"));
        let bambu = TempUserRoot::new(&format!("{tag}-bambu"));
        std::fs::write(
            orca.user_dir().join("filament/My PLA.json"),
            "{\"nozzle_temperature\":[\"215\"]}",
        )
        .unwrap();
        std::fs::write(
            bambu.user_dir().join("filament/My PLA.json"),
            "{\"nozzle_temperature\":[\"240\"]}",
        )
        .unwrap();
        // One shared backups root, exactly as production uses.
        let backups = orca.backups();
        let m_orca =
            snapshot_user_presets_core(&backups, "orca", "orca library", "proj-1", &orca.user_dir())
                .unwrap();
        let mut m_bambu = snapshot_user_presets_core(
            &backups,
            "bambu",
            "bambu library",
            "proj-1",
            &bambu.user_dir(),
        )
        .unwrap();

        // The hazard these tests exist for is two backups in DIFFERENT slicer
        // folders sharing one id. Ids carry a wall-clock second, so whether the
        // two snapshots above collide depends on how fast the machine is: they
        // did locally and on the Windows and macOS runners, and did not on the
        // slower Linux one, where the test failed on its own precondition
        // rather than on the behaviour it guards. So force the collision
        // instead of racing the clock — the production id scheme is exercised
        // by `back_to_back_backups_never_overwrite_each_other`, which is where
        // uniqueness belongs.
        if m_bambu.backup_id != m_orca.backup_id {
            let from = PathBuf::from(&m_bambu.backup_root);
            let to = from.parent().unwrap().join(&m_orca.backup_id);
            std::fs::rename(&from, &to).unwrap();
            m_bambu.backup_id = m_orca.backup_id.clone();
            m_bambu.backup_root = to.to_string_lossy().to_string();
            let manifest_path = to.join("manifest.json");
            let mut on_disk: ProfileBackupManifest =
                serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
            on_disk.backup_id = m_orca.backup_id.clone();
            on_disk.backup_root = m_bambu.backup_root.clone();
            std::fs::write(&manifest_path, serde_json::to_string(&on_disk).unwrap()).unwrap();
        }
        assert_eq!(
            m_orca.backup_id, m_bambu.backup_id,
            "the fixture must hand these tests a genuine id collision"
        );
        (orca, bambu, m_orca, m_bambu)
    }

    #[test]
    fn a_restore_addressed_to_one_slicer_never_touches_another() {
        let (orca, bambu, m_orca, _m_bambu) = two_slicer_libraries("pairaddr");
        let orca_file = orca.user_dir().join("filament/My PLA.json");
        let bambu_file = bambu.user_dir().join("filament/My PLA.json");

        // The ids really do collide — that is the whole hazard, kept explicit
        // so this test still means something if the id scheme changes.
        let colliding = m_orca.backup_id == _m_bambu.backup_id;

        // The user re-calibrates both libraries.
        std::fs::write(&orca_file, "{\"nozzle_temperature\":[\"205\"]}").unwrap();
        std::fs::write(&bambu_file, "{\"nozzle_temperature\":[\"250\"]}").unwrap();

        // …then presses Restore on the ORCA row.
        let resolved = load_manifest_at(&orca.backups(), "orca", &m_orca.backup_id).unwrap();
        assert_eq!(
            resolved.slicer_id, "orca",
            "restoring orca resolved to another slicer (ids collided: {colliding})"
        );
        let (restored, _) = restore_backup_inner(&resolved, &orca.0).unwrap();
        assert_eq!(restored.len(), 1);

        assert_eq!(
            std::fs::read_to_string(&orca_file).unwrap(),
            "{\"nozzle_temperature\":[\"215\"]}",
            "the library the user asked to restore was not restored"
        );
        assert_eq!(
            std::fs::read_to_string(&bambu_file).unwrap(),
            "{\"nozzle_temperature\":[\"250\"]}",
            "a slicer the user never touched was rewritten to an older snapshot"
        );
    }

    #[test]
    fn a_delete_addressed_to_one_slicer_removes_only_that_backup() {
        let (orca, _bambu, m_orca, m_bambu) = two_slicer_libraries("pairdel");
        let backups = orca.backups();

        delete_backup_at(&backups, "orca", &m_orca.backup_id).unwrap();

        assert!(
            !PathBuf::from(&m_orca.backup_root).is_dir(),
            "the backup the user deleted is still there"
        );
        assert!(
            PathBuf::from(&m_bambu.backup_root).join("manifest.json").is_file(),
            "deleting one slicer's backup destroyed another slicer's snapshot"
        );
        // Deleting it twice is an honest "not found", not another slicer's row.
        assert!(delete_backup_at(&backups, "orca", &m_orca.backup_id).is_err());
    }

    /// The listing is where the UI gets the pair it hands to restore and
    /// delete. If a row carried the slicer its MANIFEST claims, a backup filed
    /// under orca could address bambu's folder — where a colliding id really
    /// exists — and the mismatch guard in `load_manifest_at` would never fire,
    /// because the manifest it then read agrees with itself.
    #[test]
    fn a_listed_row_addresses_the_folder_it_was_found_in_not_the_one_its_manifest_names() {
        // The fixture guarantees the id collision this test needs.
        let (orca, _bambu, m_orca, m_bambu) = two_slicer_libraries("listclaim");
        // A backup folder copied off another machine, or a hand-edited file in
        // PerfectFit's own app data: filed under orca, claiming bambu.
        let manifest_path = PathBuf::from(&m_orca.backup_root).join("manifest.json");
        let mut m: ProfileBackupManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        m.slicer_id = "bambu".to_string();
        m.backup_id = "9999999999-1".to_string();
        std::fs::write(&manifest_path, serde_json::to_string(&m).unwrap()).unwrap();

        let rows = list_backups_at(&orca.backups());
        assert_eq!(rows.len(), 2, "both backups must still be listed");
        let mut pairs: Vec<(String, String)> = rows
            .iter()
            .map(|r| (r.slicer_id.clone(), r.backup_id.clone()))
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("bambu".to_string(), m_bambu.backup_id.clone()),
                ("orca".to_string(), m_orca.backup_id.clone()),
            ],
            "a row must address its own directory, whatever its manifest says"
        );
        // Every listed row resolves inside its own slicer, or is refused —
        // never redirected into another slicer's live library.
        for r in &rows {
            match load_manifest_at(&orca.backups(), &r.slicer_id, &r.backup_id) {
                Ok(resolved) => assert_eq!(resolved.slicer_id, r.slicer_id),
                Err(e) => assert!(e.contains("refusing"), "{e}"),
            }
        }
        // The tampered row specifically: refused, not silently pointed at bambu.
        let err = match load_manifest_at(&orca.backups(), "orca", &m_orca.backup_id) {
            Ok(_) => panic!("a redirected manifest must not be used"),
            Err(e) => e,
        };
        assert!(err.contains("refusing"), "{err}");
    }

    /// A restore rewrites the very files an open slicer holds and rewrites
    /// again on exit; `install_generated_profile` has refused to run in that
    /// state for as long as it has existed, and restore must too. The command
    /// needs a `tauri::AppHandle` to run, so the guard is asserted where it
    /// lives — its absence, or its being moved after the first write, fails.
    #[test]
    fn the_restore_command_checks_for_a_running_slicer_before_it_writes() {
        let src = include_str!("backup.rs");
        let body = src
            .split("pub fn restore_profile_backup(")
            .nth(1)
            .expect("restore command present")
            .split("\n#[tauri::command]")
            .next()
            .unwrap();
        let guard = body
            .find("is_slicer_running")
            .expect("restore must refuse while the slicer is running");
        let write = body
            .find("restore_backup_inner")
            .expect("restore must call the writer");
        assert!(
            guard < write,
            "the running-slicer check must come before anything is written"
        );
        assert!(
            body.contains("SLICER_RUNNING"),
            "the Settings panel keys its 'close the slicer' wording off this marker"
        );
    }

    #[test]
    fn a_manifest_that_claims_a_different_slicer_is_refused() {
        let (orca, _bambu, m_orca, _m_bambu) = two_slicer_libraries("mismatch");
        let manifest_path = PathBuf::from(&m_orca.backup_root).join("manifest.json");
        let mut m: ProfileBackupManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        m.slicer_id = "bambu".to_string();
        std::fs::write(&manifest_path, serde_json::to_string(&m).unwrap()).unwrap();

        let err = match load_manifest_at(&orca.backups(), "orca", &m_orca.backup_id) {
            Ok(_) => panic!("a redirected manifest must not be used"),
            Err(e) => e,
        };
        assert!(err.contains("refusing"), "{err}");
    }

    #[test]
    fn an_unknown_slicer_or_a_traversing_id_is_rejected() {
        let (orca, _bambu, m_orca, _m) = two_slicer_libraries("guard");
        assert!(load_manifest_at(&orca.backups(), "not-a-slicer", &m_orca.backup_id).is_err());
        assert!(load_manifest_at(&orca.backups(), "orca", "../orca").is_err());
        assert!(delete_backup_at(&orca.backups(), "orca", "..").is_err());
    }

    /// Two slicers backed up in the same second share `created_at`, the id, and
    /// therefore every ordering key above the slicer — without the final
    /// tiebreak the two rows the user chooses between float in `read_dir` order.
    #[test]
    fn cross_slicer_same_second_rows_have_a_repeatable_order() {
        let t = "2026-07-26T09:40:02Z";
        let row = |slicer: &str| RawBackupSummary {
            backup_id: "1785000000-4242".to_string(),
            slicer_id: slicer.to_string(),
            created_at: t.to_string(),
            installed_profile_name: "snapshot".to_string(),
            perfectfit_project_id: "proj-1".to_string(),
            file_count: 1,
            backup_root: format!("/backups/{slicer}/1785000000-4242"),
        };
        let order_of = |mut list: Vec<RawBackupSummary>| {
            sort_backups_newest_first(&mut list);
            list.into_iter().map(|s| s.slicer_id).collect::<Vec<_>>()
        };
        assert_eq!(
            order_of(vec![row("orca"), row("bambu")]),
            order_of(vec![row("bambu"), row("orca")]),
            "the same set must always list in the same order"
        );
    }

    #[test]
    fn empty_library_is_an_error_and_creates_no_backup() {
        let t = TempUserRoot::new("empty");
        let err = snapshot(&t).err().expect("empty library must not snapshot");
        assert!(err.contains("nothing to back up"), "{err}");
        assert_eq!(std::fs::read_dir(t.backups()).unwrap().count(), 0);
    }

    fn summary(backup_id: &str, created_at: &str) -> RawBackupSummary {
        RawBackupSummary {
            backup_id: backup_id.to_string(),
            slicer_id: "orca".to_string(),
            created_at: created_at.to_string(),
            installed_profile_name: "snapshot".to_string(),
            perfectfit_project_id: "proj-1".to_string(),
            file_count: 1,
            backup_root: format!("/backups/orca/{backup_id}"),
        }
    }

    /// `created_at` is second-resolution and several backups may legitimately
    /// share one second (that is what makes the id, not the clock, the
    /// uniqueness gate). Sorting on the timestamp alone therefore left the
    /// newest snapshot in an arbitrary position in Settings → Slicer profile
    /// backups, where the user picks which one to restore.
    #[test]
    fn same_second_backups_list_newest_first() {
        let t = "2026-07-26T09:40:02Z";
        // read_dir order is arbitrary — this is one of the orders it can hand back.
        let mut list = vec![
            summary("1785000000-4242-1", t),
            summary("1785000000-4242", t),
            summary("1785000000-4242-2", t),
        ];
        sort_backups_newest_first(&mut list);
        let ids: Vec<&str> = list.iter().map(|s| s.backup_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "1785000000-4242-2",
                "1785000000-4242-1",
                "1785000000-4242"
            ],
            "same-second backups must list newest first, not in directory order"
        );
    }

    /// The retry suffix is a number, so it must not be compared as text:
    /// "…-10" sorts before "…-9" lexicographically but is the newer backup.
    #[test]
    fn double_digit_retry_suffixes_sort_numerically() {
        let t = "2026-07-26T09:40:02Z";
        let mut list = vec![
            summary("1785000000-4242-9", t),
            summary("1785000000-4242-10", t),
            summary("1785000000-4242-11", t),
        ];
        sort_backups_newest_first(&mut list);
        assert_eq!(list[0].backup_id, "1785000000-4242-11");
        assert_eq!(list[2].backup_id, "1785000000-4242-9");
    }

    /// A newer second always wins, whatever the retry counters say.
    #[test]
    fn a_later_second_outranks_any_retry_of_an_earlier_one() {
        let mut list = vec![
            summary("1785000000-4242-7", "2026-07-26T09:40:00Z"),
            summary("1785000002-4242", "2026-07-26T09:40:02Z"),
        ];
        sort_backups_newest_first(&mut list);
        assert_eq!(list[0].backup_id, "1785000002-4242");
    }

    /// Ids this app did not write (hand-made folders, a future id scheme) must
    /// not make the sort panic or become non-deterministic: they fall to the
    /// back of their timestamp group in a stable, repeatable order.
    #[test]
    fn unparseable_ids_still_produce_a_stable_total_order() {
        let t = "2026-07-26T09:40:02Z";
        let order_of = |mut list: Vec<RawBackupSummary>| {
            sort_backups_newest_first(&mut list);
            list.into_iter().map(|s| s.backup_id).collect::<Vec<_>>()
        };
        let a = order_of(vec![
            summary("hand-made", t),
            summary("1785000000-4242-1", t),
            summary("also weird", t),
        ]);
        let b = order_of(vec![
            summary("also weird", t),
            summary("1785000000-4242-1", t),
            summary("hand-made", t),
        ]);
        assert_eq!(a, b, "the same set must always list in the same order");
        assert_eq!(a[0], "1785000000-4242-1", "real backups rank above unparseable ids");
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
