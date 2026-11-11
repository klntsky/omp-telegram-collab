/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the authenticated gateway transport, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * commit, so React change detection is reference equality all the way.
 *
 * High-rate frames (streaming `message_update`, `tool_execution_update`,
 * subagent progress) are applied immediately but published at most once per
 * animation frame; every other frame publishes synchronously, flushing any
 * pending state with it, so the published end state is unchanged.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import type { GuestTransport } from "./socket";
import { GuestLiveState } from "./client-live";
import { GuestHistory } from "./client-history";
import { GuestTranscriptReads } from "./client-transcripts";
import { GuestPublication } from "./client-publication";
import type { BrowserHostFrame, HistoryCursor } from "../../../shared/contracts";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	history: {
		older: HistoryCursor | null;
		loading: boolean;
		error: string | null;
		freshness: "ready" | "refreshing" | "unverified";
		/** Changes only when a history reset replaces the visible row set. */
		revision: number;
	};
}

/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

export class GuestClient {
	readonly #socket: GuestTransport;
	readonly #history = new GuestHistory(
		() => ++this.#reqSeq,
		frame => this.#socket.send(frame),
		() => this.#commit(),
		pending => pending ? this.#armSnapshotProgressTimer() : this.#clearSnapshotProgressTimer(),
		() => { this.#phase = "live"; },
	);
	readonly #listeners = new Set<() => void>();
	readonly #transcriptReads = new GuestTranscriptReads(
		() => ++this.#reqSeq,
		frame => this.#socket.send(frame),
	);
	#reqSeq = 0;
	#welcomed = false;
	#welcomeTimer: ReturnType<typeof setTimeout> | null = null;
	#snapshotProgressTimer: ReturnType<typeof setTimeout> | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	readonly #live = new GuestLiveState();
	#snapshot: GuestSnapshot;
	readonly #publication = new GuestPublication();

	constructor(socket: GuestTransport, readonly displayName: string) {
		this.#socket = socket;
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed) this.#armWelcomeTimer();
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearPendingReads();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced per commit (at most once per animation frame for streaming frames). */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		return this.#transcriptReads.fetchTranscript(agentId, fromByte);
	}

	loadEarlier(): void {
		this.#history.loadEarlier(this.#phase === "live");
	}

	/**
	 * Test seam: apply a synthetic host frame through the real apply path. With
	 * `flush` (default), a commit deferred to the next animation frame is
	 * published now, so the snapshot reflects the frame on return.
	 */
	applyFrameForTest(frame: BrowserHostFrame, options: { flush?: boolean } = {}): void {
		this.#applyFrameSafe(frame);
		if ((options.flush ?? true) && this.#publication.pending) this.#commit();
	}

	#handleOpen(): void {
		this.#phase = this.#header ? "reconnecting" : "waiting";
		this.#armWelcomeTimer();
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearPendingReads();
		this.#history.resetCursor();
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#welcomed = false;
			// The next welcome restarts the snapshot; drop the partial one.
			this.#history.pendingSnapshot = null;
			console.error({ level: "warn", event: "collab.session.connection-interrupted", message: "Session connection interrupted:", reason });
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#history.pendingSnapshot = null;
		this.#history.resetCursor();
		this.#clearPendingReads();
		this.#commit();
		this.#socket.close();
	}

	#clearPendingReads(): void {
		this.#transcriptReads.clear();
		this.#history.clearPending();
	}

	#armWelcomeTimer(): void {
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			this.#socket.reconnect("Timed out waiting for the host. Reconnecting…");
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#socket.reconnect("Timed out waiting for the session snapshot. Reconnecting…");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: BrowserHostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.error({ level: "warn", event: "collab.frame.apply-failed", message: "collab: failed to apply frame", frameType: frame.t, error: err });
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#live.pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: BrowserHostFrame): void {
		switch (frame.t) {
			case "welcome":
				this.#clearPendingReads();
				this.#history.welcome(frame.entryCount);
				this.#header = frame.header;
				this.#live.reset(frame.state, frame.agents);
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk":
			case "history-state":
			case "history-invalidated":
			case "history-reset":
			case "history-error":
			case "history-page":
				if (!this.#history.apply(frame, this.#welcomed, this.#phase === "ended")) return;
				break;
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#live.streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#live.stream = null;
					this.#live.streamDone = false;
				}
				this.#history.append(frame.entry);
				break;
			case "event":
				this.#live.applyEvent(frame.event);
				break;
			case "state":
				this.#live.applyState(frame.state);
				break;
			case "agents":
				this.#live.agents = [...frame.agents];
				this.#live.pruneBusMaps();
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#live.progress = new Map(this.#live.progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#live.lifecycle = new Map(this.#live.lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
			case "ui-request-end":
				break;
			case "transcript": {
				this.#transcriptReads.apply(frame);
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				if (this.#history.pendingHistory) {
					clearTimeout(this.#history.pendingHistory.timer);
					this.#history.pendingHistory = null;
					if (this.#history.historyFreshness === "ready" || this.#history.historyError === null) this.#history.historyError = frame.message;
				}
				this.#live.pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		if (GuestPublication.coalesces(frame)) this.#scheduleCommit();
		else this.#commit();
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#history.publishedEntries,
			state: this.#live.state,
			agents: this.#live.agents,
			progress: this.#live.progress,
			lifecycle: this.#live.lifecycle,
			stream: this.#live.stream,
			streamDone: this.#live.streamDone,
			activeTools: this.#live.activeTools,
			working: this.#live.working,
			notices: this.#live.notices,
			history: {
				older: this.#history.older,
				loading: this.#history.pendingHistory !== null,
				error: this.#history.historyError,
				freshness: this.#history.historyFreshness,
				revision: this.#history.historyRevision,
			},
			loading: this.#history.pendingSnapshot && {
				received: this.#history.pendingSnapshot.entries.length,
				total: this.#history.pendingSnapshot.total,
			},
		};
	}

	#scheduleCommit(): void {
		this.#publication.schedule(() => this.#commit());
	}

	#commit(): void {
		this.#publication.clear();
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
