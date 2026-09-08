import { workspaceSmoke } from "./workspace-smoke.ts";

if (import.meta.main) await workspaceSmoke({ closure: true, resolve: true });
