import { GATEWAY } from "./config.js";

export class RpcError extends Error {
  constructor(public method: string, public code: number, message: string, public data?: unknown) {
    super(`${method} failed (${code}): ${message}`);
  }
}

let id = 0;
/** A raw JSON-RPC call to the gateway. Throws RpcError with the node's own message. */
export async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v)),
  });
  if (!res.ok) throw new RpcError(method, res.status, `HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
  return body.result as T;
}
