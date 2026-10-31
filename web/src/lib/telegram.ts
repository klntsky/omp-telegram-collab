import { refreshSystemTheme } from "./theme";

export interface TelegramWebApp {
	initData: string;
	initDataUnsafe: { start_param?: string };
	colorScheme: "light" | "dark";
	themeParams: { bg_color?: string; text_color?: string; secondary_bg_color?: string };
	viewportHeight: number;
	viewportStableHeight?: number;
	ready(): void;
	expand(): void;
	onEvent(event: "themeChanged" | "viewportChanged", callback: () => void): void;
	offEvent(event: "themeChanged" | "viewportChanged", callback: () => void): void;
}

declare global {
	interface Window {
		Telegram?: { WebApp?: TelegramWebApp };
	}
}

export interface TelegramLaunch {
	botId: number;
	sessionId: string;
	initData: string;
}

interface SessionAuthorization {
	credential: string;
	generation: number;
	displayName: string;
	canReopen: boolean;
}

export interface ClosedAuthorizedSession extends SessionAuthorization {
	session: { id: string; name: string; status: "closed" };
}

export type AuthorizedSession = ClosedAuthorizedSession | (SessionAuthorization & {
	session: { id: string; name: string; status: "open" };
	ticket: string;
});

export class SessionAccessError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

const sessionCredentials = new Map<string, { initData: string; credential: string }>();

function readSessionCredential(launch: TelegramLaunch): string | undefined {
	const key = `omp-collab-auth:${launch.botId}:${launch.sessionId}`;
	let cached = sessionCredentials.get(key);
	if (!cached) {
		try {
			const stored: unknown = JSON.parse(globalThis.sessionStorage.getItem(key) ?? "null");
			if (stored && typeof stored === "object" && "initData" in stored && "credential" in stored &&
				typeof stored.initData === "string" && typeof stored.credential === "string" && stored.credential) {
				cached = { initData: stored.initData, credential: stored.credential };
				sessionCredentials.set(key, cached);
			}
		} catch {}
	}
	return cached?.initData === launch.initData ? cached.credential : undefined;
}

function saveSessionCredential(launch: TelegramLaunch, credential: string): void {
	const key = `omp-collab-auth:${launch.botId}:${launch.sessionId}`;
	const cached = { initData: launch.initData, credential };
	sessionCredentials.set(key, cached);
	try {
		globalThis.sessionStorage.setItem(key, JSON.stringify(cached));
	} catch {}
}

export function readTelegramLaunch(): TelegramLaunch {
	const app = window.Telegram?.WebApp;
	if (!app?.initData) {
		throw new Error("Open this Mini App using the OPEN AGENT button in your Telegram topic. Telegram authentication is required.");
	}
	const botHint = new URLSearchParams(window.location.search).get("bot");
	const botId = Number(botHint);
	if (!botHint || !/^\d+$/.test(botHint) || !Number.isSafeInteger(botId) || botId <= 0) {
		throw new Error("This Mini App is missing its bot configuration. Set its BotFather app URL to include ?bot=<bot ID>, then reopen the topic’s OPEN AGENT button.");
	}
	const startParam = app.initDataUnsafe.start_param;
	if (typeof startParam !== "string" || !/^s_[A-Za-z0-9_-]{16,128}$/.test(startParam)) {
		throw new Error("No session was selected. Open this Mini App from the OPEN AGENT button in a Telegram topic.");
	}
	return { botId, sessionId: startParam.slice(2), initData: app.initData };
}

export async function authorizeSession(launch: TelegramLaunch, signal: AbortSignal, generation?: number, reopen = false): Promise<AuthorizedSession> {
	const response = await fetch("/api/session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "same-origin",
		cache: "no-store",
		body: JSON.stringify({ ...launch, credential: readSessionCredential(launch), generation, reopen }),
		signal,
	});
	if (!response.ok) {
		const body = await response.text();
		let message = body || `Session request failed (${response.status} ${response.statusText}).`;
		try {
			const error: unknown = JSON.parse(body);
			if (error && typeof error === "object" && "error" in error && typeof error.error === "string") {
				message = error.error;
			}
		} catch {}
		if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 409) {
			throw new SessionAccessError(message, response.status);
		}
		throw new Error(message);
	}
	const data: unknown = await response.json();
	if (
		!data || typeof data !== "object" ||
		!("session" in data) || !data.session || typeof data.session !== "object" ||
		!("id" in data.session) || data.session.id !== launch.sessionId ||
		!("name" in data.session) || typeof data.session.name !== "string" ||
		!("status" in data.session) || (data.session.status !== "open" && data.session.status !== "closed") ||
		!("credential" in data) || typeof data.credential !== "string" || !data.credential ||
		!("generation" in data) || typeof data.generation !== "number" || !Number.isSafeInteger(data.generation) || data.generation < 0 ||
		!("displayName" in data) || typeof data.displayName !== "string" || !data.displayName ||
		!("canReopen" in data) || typeof data.canReopen !== "boolean"
	) {
		throw new Error("Invalid session response. Retry in a moment.");
	}
	const common = {
		credential: data.credential,
		generation: data.generation,
		displayName: data.displayName,
		canReopen: data.canReopen,
	};
	let result: AuthorizedSession;
	if (data.session.status === "closed") {
		if ("ticket" in data) throw new Error("Invalid session response. Retry in a moment.");
		result = { ...common, session: { id: data.session.id, name: data.session.name, status: "closed" } };
	} else {
		if (!("ticket" in data) || typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(data.ticket)) {
			throw new Error("Invalid session response. Retry in a moment.");
		}
		result = { ...common, session: { id: data.session.id, name: data.session.name, status: "open" }, ticket: data.ticket };
	}
	signal.throwIfAborted();
	saveSessionCredential(launch, result.credential);
	return result;
}

export function mountTelegramEnvironment(): () => void {
	const app = window.Telegram?.WebApp;
	const viewport = window.visualViewport;
	const updateHeight = (): void => {
		const heights = [viewport?.height, app?.viewportHeight].filter((height): height is number =>
			typeof height === "number" && Number.isFinite(height) && height > 0,
		);
		const height = heights.length ? Math.min(...heights) : window.innerHeight;
		document.documentElement.style.setProperty("--viewport-height", `${height}px`);
		window.scrollTo(0, 0);
	};
	const updateTheme = (): void => {
		refreshSystemTheme();
		for (const [name, value] of Object.entries(app?.themeParams ?? {})) {
			if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
				document.documentElement.style.setProperty(`--tg-theme-${name.replaceAll("_", "-")}`, value);
			}
		}
	};
	app?.ready();
	app?.expand();
	updateTheme();
	updateHeight();
	app?.onEvent("themeChanged", updateTheme);
	app?.onEvent("viewportChanged", updateHeight);
	viewport?.addEventListener("resize", updateHeight);
	viewport?.addEventListener("scroll", updateHeight);
	window.addEventListener("resize", updateHeight);
	return () => {
		app?.offEvent("themeChanged", updateTheme);
		app?.offEvent("viewportChanged", updateHeight);
		viewport?.removeEventListener("resize", updateHeight);
		viewport?.removeEventListener("scroll", updateHeight);
		window.removeEventListener("resize", updateHeight);
	};
}
