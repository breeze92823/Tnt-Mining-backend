# +1 TNT Mining Server

Colyseus server for [Tnt-Mining](../Tnt-Mining): saves a signed-in player's
progress to MongoDB and serves the three hub leaderboards (Most Damage, Most
Rebirths, Most Money). Same stack as the Poop-a-big-poop backend (`colyseus` +
`@colyseus/schema` + Mongo + Bloxity Legion deploy). The client's `GAME_SLUG`
is `tnt-mining`.

## Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground. With no `MONGODB_URI` the
server runs with persistence off (boards show only players online now).

## Structure

- `src/index.ts`: entry point (connects Mongo, then listens)
- `src/app.config.ts`: rooms, `/health`, CORS, dev-only monitor/playground
- `src/rooms/LobbyRoom.ts`: the single global room (`client.joinOrCreate("lobby")`)
- `src/rooms/schema/LobbyState.ts`: live roster (username + ranked stats)
- `src/db.ts`: Mongo persistence (no-op if `MONGODB_URI` is unset/unreachable)
- `src/constants.ts`: leaderboard timing, value caps, TNT/ore allow-lists
- `test/LobbyRoom.test.ts`: boots the real server against a fake Mongo collection

## Wire protocol

Join with `client.joinOrCreate("lobby", { username, userId })`. `userId` is the
stable Bloxity user id; omit it for a guest, whose progress isn't persisted.

### Client → server

| Message | Payload | Cadence |
|---|---|---|
| `stats` | `{ money, damage, rebirths }` (all optional). `damage` = blast power (equipped TNT blast + clickPower, the HUD boom number) | debounced on change |
| `saveProgress` | `{ money, gems, shells, rebirths, clickPower, damage, tnt, carryMax, placeMax, range, speed, tntOwned, tntEquipped, ores, tutorialStep }` (all optional); no-op for a guest; `tutorialStep` is stored with `$max`, so it never goes backwards | debounced |
| `identify` | `{ username, userId }` | when sign-in state changes after join |

`tntOwned` / `tntEquipped` are checked against `TNT_IDS` and `ores`
(`{ dirt, stone, coal, gold, diamond, bedrock }`) against `ORE_ITEMS` in
`src/constants.ts`. Add a TNT or ore in both places.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | the saved fields above plus `playTime`; `tutorialStep` is 7 (done) for a save that predates the tutorial | after a signed-in join/identify, if a saved doc exists |
| `noProgress` | `{}` | after a signed-in join/identify with no saved doc |
| `leaderboard` | `{ damage, rebirths, money }`, each `Row[]` (top 10) with `Row = { id, name, value }` | every 15 s and on roster changes; live roster merged with all-time Mongo top scorers |

`id` equals the client's `sessionId` on its own row (so a board can highlight
it); offline rows use a synthetic `offline:` id and never expose a real Bloxity
id. `playTime` is measured by the server clock, so `saveProgress` can't forge it.

The server trusts the client for gameplay values; it only enforces shape and
bounds so a bad payload can't corrupt the sender's own save.

## Environment (runtime)

- `MONGODB_URI`: injected by Bloxity Legion; unset locally (persistence off).
- `CLIENT_ORIGIN`: injected when deployed; CORS falls back to `*` locally.
- `PORT`: injected by Legion; falls back to 2567.

## Deploy

`.github/workflows/deploy.yml` runs build + tests on every push and pull
request to `dev`/`main`. On a push (or manual run) it then builds a Docker
image, pushes it to GHCR and calls the Bloxity Legion deploy API: `dev` →
`dev` channel, `main` → `prod` channel.

GitHub settings (Settings → Secrets and variables → Actions):

| Name | Type | Value |
|---|---|---|
| `LEGION_GAME_ID` | **Variable** | Lowercase game ID from the Bloxity "My Games" dashboard (`tnt-mining`) |
| `LEGION_DEPLOY_TOKEN` | **Secret** | Deploy token from the Bloxity dashboard |
| `GITHUB_TOKEN` | Automatic | Provided by GitHub; used to push to GHCR. Nothing to configure |

Also make sure Actions has write access to packages (Settings → Actions →
General → Workflow permissions), and that the GHCR package is readable by
Legion (public, or per Bloxity's instructions).
