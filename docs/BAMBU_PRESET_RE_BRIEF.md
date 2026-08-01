# Bambu cloud preset API — reverse-engineering brief

**Status:** open investigation. Nothing here is implemented in Trim.
**Written:** 2026-08-01, on a machine where this work could not be done (see
*Why not here*). Intended to be picked up on a personal machine.

---

## The problem

A Bambu account holds ~496 user filament presets, 495 of them eSUN profiles
imported by mistake. The account is over Bambu's custom-preset limit, so Bambu
Studio reports that it is syncing locally only. **That warning, not the profile
count itself, is the thing to fix** — so establishing the actual account limit may
mean deleting far fewer than 495.

Exactly one preset must survive:

```
Generic ABS Flow Rate Calibrated
  setting_id  PFUS18ede5548cd931
  base_id     GFSB99_13
```

It carries the owner's only real calibration (main-nozzle flow ratio 0.967575) and
is not recoverable if lost. Treat it as the one thing that must never be touched.

## What is already ruled out — do not re-derive these

| Approach | Result |
|---|---|
| Delete the local `.json` files | **Fails.** Studio re-downloads from cloud on next sync. Observed: 500 came back within hours. |
| Set `sync_info = delete` in the `.info` sidecar | **Fails.** Marked all 496, restarted Studio: it rewrote every sidecar and cleared the markers without acting on any. `sync_info` is written *by* Studio to describe state; it is not read as a command. |
| Read endpoints out of the DLLs as strings | **Fails.** Scanned `bambu_networking.dll` (20 MB) and `BambuSource.dll` (5 MB) in ASCII and UTF-16. Only code-signing cert URLs. Endpoints are built at runtime or obfuscated. |
| Read the HTTP calls from Studio's logs | **Fails.** Only `log_iotc.txt` (1.4 KB), which is Agora camera streaming. No HTTP logging, and no debug-level switch in `BambuStudio.conf`. |
| Find the cloud token in `BambuStudio.conf` | **Not there.** Only `user_access_code` (27 chars), which is the printer's LAN code, not a cloud session token. |
| UI Automation by control name | **Fails.** wxWidgets exposes 360 elements but zero `Button` controls — everything is a generic `Pane`. Only coordinate clicking is possible, which is what we are trying to avoid. |

**Confirmed working, but slow:** deleting one preset by hand in the UI — select the
preset, click the edit/pencil icon to open *Filament settings*, then the **X** in
that dialog's upper right. Verified once, by hand. 495 of those is the fallback.

## Why the source is not enough

