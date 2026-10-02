import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: what the leaderboards rank plus the pose/avatar other clients need to draw
// this player hub-side. The Forest Mine is client-side only and never synced. Durable state
// lives in Mongo (src/db.ts).
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),
    yaw: t.number().default(0),
    // 0..1 eased gait factor (client systems/avatarAnim.js) -- purely cosmetic.
    moveBlend: t.number().default(0),
    grounded: t.boolean().default(true),
    bending: t.boolean().default(false),
    // Selected hotbar slot (-1 = hands empty) and the equipped TNT id, so others see what is held.
    slot: t.number().default(-1),
    tnt: t.string().default(""),
    // The player's Bloxity avatar (equipped hat/back + proportions) as an opaque JSON string,
    // stored and relayed as-is (length-capped, never parsed here).
    avatar: t.string().default(""),
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
