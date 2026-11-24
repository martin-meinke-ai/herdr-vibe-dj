import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, exec, hc, theme, props, closeOverlay, setShared, window, checking } from "herdr";

const SPOTIFY_GREEN = "#1DB954";
const PIN_AMBER = "#f59e0b";
const SPOTIFY_GREEN_HOVER = "#1ed760";
const SPOTIFY_DASHBOARD_URL = "https://developer.spotify.com/dashboard";

const TIERS = [
  { id: "zen", label: "Zen", badge: "Zen Focus", vibes: ["calm", "lofi", "acoustic"] },
  { id: "flow", label: "Flow", badge: "Steady Flow", vibes: ["chill-elec", "indie", "bachata"] },
  { id: "cranking", label: "Cranking", badge: "Cranking", vibes: ["electronic", "bachata", "synthwave"] },
  { id: "overdrive", label: "Overdrive", badge: "Overdrive", vibes: ["electronic", "bachata", "dnb"] },
];

const VIBE_LABELS = {
  custom: "★ Custom",
  calm: "Calm",
  lofi: "Lo-Fi",
  acoustic: "Acoustic",
  "chill-elec": "Chill Elec",
  indie: "Indie Groove",
  bachata: "Bachata",
  electronic: "Electronic",
  synthwave: "Synthwave",
  dnb: "DnB",
};

function computeAutoTier(inverse = false) {
  const list = agents() || [];
  const working = list.filter((a) => a.status === "working").length;
  let idx = 0;
  if (working >= 6) idx = 3;
  else if (working >= 4) idx = 2;
  else if (working >= 2) idx = 1;
  const order = inverse ? ["overdrive", "cranking", "flow", "zen"] : ["zen", "flow", "cranking", "overdrive"];
  return { tier: order[idx], working };
}