BambuStudio the slicer is open source (AGPL, `github.com/bambulab/BambuStudio`),
but **all cloud communication is closed source**. It lives in two binaries shipped
in `%APPDATA%\BambuStudioBeta\plugins\`:

```
bambu_networking.dll   20.9 MB
BambuSource.dll         5.4 MB
```

The public repo declares only the *interface* — the function pointers loaded from
those DLLs (see `src/slic3r/Utils/NetworkAgent.hpp` and `bambu_networking.hpp`).
Those headers are still valuable: they give the **function names and signatures**
of the preset-sync calls, which tells you what to look for in the binary and what
the parameters mean. Start there.

## Why not on the machine this was written on

It is a work computer. Both remaining approaches are unsuitable there:

- **HTTPS interception** requires installing a root CA certificate, which makes
  every TLS connection on the machine interceptable. Not acceptable on a work
  machine, and arguably not on any machine you did not choose to compromise.
- **Disassembly** of a vendor binary is a reasonable interoperability exercise on
  a personal machine, but is not something to do on employer hardware.

Do this on a personal machine, signed into the same Bambu account.

---

## Approach 1 — HTTPS interception (recommended, highest value per effort)

One hand-deleted preset reveals the entire mechanism: endpoint, method, headers,
auth scheme, and body shape. Everything else follows from that.

1. Install [mitmproxy](https://mitmproxy.org/) on the personal machine.
2. Start `mitmweb`. Configure the system proxy to point at it.
3. Install mitmproxy's CA certificate — **on that machine only**, and remove it
   when finished. This is the step that makes this personal-machine-only.
4. Launch Bambu Studio, sign in, let it sync.
5. **Delete exactly one eSUN preset through the UI.**
6. In mitmproxy, find the request. Record:
   - full URL and method
   - which identifier it carries — `setting_id` (`PFUS…`), `base_id` (`GFSB…`/`GFSL…`), or the name
   - the auth header name and token *type* (never record the token value)
   - request and response bodies
   - any preceding list/GET call, which is the safe dry-run endpoint

Then repeat once more to confirm the shape is stable, and check whether Studio
batches or serialises when several are deleted quickly.

**Also capture the list endpoint.** A read-only "list my presets" call is what
makes a safe dry run possible, and it is the first thing to implement.

## Approach 2 — Disassembly

Slower, but needs no certificate and no network interception.

1. Open `bambu_networking.dll` in Ghidra.
2. Get the exported symbol list first (`dumpbin /exports`, or Ghidra's Symbol
   Tree). Cross-reference against the function names declared in the open-source
   `bambu_networking.hpp` — that mapping is the shortcut, because the header tells
   you a function's purpose and signature before you read a line of assembly.
3. Look for the setting/preset functions, then trace to where the URL is built.
   Since no literal endpoint strings exist, expect runtime concatenation from
   fragments, or a decryption step — find where the base URL comes from.

## Approach 3 — Community clients (do this first, it is free)

Bambu's cloud has been reverse-engineered before, for printer telemetry. Check
whether any of it covers *user settings/presets*:

- `ha-bambulab` — the Home Assistant integration, the most maintained
  reverse-engineering of Bambu's cloud and MQTT
- `pybambu`, `bambulabs_api`, `bambu-connect`
- OrcaSlicer's history — it forked from Bambu Studio and may have removed or
  reimplemented the sync layer, and the removal diff would show the call sites

Most of these cover the printer, not the account's preset library. If none cover
presets, that is itself a finding: it means the tool is novel rather than
redundant, and it means there is no second source to cross-check against.

---

## Rules for whoever picks this up

These are not optional. This is a real account with irreplaceable data.

1. **Never print, log, echo or commit the session token.** Note its shape
   (e.g. "JWT, 3 segments") and where it lives. Never its value.
2. **Read before write.** Implement and verify the *list* endpoint before any
   delete. A tool that cannot list cannot dry-run, and a tool that cannot dry-run
   should not delete.
3. **Dry run by default.** Print exactly what would be deleted and require an
   explicit flag to act. Trim's own `delete-esun-presets.ps1` is a reasonable
   model for the safety shape.
4. **Protect the keeper by BOTH name and `setting_id`**, and abort if the number
   of matches deviates from what was expected. A rename should stop the run, not
   silently widen it.
5. **Back up before the first destructive call.** Cloud deletion is not
   recoverable by restoring local files — once the account drops a preset, the
   local copy is just an orphan.
6. **Rate limit.** Space the calls. 495 rapid deletes is indistinguishable from
   abuse, and getting the account throttled or flagged costs more than the time
   saved.
7. **Find the account's actual preset ceiling first.** If the limit is 200, the
   job is "delete 300", not "delete 495" — and the warning may clear long before
   the library is empty.

## The Trim question — deliberately unresolved

The owner's longer-term interest is batch preset management inside Trim, and
eventually automatic profile sync. That is a real product decision and is **not**
settled by this brief. The tension, stated plainly:

- `PRODUCT.md` commits Trim to *"Local-first and offline. No account, no backend,
  no telemetry."* Cloud sync contradicts that commitment directly.
- Trim's safety story rests on checksummed backups and verified rollback. **A
  cloud delete cannot be rolled back**, so that story does not extend to it.
- The API is undocumented and can change without notice. A broken sync would
  damage real presets belonging to people who are not the author.

A standalone tool that shares nothing with Trim but the safety discipline may be
the better home. Decide deliberately, not by momentum.

## Local reference

On the machine where this was written:

```
%APPDATA%\BambuStudioBeta\user\2572316032\filament\    496 .json + 496 .info
%APPDATA%\BambuStudioBeta\plugins\                     the closed-source DLLs
%APPDATA%\BambuStudioBeta\BambuStudio.conf             JSON + an MD5 trailer line
                                                       (strip it before parsing)
```

`.info` sidecar shape:

```
sync_info =
user_id = 2572316032
setting_id = PFUS4654b0cd4d268a
base_id = GFSL99_04
updated_time = 1785509620
```

`PFUS…` appears to be the per-user preset id and `GFSL…`/`GFSB…` the Bambu base
profile it inherits from — **unconfirmed**, and worth establishing early, because
deleting by the wrong identifier is the failure mode that reaches the keeper.
