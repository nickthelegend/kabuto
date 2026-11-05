// Copies the compiled contract ABIs/bytecode the wallet needs from packages/contracts/out into src/abi.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const out = new URL("../../contracts/out/", import.meta.url);
const dest = new URL("../src/abi/", import.meta.url);
mkdirSync(dest, { recursive: true });
for (const name of ["KabutoAccount", "KabutoRouter", "DevnetToken"]) {
  const j = JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, out), "utf8"));
  writeFileSync(new URL(`${name}.json`, dest), JSON.stringify({ abi: j.abi, bytecode: j.bytecode.object }));
}
console.log("abi copied");
