import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

export interface PlayerDoc {
  _id: string; // Bloxity user id (SDK.auth.getUser()._id) -- see LobbyRoom.ts
  // Display name as of the last save, so an offline leaderboard row still has something to show.
  username?: string;
  money: number;
  gems?: number;
  shells?: number;
  rebirths?: number;
  clickPower?: number;
  // Blast power at the last save (equipped TNT blast + clickPower): the "Most Damage" board.
  damage?: number;
  tnt?: number;
  carryMax?: number;
  placeMax?: number;
  range?: number;
  speed?: number;
  tntOwned?: string[];
  tntEquipped?: string;
  // Mined blocks held, by data/ores.js `item` (dirt, stone, coal, gold, diamond, bedrock).
  ores?: Record<string, number>;
  // Total seconds connected, measured by the SERVER clock (LobbyRoom.ts flushPlaytime) --
  // never client-reported.
  playTime?: number;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent. A failure only
    // means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ money: -1 });
      await players.createIndex({ damage: -1 });
      await players.createIndex({ rebirths: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the leaderboard/save logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
