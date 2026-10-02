import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
listen(app);
