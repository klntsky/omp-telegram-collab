import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label="Switch theme"
			title="Switch theme"
		>
			<Icon size={16} />
		</button>
	);
}
