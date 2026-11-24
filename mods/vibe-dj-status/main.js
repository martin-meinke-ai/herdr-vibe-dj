import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, window, exec, hc, openOverlay, shared, setShared, checking } from "herdr";

const SPOTIFY_GREEN = "#1DB954";
const TIER_BADGES = {
  zen: { label: "Zen", color: "#38bdf8" },
  flow: { label: "Flow", color: "#1DB954" },
  cranking: { label: "Crank", color: "#f59e0b" },
  overdrive: { label: "Max", color: "#f43f5e" },
};

function truncate(str, max) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

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

export default class VibeDjStatus extends View {
  init(_props, cx) {
    this.spotify = null;
    this.spotifyBusy = false;
    this.vibeDj = null;
    this.vibeDjBusy = false;
    this.remoteMachine = undefined;
    this.lastSpotifySignal = shared("spotify.updated_at") ?? null;
    this.lastVibeDjSignal = shared("spotify.vibe_dj.updated_at") ?? null;

    if (checking()) return;

    this.refreshSpotify(cx);
    this.refreshVibeDj(cx);
    cx.timer.every(8000, (cx) => this.refreshSpotify(cx));
    cx.timer.every(15000, (cx) => {
      if (this.vibeDj?.enabled) {
        this.tickVibeDj(cx, false);
      }
    });
    cx.timer.every(3000, (cx) => {
      const spSig = shared("spotify.updated_at") ?? null;
      if (spSig && spSig !== this.lastSpotifySignal) {
        this.lastSpotifySignal = spSig;
        this.refreshSpotify(cx, true);
      }
      const djSig = shared("spotify.vibe_dj.updated_at") ?? null;
      if (djSig && djSig !== this.lastVibeDjSignal) {
        this.lastVibeDjSignal = djSig;
        this.refreshVibeDj(cx);
      }
    });
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

  refreshSpotify(cx, force = false) {
    if (this.spotifyBusy) return;
    this.spotifyBusy = true;
    cx.spawn(async (cx) => {
      try {
        const on = await this.resolveWorkstation();
        const args = force ? ["status", "--refresh"] : ["status"];
        const r = await exec("sh", ["-c", '"$HOME/.local/bin/herdr-spotify" "$@"', "_", ...args], { on, timeout: 10000 });
        if (r.code === 0 && r.stdout.trim()) {
          this.spotify = JSON.parse(r.stdout);
        }
      } catch {
      } finally {
        this.spotifyBusy = false;
        cx.notify();
      }
    });
  }

  spotifyAction(cx, cmd) {
    if (this.spotifyBusy) return;
    this.spotifyBusy = true;
    cx.spawn(async (cx) => {
      try {
        const on = await this.resolveWorkstation();
        const r = await exec("sh", ["-c", '"$HOME/.local/bin/herdr-spotify" "$@"', "_", cmd], { on, timeout: 12000 });
        if (r.code === 0 && r.stdout.trim()) {
          this.spotify = JSON.parse(r.stdout);
          const now = Date.now();
          this.lastSpotifySignal = now;
          setShared("spotify.updated_at", now);
        }
      } catch {
      } finally {
        this.spotifyBusy = false;
        cx.notify();
      }
    });
  }

  refreshVibeDj(cx) {
    if (this.vibeDjBusy) return;
    this.vibeDjBusy = true;
    const auto = computeAutoTier(Boolean(this.vibeDj?.inverse));
    cx.spawn(async (cx) => {
      try {
        const on = await this.resolveWorkstation();
        const r = await exec(
          "sh",
          ["-c", '"$HOME/.local/bin/herdr-spotify" "$@"', "_", "vibe-dj-status", "--working-agents", String(auto.working)],
          { on, timeout: 10000 },
        );
        if (r.code === 0 && r.stdout.trim()) {
          this.vibeDj = JSON.parse(r.stdout);
        }
      } catch {
      } finally {
        this.vibeDjBusy = false;
        cx.notify();
      }
    });
  }

  tickVibeDj(cx, force = false) {
    if (this.vibeDjBusy || !this.vibeDj?.enabled) return;
    this.vibeDjBusy = true;
    const auto = computeAutoTier(Boolean(this.vibeDj?.inverse));
    const args = ["vibe-dj-tick", "--working-agents", String(auto.working)];
    if (force) args.push("--force");
    cx.spawn(async (cx) => {
      try {
        const on = await this.resolveWorkstation();
        const r = await exec(
          "sh",
          ["-c", '"$HOME/.local/bin/herdr-spotify" "$@"', "_", ...args],
          { on, timeout: 20000 },
        );
        if (r.code === 0 && r.stdout.trim()) {
          this.vibeDj = JSON.parse(r.stdout);
        }
      } catch {
      } finally {
        this.vibeDjBusy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const openSpotify = () => openOverlay({ mod: "vibe-dj", kind: "dialog", width: 470, height: 420 });
    const sp = this.spotify;
    const spActive = Boolean(sp?.authenticated && sp?.active && sp?.track);
    const spPlaying = Boolean(sp?.is_playing);
    const spTrackLabel = spActive ? truncate(sp.artists ? `${sp.track} — ${sp.artists}` : sp.track, 34) : "♪ Spotify";
    const djOn = Boolean(this.vibeDj?.enabled);
    const djInv = Boolean(this.vibeDj?.inverse);
    const djTierId = this.vibeDj?.tier_override || computeAutoTier(djInv).tier;
    const djTier = TIER_BADGES[djTierId] || TIER_BADGES.flow;
    const djBadgeText = `${djInv ? "DJ↓" : "DJ"}·${djTier.label}${this.vibeDj?.tier_override ? "*" : ""}`;

    return h_flex()
      .gap(4)
      .items_center()
      .px(6)
      .py(2)
      .rounded(6)
      .text_size(11.8)
      .hover((s) => s.bg(t.hover))
      .child(
        h_flex()
          .id("vibe-dj-pill")
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click(openSpotify)
          .child(div().size(6).rounded(3).bg(spPlaying ? SPOTIFY_GREEN : spActive ? t.muted : t.dim))
          .child(
            div()
              .text_color(spPlaying ? t.foreground : t.muted)
              .hover((s) => s.text_color(t.foreground))
              .child(spTrackLabel),
          )
          .when(djOn, (el) =>
            el.child(
              div()
                .px(4)
                .py(1)
                .rounded(4)
                .bg(t.selected)
                .text_size(10)
                .font_semibold()
                .text_color(djTier.color)
                .child(djBadgeText),
            ),
          ),
      )
      .when(spActive, (el) =>
        el
          .child(
            div()
              .id("vibe-dj-prev")
              .px(3)
              .rounded(4)
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.spotifyAction(cx, "prev"))
              .child("⏮"),
          )
          .child(
            div()
              .id("vibe-dj-toggle")
              .px(3)
              .rounded(4)
              .cursor_pointer()
              .text_color(spPlaying ? SPOTIFY_GREEN : t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.spotifyAction(cx, spPlaying ? "pause" : "play"))
              .child(spPlaying ? "⏸" : "▶"),
          )
          .child(
            div()
              .id("vibe-dj-next")
              .px(3)
              .rounded(4)
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => this.spotifyAction(cx, "next"))
              .child("⏭"),
          ),
      );
  }
}
