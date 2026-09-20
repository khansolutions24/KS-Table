// JSON encoding for the dev WebSocket transport (keeps Uint8Array / Buffer values).

interface NodeBufferLike {
  toString(encoding: string): string;
}
interface NodeBufferCtor {
  from(data: ArrayBufferLike, byteOffset?: number, length?: number): NodeBufferLike;
  from(data: string, encoding: string): Uint8Array;
}

const NodeBuffer = (globalThis as unknown as { Buffer?: NodeBufferCtor }).Buffer;

function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, function (_key, val: unknown) {
    if (val instanceof Uint8Array) return { __b64: toBase64(val) };
    if (val && typeof val === 'object' && (val as { type?: string }).type === 'Buffer' && Array.isArray((val as { data?: unknown }).data)) {
      return { __b64: toBase64(Uint8Array.from((val as { data: number[] }).data)) };
    }
    return val;
  });
}

export function decodeWire(text: string): unknown {
  return JSON.parse(text, (_key, val: unknown) => {
    if (val && typeof val === 'object' && typeof (val as { __b64?: unknown }).__b64 === 'string') {
      return fromBase64((val as { __b64: string }).__b64);
    }
    return val;
  });
}
