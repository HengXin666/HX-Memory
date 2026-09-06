// HX-Memory public entry. Kernel types/ports only; adapters/storage are
// pluggable and must be imported by the consumer, not here (keeps deps one-way).
export type * from "./kernel/types.ts";
export type * from "./kernel/ports.ts";
export { expandEvolutionChain, sliceAt } from "./kernel/evolution.js";
