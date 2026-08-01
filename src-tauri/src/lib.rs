pub mod slicer_integration;

use slicer_integration::{backup, discovery, filesystem, install, processes};

/// The bundle identifier this app ships under, as a Rust-side constant.
///
/// It must equal `identifier` in tauri.conf.json, and `the_identifier_matches_the_shipped_config`
/// fails the build if it drifts — because on Windows and Linux this string
/// decides where ALL of the app's data lives, not just where its caches do.
///
/// Tauri forces the webview's data directory to `LocalData/<identifier>` on
/// those two platforms (tauri 2.11.5, `src/manager/webview.rs`: "in `windows`,
/// we need to force a data_directory"). So `%LOCALAPPDATA%\<identifier>` holds
/// `EBWebView/Default/IndexedDB` and `.../Local Storage` — every project,
/// printer, photo, setting and autosave the user has — and `{data_dir}/<identifier>`
/// holds the slicer preset backups.
///
/// The consequence, for whoever proposes the NEXT identifier change: changing
/// this string moves all of that, and the app comes up empty with the old data
/// stranded in a folder it no longer looks in. The IndexedDB origin
/// (`http://tauri.localhost`) does not depend on the identifier, so the stores
/// themselves are portable — but nothing moves them. 3.0.0 could change it
/// freely only because 2.0.0 had never been installed by anyone; that will not
/// be true a second time, and a data migration has to ship with the change.
const APP_IDENTIFIER: &str = "io.github.espentruls.trim";

/// Remove service-worker registrations and HTTP caches left behind by previous
/// installs. A cache-first service worker registered by an older version keeps
/// serving that version's index.html, whose hashed bundle no longer exists
/// after an update, wedging the app on the static loading screen. Runs before
/// the webview starts so no files are locked. IndexedDB and Local Storage
/// (user calibration data) are deliberately untouched.
#[cfg(target_os = "windows")]
fn purge_stale_webview_caches() {
  let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
  // WebView2 keeps its profile in %LOCALAPPDATA%\<identifier>\EBWebView, so a
  // stale identifier here silently purges a folder belonging to some other
  // build. `APP_IDENTIFIER` is the single copy of it, under test.
  let profile = std::path::Path::new(&local)
    .join(APP_IDENTIFIER)
    .join("EBWebView")
    .join("Default");
  for dir in ["Service Worker", "Cache", "Code Cache"] {
    let _ = std::fs::remove_dir_all(profile.join(dir));
  }
}

#[cfg(not(target_os = "windows"))]
fn purge_stale_webview_caches() {}

/// Work around a blank/empty window on some Linux setups (notably Wayland).
/// WebKitGTK 2.42+ defaults to a DMABUF-based accelerated renderer that calls
/// `eglGetPlatformDisplay`; when that fails it aborts with
/// "Could not create default EGL display: EGL_BAD_PARAMETER" and the window
/// renders nothing. This bites the bundled AppImage in particular, because it
/// ships its own `libwayland-client` that can be incompatible with the host
/// compositor. Disabling the DMABUF renderer makes WebKitGTK fall back to a
/// path that avoids that EGL init entirely. Only set when the user hasn't
/// expressed a preference, so an explicit override (or an `LD_PRELOAD` of the
/// system libwayland) still wins.
#[cfg(target_os = "linux")]
fn configure_linux_webview_env() {
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_webview_env() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  configure_linux_webview_env();
  purge_stale_webview_caches();
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      discovery::detect_supported_slicers,
      discovery::get_platform_info,
      filesystem::scan_slicer_profiles,
      processes::detect_running_slicer_process,
      processes::open_slicer,
      processes::open_external_url,
      processes::open_profile_directory,
      backup::backup_slicer_user_presets,
      backup::list_profile_backups,
      backup::get_profile_backup_manifest,
      backup::restore_profile_backup,
      backup::delete_profile_backup,
      backup::open_backup_directory,
      install::install_generated_profile,
      install::verify_generated_profile,
      install::save_exported_profile,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  /// `purge_stale_webview_caches` recursively deletes three directories under
  /// `%LOCALAPPDATA%\<APP_IDENTIFIER>`. If that constant ever disagrees with the
  /// shipped config, those deletes land in a folder belonging to some other
  /// build — which is a different application's data, not this one's.
  #[test]
  fn the_identifier_matches_the_shipped_config() {
    let conf: serde_json::Value =
      serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(
      conf["identifier"].as_str().unwrap(),
      APP_IDENTIFIER,
      "APP_IDENTIFIER has drifted from tauri.conf.json"
    );
  }
}
