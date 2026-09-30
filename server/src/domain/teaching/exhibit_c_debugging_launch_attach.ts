/**
 * Teaching exhibit (debugging topic — "node --inspect and breakpoints").
 *
 * The VS Code ATTACH configuration for a process already running with
 * --inspect (tsx forwards node CLI flags, so `npx tsx --inspect src/server.ts`
 * is the direct form). The debugging topic quotes this JSON verbatim as its
 * launch.json sketch; it lives here — a real repo file — so the quoted config
 * is pinned source rather than hand-invented prose. To use it, copy the JSON
 * into .vscode/launch.json and attach while the dev server runs.
 *
 * Why ATTACH and not LAUNCH: the dev workflow runs the server through tsx
 * watch inside the devcontainer; attaching works identically for a process on
 * localhost or inside a container with a published 9229, and avoids launch-
 * config coupling to the wrapper. sourceMaps stays on so breakpoints land in
 * the .ts sources (tsx serves source-mapped TypeScript to the debugger).
 */
export const ATTACH_LAUNCH_CONFIG = `
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to tsx --inspect",
      "port": 9229,
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"],
      "sourceMaps": true
    }
  ]
}
`;
