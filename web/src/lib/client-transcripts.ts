import type { BrowserHostFrame } from "../../../shared/contracts";
import type { TranscriptResult } from "./client";
import type { GuestTransport } from "./socket";

const TRANSCRIPT_TIMEOUT_MS = 10_000;
interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Correlates subagent reads without replaying requests across reconnects. */
export class GuestTranscriptReads {
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	constructor(private readonly nextRequest: () => number, private readonly send: GuestTransport["send"]) {}

	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = this.nextRequest();
		let resolve!: (result: TranscriptResult | null) => void;
		const promise = new Promise<TranscriptResult | null>(res => {
			resolve = res;
		});
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	clear(): void {
		for (const pending of this.#pendingTranscripts.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	apply(frame: Extract<BrowserHostFrame, { t: "transcript" }>): void {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
	}
}
