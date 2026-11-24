# Herdr Vibe DJ

A Spotify mini-player and adaptive **Vibe DJ** plugin for [Herdr](https://herdr.dev) that reads your live coding-agent load and automatically queues the next song right before your current track ends.

Zero external Python dependencies — just Python 3.10+ stdlib and two lightweight Herdr mods.

## Features

- **Spotify Mini-Player (`⌘⇧M` / `Ctrl+Alt+M`)**: Play/pause, seek, volume, shuffle, repeat, like/unlike, album art, and device switching right inside Herdr.
- **Vibecode Meter**: Maps your live working agent count into 4 energy tiers:
  - `0–1` working agents → **Zen Focus**
  - `2–3` working agents → **Steady Flow**
  - `4–5` working agents → **Cranking**
  - `6+` working agents → **Overdrive**
- **Just-in-Time Auto-DJ (`● Auto-DJ`)**: Toggle once and close the dialog. About **60 seconds before the current song ends**, Vibe DJ checks your live agent load and queues **1** fresh track (never spamming or bloating your Spotify queue).
- **Inverse Calm Mode (`⇅ Inverse` / `⇅ Calm↑`)**: Flip the energy curve so *more* working agents gives you *calmer* music (`6+` → Zen Focus, `0–1` → Overdrive).
- **Custom Music Preferences (`✎ Prefs`)**: Set your own global taste (e.g., `french house, khruangbin, instrumental` or `bachata, the blaze`) that automatically adapts across all 4 tiers, plus optional per-tier query overrides.

---

## Install

### Local machine (Mac or Linux running Herdr locally)

```bash
git clone https://github.com/martin-meinke-ai/herdr-vibe-dj.git
cd herdr-vibe-dj
./install.sh
```

### MacBook Herdr UI + Remote Linux Workstation (`hc` machine)

Run `--ui-only` on your MacBook and `--cli-only` on your remote Linux workstation:

```bash
# On your MacBook (UI mods + shortcuts):
git clone https://github.com/martin-meinke-ai/herdr-vibe-dj.git
cd herdr-vibe-dj && ./install.sh --ui-only

# On your remote Linux workstation (Spotify CLI backend):
git clone https://github.com/martin-meinke-ai/herdr-vibe-dj.git
cd herdr-vibe-dj && ./install.sh --cli-only
```

---

## Connect Your Spotify Account

Spotify Web API playback control requires a **Spotify Premium** account and a free Spotify Developer **Client ID** (uses OAuth PKCE — no client secret needed).

### Step 1: Create a free Spotify Developer App (takes ~1 minute)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app**.
3. Fill in:
   - **App name**: `Herdr Vibe DJ` (anything you like)
   - **App description**: `Local Herdr Spotify controller`
   - **Redirect URI**:
     ```text
     http://127.0.0.1:18472/callback
     ```
     *(Important: use `127.0.0.1`, not `localhost`, and click **Add** before saving.)*
   - Under **Which API/SDKs are you planning to use?**, check **Web API**.
4. Click **Save**, then open **Settings** and copy your **Client ID** (32 alphanumeric characters).

### Step 2: Sign in from Herdr

1. Reload or restart Herdr, then press **`⌘⇧M`** (macOS) or **`Ctrl+Alt+M`** (Linux) to open **Spotify / Vibe DJ**.
2. Paste your **Client ID** and click **Save Client ID**.
3. Click **Connect Spotify** — your browser opens Spotify’s consent screen.
4. Click **Agree**. Herdr captures the `127.0.0.1:18472/callback` redirect automatically and connects.
   - *Manual fallback*: If your browser doesn’t auto-complete (e.g., strict firewall), copy the full `http://127.0.0.1:18472/callback?code=...` URL from your browser’s address bar and paste it into the fallback box in the setup dialog.
5. Start playing a song on any Spotify device (MacBook, phone, desktop app) so Spotify has an active playback device.

### Privacy & Storage

- Uses OAuth 2.0 **PKCE** (no client secret stored anywhere).
- Your Client ID, tokens, and Vibe DJ state are stored locally with `0600` permissions in `~/.local/state/herdr-spotify/`.

---

## Optional: Status Bar Pill & Background Auto-DJ Runner

To keep Auto-DJ running after you close the `⌘⇧M` dialog (and show a now-playing pill + `DJ` / `DJ↓` badge in your bottom bar), add `vibe-dj-status` to your Herdr layout JSON (`~/.config/herdr-app/layouts/<your-layout>.json`):

```json
{
  "id": "vibe-dj-status",
  "type": "block",
  "content": { "mod": "vibe-dj-status" },
  "size": { "px": 28 }
}
```

---

## Keyboard Shortcuts (inside the Vibe DJ dialog)

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `v` | Switch between Player & Vibe DJ tabs |
| `a` | Toggle **Auto-DJ** on / off |
| `p` / `n` | Previous / Next track |
| `←` / `→` | Seek -10s / +10s |
| `↑` / `↓` | Volume +10% / -10% |
| `l` | Like / Unlike current track |
| `s` / `r` | Toggle Shuffle / Cycle Repeat |
| `Esc` | Close dialog |

---

## CLI Usage

`~/.local/bin/herdr-spotify` also works standalone from any terminal:

```bash
herdr-spotify status
herdr-spotify vibe-dj-status --working-agents 4
herdr-spotify vibe-dj-set --enabled on --inverse on --taste "french house, khruangbin"
herdr-spotify vibe-dj-set --tier-query "zen=bill evans piano, nils frahm"
herdr-spotify vibe-dj-tick --working-agents 6
```

## Troubleshooting

- **"No active Spotify device found"**: Open Spotify on your laptop or phone and play any track once so Spotify registers an active device.
- **403 on Play/Pause**: Spotify Web API playback control requires a Spotify Premium account.
- **Run unit tests**:
  ```bash
  python3 tests/test_herdr_spotify.py -v
  ```
