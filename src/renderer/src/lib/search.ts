/*
 * The search rules live in `shared/` so the tailnet server answers a peer's query with exactly
 * the rules this window's search box uses (`/search` in `remote-process.ts`). Re-exported here
 * so nothing in the renderer had to change its imports.
 */
export * from '@shared/search'
