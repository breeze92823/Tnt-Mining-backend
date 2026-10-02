// Leaderboards: how often LobbyRoom re-queries Mongo for the all-time top players per stat,
// how many rows it fetches per stat before merging with the live roster, and how many it sends.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;
export const LEADERBOARD_ROWS = 10;

// Playtime: how often each connected player's elapsed time is added to their total.
export const PLAYTIME_FLUSH_MS = 30_000;

// Upper bounds for saved values, so a forged payload cannot push a bogus number onto the
// leaderboards. Generous ceilings, not game rules.
export const MONEY_MAX = 1_000_000_000_000_000_000; // money, gems, shells
export const DAMAGE_MAX = 1_000_000_000_000_000_000; // blast power (equipped TNT blast + clickPower)
export const REBIRTH_MAX = 1_000_000;
export const ORE_MAX = 1_000_000_000_000; // per ore type held
export const UPGRADE_MAX = 1_000_000; // carryMax, placeMax, range, speed, tnt

// Ids of the client's data/tnts.js and data/ores.js `item`. Allow-listed so a forged payload
// cannot invent one; keep in step by hand when TNTs or ores are added.
export const TNT_IDS: readonly string[] = [
  "classic", "green", "yellow", "blue", "purple", "white", "black", "silver", "gold",
  "diamond", "obsidian", "springy", "speedy", "lucky", "fire", "nuke", "ice",
];
export const ORE_ITEMS: readonly string[] = ["dirt", "stone", "coal", "gold", "diamond", "bedrock"];

// Client onboarding progress: the client's data/tutorial.js TUTORIAL_DONE_STEP (finished). Keep in
// step by hand.
export const TUTORIAL_DONE_STEP = 7;
