import { workspaceSmoke } from "./m2a-smoke.ts";

if (import.meta.main) await workspaceSmoke({ closure: true, resolve: true });
