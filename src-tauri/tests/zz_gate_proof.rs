//! THROWAWAY final-gate proof. Delete after running.
//! Proves (a) Beta discovery + no silent pick, (b) running refusal covers Beta.

use app_lib::slicer_integration::{
    self, discovery,
    processes::is_slicer_running,
};
use std::fs;
use std::path::{Path, PathBuf};

fn conf(version: &str, folder: &str) -> String {
    format!(
        "{{\n  \"app\": {{\n    \"version\": \"{version}\",\n    \"preset_folder\": \"{folder}\",\n    \"sync_user_preset\": \"true\"\n  }}\n}}\n# MD5 checksum deadbeef\n"
    )
}

fn make_install(root: &Path, dir: &str, conf_name: &str, version: &str, folder: &str) -> PathBuf {
    let d = root.join(dir);
    fs::create_dir_all(d.join("user").join(folder).join("filament")).unwrap();
    fs::write(
        d.join("user").join(folder).join("filament").join("x.json"),
        "{}",
    )
    .unwrap();
    fs::write(d.join(conf_name), conf(version, folder)).unwrap();
    d
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("zz_gate_{tag}_{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// (a) Both flavours discovered, both visible, neither silently chosen.
#[test]
fn proof_a_beta_is_discovered_and_neither_flavour_is_silently_picked() {
    let root = tmp("a");
    // Release written FIRST (older), Beta SECOND (newer) -- mirrors the owner's
    // real machine (release 2026-07-18, beta 2026-08-01).
    make_install(&root, "BambuStudio", "BambuStudio.conf", "02.03.00.00", "111");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    make_install(
        &root,
        "BambuStudioBeta",
        "BambuStudio.conf",
        "02.08.01.55",
        "2572316032",
    );

    let rows = discovery::detect_in_root(&root, &[]);
    let bambu: Vec<_> = rows.iter().filter(|r| r.slicer_id == "bambu").collect();

    println!("PROOF A: {} bambu rows", bambu.len());
    for r in &bambu {
        println!(
            "  variant_id={} label={:?} default={} conf_version={:?} preset_folder={:?} superseded_by={:?} data_dir={:?}",
            r.variant_id, r.variant_label, r.is_default_variant, r.conf_version,
            r.preset_folder, r.superseded_by, r.data_dir
        );
        for n in &r.notes {
            println!("    note: {n}");
        }
    }

    // Beta is discovered at all.
    let beta = bambu
        .iter()
        .find(|r| r.variant_id == "bambu-beta")
        .expect("PROOF A FAILED: Beta not discovered");
    assert_eq!(beta.conf_version.as_deref(), Some("02.08.01.55"));
    assert_eq!(beta.preset_folder.as_deref(), Some("2572316032"));
    assert!(beta.data_dir.as_deref().unwrap().contains("BambuStudioBeta"));

    // BOTH are reported -- nothing is dropped, so nothing is silently picked.
    assert_eq!(bambu.len(), 2, "PROOF A FAILED: a flavour was dropped");
    let release = bambu.iter().find(|r| r.variant_id == "bambu").unwrap();
    assert!(release.data_dir.is_some());

    // The newer one sorts first AND the older one carries an explicit,
    // user-visible note naming the newer sibling. Silence would be the failure.
    assert_eq!(bambu[0].variant_id, "bambu-beta");
    assert_eq!(
        release.superseded_by.as_deref(),
        Some("Bambu Studio (Beta)"),
        "PROOF A FAILED: the release row does not say the Beta was used more recently"
    );
    assert!(release
        .notes
        .iter()
        .any(|n| n.contains("used more recently") && n.contains("will not appear")));
    assert!(
        beta.superseded_by.is_none(),
        "the newest install must not be flagged"
    );

    // Each flavour addresses its OWN directory: a write cannot leak across.
    for r in &bambu {
        let v = slicer_integration::variant(&r.variant_id).unwrap();
        println!(
            "  addresses: {} -> %APPDATA%\\{} (conf {})",
            r.variant_id, v.data_dir_name, v.conf_file_name
        );
    }
    let a = slicer_integration::variant("bambu").unwrap();
    let b = slicer_integration::variant("bambu-beta").unwrap();
    assert_ne!(a.data_dir_name, b.data_dir_name);
    let _ = fs::remove_dir_all(&root);
    println!("PROOF A: PASS");
}

/// (b) The running-slicer refusal covers the Beta.
#[test]
fn proof_b_running_refusal_fires_for_the_beta() {
    // b1: the Beta's family id is "bambu" -- the exact string both refusal
    // sites (install_generated_profile, restore_profile_backup) pass.
    let beta = slicer_integration::variant("bambu-beta").unwrap();
    assert_eq!(beta.id, "bambu");
    println!(
        "PROOF B1: variant bambu-beta -> family id {:?}, process_names {:?}",
        beta.id, beta.process_names
    );

    // b2: family-wide process names cover EVERY flavour, Beta included.
    let names = slicer_integration::family_process_names("bambu").unwrap();
    println!("PROOF B2: family_process_names(\"bambu\") = {names:?}");
    for n in beta.process_names {
        assert!(
            names.contains(n),
            "PROOF B FAILED: Beta process name {n} not covered"
        );
    }

    // b3: END TO END. Spawn a real process image-named bambu-studio.exe (a copy
    // of ping.exe) and check the refusal predicate actually returns true.
    #[cfg(target_os = "windows")]
    {
        let d = tmp("b");
        let fake = d.join("bambu-studio.exe");
        fs::copy(r"C:\Windows\System32\PING.EXE", &fake).unwrap();
        assert!(
            !is_slicer_running("bambu").unwrap(),
            "PROOF B PRECONDITION FAILED: a bambu process was already running"
        );
        let mut child = std::process::Command::new(&fake)
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let running = is_slicer_running("bambu").unwrap();
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&d);
        println!("PROOF B3: is_slicer_running(\"bambu\") with a live bambu-studio.exe = {running}");
        assert!(
            running,
            "PROOF B FAILED: refusal predicate did not fire on a live bambu-studio.exe"
        );
        std::thread::sleep(std::time::Duration::from_millis(800));
        println!(
            "PROOF B3: after kill = {}",
            is_slicer_running("bambu").unwrap()
        );
    }
    println!("PROOF B: PASS");
}
