import type { AgentSnapshot, AssistantMessage, HostFrame, SessionState, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import type { ActiveTool, Notice } from "./client";
import { miniAppInterruptionAuthor } from "../../../shared/interruption";

const MAX_NOTICES = 50;

/** Owns the ephemeral live replica independently of retained transcript rows. */
export class GuestLiveState {
	noticeSeq = 0;
	state: SessionState | null = null;
	agents: readonly AgentSnapshot[] = [];
	progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	/**
	 * Bus-map keys absent from the latest `agents` frame. Progress can arrive
	 * before its agent is listed, so such keys survive one `agents` frame and
	 * are pruned only if the next one still omits them.
	 */
	unlistedBusIds = new Set<string>();
	stream: AssistantMessage | null = null;
	streamDone = false;
	activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	working = false;
	notices: readonly Notice[] = [];

	reset(state: SessionState, agents: readonly AgentSnapshot[]): void {
		this.state = state;
		this.agents = [...agents];
		this.stream = null;
		this.streamDone = false;
		this.activeTools = new Map();
		this.progress = new Map();
		this.lifecycle = new Map();
		this.unlistedBusIds.clear();
		this.working = state.isStreaming;
	}

	applyState(state: SessionState): void {
		this.state = state;
		this.working = state.isStreaming;
		if (!state.isStreaming) {
			this.activeTools = new Map();
			if (this.streamDone) {
				this.stream = null;
				this.streamDone = false;
			}
		}
	}

	/**
	 * Drops progress/lifecycle payloads of agents the host no longer lists.
	 * A key missing from this `agents` frame is pruned when it was already
	 * missing from the previous one; the one-frame grace covers progress that
	 * outran its agent's registration.
	 */
	pruneBusMaps(): void {
		if (this.progress.size === 0 && this.lifecycle.size === 0) {
			this.unlistedBusIds.clear();
			return;
		}
		const listed = new Set<string>();
		for (const agent of this.agents) listed.add(agent.id);
		const previouslyUnlisted = this.unlistedBusIds;
		const unlisted = new Set<string>();
		const prune = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
			let kept: Map<string, V> | null = null;
			for (const [id, value] of map) {
				const drop = !listed.has(id) && previouslyUnlisted.has(id);
				if (!listed.has(id) && !drop) unlisted.add(id);
				if (drop && kept === null) {
					kept = new Map();
					for (const [keptId, keptValue] of map) {
						if (keptId === id) break;
						kept.set(keptId, keptValue);
					}
				} else if (!drop && kept !== null) {
					kept.set(id, value);
				}
			}
			return kept ?? map;
		};
		this.progress = prune(this.progress);
		this.lifecycle = prune(this.lifecycle);
		this.unlistedBusIds = unlisted;
	}

	applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.stream = event.message;
					this.streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.stream = event.message;
					this.streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.activeTools = new Map(this.activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.activeTools = new Map(this.activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.activeTools);
				next.delete(event.toolCallId);
				this.activeTools = next;
				break;
			}
			case "agent_start":
				this.working = true;
				break;
			case "agent_end":
				this.working = false;
				break;
			case "notice":
				// Join announcements have no structured subtype; match only the verified producer's
				// two informational forms so other notices and participant-state frames survive.
				// https://github.com/can1357/oh-my-pi/blob/fbc3ac6a148d24d50f573e9b531999e32bae42eb/packages/coding-agent/src/collab/host.ts#L846-L850
				if (event.source === "collab" && event.level === "info" &&
					(event.message.endsWith(" joined the collab session") ||
					 event.message.endsWith(" joined the collab session (read-only)"))) break;
				if (miniAppInterruptionAuthor(event)) {
					this.working = false;
					this.activeTools = new Map();
					if (this.state) {
						this.state = { ...this.state, isStreaming: false, isAborting: false, queuedMessageCount: 0 };
					}
					if (this.stream && !this.streamDone) {
						this.stream = { ...this.stream, stopReason: "aborted" };
						this.streamDone = true;
					}
				}
				this.pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.noticeSeq, level, message, at: Date.now() };
		const next = [...this.notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.notices = next;
	}

}
