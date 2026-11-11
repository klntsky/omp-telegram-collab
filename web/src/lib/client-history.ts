import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { BrowserHostFrame, HistoryCursor } from "../../../shared/contracts";
import type { GuestSnapshot } from "./client";
import type { GuestTransport } from "./socket";

const TRANSCRIPT_TIMEOUT_MS = 10_000;
interface PendingHistory {
	reqId: number;
	cursor: HistoryCursor;
	timer: ReturnType<typeof setTimeout>;
}

/** Owns retained rows, snapshot assembly, and cursor-validated history reads. */
export class GuestHistory {
	older: HistoryCursor | null = null;
	historyError: string | null = null;
	historyFreshness: GuestSnapshot["history"]["freshness"] = "ready";
	historyRevision = 0;
	pendingHistory: PendingHistory | null = null;

	entries: SessionEntry[] = [];
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	pendingSnapshot: { entries: SessionEntry[]; live: SessionEntry[]; total: number } | null = null;
	publishedEntries: readonly SessionEntry[] = [];

	constructor(
		private readonly nextRequest: () => number,
		private readonly send: GuestTransport["send"],
		private readonly commit: () => void,
		private readonly onProgress: (pending: boolean) => void,
		private readonly onLive: () => void,
	) {}

	clearPending(): void {
		if (this.pendingHistory) clearTimeout(this.pendingHistory.timer);
		this.pendingHistory = null;
	}

	resetCursor(): void {
		this.older = null;
		this.historyError = null;
		this.historyFreshness = "ready";
	}

	welcome(entryCount: number): void {
		this.resetCursor();
		// Keep retained rows visible until their replacement snapshot completes.
		if (entryCount === 0) {
			this.entries = [];
			this.publishedEntries = [];
			this.pendingSnapshot = null;
		} else {
			this.pendingSnapshot = { entries: [], live: [], total: entryCount };
		}
	}

	append(entry: SessionEntry): void {
		if (this.pendingSnapshot !== null) this.pendingSnapshot.live.push(entry);
		else {
			this.entries.push(entry);
			this.publishedEntries = [...this.entries];
		}
	}

	loadEarlier(live: boolean): void {
		if (
			!live || this.pendingSnapshot || this.pendingHistory ||
			this.historyFreshness === "refreshing" || !this.older
		) return;
		const reqId = this.nextRequest();
		const cursor = { ...this.older };
		const timer = setTimeout(() => {
			this.pendingHistory = null;
			this.historyError ??= "Timed out waiting for earlier history.";
			this.commit();
		}, TRANSCRIPT_TIMEOUT_MS);
		this.pendingHistory = { reqId, cursor, timer };
		if (this.historyFreshness === "ready") this.historyError = null;
		this.commit();
		this.send({ t: "history-page", reqId, cursor });
	}

	apply(frame: BrowserHostFrame, welcomed: boolean, ended: boolean): boolean {
		switch (frame.t) {
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.pendingSnapshot;
				if (pending === null || this.historyFreshness !== "ready") return false;
				pending.entries.push(...frame.entries);
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.onProgress(true);
					break;
				}
				this.entries = pending.entries;
				this.entries.push(...pending.live);
				this.publishedEntries = [...this.entries];
				this.pendingSnapshot = null;
				this.onProgress(false);
				this.onLive();
				break;
			}
			case "history-state":
				if (!welcomed || ended || this.historyFreshness !== "ready") return false;
				this.older = frame.older;
				break;
			case "history-invalidated":
				if (!welcomed || ended) return false;
				if (this.pendingHistory) clearTimeout(this.pendingHistory.timer);
				this.pendingHistory = null;
				this.onProgress(false);
				this.historyFreshness = "refreshing";
				break;
			case "history-reset":
				if (!welcomed || ended) return false;
				if (this.pendingHistory) clearTimeout(this.pendingHistory.timer);
				this.pendingHistory = null;
				this.pendingSnapshot = null;
				this.onProgress(false);
				this.entries = [...frame.page.entries];
				this.publishedEntries = [...this.entries];
				this.older = frame.page.older;
				this.historyFreshness = "ready";
				this.historyError = null;
				this.historyRevision++;
				this.onLive();
				break;
			case "history-error":
				if (!welcomed || ended) return false;
				if (this.pendingHistory) clearTimeout(this.pendingHistory.timer);
				this.pendingHistory = null;
				this.onProgress(false);
				this.historyFreshness = "unverified";
				this.historyError = frame.message;
				break;
			case "history-page": {
				const pending = this.pendingHistory;
				if (!pending || pending.reqId !== frame.reqId) return false;
				if (
					frame.cursor.epoch !== pending.cursor.epoch ||
					frame.cursor.before !== pending.cursor.before ||
					this.older?.epoch !== pending.cursor.epoch ||
					this.older.before !== pending.cursor.before
				) return false;
				if (frame.page.older && (
					frame.page.older.epoch !== pending.cursor.epoch ||
					frame.page.older.before >= pending.cursor.before
				)) return false;
				clearTimeout(pending.timer);
				this.pendingHistory = null;
				// A page cannot certify rows retained across a failed source refresh.
				if (this.historyFreshness !== "ready") break;
				this.historyError = null;
				this.entries = [...frame.page.entries, ...this.entries];
				this.publishedEntries = [...this.entries];
				this.older = frame.page.older;
				break;
			}
		}
		return true;
	}
}
