/** The realtime channel the server tells the app about its session on (`SessionSignal` in server/session.ts). */
export const SESSION_CHANNEL = "session";

/** The app tells the server it still holds the call this often (`session.alive`). */
export const ALIVE_EVERY_MS = 15_000;
