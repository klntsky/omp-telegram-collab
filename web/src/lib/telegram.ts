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

export interface AuthorizedSession {
	session: { id: string; name: string; status: "open" | "closed" };
	ticket: string;
	generation: number;
	displayName: string;
}

export class SessionAccessError extends Error {}

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

export async function authorizeSession(launch: TelegramLaunch, signal: AbortSignal, generation?: number): Promise<AuthorizedSession> {
	let response: Response;
	try {
		response = await fetch("/api/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			cache: "no-store",
			body: JSON.stringify({ ...launch, generation }),
			signal,
		});
	} catch {
		throw new Error("Could not reach the session service. Check your connection and Retry.");
	}
	if (!response.ok) {
		if (response.status === 409) throw new SessionAccessError("This session was killed. Select Rejoin or reopen the topic’s OPEN AGENT button to resume explicitly.");
		if (response.status === 401 || response.status === 403) {
			throw new SessionAccessError("Telegram authentication expired or access was denied. Reopen the topic’s OPEN AGENT button and confirm you are still a group member.");
		}
		if (response.status === 404) throw new SessionAccessError("This topic’s session is unavailable. Reopen its OPEN AGENT button in Telegram.");
		throw new Error("The session service is unavailable. Retry in a moment.");
	}
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error("The session service returned an invalid response. Retry in a moment.");
	}
	if (!data || typeof data !== "object") throw new Error("Invalid session response. Retry in a moment.");
	const result = data as Partial<AuthorizedSession>;
	if (
		!result.session || result.session.id !== launch.sessionId || typeof result.session.name !== "string" ||
		(result.session.status !== "open" && result.session.status !== "closed") ||
		typeof result.ticket !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(result.ticket) ||
		typeof result.generation !== "number" || !Number.isSafeInteger(result.generation) || result.generation < 0 ||
		typeof result.displayName !== "string" || !result.displayName
	) {
		throw new Error("Invalid session response. Retry in a moment.");
	}
	return result as AuthorizedSession;
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
