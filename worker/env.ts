export type Env = {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  /** URL of the pipeline's runs/history.json (latest published snapshot). */
  SNAPSHOT_HISTORY_URL: string;
};
/** `workspace`: the resolved workspace id ("demo" when no key is sent), set by `resolveWorkspace`. */
export type AppEnv = { Bindings: Env; Variables: { workspace: string } };
