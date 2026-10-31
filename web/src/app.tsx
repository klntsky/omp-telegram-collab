import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { OmpMark } from "./components/shell/OmpMark";
import { ThemeToggle } from "./components/shell/ThemeToggle";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { GatewaySocket } from "./lib/socket";
import { authorizeSession, mountTelegramEnvironment, readTelegramLaunch, SessionAccessError } from "./lib/telegram";
import type { ClosedAuthorizedSession, TelegramLaunch } from "./lib/telegram";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

interface ClosedConnection {
	authorization: ClosedAuthorizedSession;
	launch: TelegramLaunch;
}

type ConnectionState =
	| { kind: "authorizing" }
	| { kind: "error"; message: string }
	| ({ kind: "closed"; phase: "idle" | "reopening" | "stale"; error: string | null } & ClosedConnection);

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connection, setConnection] = useState<ConnectionState>({ kind: "authorizing" });
	const clientRef = useRef<GuestClient | null>(null);
	const requestRef = useRef<AbortController | null>(null);
	const attemptRef = useRef(0);

	const connect = useCallback(async (confirmation?: ClosedConnection): Promise<void> => {
		if (confirmation && requestRef.current) return;
		const attempt = ++attemptRef.current;
		requestRef.current?.abort();
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		setConnection(confirmation
			? { kind: "closed", ...confirmation, phase: "reopening", error: null }
			: { kind: "authorizing" });
		const controller = new AbortController();
		requestRef.current = controller;
		const timeout = setTimeout(() => controller.abort(), 20_000);
		try {
			const launch = confirmation?.launch ?? readTelegramLaunch();
			const authorized = await authorizeSession(launch, controller.signal, confirmation?.authorization.generation, !!confirmation);
			if (attempt !== attemptRef.current) return;
			if (!("ticket" in authorized)) {
				setConnection({ kind: "closed", authorization: authorized, launch, phase: "idle", error: null });
				return;
			}
			const next = new GuestClient(
				new GatewaySocket(authorized.ticket, async signal => {
					const refreshed = await authorizeSession(launch, signal, authorized.generation);
					if (!("ticket" in refreshed)) {
						throw new SessionAccessError("This Telegram topic is closed. Rejoin to check whether it can be reopened.");
					}
					return refreshed.ticket;
				}),
				authorized.displayName,
			);
			clientRef.current = next;
			setClient(next);
			next.connect();
		} catch (error) {
			if (attempt === attemptRef.current) {
				const message = error instanceof Error ? error.message : "Could not join this session. Retry in a moment.";
				setConnection(confirmation
					? {
						kind: "closed",
						...confirmation,
						phase: error instanceof SessionAccessError && error.status === 409 ? "stale" : "idle",
						error: message,
					}
					: { kind: "error", message });
			}
		} finally {
			clearTimeout(timeout);
			if (attempt === attemptRef.current) {
				requestRef.current = null;
			}
		}
	}, []);

	const leave = useCallback((): void => {
		++attemptRef.current;
		requestRef.current?.abort();
		requestRef.current = null;
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		setConnection({ kind: "error", message: "You left this session. Retry to authenticate and join again, or return to your Telegram topic." });
	}, []);

	const rejoin = useCallback((): void => {
		void connect();
	}, [connect]);

	const reopen = useCallback((): void => {
		if (connection.kind !== "closed" || connection.phase !== "idle" || !connection.authorization.canReopen) return;
		void connect(connection);
	}, [connect, connection]);

	const cancelReopen = useCallback((): void => {
		++attemptRef.current;
		requestRef.current?.abort();
		requestRef.current = null;
		setConnection({ kind: "error", message: "Reopening cancelled. Return to Telegram, or retry to check this topic again." });
	}, []);

	useEffect(() => mountTelegramEnvironment(), []);

	useEffect(() => {
		void connect();
		return () => {
			++attemptRef.current;
			requestRef.current?.abort();
			clientRef.current?.close();
		};
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "OMP Collab · Telegram";
	}, [client]);

	if (!client) {
		const closed = connection.kind === "closed" ? connection : null;
		const loading = connection.kind === "authorizing" || closed?.phase === "reopening";
		const connectError = connection.kind === "error" ? connection.message : closed?.error;
		return (
			<div className="sh-connect">
				<div className="sh-ambient" />
				<div className="sh-connect-top">
					<div className="sh-brand">
						<OmpMark />
						<span>omp</span>
						<span className="sh-brand-slash">/</span>
						<span className="sh-brand-app">collab</span>
					</div>
					<ThemeToggle />
				</div>
				<section className="sh-connect-card" aria-busy={loading}>
					<div className="sh-connect-head">
						<h1 className="sh-connect-title">
							{closed ? "This Telegram topic is closed" : loading ? "Opening your Telegram session…" : "Join from Telegram"}
						</h1>
						<p className="sh-connect-sub">
							{closed
								? "Reopening this topic in Telegram permits the agent to work again. No agent connection is made until you confirm."
								: "Use the OPEN AGENT button in your group topic. Only current group members can access its conversation."}
						</p>
					</div>
					{connectError && <div className="sh-connect-error" role="alert" style={{ whiteSpace: "pre-wrap" }}>{connectError}</div>}
					{closed ? (
						<>
							{!closed.authorization.canReopen && (
								<p className="sh-connect-sub">An administrator must reopen the topic before you can connect.</p>
							)}
							{closed.phase === "reopening" && <p role="status">Reopening the Telegram topic…</p>}
							{closed.phase === "stale" && (
								<p className="sh-connect-sub">The session changed. Check the topic again before deciding whether to reopen it.</p>
							)}
							{closed.phase === "stale" || !closed.authorization.canReopen ? (
								<button type="button" className="sh-btn sh-btn-primary" onClick={rejoin}>Check topic again</button>
							) : (
								<button type="button" className="sh-btn sh-btn-primary" onClick={reopen} disabled={loading}>
									Reopen topic and connect
								</button>
							)}
							<button type="button" className="sh-btn" onClick={cancelReopen} disabled={loading}>Cancel</button>
						</>
					) : loading ? <p role="status">Checking Telegram authentication and group membership…</p> : (
						<button type="button" className="sh-btn sh-btn-primary" onClick={rejoin}>Retry</button>
					)}
				</section>
			</div>
		);
	}
	return <Session key={client.displayName} client={client} onLeave={leave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onLeave={onLeave}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onLeave={onLeave}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}
