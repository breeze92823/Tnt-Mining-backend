import { Room, Client, CloseCode } from "colyseus";
import { LobbyState, PlayerState } from "./schema/LobbyState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  LEADERBOARD_ROWS,
  PLAYTIME_FLUSH_MS,
  MONEY_MAX,
  DAMAGE_MAX,
  REBIRTH_MAX,
  ORE_MAX,
  UPGRADE_MAX,
  TNT_IDS,
  ORE_ITEMS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";

// One board per stat, matching the three leaderboards on the east stage of the hub
// (client data/world.js LB_BOARDS: Most Damage, Most Rebirths, Most Money).
const LEADERBOARD_STATS = ["damage", "rebirths", "money"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the
// same tick) down to one, keeping the higher value for the ranked stat.
// Guests have no id to key on and are never collapsed against each other.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

function clampInt(v: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(v)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Owned TNT types -> known ids only, no duplicates.
export function sanitizeTntOwned(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && TNT_IDS.includes(id)))];
}

// Held mined blocks { dirt, stone, ... } -> known ores only, non-negative integers.
export function sanitizeOres(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const item of ORE_ITEMS) {
    const n = raw[item];
    if (finite(n)) out[item] = clampInt(n, ORE_MAX);
  }
  return out;
}

// Same client-trusted model as the live `stats` message -- no server-side game-logic
// validation. What IS enforced: shape and bounds, so a malformed payload can never corrupt
// this player's own Mongo document. A forged number can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.money)) out.money = clampNum(raw.money, MONEY_MAX);
  if (finite(raw.gems)) out.gems = clampInt(raw.gems, MONEY_MAX);
  if (finite(raw.shells)) out.shells = clampInt(raw.shells, MONEY_MAX);
  if (finite(raw.rebirths)) out.rebirths = Math.max(1, clampInt(raw.rebirths, REBIRTH_MAX));
  if (finite(raw.clickPower)) out.clickPower = clampInt(raw.clickPower, DAMAGE_MAX);
  if (finite(raw.damage)) out.damage = clampNum(raw.damage, DAMAGE_MAX);
  for (const key of ["tnt", "carryMax", "placeMax", "range", "speed"] as const) {
    if (finite(raw[key])) out[key] = clampInt(raw[key] as number, UPGRADE_MAX);
  }
  if (raw.tntOwned !== undefined) out.tntOwned = sanitizeTntOwned(raw.tntOwned);
  if (typeof raw.tntEquipped === "string" && TNT_IDS.includes(raw.tntEquipped)) out.tntEquipped = raw.tntEquipped;
  if (raw.ores !== undefined) out.ores = sanitizeOres(raw.ores);
  return out;
}

/**
 * Single global room every client joins via `client.joinOrCreate("lobby")`.
 * Clients report their stats (the game is client-authoritative); this room stores them and
 * broadcasts the leaderboards. No server-side gameplay validation.
 */
export class LobbyRoom extends Room<{ state: LobbyState }> {
  state = new LobbyState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed in. Deliberately
  // NOT part of LobbyState: it only gates this room's own Mongo reads/writes.
  userIds = new Map<string, string>();

  // sessionId -> epoch ms up to which that connection's playtime has already been counted.
  private playTimeMark = new Map<string, number>();

  messages = {
    // Live stats for the leaderboards, sent debounced on change.
    stats: (client: Client, msg: { money?: number; damage?: number; rebirths?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.money)) p.money = clampNum(msg.money, MONEY_MAX);
      if (finite(msg?.damage)) p.damage = clampNum(msg.damage, DAMAGE_MAX);
      if (finite(msg?.rebirths)) p.rebirths = Math.max(1, clampInt(msg.rebirths, REBIRTH_MAX));
    },
    // Debounced push of the durable half of the client state. A guest has no userId and this
    // no-ops. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      // Display name comes from this connection's own PlayerState, not `msg`.
      const p = this.state.players.get(client.sessionId);
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...patch, username: p?.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[LobbyRoom] saveProgress failed", err);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). Without this a late sign-in would never get a userId and saveProgress
    // would no-op for the whole session.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for a full
  // LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
  }

  // Adds the seconds elapsed since this session's last mark to its live playTime and, for a
  // signed-in player, $inc's the same amount into Mongo. $inc (not $set) so it can't race
  // saveProgress and a client can never forge or reset its own time.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[LobbyRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush.
  private forgetSession(sessionId: string) {
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
  }

  onJoin(client: Client, options?: { username?: string; userId?: string }) {
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    void this.refreshLeaderboard();
  }

  // Client-trusted Bloxity user id. A forged id can only read/overwrite the SENDER's own save
  // (there is no cross-player read in `saveProgress`). Called from both onJoin and `identify`.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev) return; // no change -- e.g. a username-only identify

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never shows
      // as two leaderboard rows / two racing Mongo writers (a crashed tab lingers up to 20s
      // via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
      void this.loadProgress(client, userId, p);
    } else {
      // Logged out: stop persisting for this connection. The client flushes a final
      // saveProgress under the OLD id before sending this.
      this.userIds.delete(client.sessionId);
    }

    void this.refreshLeaderboard();
  }

  // Seeds this player's own leaderboard row immediately and sends the saved doc to just this
  // client so it can hydrate its state. A missing doc or unreachable Mongo leaves the client
  // on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    try {
      const doc = await players.findOne({ _id: userId });
      if (!doc) {
        // A brand-new account: tell the client there's nothing to load so it can start from
        // its defaults right away instead of waiting on a timeout.
        client.send("noProgress", {});
        return;
      }
      p.money = doc.money ?? 0;
      p.damage = doc.damage ?? 0;
      p.rebirths = doc.rebirths ?? 1;
      // Saved total (already includes anything flushed while signed in this session).
      p.playTime = doc.playTime ?? 0;
      client.send("progress", {
        money: doc.money ?? 0,
        gems: doc.gems,
        shells: doc.shells,
        rebirths: doc.rebirths,
        clickPower: doc.clickPower,
        damage: doc.damage,
        tnt: doc.tnt,
        carryMax: doc.carryMax,
        placeMax: doc.placeMax,
        range: doc.range,
        speed: doc.speed,
        tntOwned: sanitizeTntOwned(doc.tntOwned),
        tntEquipped: doc.tntEquipped,
        ores: sanitizeOres(doc.ores),
        playTime: p.playTime,
      });
    } catch (err) {
      console.warn("[LobbyRoom] loadProgress failed", err);
    }
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets 20s to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, 20);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online" leaderboard. Only the
  // server has both the live roster and the sessionId->userId map needed to tell "this online
  // player already IS a saved account" apart from "this saved account is offline". Private so
  // tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        damage: p.damage,
        rebirths: p.rebirths,
        money: p.money,
      });
    });

    const players = getPlayers();
    const payload = { damage: [], rebirths: [], money: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current than their last save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw Bloxity id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[LobbyRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a different id would
      // otherwise appear twice). Keep the higher value but prefer an online row's id so the
      // client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_ROWS);
    }

    this.broadcast("leaderboard", payload);
  }
}
