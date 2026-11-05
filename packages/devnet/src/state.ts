import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const FILE = fileURLToPath(new URL("../.devnet-state.json", import.meta.url));
export type State = Record<string, any>;
export const readState = (): State => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const writeState = (patch: State) => writeFileSync(FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
