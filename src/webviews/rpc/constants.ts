/**
 * Shared constants for Supertalk RPC integration.
 *
 * This file contains constants that need to be shared between the extension
 * host and webview bundles.
 */

/** Namespace for Supertalk RPC messages on the shared postMessage pipe */
export const RPC_NAMESPACE = '__supertalk_rpc__';

/** Wrapper for Supertalk messages sent over VS Code webview channel */
export interface RpcMessageWrapper {
	[RPC_NAMESPACE]: true;
	payload: unknown;
	/** Compression applied to `payload`, if any. Absent means the payload is uncompressed. */
	compressed?: 'deflate-raw';
	/**
	 * Byte length stamped by the host so a third-party postMessage patch that JSON-round-trips a
	 * Uint8Array can be rebuilt by the webview receiver.
	 */
	byteLength?: number;
}

/** Type guard to check if a message is a Supertalk RPC message */
export function isRpcMessage(message: unknown): message is RpcMessageWrapper {
	return (
		typeof message === 'object' &&
		message !== null &&
		RPC_NAMESPACE in message &&
		(message as RpcMessageWrapper)[RPC_NAMESPACE] === true
	);
}

/** Type guard for a binary RPC payload as delivered by VS Code's message channel */
export function isBinaryRpcPayload(payload: unknown): payload is Uint8Array | ArrayBuffer {
	return payload instanceof Uint8Array || payload instanceof ArrayBuffer;
}

/**
 * Rehydrates a payload that a third-party postMessage patch may have JSON-round-tripped into a
 * numeric-keyed plain object. The normal binary path returns without allocating.
 */
export function rehydrateBinaryRpcPayload(
	payload: unknown,
	byteLength: number | undefined,
): Uint8Array | ArrayBuffer | undefined {
	if (isBinaryRpcPayload(payload)) return payload;
	if (byteLength == null || !Number.isInteger(byteLength) || byteLength < 0) return undefined;
	if (typeof payload !== 'object' || payload === null) return undefined;

	const indexed = payload as Record<number, unknown>;
	if (byteLength > 0 && typeof indexed[0] !== 'number') return undefined;

	const bytes = new Uint8Array(byteLength);
	for (let i = 0; i < byteLength; i++) {
		bytes[i] = indexed[i] as number;
	}

	return bytes;
}

// Cached encoder/decoder instances for binary payload encoding
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes a Supertalk message as a Uint8Array for binary transit through VS Code IPC.
 *
 * VS Code extracts TypedArrays from postMessage payloads before JSON serialization,
 * sends them as raw binary through the IPC channel, and zero-copy transfers them
 * through the Structured Clone hops in the renderer. This avoids 2 expensive
 * structuredClone deep copies on the renderer UI thread.
 */
export function encodeRpcPayload(message: unknown): Uint8Array {
	return textEncoder.encode(JSON.stringify(message));
}

/**
 * Decodes a binary payload back to a Supertalk message.
 * Accepts Uint8Array or ArrayBuffer for robustness against
 * VS Code's internal buffer type normalization.
 */
export function decodeRpcPayload(data: Uint8Array | ArrayBuffer): unknown {
	return JSON.parse(textDecoder.decode(data));
}

/** Minimum encoded payload size (bytes) worth compressing — carried over from the legacy IPC stack's threshold. */
export const rpcCompressionMinBytes = 1024;

/**
 * Inflates a raw-DEFLATE compressed payload and parses it — the counterpart to the host's `deflateRaw`.
 * Uses the native `DecompressionStream`, available in both Chromium webviews and Node >= 18, so it is
 * bundle-safe on both sides.
 */
export async function inflateRpcPayload(data: Uint8Array | ArrayBuffer): Promise<unknown> {
	// `body` is only null for a Response with no body (e.g. a 204/205); `data` always provides one.
	const stream = new Response(data instanceof Uint8Array ? new Uint8Array(data) : data).body!.pipeThrough(
		new DecompressionStream('deflate-raw'),
	);
	return JSON.parse(await new Response(stream).text());
}
