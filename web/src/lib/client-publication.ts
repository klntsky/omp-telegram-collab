import type { BrowserHostFrame } from "../../../shared/contracts";

/** Coalesces only high-rate live updates; synchronous publications supersede them. */
export class GuestPublication {
	#cancel: (() => void) | null = null;
	get pending(): boolean { return this.#cancel !== null; }

	static coalesces(frame: BrowserHostFrame): boolean {
		if (frame.t === "event")
			return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
		return frame.t === "bus" && frame.channel === "task:subagent:progress";
	}

	schedule(commit: () => void): void {
		if (this.#cancel !== null) return;
		const callback = (): void => {
			this.#cancel = null;
			commit();
		};
		if (typeof requestAnimationFrame === "function") {
			const id = requestAnimationFrame(callback);
			this.#cancel = () => cancelAnimationFrame(id);
		} else {
			// Match animation-frame cadence in tests and non-DOM hosts.
			const timer = setTimeout(callback, 16);
			this.#cancel = () => clearTimeout(timer);
		}
	}

	clear(): void {
		this.#cancel?.();
		this.#cancel = null;
	}
}
