import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";
import { SessionAccessError } from "./telegram";

export type GatewayAction = Exclude<GuestFrame, { t: "hello" }>;

export interface GuestTransport {
	onOpen?: () => void;
	onFrame?: (frame: HostFrame) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	connect(): void;
	reconnect(reason: string): void;
	close(): void;
	send(frame: GatewayAction): void;
}

const MAX_BUFFERED_BYTES = 1024 * 1024;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class GatewaySocket implements GuestTransport {
	onOpen?: () => void;
	onFrame?: (frame: HostFrame) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;

	#ticket: string | null;
	#ws: WebSocket | null = null;
	#started = false;
	#closed = false;
	#attempt = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#authorization: AbortController | null = null;
	readonly #refreshTicket: (signal: AbortSignal) => Promise<string>;

	constructor(ticket: string, refreshTicket: (signal: AbortSignal) => Promise<string>) {
		this.#ticket = ticket;
		this.#refreshTicket = refreshTicket;
	}

	connect(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		void this.#openSocket();
	}

	async #openSocket(): Promise<void> {
		const controller = new AbortController();
		this.#authorization = controller;
		const timeout = setTimeout(() => controller.abort(), 20_000);
		let ticket = this.#ticket;
		this.#ticket = null;
		try {
			ticket ??= await this.#refreshTicket(controller.signal);
		} catch (error) {
			if (this.#closed || this.#authorization !== controller) return;
			if (error instanceof SessionAccessError) this.#finish(error.message);
			else this.reconnect(`${error instanceof Error ? error.message : String(error)}\nReconnecting…`);
			return;
		} finally {
			clearTimeout(timeout);
			if (this.#authorization === controller) this.#authorization = null;
		}
		if (this.#closed || controller.signal.aborted) return;
		const url = new URL("/api/socket", window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("ticket", ticket);
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			this.reconnect("Could not connect to the session. Reconnecting…");
			return;
		}
		this.#ws = ws;
		let lastError: string | undefined;
		ws.onopen = () => {
			if (this.#ws === ws) this.onOpen?.();
		};
		ws.onmessage = event => {
			if (this.#ws !== ws) return;
			let frame: HostFrame;
			try {
				if (typeof event.data !== "string") throw new Error("Expected JSON");
				const value: unknown = JSON.parse(event.data);
				if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") {
					throw new Error("Invalid frame");
				}
				frame = value as HostFrame;
			} catch {
				this.#finish("The session sent an invalid response. Rejoin to try again.");
				return;
			}
			if (frame.t === "snapshot-chunk" && frame.final) this.#attempt = 0;
			if (frame.t === "error") lastError = frame.message;
			this.onFrame?.(frame);
		};
		ws.onerror = () => {};
		ws.onclose = event => {
			if (this.#ws !== ws) return;
			if (event.code === 4001 || event.code === 4002 || event.code === 4003 || event.code === 4009) {
				this.#finish(event.reason || "Session unavailable. Reopen the topic’s OPEN AGENT button.");
				return;
			}
			const reason = event.reason || (event.code === 1013 ? lastError : undefined);
			this.reconnect(reason ? `${reason}\nReconnecting…` : "Disconnected from the session. Reconnecting…");
		};
	}

	reconnect(reason: string): void {
		if (this.#closed || this.#retryTimer !== undefined) return;
		this.#detach();
		this.onClose?.(reason, true);
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(this.#attempt++, 5), BACKOFF_MAX_MS);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (!this.#closed) void this.#openSocket();
		}, delay);
	}

	send(frame: GatewayAction): void {
		const ws = this.#ws;
		if (this.#closed) return;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			this.reconnect("The connection is not open. Reconnecting; the action was not sent.");
			return;
		}
		const text = JSON.stringify(frame);
		if (ws.bufferedAmount + text.length > MAX_BUFFERED_BYTES) {
			this.reconnect("The connection is too slow. Reconnecting; the action was not sent.");
			return;
		}
		try {
			ws.send(text);
		} catch {
			this.reconnect("Could not send to the session. Reconnecting; delivery is uncertain.");
		}
	}

	close(): void {
		this.#finish("Left the session.");
	}

	#detach(): void {
		this.#authorization?.abort();
		this.#authorization = null;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			ws.onopen = null;
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			ws.close();
		}
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#ticket = null;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#detach();
		this.onClose?.(reason, false);
	}
}
