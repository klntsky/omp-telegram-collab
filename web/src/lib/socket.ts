import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";

export type GatewayAction = Exclude<GuestFrame, { t: "hello" }>;

export interface GuestTransport {
	onOpen?: () => void;
	onFrame?: (frame: HostFrame) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	connect(): void;
	close(): void;
	send(frame: GatewayAction): void;
}

const MAX_BUFFERED_BYTES = 1024 * 1024;

export class GatewaySocket implements GuestTransport {
	onOpen?: () => void;
	onFrame?: (frame: HostFrame) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;

	#ticket: string | null;
	#ws: WebSocket | null = null;
	#started = false;
	#closed = false;

	constructor(ticket: string) {
		this.#ticket = ticket;
	}

	connect(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		const url = new URL("/api/socket", window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("ticket", this.#ticket!);
		this.#ticket = null;
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			this.#finish("Could not connect to the session. Check your connection and Rejoin.");
			return;
		}
		this.#ws = ws;
		ws.onopen = () => {
			if (!this.#closed) this.onOpen?.();
		};
		ws.onmessage = event => {
			if (this.#closed) return;
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
			this.onFrame?.(frame);
		};
		ws.onerror = () => this.#finish("Connection failed. Check your connection, then Rejoin to authenticate again.");
		ws.onclose = event => {
			const reason = event.code === 1008
				? "Session access expired or is no longer allowed. Rejoin to check your membership again."
				: "Disconnected from the session. Rejoin to authenticate again.";
			this.#finish(reason);
		};
	}

	send(frame: GatewayAction): void {
		const ws = this.#ws;
		if (this.#closed) return;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			this.#finish("The connection is not open. Rejoin before sending again.");
			return;
		}
		const text = JSON.stringify(frame);
		if (ws.bufferedAmount + text.length > MAX_BUFFERED_BYTES) {
			this.#finish("The connection is too slow. Rejoin before sending again.");
			return;
		}
		try {
			ws.send(text);
		} catch {
			this.#finish("Could not send to the session. Rejoin before sending again.");
		}
	}

	close(): void {
		this.#finish("Left the session.");
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#ticket = null;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			ws.onopen = null;
			ws.onmessage = null;
			ws.onerror = null;
			ws.onclose = null;
			ws.close();
		}
		this.onClose?.(reason, false);
	}
}
