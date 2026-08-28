# Drive sync — LIVE

Folder: https://drive.google.com/drive/folders/1xyRvJ_fO-3wDjr5SN5m9WBFGUqcebTOI

```
Lost Empires/
  videos/   <- every baked *_tiktok.mp4, automatically
  covers/   <- thumbnails
  yt-publisher.zip
```

## How it works

Drive for Desktop mounts My Drive as a local drive letter, so syncing is a
plain file copy — no upload step, no size limit, no credentials in the path.

`drive_sync.sh` is called automatically at the end of
`ig-publisher/bake_cover.sh`. Every published video passes through that script,
so every published video lands in Drive without anyone remembering to do it.

    bash drive_sync.sh <file> [<file> ...]   # copy specific files
    bash drive_sync.sh --status              # mount + what is already synced

## Design notes

- **The mount letter is detected at runtime, not hardcoded.** Drive for Desktop
  takes the first free letter (currently G:), which can move between reboots or
  if another volume claims it. The script scans G: through Z: for `My Drive`.
- **The hook is non-fatal.** If Drive is unmounted or paused, the copy is
  skipped with a note and the render still succeeds. A sync failure must never
  cost a build.
- **Unchanged files are skipped** (same size, not newer). Re-copying an
  identical file makes Drive re-upload it and churn version history.

## Why videos could not go via the Drive API

File content has to pass through the model context as base64 to reach the Drive
tool. These renders are 12-18 MB each — roughly 16-24 MB of base64 — orders of
magnitude past a single request. There is no upload-from-URL on the tool, and
browsers block scripts from setting a file input, so automating the web UI does
not work either. The synced folder sidesteps all of it.

Verified 2026-08-23: 9 videos (132 MB) confirmed present server-side via the
Drive API, not just locally.
