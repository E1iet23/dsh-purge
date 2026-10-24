# DSH Desktop 0.12.1 / Harness 0.2.1-rc.2 compatibility

This fork retains the 1.1.71 features, UI, skills and prompt assets. The local
version is `1.1.71-compat.0.2.1-rc.2.4` (validated compatibility backport).

## Desktop installation

DSH Desktop 0.12.1 runs the `web` profile in its own home:
`%APPDATA%\dsh-desktop\harness`. Its reserved `desktop` profile cannot be managed
with `dsh plugin`. An independent `dsh web` installation can have another home;
check `DSH_HOME` before installing.

Fully quit the desktop application, including its tray icon. With the CLI using
the desktop home, install this fork's archive:

```powershell
dsh plugin --profile web add "https://github.com/E1iet23/dsh-purge/archive/refs/heads/master.tar.gz"
```

Reopen the desktop application. Leave the normal window open for at least
60 seconds on the first migration so the desktop can confirm startup. Apply
is blocked while the desktop's migration journal is unconfirmed; the plugin
never confirms or discards that journal itself.
In dsh-purge, choose Clean / Apply. After a
successful restart, start a new conversation and check `/purge status`.

For a local download, prefer packing the folder and installing the resulting
archive instead of retaining a mutable `link:` installation:

```powershell
npm pack --ignore-scripts
# Use the .tgz filename printed by npm:
dsh plugin --profile web add "./dsh-purge-1.1.71-compat.0.2.1-rc.2.4.tgz"
```

## Additional compatibility repairs

- Cordis is a host integration, not a direct runtime import in this plugin.
  Declare its peer optional so the desktop generation validator accepts a
  source/package installation without a private Cordis copy. This does not
  bypass the desktop's validation code or install another host singleton.
- Installed preset anchor modules use absolute file URLs so desktop legacy
  preset migration does not resolve `./anchor-gate.mjs` against the profile.
- For already migrated profiles, repair only the anchor module field inside
  the desktop-generated `preset-redteam` entry. Preserve the first copy as
  `cordis.patch.yml.dsh-purge-desktop-compat.bak`. Keep prompts, other presets
  and all other configuration bytes unchanged. The profile watcher can reload
  the repaired declaration; the old path diagnostic may precede that reload.
- Reuse a desktop-owned redteam declaration without registering or disposing
  it. If the desktop declaration starts later, wait for it instead of racing
  its registration. Standalone hosts retain plugin-owned registration.
- Respect `.generations-pre-migration.json` before patching or restarting.
  An unconfirmed first boot must not be interrupted by Apply.
- Windows PowerShell on the tested machine exits 0 without executing `-File`
  under the previous `detached` flag. Use a short-lived broker to start a hidden
  independent worker. The worker owns stop/swap/relaunch; no timer forcibly
  exits Harness. Its transcript is `%TEMP%\dsh-purge-asar-swap.log`.
- The unpacked desktop bootstrap retains the installed `resources/office-runtime`
  assets instead of choosing the development-only `.build/office-runtime` path.
  The original bootstrap is saved as `harness-node-entry.mjs.dsh-purge.bak`.
- Restart helpers select a native Node executable, skipping `.cmd` shims that
  cause `spawn EINVAL` when used without a shell.

## Validation

Run `node --test scripts/check-desktop-compat.mjs` for migration scoping, literal
prompt preservation, mixed newlines, backup/idempotence, ownership, loading
order and isolated plugin startup tests.

Run `node --test scripts/check-desktop-restart.mjs` for migration barriers,
launch failure, quoting and a real Windows stop/archive swap/relaunch test
using a temporary Node executable and dummy archive. This test does not
target the installed desktop process or archive.

The installed desktop's original `verifyGenerationPeers` was also run against
isolated before/after manifests: the original required peer reproduced the
reported error; the optional peer passed. No desktop executable/archive was
modified by the isolated tests. Local desktop acceptance also exercised the
early-Apply barrier, native ASAR swap, application relaunch, unpacked Office
bootstrap, and a subsequent Apply/restart. The final local version returned
`complete: true`, `failed: 0`; after relaunch its status showed 60 applied and
0 pending. Model response behavior is outside this startup/restart acceptance.
