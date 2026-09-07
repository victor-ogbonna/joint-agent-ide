import dotenv from "dotenv";

// Must be the first import in server.ts. ES module imports evaluate before
// the importing file's own body runs, so any module that reads process.env
// at import time (e.g. firebaseAdmin.ts) needs .env already loaded before
// it's ever imported — a plain `dotenv.config()` call later in server.ts's
// body is too late for that.
dotenv.config();
