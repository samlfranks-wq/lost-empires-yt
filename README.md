# yt-publisher

Uploads Shorts to YouTube from a public video URL via the Data API v3.
Zero dependencies — Node 18+ native `fetch`. Mirrors `ig-publisher` deliberately:
same `.env`, same `queue.json` shape, same one-item-per-run safety rule.

## The one thing to know before you start

**Uploads from an unverified API project are force-locked to `private`,**
regardless of what `privacyStatus` you send. This is a YouTube policy for every
API project created after 28 July 2020. Lifting it requires passing a YouTube
API compliance audit.

So there are two phases:

| | Upload | Metadata | Thumbnail | Goes public |
|---|---|---|---|---|
| **Before audit** | automatic | automatic | automatic | you flip it in Studio |
| **After audit** | automatic | automatic | automatic | automatic |

Even before the audit this is still worth running — it does the download,
upload, title, description, tags and thumbnail. You click one button per video
instead of doing the whole upload by hand.

## Setup — the parts only you can do

I can't create accounts or enter credentials, so these five steps are yours.

1. **Create the YouTube channel.** Sign in to youtube.com with the Google account
   that should own it, then Settings -> Channel -> *Create a new channel*. Make it a
   **Brand Account** channel, not the personal one tied to your name — a Brand Account
   can be renamed, handed to a manager, and kept separate from your personal identity.
   Name it Lost Empires AI and set the handle to match the Instagram one.

   Then **verify by phone** (youtube.com/verify). Without it the API upload still
   succeeds but the custom thumbnail is silently skipped — and the frame-0 cover is
   half the reason this pipeline exists.

   When `npm run auth` opens the consent screen, Google will ask which channel to
   authorise. **Pick the Brand Account**, not your personal channel. Choosing wrong
   here is the single most common way this ends up uploading to the wrong place —
   `npm run check` prints the channel name so you can catch it immediately.

2. **Create a Google Cloud project** at `console.cloud.google.com`.

3. **Enable the API**: APIs & Services → Library → *YouTube Data API v3* → Enable.

4. **Create OAuth credentials**: APIs & Services → Credentials →
   Create credentials → OAuth client ID → **Desktop app**.
   Copy the client ID and secret.

5. **Set the consent screen to "In production"**
   (APIs & Services → OAuth consent screen). If it stays in *Testing*, refresh
   tokens die after 7 days and the queue silently stops.

Then:

```bash
cd yt-publisher
cp .env.example .env
```

Paste `YT_CLIENT_ID` and `YT_CLIENT_SECRET` into `.env` — **into the file, not
into chat.** They are live credentials with upload rights on your channel.

```bash
npm run auth     # opens Google consent, writes YT_REFRESH_TOKEN to .env
npm run check    # confirms which channel you are pointed at
```

`auth.js` starts a listener on a random loopback port. **There is nothing to register** —
a Desktop-app OAuth client accepts any `http://127.0.0.1:<port>` redirect. If you get
`redirect_uri_mismatch`, the OAuth client was created as **Web application** instead of
**Desktop app**; delete it and make a Desktop one.

## Use

```bash
# dry run — shows exactly what would be sent, uploads nothing
node post.js --url https://cdn/video.mp4 --caption-file cap.txt --cover https://cdn/thumb.jpg

# actually upload
node post.js --url https://cdn/video.mp4 --caption-file cap.txt --cover https://cdn/thumb.jpg --confirm
```

The **first line of the caption becomes the title** (capped at 100 chars,
`#Shorts` appended if it fits). The whole caption becomes the description.

## Scheduling

`queue.json` uses the same format as the Instagram queue:

```json
[
  {
    "at": "2026-08-29T18:00:00Z",
    "url": "https://.../video.mp4",
    "cover": "https://.../thumb.jpg",
    "caption": "First line is the title.\n\nRest is the description."
  }
]
```

`at` is **UTC** — during British Summer Time that is one hour behind the clock,
so `18:00Z` fires at 19:00 local.

```bash
node queue.js            # dry run: what is due
node queue.js --confirm  # upload the one due item
```

Register `run_queue.cmd` with Windows Task Scheduler on an hourly trigger, the
same way the IG queue runs. It uploads **at most one item per run**, so a bad
queue can never dump the backlog onto the channel at once. Results append to
`queue.log`, and the outcome is written back to `queue.json` before anything
else, so a crash after upload can't double-post.

## Quota

`videos.insert` cost dropped from ~1,600 units to ~100 on 4 December 2025.
Against the default 10,000 units/day that is roughly **100 uploads a day** — the
quota is not a constraint for one post a day.

## AI disclosure

The altered/synthetic-content toggle stays **OFF**, same as every other
platform. The Data API does not expose the flag at all, so `post.js` never
sets it — but when you are in Studio flipping a video public, leave the
"altered or synthetic content" switch off. Do not turn it on.

## Gotchas

- **Custom thumbnails need a phone-verified channel.** Without it the upload
  succeeds and only the thumbnail is skipped — `post.js` prints why and carries on.
- **`invalid_grant` on refresh** almost always means the consent screen went
  back to *Testing*. Set it to *In production* and re-run `npm run auth`.
- **YouTube has no upload-from-URL**, unlike Instagram. The bytes are pulled to
  this machine and pushed up, so the CDN URL must still be live at upload time.
  Higgsfield CDN links expire — re-upload if a queued item is more than a day old.
