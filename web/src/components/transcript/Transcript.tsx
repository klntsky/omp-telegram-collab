import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase, GuestSnapshot } from "../../lib/client";
import type { ToolRenderHost } from "../../tool-render";
import { AssistantBody, EntryRow, Row } from "./TranscriptRows";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	history?: GuestSnapshot["history"];
	onLoadEarlier?: () => void;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase, history, onLoadEarlier } = props;

	const [pin, setPin] = useState<{ revision: number | undefined; start: SessionEntry | "beginning" | null }>({
		revision: history?.revision,
		start: null,
	});
	const pinnedStart = pin.revision === history?.revision ? pin.start : null;
	const setPinnedStart = (start: SessionEntry | "beginning" | null): void => {
		setPin({ revision: history?.revision, start });
	};
	const tailStart = Math.max(0, entries.length - WINDOW);
	const pinnedIndex = useMemo(
		() => pinnedStart === "beginning" ? 0 : pinnedStart === null ? tailStart : entries.indexOf(pinnedStart),
		[entries, pinnedStart, tailStart],
	);
	const start = pinnedIndex < 0 ? tailStart : Math.min(pinnedIndex, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);
	const lastScrollTopRef = useRef(0);
	const earlierScrollArmedRef = useRef(true);
	const historyRevisionRef = useRef(history?.revision);

	const captureAnchor = (): void => {
		const el = rootRef.current;
		if (!el) return;
		prependRef.current = null;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (!row.matches(".tr-row, .tr-divider")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
	};

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) {
			followTranscriptTail(el, lockRef);
			lastScrollTopRef.current = el.scrollTop;
		}
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		prependRef.current = null;
		followTranscriptTail(el, lockRef, true);
		lastScrollTopRef.current = el.scrollTop;
	}, [phase]);

	useLayoutEffect(() => {
		const replaced = historyRevisionRef.current !== history?.revision;
		historyRevisionRef.current = history?.revision;
		if (replaced || (history && history.freshness !== "ready")) {
			prependRef.current = null;
			earlierScrollArmedRef.current = false;
		}
		if (replaced && rootRef.current) lastScrollTopRef.current = rootRef.current.scrollTop;
	}, [history?.revision, history?.freshness]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		if (!history?.loading) prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
		lastScrollTopRef.current = el.scrollTop;
	}, [start, entries, history?.loading, history?.error, history?.freshness, history?.revision]);

	const showEarlier = (): void => {
		if (!rootRef.current || history?.loading || history?.freshness === "refreshing") return;
		if (start === 0 && (!history?.older || !onLoadEarlier || phase !== "live")) return;
		captureAnchor();
		lockRef.current = false;
		earlierScrollArmedRef.current = false;
		if (start > 0) {
			const next = Math.max(0, start - WINDOW);
			setPinnedStart(next === 0 ? "beginning" : entries[next]!);
		} else {
			setPinnedStart("beginning");
			onLoadEarlier?.();
		}
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null || el.scrollTop === lastScrollTopRef.current) return;
				const movingUp = el.scrollTop < lastScrollTopRef.current;
				lastScrollTopRef.current = el.scrollTop;
				updateTranscriptTailLock(el, lockRef);
				if (lockRef.current) {
					prependRef.current = null;
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start === 0 ? "beginning" : entries[start]!);
				}
				if (history?.loading && !lockRef.current) captureAnchor();
				if (el.scrollTop > EARLIER_TRIGGER_PX) earlierScrollArmedRef.current = true;
				if (
					movingUp && el.scrollTop <= EARLIER_TRIGGER_PX && earlierScrollArmedRef.current &&
					history?.freshness !== "unverified"
				) showEarlier();
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{(start > 0 || history?.older || history?.loading || history?.error || history?.freshness === "refreshing") && (
				<div className="tr-history" aria-busy={history?.loading || history?.freshness === "refreshing"}>
					<button
						type="button"
						className="tr-earlier"
						disabled={
							history?.loading || history?.freshness === "refreshing" ||
							(start === 0 && (phase !== "live" || !history?.older))
						}
						onClick={showEarlier}
					>
						{history?.loading ? "loading earlier…" : history?.error ? "retry earlier history" : "show earlier"}
					</button>
					{history?.freshness === "refreshing" && (
						<div className="tr-history-status" role="status">Refreshing session history…</div>
					)}
					{history?.freshness === "unverified" && (
						<div className="tr-history-status" role="status">
							{history.older
								? "History is unverified. Retry earlier history to check again."
								: "History is unverified. Waiting for the session source to recover."}
						</div>
					)}
					{history?.error && <div className="tr-history-error" role="alert">{history.error}</div>}
				</div>
			)}
			{visible.map(entry => (
				<EntryRow key={entry.id} entry={entry} results={results} active={activeTools} host={host} />
			))}
			{stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
