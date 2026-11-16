// Layout of a generated "path -> hash" registry (defect C, 2026-11-15). Git refuses to merge changes to adjacent lines,
// so two queued pull requests that change two different files next to each other in the path order made the registry
// conflict, and the next PR had to rerun the generator after taking main in. One unchanged empty line after every
// entry keeps each entry's change apart: only two PRs changing the same file still touch the same line. JSON ignores
// the empty lines, so every reader is unchanged.
export const ENTRY = /^( +"[^"\n]*\/[^"\n]*": "[a-f0-9]{40}(?:[a-f0-9]{24})?",?)\n(?!\n)/gm;
export const layoutRegistry = value => (JSON.stringify(value, null, 2) + '\n').replace(ENTRY, '$1\n\n');
