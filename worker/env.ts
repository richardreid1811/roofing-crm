export type Env = {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  /** URL of the pipeline's runs/history.json (latest published snapshot). */
  SNAPSHOT_HISTORY_URL: string;
};
export type AppEnv = { Bindings: Env };
