# Deploying the YouTube queue to GitHub Actions

The workflow uploads **one** queued Short per hour-check, so the channel keeps
posting while nobody is at the laptop. Everything below is a one-off.

## What you have to do (I cannot — it needs your GitHub login)

### 1. Create the repo and push

    cd yt-publisher
    git init
    git add .
    git commit -m "yt-publisher + scheduled upload workflow"
    gh repo create lost-empires-yt --private --source=. --push
    # or make an empty PRIVATE repo on github.com and:
    #   git remote add origin git@github.com:<you>/lost-empires-yt.git
    #   git push -u origin main

**Make it private.** The queue contains your captions and posting schedule.

### 2. Add the secrets

Repo → Settings → Secrets and variables → Actions → *New repository secret*.
Copy each value out of your local `yt-publisher/.env`:

| Secret | Notes |
|---|---|
| `YT_CLIENT_ID` | |
| `YT_CLIENT_SECRET` | |
| `YT_REFRESH_TOKEN` | the long-lived one from `npm run auth` |
| `YT_CHANNEL_ID` | |
| `YT_CATEGORY_ID` | `27` (Education) if unsure |
| `YT_PRIVACY` | `public` |

`.gitignore` already excludes `.env`, so the file itself never leaves the laptop.

### 3. Prove it works before you fly

Actions tab → *Publish one Short* → **Run workflow**. It should either upload the
next due item or print "Nothing due". Do this at least once — the first run is
also what surfaces any bad secret, and you want to see that while you can fix it.

## How it behaves

- **Hourly at :17.** GitHub's scheduler is best-effort and can run late under
  load; for a daily-cadence queue that is irrelevant.
- **One upload per run, ever.** `queue.js` takes the first entry whose `at` has
  passed and which has no `posted` stamp.
- **The commit is the lock.** After a successful upload the workflow commits
  `queue.json` with the `posted` timestamp. If that commit fails, the next run
  would re-upload the same video — so if you see a push failure, check the
  channel before re-running.
- **Scheduled workflows switch off after 60 days of repo inactivity.** Any
  commit resets the clock. Irrelevant for one week away, worth knowing later.

## Turning it off

Actions tab → *Publish one Short* → ⋯ → **Disable workflow**. Or delete the
future rows from `queue.json` and push.

## ⚠ Do not run both schedulers at once

There is also a Windows task, **"YT Publisher Queue"**, running `run_queue.cmd`
hourly on the laptop. It reads the *local* `queue.json`; Actions reads the
*repo* copy and commits back to it. Once GitHub Actions is live those two copies
drift apart, and the same video can go up twice.

**Before you fly:** disable the Windows task.

    Task Scheduler → YT Publisher Queue → Disable

or from an admin PowerShell:

    Disable-ScheduledTask -TaskName "YT Publisher Queue"

Re-enable it when you are back if you would rather run locally again — but pull
the repo first so the local `queue.json` has the `posted` stamps Actions wrote.
