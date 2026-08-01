# Install on Mac

This guide is for people who just want to install the released **Trim** Mac app from GitHub. You do **not** need Node.js, Rust, Tauri, Xcode, Terminal, or any developer tools.

## Before you start

- Use the Mac download, not the Windows `.exe`, Linux `.deb`, or Linux `.AppImage` files.
- The Mac release is a universal `.dmg`, which means the same download works on both Apple Silicon Macs (M1/M2/M3/M4) and Intel Macs.
- Only download Trim from the official repository releases page:
  <https://github.com/espentruls/Filament_Calibration_Wizard/releases>
- **The `.dmg` is not notarized and the app is not code-signed.** There is no paid Apple
  Developer certificate behind this project. macOS will therefore complain — it may say the
  developer cannot be verified, or that the `.dmg` is **damaged and can't be opened**. That
  wording sounds like a virus warning, but it is not one: it is the *absence of an Apple
  signature*, and it appears for every unsigned app. The sections below tell you exactly what to
  click. If you would rather not rely on any of that, you can build the app yourself from source.

## Step-by-step install

1. Open the releases page:
   <https://github.com/espentruls/Filament_Calibration_Wizard/releases>
2. Click the newest release at the top of the page.
3. Find the **Assets** section for that release.
   - If the assets are hidden, click **Assets** to expand them.
4. Download the file that ends in **`.dmg`**.
   - Do not download the source code `.zip` or `.tar.gz` files unless you are a developer.
5. When the download finishes, open your **Downloads** folder.
6. Double-click the downloaded **`.dmg`** file.
7. A small installer window should open.
8. Drag **Trim** into the **Applications** folder shown in that window.
9. Wait for the copy to finish.
10. Close the installer window.
11. In Finder, eject the Trim disk image:
    - Look in the Finder sidebar for the mounted Trim disk.
    - Click the eject icon next to it.
12. Open your **Applications** folder.
13. Double-click **Trim** to launch it.

## If macOS says it cannot verify the app

Depending on how the release was built, macOS Gatekeeper may show a warning such as:

- "Apple could not verify Trim is free of malware"
- "Trim cannot be opened because the developer cannot be verified"

If you downloaded the `.dmg` from the official releases page and you trust it, do this:

1. Open **Applications** in Finder.
2. Find **Trim**.
3. Hold **Control** on your keyboard and click **Trim**.
   - You can also right-click it if your mouse or trackpad is set up for right-click.
4. Click **Open**.
5. If macOS asks again, click **Open** one more time.

After you approve it once, you should be able to open Trim normally in the future.

## If macOS still blocks it

If Control-click → **Open** does not work:

1. Open **System Settings**.
2. Go to **Privacy & Security**.
3. Scroll down to the **Security** section.
4. Look for a message about **Trim** being blocked.
5. Click **Open Anyway**.
6. Enter your Mac password or use Touch ID if asked.
7. Try opening **Trim** again from the **Applications** folder.

## After installing

- You can delete the downloaded `.dmg` file from your **Downloads** folder after Trim is copied to **Applications**.
- Always open Trim from **Applications**, Launchpad, or Spotlight after installing.
- Your Trim data is stored locally on your Mac. Before replacing or removing the app, use **Settings → Export all data** inside Trim if you want a backup of your projects.

## If you tried PerfectFit X2D (version 2.0.0 or earlier)

This app used to be called **PerfectFit X2D**. Version 3.0.0 renamed it to **Trim**, which also
changes the identity macOS files its data under — so Trim starts empty rather than picking up
where the old app left off. Nothing of yours is deleted; the two install side by side, and
anything the old app saved stays where it was.

If you have projects in the old app you want in Trim, move them across yourself before deleting it:

1. Open your existing **PerfectFit X2D** app.
2. **Settings → ⭳ Export all data + photos**. Save the JSON file somewhere you will find it.
3. Install **Trim** following the steps above.
4. Open Trim, then **Settings → 📥 Restore from backup** and pick that file.

## Updating Trim later

To update to a newer release:

1. Download the newest Mac `.dmg` from the releases page.
2. Open the `.dmg`.
3. Drag the new **Trim** app into **Applications**.
4. If macOS asks whether to replace the existing app, click **Replace**.
5. Open Trim from **Applications**.

Your projects should remain on your Mac, but exporting a backup first is still a good habit.

## Quick troubleshooting

### I downloaded a `.zip` instead of a `.dmg`

You probably downloaded the source code. Go back to the release, open **Assets**, and download the file ending in **`.dmg`**.

### The app opens from the `.dmg`, but disappears later

You may have run it from the disk image instead of installing it. Open the `.dmg` again and drag **Trim** into **Applications**.

### I cannot find the app after installing

Open Finder, click **Applications**, and look for **Trim**. You can also press **Command + Space**, type `Trim`, and press **Return**.

### The `.dmg` will not open or says it is damaged

"**… is damaged and can't be opened. You should move it to the Trash**" is the message macOS shows for a disk image that has no Apple notarization. The download is almost certainly fine — this release is not notarized, as noted at the top of this guide.

Try this in order:

1. Delete the downloaded `.dmg`, download it again from the official releases page, and try again — this rules out a genuinely truncated download.
2. In **Finder**, Control-click the `.dmg` and choose **Open**, then **Open** again in the dialog.
3. If macOS still refuses, remove the quarantine flag that Safari/Chrome attached to the download. Open **Terminal** (Command + Space, type `Terminal`, press Return) and run — with `<version>` replaced by the version number in the filename you actually downloaded:

   ```bash
   cd ~/Downloads
   xattr -d com.apple.quarantine "Trim_<version>_universal.dmg"
   ```

   The easiest way to get the filename exactly right: type `xattr -d com.apple.quarantine ` (including the trailing space), then drag the downloaded `.dmg` from Finder into the Terminal window — Terminal fills in the full path for you — and press Return.

   That command removes one attribute from that one file. It does not disable Gatekeeper, and you should not run it on a file you did not deliberately download from this project's releases page. If you are not comfortable running it, do not — use step 4 instead.
4. Build the app yourself instead of downloading it. With [Node.js](https://nodejs.org) and [Rust](https://rustup.rs) installed:

   ```bash
   git clone https://github.com/espentruls/Filament_Calibration_Wizard.git
   cd Filament_Calibration_Wizard
   npm install
   npm run tauri build
   ```

   The app appears under `src-tauri/target/release/bundle/`. A binary you built yourself needs no signature from anyone.

If none of that works, report the exact release version and the exact macOS warning message in GitHub Issues.
