// Workspaces: the shared contract between the UI and the Worker API.
// The public demo workspace needs no key. A private workspace is a capability link: whoever holds its
// secret key can read and edit it. There are no accounts, passwords or emails.
import { z } from "zod";

export const DEMO_WORKSPACE_ID = "demo";
export const DEMO_WORKSPACE_NAME = "Demo workspace (public)";
/** Request header that carries a private workspace key. No header means the demo workspace. */
export const WORKSPACE_HEADER = "x-workspace-key";
/** Keys are "wsk_" plus 43 base64url characters (32 random bytes). */
export const WORKSPACE_KEY_RE = /^wsk_[A-Za-z0-9_-]{43}$/;

export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export type Workspace = { id: string; name: string; public: boolean };
