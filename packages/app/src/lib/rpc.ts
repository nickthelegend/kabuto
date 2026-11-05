import { D } from "./config";

export class RpcError extends Error {
  constructor(public method: string, public code: number, message: string, public data?: unknown) {
    super(message);
  }
}
let id = 0;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
export async function rpc<T = any>(method: string, params: unknown[] = [], url = D.gateway): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: json({ jsonrpc: "2.0", id: ++id, method, params }) });
  } catch {
    throw new RpcError(method, -1, `The devnet gateway is unreachable (${url}).`);
  }
  if (!res.ok) throw new RpcError(method, res.status, `Gateway HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data);
  return body.result as T;
}
