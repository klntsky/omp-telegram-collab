import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { OmpMark } from "./components/shell/OmpMark";
import { ThemeToggle } from "./components/shell/ThemeToggle";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { GatewaySocket } from "./lib/socket";
import { authorizeSession, mountTelegramEnvironment, readTelegramLaunch, SessionAccessError } from "./lib/telegram";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

type ConnectionState =
	| { kind: "authorizing" }
	| { kind: "error"; message: string }
	| { kind: "closed" };

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connection, setConnection] = useState<ConnectionState>({ kind: "authorizing" });
	const clientRef = useRef<GuestClient | null>(null);
	const requestRef = useRef<AbortController | null>(null);
	const attemptRef = useRef(0);

	const connect = useCallback(async (): Promise<void> => {
		const attempt = ++attemptRef.current;
		requestRef.current?.abort();
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		setConnection({ kind: "authorizing" });
		const controller = new AbortController();
		requestRef.current = controller;
		const timeout = setTimeout(() => controller.abort(), 20_000);
		try {
			const launch = readTelegramLaunch();
			const authorized = await authorizeSession(launch, controller.signal);
			if (attempt !== attemptRef.current) return;
			if (!("ticket" in authorized)) {
				setConnection({ kind: "closed" });
				return;
			}
			const next = new GuestClient(
				new GatewaySocket(authorized.ticket, async signal => {
					const refreshed = await authorizeSession(launch, signal, authorized.generation);
					if (!("ticket" in refreshed)) {
						throw new SessionAccessError("This Telegram topic is closed. Return to Telegram to manage it.");
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
				setConnection({ kind: "error", message });
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
		const loading = connection.kind === "authorizing";
		const connectError = connection.kind === "error" ? connection.message : null;
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
								? "Return to Telegram to manage this topic. The Mini App only displays conversations."
								: "Use the OPEN AGENT button in your group topic. Only current group members can access its conversation."}
						</p>
					</div>
					{connectError && <div className="sh-connect-error" role="alert" style={{ whiteSpace: "pre-wrap" }}>{connectError}</div>}
					{closed ? (
						<button type="button" className="sh-btn sh-btn-primary" onClick={rejoin}>Check topic again</button>
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
