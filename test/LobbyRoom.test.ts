import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import { sanitizeProgress, sanitizeOres, sanitizeTntOwned, resolveTutorialStep } from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// Hand-rolled fake `players` collection implementing only the subset LobbyRoom.ts calls:
// find().sort().limit().toArray(), updateOne() (upsert, $set/$inc), findOne().
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next = { ...base, ...(update.$set ?? {}) } as any;
      for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
      for (const [k, v] of Object.entries(update.$max ?? {})) next[k] = Math.max(next[k] ?? -Infinity, v as number);
      docs.set(filter._id, next as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return { _id: "test", money: 0, version: 1, updatedAt: new Date(), ...overrides };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The `progress` / `noProgress` reply can land before a client-side handler is registered, so
// capture what the server sends on the server side.
function captureSends(room: any) {
  const sent: [string, any][] = [];
  const origLoad = room.loadProgress.bind(room);
  room.loadProgress = (c: any, ...rest: any[]) => {
    const origSend = c.send.bind(c);
    c.send = (type: string, msg: any) => {
      sent.push([type, msg]);
      origSend(type, msg);
    };
    return origLoad(c, ...rest);
  };
  return sent;
}

describe("LobbyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Tests that swap in a fake collection reset it so the others keep exercising the real
  // "no MONGODB_URI" no-op path.
  afterEach(() => __setPlayersForTest(null));

  it("syncs live stats and clamps bad values", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { username: "Boomer" });
    const client2 = await colyseus.connectTo(room);

    client1.send("stats", { money: 250.5, damage: 1200, rebirths: 3 });
    await room.waitForNextPatch();
    const s = client2.state.players.get(client1.sessionId)!;
    assert.strictEqual(s.username, "Boomer");
    assert.strictEqual(s.money, 250.5);
    assert.strictEqual(s.damage, 1200);
    assert.strictEqual(s.rebirths, 3);

    client1.send("stats", { money: -5, damage: NaN, rebirths: 0 });
    await room.waitForNextPatch();
    const s2 = client2.state.players.get(client1.sessionId)!;
    assert.strictEqual(s2.money, 0);
    assert.strictEqual(s2.damage, 1200); // NaN ignored
    assert.strictEqual(s2.rebirths, 1);
  });

  it("saves progress for a signed-in player and sends it back on the next join", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const sent = captureSends(room);
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    await sleep(50);
    assert.ok(sent.some(([t]) => t === "noProgress"));

    c.send("saveProgress", {
      money: 1234,
      rebirths: 2,
      damage: 99,
      tntOwned: ["classic", "green", "bogus"],
      tntEquipped: "green",
      ores: { dirt: 5, stone: 2.9, bogus: 1 },
    });
    await sleep(80);
    const doc = fake.docs.get("u1")!;
    assert.strictEqual(doc.money, 1234);
    assert.strictEqual(doc.username, "Ann");
    assert.deepStrictEqual(doc.tntOwned, ["classic", "green"]);
    assert.deepStrictEqual(doc.ores, { dirt: 5, stone: 2 });

    const room2 = await colyseus.createRoom<LobbyState>("lobby", {});
    const sent2 = captureSends(room2);
    await colyseus.connectTo(room2, { userId: "u1", username: "Ann" });
    await sleep(100);
    const progress = sent2.find(([t]) => t === "progress")![1];
    assert.strictEqual(progress.money, 1234);
    assert.strictEqual(progress.rebirths, 2);
    assert.strictEqual(progress.tntEquipped, "green");
  });

  it("ignores saves from guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const guest = await colyseus.connectTo(room);
    guest.send("saveProgress", { money: 999 });
    await sleep(50);
    assert.strictEqual(fake.docs.size, 0);
  });

  it("broadcasts leaderboards merging online players with saved offline ones", async () => {
    const fake = fakePlayersCollection([
      baseDoc({ _id: "off1", username: "OfflineAce", money: 9000, damage: 4000, rebirths: 7 }),
      baseDoc({ _id: "u1", username: "Me", money: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { money: 500, damage: 10, rebirths: 1 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(Object.keys(board).sort(), ["damage", "money", "rebirths"]);
    assert.deepStrictEqual(
      board.money.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 9000], ["Me", 500]],
    );
    assert.strictEqual(board.money.filter((r: any) => r.name === "Me").length, 1);
    assert.strictEqual(board.damage[0].name, "OfflineAce");
    assert.strictEqual(board.rebirths[0].value, 7);
    assert.ok(board.money[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.money[0].id.startsWith("offline:"), "offline rows never expose the real id");
  });

  it("counts server-measured playtime and persists it with $inc", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u1", playTime: 100 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const r = room as any;
    assert.strictEqual(c.state.players.get(c.sessionId)!.playTime, 100);
    r.playTimeMark.set(c.sessionId, Date.now() - 90_000);
    r.flushAllPlaytime();
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    // A client cannot forge it through saveProgress.
    c.send("saveProgress", { money: 10, playTime: 999999 });
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(fake.docs.get("u1")!.money, 10);
  });

  it("never moves a saved tutorialStep backwards", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "tut1", username: "Tom" });
    await sleep(50);
    c.send("saveProgress", { tutorialStep: 4 });
    await sleep(80);
    assert.strictEqual(fake.docs.get("tut1")!.tutorialStep, 4);
    c.send("saveProgress", { money: 5, tutorialStep: 1 });
    await sleep(80);
    assert.strictEqual(fake.docs.get("tut1")!.tutorialStep, 4);
    assert.strictEqual(fake.docs.get("tut1")!.money, 5);

    const room2 = await colyseus.createRoom<LobbyState>("lobby", {});
    const sent = captureSends(room2);
    await colyseus.connectTo(room2, { userId: "tut1", username: "Tom" });
    await sleep(100);
    assert.strictEqual(sent.find(([t]) => t === "progress")![1].tutorialStep, 4);
  });

  describe("sanitizeProgress", () => {
    it("rejects non-objects and clamps values", () => {
      assert.strictEqual(sanitizeProgress(null), null);
      assert.strictEqual(sanitizeProgress("x"), null);
      const out = sanitizeProgress({ money: -3, gems: 1e30, rebirths: 0, carryMax: 7.9, tntOwned: 5, ores: 1 })!;
      assert.strictEqual(out.money, 0);
      assert.strictEqual(out.gems, 1_000_000_000_000_000_000);
      assert.strictEqual(out.rebirths, 1);
      assert.strictEqual(out.carryMax, 7);
      assert.deepStrictEqual(out.tntOwned, []);
      assert.deepStrictEqual(out.ores, {});
      assert.strictEqual(sanitizeProgress({ money: NaN })!.money, undefined);
      assert.strictEqual(sanitizeProgress({ tntEquipped: "bogus" })!.tntEquipped, undefined);
    });

    it("clamps tutorialStep and resolves it for saves that predate it", () => {
      assert.strictEqual(sanitizeProgress({ tutorialStep: 3.9 })!.tutorialStep, 3);
      assert.strictEqual(sanitizeProgress({ tutorialStep: 99 })!.tutorialStep, 7);
      assert.strictEqual(sanitizeProgress({ tutorialStep: -2 })!.tutorialStep, 0);
      assert.strictEqual(sanitizeProgress({ tutorialStep: "4" })!.tutorialStep, undefined);
      const base = { _id: "u", money: 0, version: 1, updatedAt: new Date() };
      assert.strictEqual(resolveTutorialStep(base), 0); // playtime-only doc: a new player
      assert.strictEqual(resolveTutorialStep({ ...base, tutorialStep: 4 }), 4);
      assert.strictEqual(resolveTutorialStep({ ...base, tntOwned: ["classic"] }), 7); // existing player
    });

    it("keeps only known TNT ids and ores", () => {
      assert.deepStrictEqual(sanitizeTntOwned(["ice", "ice", "x", 3]), ["ice"]);
      assert.deepStrictEqual(sanitizeOres({ gold: 3, coal: -1, nope: 4 }), { gold: 3, coal: 0 });
    });
  });
});
