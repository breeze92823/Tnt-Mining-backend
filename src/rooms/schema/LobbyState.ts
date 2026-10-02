import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster. The game has no remote avatars yet, so this only carries what the
// leaderboards rank; durable state lives in Mongo (src/db.ts).
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    money: t.number().default(0),
    damage: t.number().default(0), // blast power: equipped TNT blast + clickPower
    rebirths: t.number().default(1),
    // Total seconds connected (saved total for a signed-in player + this session), server-measured.
    playTime: t.number().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const LobbyState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "LobbyState",
);
export type LobbyState = SchemaType<typeof LobbyState>;