function fmtMs(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function truncate(str, max) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function artKeyFromUrl(url) {
  const s = String(url || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `art_${(h >>> 0).toString(16)}`;
}

const MAC_CALLBACK_LISTENER_PY = [
  "import http.server, socketserver, sys",
  "port = int(sys.argv[1])",
  "captured = []",
  "class S(socketserver.TCPServer):",
  "    allow_reuse_address = True",
  "class H(http.server.BaseHTTPRequestHandler):",
  "    def log_message(self, *a): pass",
  "    def do_GET(self):",
  "        if not self.path.startswith('/callback'):",
  "            self.send_response(404); self.end_headers(); return",
  "        captured.append(f'http://127.0.0.1:{port}{self.path}')",
  "        body = b'<html><body style=\"background:#111318;color:#e6edf3;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>Spotify Connected</h2><p style=\"color:#8b949e\">You can close this tab and return to Herdr.</p></div></body></html>'",
  "        self.send_response(200)",
  "        self.send_header('Content-Type', 'text/html; charset=utf-8')",
  "        self.send_header('Content-Length', str(len(body)))",
  "        self.end_headers()",
  "        self.wfile.write(body)",
  "srv = S(('127.0.0.1', port), H)",
  "srv.timeout = 180",
  "srv.handle_request()",
  "srv.server_close()",
  "if captured: print(captured[0], flush=True)",
].join("\n");

export default class VibeDj extends View {
  init(_props, cx) {
    this.data = null;
    this.loading = true;
    this.busyAction = false;
    this.error = "";
    this.notice = "";
    this.closed = false;
    this.remoteMachine = undefined;

    this.tab = "player"; // "player" | "vibe"
    this.vibeTierOverride = null; // null = auto from agents()
    this.vibeGenre = null;
    this.vibeOffset = 0;
    this.vibeLoading = false;
    this.vibeData = null;
    this.vibeInverse = false;
    this.vibeDj = null;
    this.vibeDjBusy = false;
    this.showVibePrefs = false;
    this.tasteText = "";
    this.tasteFocused = false;
    this.tierQueryText = "";
    this.tierQueryFocused = false;

    this.baseProgressMs = 0;
    this.baseAtMs = Date.now();

    this.artUrl = null;
    this.artRelPath = null;
    this.artLoading = false;

    this.showDevices = false;
    this.devices = [];
    this.devicesLoading = false;

    this.showClientIdEdit = false;
    this.authBusy = false;
    this.authPending = false;
    this.authUrl = "";

    this.clientIdText = "";
    this.clientIdFocused = false;
    this.clientIdInput = InputState.new({ placeholder: "Paste Spotify Client ID (32 hex chars)…" });
    this.clientIdInput.on("change", (_e, cx) => {
      this.clientIdText = this.clientIdInput.value();
      if (this.error) this.error = "";
      cx.notify();
    });
    this.clientIdInput.on("submit", (_e, cx) => this.saveClientId(cx));
    this.clientIdInput.on("focus", (_e, cx) => { this.clientIdFocused = true; cx.notify(); });
    this.clientIdInput.on("blur", (_e, cx) => { this.clientIdFocused = false; cx.notify(); });

    this.callbackText = "";
    this.callbackFocused = false;
    this.callbackInput = InputState.new({ placeholder: "Optional: paste http://127.0.0.1:18472/callback?code=…" });
    this.callbackInput.on("change", (_e, cx) => {
      this.callbackText = this.callbackInput.value();
      if (this.error) this.error = "";
      cx.notify();
    });
    this.callbackInput.on("submit", (_e, cx) => this.completeAuthManual(cx));
    this.callbackInput.on("focus", (_e, cx) => { this.callbackFocused = true; cx.notify(); });
    this.callbackInput.on("blur", (_e, cx) => { this.callbackFocused = false; cx.notify(); });

    this.tasteInput = InputState.new({ placeholder: "e.g. french house, khruangbin, nujabes…" });
    this.tasteInput.on("change", (_e, cx) => {
      this.tasteText = this.tasteInput.value();
      if (this.error) this.error = "";
      cx.notify();
    });
    this.tasteInput.on("submit", (_e, cx) => this.saveVibePrefs(cx));
    this.tasteInput.on("focus", (_e, cx) => { this.tasteFocused = true; cx.notify(); });
    this.tasteInput.on("blur", (_e, cx) => { this.tasteFocused = false; cx.notify(); });

    this.tierQueryInput = InputState.new({ placeholder: "Optional exact query for this tier…" });
    this.tierQueryInput.on("change", (_e, cx) => {
      this.tierQueryText = this.tierQueryInput.value();
      if (this.error) this.error = "";
      cx.notify();
    });
    this.tierQueryInput.on("submit", (_e, cx) => this.saveVibePrefs(cx));
    this.tierQueryInput.on("focus", (_e, cx) => { this.tierQueryFocused = true; cx.notify(); });
    this.tierQueryInput.on("blur", (_e, cx) => { this.tierQueryFocused = false; cx.notify(); });

    this.handle = cx.focus_handle();
    this.handle.focus();

    if (checking()) {
      this.loading = false;
      return;
    }

    this.load(cx, true);
    this.loadVibeDj(cx, true);
    cx.timer.every(5000, (cx) => {
      if (!this.closed && !this.busyAction && !this.authPending) {
        this.load(cx, false, true);
        if (this.vibeDj?.enabled && !this.vibeDjBusy) {
          this.loadVibeDj(cx, false);
        }
      }
    });
    cx.timer.every(1000, (cx) => {
      if (!this.closed && this.data?.active && this.data?.is_playing) {
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
  }

  dismiss() {
    this.closed = true;
    closeOverlay(props().overlay);
  }

  async resolveWorkstation() {
    const sp = spaces();
    const active = sp.find((s) => s.active);
    if (active?.machine) return active.machine;
    const anyRemote = sp.find((s) => s.machine);
    if (anyRemote?.machine) return anyRemote.machine;
    if (this.remoteMachine) return this.remoteMachine;
    if (this.remoteMachine === null && window()?.platform !== "macos") return null;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      if (r.code === 0) {
        const list = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary);
        if (list.length > 0) {
          this.remoteMachine = list[0].name;
          return this.remoteMachine;
        }
        if (window()?.platform !== "macos") {
          this.remoteMachine = null;
        }
      }
    } catch {}
    return null;
  }

  async runCli(args, timeout = 15000) {
    const on = await this.resolveWorkstation();
    const r = await exec("sh", ["-c", '"$HOME/.local/bin/herdr-spotify" "$@"', "_", ...args], { on, timeout });
    const raw = (r.stdout || "").trim();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {}
    }
    if (r.code !== 0) {
      throw new Error(parsed?.error || (r.stderr || raw || `exit ${r.code}`).trim());
    }
    if (!parsed) throw new Error("Empty response from herdr-spotify");
    return parsed;
  }

  applyStatus(d, cx) {
    this.data = d;
    this.baseProgressMs = Number(d?.progress_ms ?? 0);
    this.baseAtMs = Date.now();
    if (d?.error) {
      this.error = d.error;
    } else {
      this.error = "";
    }
    setShared("spotify.updated_at", Date.now());
    this.syncArtwork(d?.artwork_url || null, cx);
  }

  currentProgressMs() {
    if (!this.data?.active) return 0;
    const dur = Math.max(0, Number(this.data.duration_ms || 0));
    if (!this.data.is_playing) return Math.min(dur, this.baseProgressMs);
    const elapsed = Math.max(0, Date.now() - this.baseAtMs);
    return Math.min(dur, this.baseProgressMs + elapsed);
  }

  syncArtwork(url, cx) {
    if (!url) {
      this.artUrl = null;
      this.artRelPath = null;
      return;
    }
    if (url === this.artUrl && this.artRelPath) return;
    this.artUrl = url;
    const key = artKeyFromUrl(url);
    const rel = `mods/vibe-dj/art/${key}.jpg`;
    this.artLoading = true;
    cx.spawn(async (cx) => {
      try {
        const script = [
          'DIR="$HOME/.config/herdr-app/mods/vibe-dj/art"',
          'mkdir -p "$DIR"',
          'DEST="$DIR/$1.jpg"',
          'if [ ! -s "$DEST" ]; then curl -fsSL --max-time 8 "$2" -o "$DEST.tmp" && mv "$DEST.tmp" "$DEST"; fi',
          'ls -t "$DIR"/*.jpg 2>/dev/null | tail -n +25 | xargs -r rm -f 2>/dev/null || true',
          'test -s "$DEST"',
        ].join("\n");
        const r = await exec("sh", ["-c", script, "_", key, url], { timeout: 12000 });
        if (!this.closed && r.code === 0 && this.artUrl === url) {
          this.artRelPath = rel;
        }
      } catch {
      } finally {
        this.artLoading = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  load(cx, force = false, silent = false) {
    if (!silent) {
      this.loading = true;
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        const args = force ? ["status", "--refresh"] : ["status"];
        const d = await this.runCli(args);
        if (!this.closed) this.applyStatus(d, cx);
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.loading = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  activeTierId() {
    return this.vibeTierOverride || computeAutoTier(this.vibeInverse).tier;
  }

  hasCustomForTier(tierId) {
    const taste = (this.vibeDj?.taste || "").trim();
    const tq = ((this.vibeDj?.custom_queries || {})[tierId] || "").trim();
    return Boolean(taste || tq);
  }

  vibesForTier(tierId) {
    const tierSpec = TIERS.find((x) => x.id === tierId) || TIERS[1];
    return this.hasCustomForTier(tierId) ? ["custom", ...tierSpec.vibes] : [...tierSpec.vibes];
  }

  syncPrefsInputsForTier(tierId) {
    const taste = this.vibeDj?.taste || "";
    const tq = (this.vibeDj?.custom_queries || {})[tierId] || "";
    this.tasteText = taste;
    this.tierQueryText = tq;
    this.tasteInput.set_value(taste);
    this.tierQueryInput.set_value(tq);
  }

  toggleVibePrefs(cx) {
    this.showVibePrefs = !this.showVibePrefs;
    if (this.showVibePrefs) {
      this.syncPrefsInputsForTier(this.activeTierId());
    }
    cx.notify();
  }

  saveVibePrefs(cx) {
    const tierId = this.activeTierId();
    const taste = (this.tasteInput.value() || "").trim();
    const tierQuery = (this.tierQueryInput.value() || "").trim();
    const hasCustom = Boolean(taste || tierQuery);
    this.showVibePrefs = false;
    this.vibeOffset = 0;
    if (hasCustom) {
      this.vibeGenre = "custom";
    } else if (this.vibeGenre === "custom") {
      this.vibeGenre = null;
    }
    this.updateVibeDj(cx, {
      taste,
      tierQuery: `${tierId}=${tierQuery}`,
      vibe: hasCustom ? "custom" : "auto",
      noSync: !Boolean(this.vibeDj?.enabled),
      refreshSuggestions: true,
      notice: hasCustom ? "Saved custom music preferences" : "Cleared custom preferences",
    });
  }

  clearVibePrefs(cx) {
    const tierId = this.activeTierId();
    this.tasteInput.set_value("");
    this.tierQueryInput.set_value("");
    this.tasteText = "";
    this.tierQueryText = "";
    this.showVibePrefs = false;
    this.vibeOffset = 0;
    if (this.vibeGenre === "custom") this.vibeGenre = null;
    this.updateVibeDj(cx, {
      taste: "",
      tierQuery: `${tierId}=`,
      vibe: "auto",
      noSync: !Boolean(this.vibeDj?.enabled),
      refreshSuggestions: true,
      notice: "Reset to built-in vibes",
    });
  }

  applyVibeDjState(res, syncSelections = false) {
    if (!res) return;
    this.vibeDj = res;
    this.vibeInverse = Boolean(res.inverse);
    if (syncSelections) {
      this.vibeTierOverride = res.tier_override || null;
      if (res.vibe) this.vibeGenre = res.vibe;
    }
    if (!this.tasteFocused && !this.tierQueryFocused && !this.showVibePrefs) {
      this.tasteText = res.taste || "";
      this.tierQueryText = (res.custom_queries || {})[this.activeTierId()] || "";
    }
  }

  loadVibeDj(cx, syncSelections = false) {
    const auto = computeAutoTier(this.vibeInverse);
    cx.spawn(async (cx) => {
      try {
        const res = await this.runCli(["vibe-dj-status", "--working-agents", String(auto.working)]);
        if (!this.closed) this.applyVibeDjState(res, syncSelections);
      } catch {
      } finally {
        if (!this.closed) cx.notify();
      }
    });
  }

  updateVibeDj(cx, opts = {}) {
    if (this.vibeDjBusy) return;
    this.vibeDjBusy = true;
    this.error = "";
    cx.notify();

    const nextInverse = opts.inverse !== undefined ? Boolean(opts.inverse) : this.vibeInverse;
    const auto = computeAutoTier(nextInverse);
    const args = ["vibe-dj-set", "--working-agents", String(auto.working)];
    if (opts.enabled !== undefined) args.push("--enabled", opts.enabled ? "on" : "off");
    if (opts.inverse !== undefined) args.push("--inverse", opts.inverse ? "on" : "off");
    if (opts.tier !== undefined) args.push("--tier", opts.tier === null ? "auto" : String(opts.tier));
    if (opts.vibe !== undefined) args.push("--vibe", opts.vibe === null ? "auto" : String(opts.vibe));
    if (opts.taste !== undefined) args.push("--taste", String(opts.taste));
    if (opts.tierQuery !== undefined) args.push("--tier-query", String(opts.tierQuery));
    if (opts.noSync) args.push("--no-sync");

    cx.spawn(async (cx) => {
      try {
        const res = await this.runCli(args, 25000);
        if (!this.closed) {
          this.applyVibeDjState(res, false);
          setShared("spotify.vibe_dj.updated_at", Date.now());
          if (opts.notice) {
            this.notice = opts.notice;
          } else if (opts.enabled === true) {
            const added = (res.added || []).length;
            if (added > 0) {
              this.notice = `Auto-DJ on · queued ${truncate(res.added[0].track, 28)}`;
            } else if (res.last_action === "waiting" && res.next_queue_in_s) {
              this.notice = `Auto-DJ on · queues next in ${fmtMs(res.next_queue_in_s * 1000)}`;
            } else if (res.last_action === "paused" || res.last_action === "idle") {
              this.notice = "Auto-DJ armed · will queue when Spotify plays";
            } else if (res.last_error) {
              this.error = res.last_error;
            } else {
              this.notice = "Auto-DJ on";
            }
          } else if (opts.enabled === false) {
            this.notice = "Auto-DJ off";
          } else if (res.last_error) {
            this.error = res.last_error;
          }
          if (opts.refreshSuggestions) {
            this.loadSuggestions(cx, { tier: this.activeTierId(), offset: 0 });
          }
        }
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.vibeDjBusy = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  toggleAutoDj(cx) {
    const nextEnabled = !Boolean(this.vibeDj?.enabled);
    const tierArg = this.vibeTierOverride === null ? "auto" : this.vibeTierOverride;
    const opts = {
      enabled: nextEnabled,
      tier: tierArg,
    };
    if (this.vibeGenre) opts.vibe = this.vibeGenre;
    this.updateVibeDj(cx, opts);
  }

  toggleInverse(cx) {
    const nextInverse = !this.vibeInverse;
    this.vibeInverse = nextInverse;
    this.vibeOffset = 0;
    this.updateVibeDj(cx, {
      inverse: nextInverse,
      refreshSuggestions: this.tab === "vibe",
      notice: nextInverse ? "Inverse mode on · more agents → calmer music" : "Normal mode · more agents → higher energy",
    });
  }

  syncAutoDjNow(cx) {
    if (this.vibeDjBusy) return;
    this.vibeDjBusy = true;
    this.error = "";
    cx.notify();
    const auto = computeAutoTier(this.vibeInverse);
    cx.spawn(async (cx) => {
      try {
        const res = await this.runCli(["vibe-dj-tick", "--working-agents", String(auto.working), "--force"], 25000);
        if (!this.closed) {
          this.applyVibeDjState(res, false);
          setShared("spotify.vibe_dj.updated_at", Date.now());
          const added = (res.added || []).length;
          if (res.last_error) {
            this.error = res.last_error;
          } else if (added > 0) {
            this.notice = `Auto-DJ queued ${added} ${added === 1 ? "track" : "tracks"}`;
          } else {
            this.notice = `Auto-DJ synced · ${res.queued_ahead_count || 0} ahead`;
          }
        }
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.vibeDjBusy = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  loadSuggestions(cx, opts = {}) {
    const tierId = opts.tier ?? this.activeTierId();
    const availVibes = this.vibesForTier(tierId);
    const genre = opts.vibe && availVibes.includes(opts.vibe)
      ? opts.vibe
      : (this.vibeGenre && availVibes.includes(this.vibeGenre) ? this.vibeGenre : availVibes[0]);
    const offset = opts.offset !== undefined ? opts.offset : this.vibeOffset;

    this.vibeGenre = genre;
    this.vibeOffset = offset;
    this.vibeLoading = true;
    this.error = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const args = ["suggest", "--intensity", tierId, "--vibe", genre, "--offset", String(offset), "--limit", "5"];
        const res = await this.runCli(args);
        if (!this.closed) this.vibeData = res;
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.vibeLoading = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  openVibeTab(cx) {
    this.tab = "vibe";
    this.showDevices = false;
    if (!this.vibeData) {
      this.loadSuggestions(cx);
    } else {
      cx.notify();
    }
  }

  playSuggested(cx, track) {
    this.runAction(cx, ["play-uri", track.uri]);
    this.notice = `Playing ${truncate(track.track, 32)}`;
    this.tab = "player";
    cx.notify();
  }

  queueSuggested(cx, track) {
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        await this.runCli(["queue-uri", track.uri]);
        if (!this.closed) {
          this.notice = `Queued ${truncate(track.track, 32)}`;
          cx.notify();
        }
      } catch (e) {
        if (!this.closed) {
          this.error = String(e?.message || e);
          cx.notify();
        }
      }
    });
  }

  runAction(cx, args, optimisticFn = null) {
    if (this.busyAction) return;
    this.busyAction = true;
    this.error = "";
    this.notice = "";
    if (optimisticFn) optimisticFn();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const d = await this.runCli(args);
        if (!this.closed) this.applyStatus(d, cx);
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.busyAction = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  togglePlay(cx) {
    const playing = Boolean(this.data?.is_playing);
    this.runAction(cx, [playing ? "pause" : "play"], () => {
      if (this.data) {
        this.baseProgressMs = this.currentProgressMs();
        this.baseAtMs = Date.now();
        this.data = { ...this.data, is_playing: !playing };
      }
    });
  }

  seekTo(cx, targetMs) {
    const dur = Number(this.data?.duration_ms || 0);
    if (dur <= 0) return;
    const clamped = Math.max(0, Math.min(dur - 500, Math.round(targetMs)));
    this.runAction(cx, ["seek", String(clamped)], () => {
      this.baseProgressMs = clamped;
      this.baseAtMs = Date.now();
    });
  }

  setVolume(cx, pct) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    this.runAction(cx, ["volume", String(clamped)], () => {
      if (this.data) this.data = { ...this.data, volume_percent: clamped };
    });
  }

  toggleShuffle(cx) {
    const next = !this.data?.shuffle;
    this.runAction(cx, ["shuffle", next ? "on" : "off"], () => {
      if (this.data) this.data = { ...this.data, shuffle: next };
    });
  }

  cycleRepeat(cx) {
    const cur = this.data?.repeat || "off";
    const next = cur === "off" ? "context" : cur === "context" ? "track" : "off";
    this.runAction(cx, ["repeat", next], () => {
      if (this.data) this.data = { ...this.data, repeat: next };
    });
  }

  toggleLike(cx) {
    const tid = this.data?.track_id;
    if (!tid) return;
    const next = !this.data?.is_liked;
    this.runAction(cx, ["like", tid, next ? "on" : "off"], () => {
      if (this.data) this.data = { ...this.data, is_liked: next };
    });
  }

  toggleDevices(cx) {
    this.showDevices = !this.showDevices;
    cx.notify();
    if (!this.showDevices) return;
    this.devicesLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await this.runCli(["devices"]);
        if (!this.closed) this.devices = res.devices || [];
      } catch (e) {
        if (!this.closed) this.error = String(e?.message || e);
      } finally {
        this.devicesLoading = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  transferDevice(cx, deviceId) {
    this.showDevices = false;
    this.runAction(cx, ["transfer", deviceId]);
  }

  saveClientId(cx) {
    const cid = this.clientIdText.trim();
    if (!cid) {
      this.error = "Paste your Spotify Client ID first.";
      cx.notify();
      return;
    }
    this.error = "";
    this.notice = "";
    cx.spawn(async (cx) => {
      try {
        await this.runCli(["set-client-id", cid]);
        if (this.closed) return;
        this.showClientIdEdit = false;
        this.clientIdText = "";
        this.clientIdInput.set_value("");
        this.notice = "Client ID saved — click Connect Spotify to log in.";
        this.load(cx, true);
      } catch (e) {
        if (!this.closed) {
          this.error = String(e?.message || e);
          cx.notify();
        }
      }
    });
  }

  startAuth(cx) {
    if (this.authBusy) return;
    this.authBusy = true;
    this.error = "";
    this.notice = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const st = await this.runCli(["auth-start"]);
        if (this.closed) return;
        if (st.status !== "pending" || !st.auth_url) {
          throw new Error(st.error || "Failed to start Spotify login.");
        }
        this.authPending = true;
        this.authUrl = st.auth_url;
        this.notice = "Approve access in your browser…";
        cx.notify();

        if (window()?.platform === "macos") {
          const port = (() => {
            const m = String(st.redirect_uri || "").match(/:(\d+)\//);
            return m ? m[1] : "18472";
          })();
          cx.spawn(async (cx) => {
            try {
              const lr = await exec("python3", ["-c", MAC_CALLBACK_LISTENER_PY, port], { timeout: 185000 });
              const cbUrl = (lr.stdout || "").trim();
              if (!this.closed && this.authPending && cbUrl.includes("code=")) {
                await this.runCli(["auth-complete", cbUrl]);
                this.authPending = false;
                this.authBusy = false;
                this.notice = "Connected to Spotify!";
                this.load(cx, true);
              }
            } catch {}
          });
        }

        cx.open_url(st.auth_url);

        for (let i = 0; i < 120; i++) {
          await cx.sleep(1500);
          if (this.closed || !this.authPending) return;
          try {
            const cur = await this.runCli(["auth-status"], 8000);
            if (cur.status === "done" || cur.authenticated) {
              this.authPending = false;
              this.authBusy = false;
              this.notice = "Connected to Spotify!";
              this.load(cx, true);
              return;
            }
            if (cur.status === "error") {
              this.authPending = false;
              this.authBusy = false;
              this.error = cur.error || "Spotify authorization failed.";
              cx.notify();
              return;
            }
          } catch {}
        }
        this.authPending = false;
        this.authBusy = false;
        this.error = "Timed out waiting for Spotify authorization.";
      } catch (e) {
        this.authPending = false;
        this.authBusy = false;
        this.error = String(e?.message || e);
      } finally {
        if (!this.closed) cx.notify();
      }
    });
  }

  completeAuthManual(cx) {
    const raw = this.callbackText.trim();
    if (!raw) {
      this.error = "Paste the callback URL from your browser address bar.";
      cx.notify();
      return;
    }
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        await this.runCli(["auth-complete", raw]);
        if (this.closed) return;
        this.authPending = false;
        this.authBusy = false;
        this.callbackText = "";
        this.callbackInput.set_value("");
        this.notice = "Connected to Spotify!";
        this.load(cx, true);
      } catch (e) {
        if (!this.closed) {
          this.error = String(e?.message || e);
          cx.notify();
        }
      }
    });
  }

  disconnect(cx) {
    this.error = "";
    this.notice = "";
    cx.spawn(async (cx) => {
      try {
        await this.runCli(["logout"]);
        if (!this.closed) {
          this.artUrl = null;
          this.artRelPath = null;
          this.showDevices = false;
          this.vibeData = null;
          this.tab = "player";
          this.load(cx, true);
        }
      } catch (e) {
        if (!this.closed) {
          this.error = String(e?.message || e);
          cx.notify();
        }
      }
    });
  }

  pillBtn(id, label, onClick, opts = {}) {
    const t = theme();
    const green = Boolean(opts.green);
    const active = Boolean(opts.active);
    return div()
      .id(id)
      .px(opts.px ?? 9)
      .py(opts.py ?? 4)
      .rounded(6)
      .cursor_pointer()
      .text_size(opts.size ?? 11.5)
      .border_1()
      .border_color(green ? SPOTIFY_GREEN : active ? SPOTIFY_GREEN : t.border)
      .bg(green ? SPOTIFY_GREEN : active ? t.selected : t.raised)
      .text_color(green ? "#0b0f0c" : active ? SPOTIFY_GREEN : t.muted)
      .hover((s) =>
        s
          .bg(green ? SPOTIFY_GREEN_HOVER : t.hover)
          .text_color(green ? "#0b0f0c" : t.foreground),
      )
      .on_click(onClick)
      .child(label);
  }

  renderSetup(t) {
    const redirectUri = this.data?.redirect_uri || "http://127.0.0.1:18472/callback";
    const configured = Boolean(this.data?.configured) && !this.showClientIdEdit;

    return v_flex()
      .flex_1()
      .gap(10)
      .justify_center()
      .when(!configured, (el) =>
        el
          .child(
            v_flex()
              .p(12)
              .gap(8)
              .rounded(10)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("1. Create a free Spotify app (one-time)"))
              .child(
                div()
                  .text_size(11.5)
                  .text_color(t.muted)
                  .child("Open Spotify Developer Dashboard → Create app → add this Redirect URI (Web API):"),
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .flex_1()
                      .px(8)
                      .py(5)
                      .rounded(6)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(t.border)
                      .text_size(11)
                      .text_color(t.foreground)
                      .child(redirectUri),
                  )
                  .child(
                    this.pillBtn("sp-copy-uri", "Copy URI", (_e, cx) => {
                      cx.write_to_clipboard(redirectUri);
                      this.notice = "Redirect URI copied to clipboard.";
                      cx.notify();
                    }),
                  )
                  .child(
                    this.pillBtn("sp-open-dash", "Dashboard ↗", (_e, cx) => cx.open_url(SPOTIFY_DASHBOARD_URL)),
                  ),
              ),
          )
          .child(
            v_flex()
              .p(12)
              .gap(8)
              .rounded(10)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("2. Paste your Client ID"))
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .flex_1()
                      .h(30)
                      .px(8)
                      .rounded(6)
                      .bg(t.chrome)
                      .border_1()
                      .border_color(this.clientIdFocused ? SPOTIFY_GREEN : t.border)
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .child(Input.new(this.clientIdInput).h_full().text_size(12).text_color(t.foreground)),
                  )
                  .child(
                    this.pillBtn("sp-paste-cid", "Paste", (_e, cx) => {
                      const clip = cx.read_from_clipboard()?.trim();
                      if (clip) {
                        this.clientIdText = clip;
                        this.clientIdInput.set_value(clip);
                        cx.notify();
                      }
                    }),
                  )
                  .child(this.pillBtn("sp-save-cid", "Save", (_e, cx) => this.saveClientId(cx), { green: true })),
              ),
          ),
      )
      .when(configured, (el) =>
        el
          .child(
            v_flex()
              .p(16)
              .gap(10)
              .rounded(10)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .items_center()
              .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Connect your Spotify account"))
              .child(
                div()
                  .text_size(11.5)
                  .text_color(t.muted)
                  .child("Controls playback across MacBook, iPhone, Linux, and Web Player via PKCE OAuth."),
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(
                    this.pillBtn(
                      "sp-connect",
                      this.authBusy ? "Waiting for browser…" : "Connect Spotify",
                      (_e, cx) => this.startAuth(cx),
                      { green: true, px: 14, py: 6, size: 12.5 },
                    ),
                  )
                  .child(
                    this.pillBtn("sp-edit-cid", "Change Client ID", (_e, cx) => {
                      this.showClientIdEdit = true;
                      cx.notify();
                    }),
                  ),
              ),
          )
          .when(this.authPending, (sub) =>
            sub.child(
              v_flex()
                .p(10)
                .gap(6)
                .rounded(8)
                .bg(t.chrome)
                .border_1()
                .border_color(t.border)
                .child(
                  div()
                    .text_size(11)
                    .text_color(t.muted)
                    .child("Browser didn't auto-complete? Paste the redirected 127.0.0.1 URL below:"),
                )
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(
                      div()
                        .flex_1()
                        .h(28)
                        .px(8)
                        .rounded(6)
                        .bg(t.popover)
                        .border_1()
                        .border_color(this.callbackFocused ? SPOTIFY_GREEN : t.border)
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .child(Input.new(this.callbackInput).h_full().text_size(11.5).text_color(t.foreground)),
                    )
                    .child(
                      this.pillBtn("sp-paste-cb", "Paste", (_e, cx) => {
                        const clip = cx.read_from_clipboard()?.trim();
                        if (clip) {
                          this.callbackText = clip;
                          this.callbackInput.set_value(clip);
                          cx.notify();
                        }
                      }),
                    )
                    .child(this.pillBtn("sp-finish-cb", "Finish", (_e, cx) => this.completeAuthManual(cx), { green: true })),
                ),
            ),
          ),
      );
  }

  renderVibeDj(t) {
    const auto = computeAutoTier(this.vibeInverse);
    const activeTierId = this.activeTierId();
    const tierSpec = TIERS.find((x) => x.id === activeTierId) || TIERS[1];
    const availVibes = this.vibesForTier(activeTierId);
    const activeGenre = this.vibeGenre && availVibes.includes(this.vibeGenre) ? this.vibeGenre : availVibes[0];
    const hasAnyPrefs = Boolean((this.vibeDj?.taste || "").trim() || Object.keys(this.vibeDj?.custom_queries || {}).length > 0);
    const tracks = this.vibeData?.tracks || [];
    const djOn = Boolean(this.vibeDj?.enabled);
    const queuedAhead = this.vibeDj?.queued_ahead || [];
    const djAction = this.vibeDj?.last_action || "off";
    let djStatusText = "Auto-DJ active";
    if (queuedAhead.length > 0) {
      djStatusText = `Auto-DJ · Next: ${truncate(queuedAhead[0].track, 28)}`;
    } else if (djAction === "waiting" && this.vibeDj?.next_queue_in_s) {
      djStatusText = `Auto-DJ · queues next in ${fmtMs(this.vibeDj.next_queue_in_s * 1000)}`;
    } else if (djAction === "paused") {
      djStatusText = "Auto-DJ armed · resumes when playing";
    } else if (djAction === "idle") {
      djStatusText = "Auto-DJ armed · start Spotify to queue";
    } else if (djAction === "error" && this.vibeDj?.last_error) {
      djStatusText = `Auto-DJ error · ${truncate(this.vibeDj.last_error, 34)}`;
    }

    return v_flex()
      .flex_1()
      .gap(8)
      // Live agent load + intensity tier bar
      .child(
        v_flex()
          .p(10)
          .gap(7)
          .rounded(10)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Vibecode"))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(`${auto.working} ${auto.working === 1 ? "agent" : "agents"}`),
              )
              .child(div().flex_1())
              .when(this.vibeTierOverride !== null, (el) =>
                el.child(
                  div()
                    .id("vibe-auto-reset")
                    .px(7)
                    .py(2)
                    .rounded(6)
                    .cursor_pointer()
                    .bg(t.selected)
                    .border_1()
                    .border_color(PIN_AMBER)
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(PIN_AMBER)
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.vibeTierOverride = null;
                      this.vibeOffset = 0;
                      const nextTier = computeAutoTier(this.vibeInverse).tier;
                      this.loadSuggestions(cx, { tier: nextTier, offset: 0 });
                      this.updateVibeDj(cx, { tier: null, noSync: !djOn, notice: "Tier unpinned · following agents (Auto)" });
                    })
                    .child("× Unpin"),
                ),
              )
              .child(
                this.pillBtn(
                  "vibe-inverse-toggle",
                  this.vibeInverse ? "⇅ Calm↑" : "⇅ Inverse",
                  (_e, cx) => this.toggleInverse(cx),
                  { active: this.vibeInverse, px: 7, py: 2, size: 10.5 },
                ),
              )
              .child(
                this.pillBtn(
                  "vibe-autodj-toggle",
                  this.vibeDjBusy ? "…" : djOn ? "● Auto-DJ" : "Auto-DJ",
                  (_e, cx) => this.toggleAutoDj(cx),
                  { green: djOn, px: 8, py: 2, size: 10.5 },
                ),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .children(
                TIERS.map((tier) => {
                  const isPinned = this.vibeTierOverride === tier.id;
                  const isAutoTier = auto.tier === tier.id;
                  const isActive = activeTierId === tier.id;
                  const accentColor = isPinned ? PIN_AMBER : isActive ? SPOTIFY_GREEN : t.muted;
                  const borderColor = isPinned ? PIN_AMBER : isActive ? SPOTIFY_GREEN : t.border;
                  const labelText = isPinned
                    ? `${tier.label} (pin)`
                    : (this.vibeTierOverride !== null && isAutoTier ? `• ${tier.label}` : tier.label);
                  return div()
                    .id(`vibe-tier-${tier.id}`)
                    .flex_1()
                    .py(4)
                    .rounded(6)
                    .cursor_pointer()
                    .border_1()
                    .border_color(borderColor)
                    .bg(isActive ? t.selected : t.chrome)
                    .text_size(11)
                    .text_color(accentColor)
                    .flex()
                    .justify_center()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      if (this.vibeTierOverride === tier.id) {
                        this.vibeTierOverride = null;
                        this.vibeOffset = 0;
                        const nextTier = computeAutoTier(this.vibeInverse).tier;
                        if (this.showVibePrefs) this.syncPrefsInputsForTier(nextTier);
                        this.loadSuggestions(cx, { tier: nextTier, offset: 0 });
                        this.updateVibeDj(cx, { tier: null, noSync: !djOn, notice: "Tier unpinned · following agents (Auto)" });
                        return;
                      }
                      this.vibeTierOverride = tier.id;
                      const nextVibe = this.hasCustomForTier(tier.id) ? "custom" : tier.vibes[0];
                      this.vibeGenre = nextVibe;
                      this.vibeOffset = 0;
                      if (this.showVibePrefs) this.syncPrefsInputsForTier(tier.id);
                      this.loadSuggestions(cx, { tier: tier.id, vibe: nextVibe, offset: 0 });
                      this.updateVibeDj(cx, { tier: tier.id, vibe: nextVibe, noSync: !djOn, notice: `Pinned to ${tier.label} (click again or × Unpin for Auto)` });
                    })
                    .child(labelText);
                }),
              ),
          )
          // Genre pills + Prefs + Reroll
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .children(
                availVibes.map((v) =>
                  this.pillBtn(
                    `vibe-genre-${v}`,
                    VIBE_LABELS[v] || v,
                    (_e, cx) => {
                      this.vibeGenre = v;
                      this.vibeOffset = 0;
                      this.loadSuggestions(cx, { tier: activeTierId, vibe: v, offset: 0 });
                      this.updateVibeDj(cx, { vibe: v, noSync: !djOn });
                    },
                    { active: activeGenre === v, px: 7, py: 2, size: 10.5 },
                  ),
                ),
              )
              .child(div().flex_1())
              .child(
                this.pillBtn(
                  "vibe-prefs-btn",
                  this.showVibePrefs ? "Done" : hasAnyPrefs ? "✎ Prefs*" : "✎ Prefs",
                  (_e, cx) => this.toggleVibePrefs(cx),
                  { active: this.showVibePrefs || hasAnyPrefs, px: 7, py: 2, size: 10.5 },
                ),
              )
              .child(
                this.pillBtn(
                  "vibe-reroll",
                  this.vibeLoading ? "…" : "↻",
                  (_e, cx) => this.loadSuggestions(cx, { offset: this.vibeOffset + 1 }),
                  { px: 7, py: 2, size: 11 },
                ),
              ),
          )
          .when(djOn, (el) =>
            el.child(
              h_flex()
                .pt(2)
                .gap(6)
                .items_center()
                .child(div().size(6).rounded(3).bg(SPOTIFY_GREEN))
                .child(div().flex_1().text_size(10.5).text_color(t.muted).child(djStatusText))
                .child(
                  this.pillBtn(
                    "vibe-autodj-sync",
                    this.vibeDjBusy ? "…" : "↻ Sync",
                    (_e, cx) => this.syncAutoDjNow(cx),
                    { px: 6, py: 1, size: 10 },
                  ),
                ),
            ),
          ),
      )
      // Inline Music Preferences editor
      .when(this.showVibePrefs, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .p(10)
            .gap(8)
            .rounded(10)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(
              v_flex()
                .gap(3)
                .child(div().text_size(11).font_semibold().text_color(t.foreground).child("Global Music Taste (adapts across all tiers)"))
                .child(
                  div()
                    .h(28)
                    .px(8)
                    .rounded(6)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(this.tasteFocused ? SPOTIFY_GREEN : t.border)
                    .child(Input.new(this.tasteInput).h_full().text_size(11.5).text_color(t.foreground)),
                ),
            )
            .child(
              v_flex()
                .gap(3)
                .child(
                  div()
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.foreground)
                    .child(`${tierSpec.label} Tier Override (optional exact queries)`),
                )
                .child(
                  div()
                    .h(28)
                    .px(8)
                    .rounded(6)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(this.tierQueryFocused ? SPOTIFY_GREEN : t.border)
                    .child(Input.new(this.tierQueryInput).h_full().text_size(11.5).text_color(t.foreground)),
                ),
            )
            .child(
              div()
                .text_size(10.5)
                .text_color(t.dim)
                .child("Comma-separate artists, genres, or moods (e.g. 'fred again, rufus du sol, instrumental')."),
            )
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  this.pillBtn("vibe-prefs-save", "Save preferences", (_e, cx) => this.saveVibePrefs(cx), {
                    green: true,
                    px: 10,
                    py: 4,
                    size: 11,
                  }),
                )
                .child(
                  this.pillBtn("vibe-prefs-clear", "Clear", (_e, cx) => this.clearVibePrefs(cx), {
                    px: 9,
                    py: 4,
                    size: 11,
                  }),
                )
                .child(div().flex_1())
                .child(
                  this.pillBtn("vibe-prefs-cancel", "Cancel", (_e, cx) => {
                    this.showVibePrefs = false;
                    cx.notify();
                  }, { px: 8, py: 4, size: 11 }),
                ),
            ),
        ),
      )
      // Track list
      .when(!this.showVibePrefs, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .gap(4)
          .when(this.vibeLoading && tracks.length === 0, (el) =>
            el.child(
              v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(div().text_size(12).text_color(t.muted).child("Curating tracks for your vibe…")),
            ),
          )
          .when(!this.vibeLoading && tracks.length === 0, (el) =>
            el.child(
              v_flex()
                .flex_1()
                .items_center()
                .justify_center()
                .child(div().text_size(12).text_color(t.muted).child("No tracks returned — click New picks.")),
            ),
          )
          .children(
            tracks.map((tr, idx) =>
              h_flex()
                .id(`vibe-track-${idx}`)
                .px(9)
                .py(5)
                .gap(8)
                .items_center()
                .rounded(7)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .hover((s) => s.bg(t.hover))
                .child(
                  v_flex()
                    .flex_1()
                    .gap(1)
                    .overflow_hidden()
                    .child(div().text_size(12).font_semibold().text_color(t.foreground).child(truncate(tr.track, 32)))
                    .child(div().text_size(10.5).text_color(t.muted).child(truncate(tr.artists, 36))),
                )
                .child(div().text_size(10.5).text_color(t.dim).child(fmtMs(tr.duration_ms)))
                .child(
                  this.pillBtn(`vibe-q-${idx}`, "+Q", (_e, cx) => this.queueSuggested(cx, tr), {
                    px: 7,
                    py: 2,
                    size: 10.5,
                  }),
                )
                .child(
                  this.pillBtn(`vibe-play-${idx}`, "▶", (_e, cx) => this.playSuggested(cx, tr), {
                    green: true,
                    px: 8,
                    py: 2,
                    size: 10.5,
                  }),
                ),
            ),
          ),
        ),
      );
  }

  renderPlayer(t) {
    const d = this.data;
    const active = Boolean(d?.active);
    const playing = Boolean(d?.is_playing);
    const durMs = Math.max(0, Number(d?.duration_ms || 0));
    const progMs = this.currentProgressMs();
    const pct = durMs > 0 ? Math.min(100, Math.max(0, (progMs / durMs) * 100)) : 0;
    const vol = typeof d?.volume_percent === "number" ? d.volume_percent : 50;
    const repeat = d?.repeat || "off";
    const repeatLabel = repeat === "track" ? "↻ 1" : repeat === "context" ? "↻ All" : "↻";

    const seekBuckets = Array.from({ length: 20 }, (_, i) => i);
    const volSteps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const auto = computeAutoTier(this.vibeInverse);
    const activeTierId = this.activeTierId();
    const autoTierSpec = TIERS.find((x) => x.id === activeTierId) || TIERS[0];
    const djOn = Boolean(this.vibeDj?.enabled);

    return v_flex()
      .flex_1()
      .gap(10)
      .when(this.showDevices, (el) =>
        el.child(
          v_flex()
            .p(8)
            .gap(4)
            .rounded(8)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(div().text_size(11).font_semibold().text_color(t.muted).child("PLAYBACK DEVICES"))
            .when(this.devicesLoading, (s) => s.child(div().text_size(11.5).text_color(t.dim).child("Loading devices…")))
            .when(!this.devicesLoading && this.devices.length === 0, (s) =>
              s.child(div().text_size(11.5).text_color(t.dim).child("No active Spotify devices found. Open Spotify on any device.")),
            )
            .children(
              this.devices.map((dev, idx) =>
                h_flex()
                  .id(`sp-dev-${idx}`)
                  .px(8)
                  .py(5)
                  .gap(8)
                  .items_center()
                  .rounded(6)
                  .cursor_pointer()
                  .bg(dev.is_active ? t.selected : t.popover)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.transferDevice(cx, dev.id))
                  .child(div().size(7).rounded(4).bg(dev.is_active ? SPOTIFY_GREEN : t.dim))
                  .child(div().flex_1().text_size(12).text_color(dev.is_active ? SPOTIFY_GREEN : t.foreground).child(truncate(dev.name, 34)))
                  .child(div().text_size(10.5).text_color(t.dim).child(dev.type || "")),
              ),
            ),
        ),
      )
      .when(!active, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .p(20)
            .gap(8)
            .rounded(10)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .items_center()
            .justify_center()
            .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Nothing playing right now"))
            .child(div().text_size(11.5).text_color(t.muted).child("Start a track on your MacBook, phone, or pick one from Vibe DJ."))
            .child(
              h_flex()
                .gap(8)
                .mt(4)
                .child(this.pillBtn("sp-idle-play", "▶ Resume", (_e, cx) => this.runAction(cx, ["play"]), { green: true }))
                .child(this.pillBtn("sp-idle-vibe", "⚡ Vibe DJ", (_e, cx) => this.openVibeTab(cx)))
                .child(this.pillBtn("sp-idle-devices", "Devices", (_e, cx) => this.toggleDevices(cx))),
            ),
        ),
      )
      .when(active, (el) =>
        el
          // Track hero card
          .child(
            h_flex()
              .gap(14)
              .p(12)
              .rounded(12)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .items_center()
              .child(
                div()
                  .size(92)
                  .rounded(10)
                  .overflow_hidden()
                  .bg(t.chrome)
                  .border_1()
                  .border_color(t.border)
                  .flex()
                  .items_center()
                  .justify_center()
                  .when(Boolean(this.artRelPath), (a) => a.child(image(this.artRelPath).size(92)))
                  .when(!this.artRelPath, (a) => a.child(div().text_size(28).text_color(SPOTIFY_GREEN).child("♪"))),
              )
              .child(
                v_flex()
                  .flex_1()
                  .gap(4)
                  .overflow_hidden()
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(
                        div()
                          .flex_1()
                          .text_size(15)
                          .font_semibold()
                          .text_color(t.foreground)
                          .child(truncate(d.track, 30)),
                      )
                      .child(
                        div()
                          .id("sp-like")
                          .px(6)
                          .py(2)
                          .rounded(6)
                          .cursor_pointer()
                          .text_size(14)
                          .text_color(d.is_liked ? SPOTIFY_GREEN : t.muted)
                          .hover((s) => s.bg(t.hover).text_color(SPOTIFY_GREEN))
                          .on_click((_e, cx) => this.toggleLike(cx))
                          .child(d.is_liked ? "♥" : "♡"),
                      ),
                  )
                  .child(div().text_size(12.5).text_color(t.muted).child(truncate(d.artists, 36)))
                  .child(div().text_size(11).text_color(t.dim).child(truncate(d.album, 38))),
              ),
          )
          // Progress bar + timestamps
          .child(
            v_flex()
              .gap(5)
              .child(
                h_flex()
                  .h(8)
                  .rounded(4)
                  .overflow_hidden()
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .children(
                    seekBuckets.map((i) => {
                      const bucketEndPct = ((i + 1) / seekBuckets.length) * 100;
                      const filled = pct >= bucketEndPct - 2.5;
                      return div()
                        .id(`sp-seek-${i}`)
                        .flex_1()
                        .h_full()
                        .cursor_pointer()
                        .bg(filled ? SPOTIFY_GREEN : t.raised)
                        .hover((s) => s.bg(SPOTIFY_GREEN_HOVER))
                        .on_click((_e, cx) => this.seekTo(cx, ((i + 0.5) / seekBuckets.length) * durMs));
                    }),
                  ),
              )
              .child(
                h_flex()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(fmtMs(progMs))
                  .child(div().flex_1())
                  .child(fmtMs(durMs)),
              ),
          )
          // Transport controls
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .justify_center()
              .child(
                this.pillBtn("sp-shuffle", "⇄", (_e, cx) => this.toggleShuffle(cx), {
                  active: Boolean(d.shuffle),
                  px: 10,
                  py: 5,
                }),
              )
              .child(this.pillBtn("sp-prev", "⏮", (_e, cx) => this.runAction(cx, ["prev"]), { px: 12, py: 6, size: 13 }))
              .child(
                div()
                  .id("sp-playpause")
                  .px(18)
                  .py(7)
                  .rounded(20)
                  .cursor_pointer()
                  .bg(SPOTIFY_GREEN)
                  .text_color("#0b0f0c")
                  .text_size(14)
                  .font_semibold()
                  .hover((s) => s.bg(SPOTIFY_GREEN_HOVER))
                  .on_click((_e, cx) => this.togglePlay(cx))
                  .child(playing ? "⏸  Pause" : "▶  Play"),
              )
              .child(this.pillBtn("sp-next", "⏭", (_e, cx) => this.runAction(cx, ["next"]), { px: 12, py: 6, size: 13 }))
              .child(
                this.pillBtn("sp-repeat", repeatLabel, (_e, cx) => this.cycleRepeat(cx), {
                  active: repeat !== "off",
                  px: 10,
                  py: 5,
                }),
              ),
          )
          // Volume row
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .px(4)
              .child(div().text_size(11).text_color(t.muted).child("Vol"))
              .child(this.pillBtn("sp-vol-down", "−", (_e, cx) => this.setVolume(cx, vol - 10), { px: 7, py: 2 }))
              .child(
                h_flex()
                  .flex_1()
                  .gap(2)
                  .h(7)
                  .items_center()
                  .children(
                    volSteps.map((step) =>
                      div()
                        .id(`sp-vol-${step}`)
                        .flex_1()
                        .h(6)
                        .rounded(2)
                        .cursor_pointer()
                        .bg(vol >= step - 4 ? SPOTIFY_GREEN : t.raised)
                        .hover((s) => s.bg(SPOTIFY_GREEN_HOVER))
                        .on_click((_e, cx) => this.setVolume(cx, step)),
                    ),
                  ),
              )
              .child(this.pillBtn("sp-vol-up", "+", (_e, cx) => this.setVolume(cx, vol + 10), { px: 7, py: 2 }))
              .child(div().w(30).text_size(11).text_color(t.dim).child(`${vol}%`)),
          ),
      )
      // Compact Vibe DJ launcher strip + quick Auto-DJ toggle
      .child(
        h_flex()
          .px(10)
          .py(6)
          .gap(8)
          .items_center()
          .rounded(8)
          .bg(t.chrome)
          .border_1()
          .border_color(djOn ? SPOTIFY_GREEN : t.border)
          .child(
            h_flex()
              .id("sp-vibe-strip")
              .flex_1()
              .gap(7)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.openVibeTab(cx))
              .child(div().size(7).rounded(4).bg(SPOTIFY_GREEN))
              .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(`Vibe DJ: ${autoTierSpec.badge}`))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(`· ${auto.working} working${this.vibeInverse ? " · inv" : ""}`),
              ),
          )
          .child(
            this.pillBtn(
              "sp-strip-autodj",
              this.vibeDjBusy ? "…" : djOn ? "● Auto-DJ" : "Auto-DJ",
              (_e, cx) => this.toggleAutoDj(cx),
              { green: djOn, px: 8, py: 2, size: 10.5 },
            ),
          ),
      );
  }

  onKeyDown(e, cx) {
    if (e.key === "escape") {
      this.dismiss();
      return;
    }
    if (this.clientIdFocused || this.callbackFocused || this.tasteFocused || this.tierQueryFocused) return;
    if (!this.data?.authenticated) return;

    if (e.key === "space" || e.key === " ") {
      this.togglePlay(cx);
    } else if (e.key === "a") {
      this.toggleAutoDj(cx);
    } else if (e.key === "v") {
      if (this.tab === "vibe") {
        this.tab = "player";
        cx.notify();
      } else {
        this.openVibeTab(cx);
      }
    } else if (e.key === "n") {
      this.runAction(cx, ["next"]);
    } else if (e.key === "p") {
      this.runAction(cx, ["prev"]);
    } else if (e.key === "right") {
      this.seekTo(cx, this.currentProgressMs() + 10000);
    } else if (e.key === "left") {
      this.seekTo(cx, this.currentProgressMs() - 10000);
    } else if (e.key === "up") {
      const vol = typeof this.data?.volume_percent === "number" ? this.data.volume_percent : 50;
      this.setVolume(cx, vol + 10);
    } else if (e.key === "down") {
      const vol = typeof this.data?.volume_percent === "number" ? this.data.volume_percent : 50;
      this.setVolume(cx, vol - 10);
    } else if (e.key === "l") {
      this.toggleLike(cx);
    } else if (e.key === "s") {
      this.toggleShuffle(cx);
    } else if (e.key === "r") {
      this.cycleRepeat(cx);
    }
  }

  render() {
    const t = theme();
    const d = this.data;
    const authenticated = Boolean(d?.authenticated) && !d?.auth_required;
    const deviceName = d?.device?.name || "Devices";

    return v_flex()
      .id("spotify-dialog")
      .track_focus(this.handle)
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .on_key_down((e, cx) => this.onKeyDown(e, cx))
      // Header
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(9).rounded(5).bg(authenticated ? SPOTIFY_GREEN : t.dim))
          .child(div().text_size(14.5).font_semibold().child("Spotify"))
          .when(authenticated, (el) =>
            el
              .child(
                this.pillBtn("sp-tab-player", "Player", (_e, cx) => {
                  this.tab = "player";
                  cx.notify();
                }, { active: this.tab === "player", px: 8, py: 2, size: 11 }),
              )
              .child(
                this.pillBtn("sp-tab-vibe", "Vibe DJ", (_e, cx) => this.openVibeTab(cx), {
                  active: this.tab === "vibe",
                  px: 8,
                  py: 2,
                  size: 11,
                }),
              )
              .child(
                this.pillBtn("sp-devices-btn", truncate(deviceName, 14), (_e, cx) => this.toggleDevices(cx), {
                  active: this.showDevices,
                  px: 7,
                  py: 2,
                  size: 10.5,
                }),
              ),
          )
          .child(div().flex_1())
          .when(authenticated && Boolean(d?.track_url), (el) =>
            el.child(this.pillBtn("sp-open-track", "↗", (_e, cx) => cx.open_url(d.track_url), { px: 7, py: 2, size: 11 })),
          )
          .when(authenticated, (el) =>
            el.child(this.pillBtn("sp-refresh", this.loading ? "…" : "↻", (_e, cx) => this.load(cx, true), { px: 7, py: 2, size: 11 })),
          )
          .when(authenticated, (el) =>
            el.child(this.pillBtn("sp-logout", "Sign out", (_e, cx) => this.disconnect(cx), { px: 7, py: 2, size: 10.5 })),
          )
          .child(this.pillBtn("sp-close", "×", () => this.dismiss(), { px: 7, py: 2, size: 12 })),
      )
      // Notice / Error banners
      .when(Boolean(this.notice), (el) =>
        el.child(
          div()
            .px(10)
            .py(5)
            .rounded(6)
            .bg(t.raised)
            .border_1()
            .border_color(SPOTIFY_GREEN)
            .text_size(11.5)
            .text_color(SPOTIFY_GREEN)
            .child(this.notice),
        ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .px(10)
            .py(5)
            .rounded(6)
            .bg(t.raised)
            .border_1()
            .border_color(t.ansi1)
            .text_size(11.5)
            .text_color(t.ansi1)
            .child(truncate(this.error, 140)),
        ),
      )
      // Body
      .when(this.loading && !d, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .child(div().text_size(12).text_color(t.muted).child("Connecting to Spotify…")),
        ),
      )
      .when(!this.loading || Boolean(d), (el) =>
        el.child(
          !authenticated || this.showClientIdEdit
            ? this.renderSetup(t)
            : this.tab === "vibe"
              ? this.renderVibeDj(t)
              : this.renderPlayer(t),
        ),
      )
      // Footer hint
      .when(authenticated && !this.showClientIdEdit, (el) =>
        el.child(
          h_flex()
            .text_size(10.5)
            .text_color(t.dim)
            .child("Space play/pause · v Vibe DJ · a Auto-DJ · p/n prev/next · ←/→ seek · ↑/↓ vol · l like · Esc"),
        ),
      );
  }
}
