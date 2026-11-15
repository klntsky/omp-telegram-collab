import { isRecord, num, str } from "../util";
import { cellsFromArgs, evalLangAlias, type EvalCell } from "./eval-input";
import { viewsOf, type EvalViewEntry } from "./eval-output";

/** Per-cell execution result from `result.details.cells` (typed by the tool). */
export interface DetailCell {
	index: number;
	title: string;
	code: string;
	lang: string | null;
	output: string;
	status: string;
	durationMs: number | null;
	exitCode: number | null;
	views: EvalViewEntry[];
}

export function detailCellsOf(details: Record<string, unknown> | null): DetailCell[] {
	const raw = details?.cells;
	if (!Array.isArray(raw)) return [];
	const out: DetailCell[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item: unknown = raw[i];
		if (!isRecord(item)) continue;
		const language = str(item.language);
		out.push({
			index: num(item.index) ?? i,
			title: str(item.title) ?? "",
			code: str(item.code) ?? "",
			lang: language !== null ? (evalLangAlias(language) ?? "py") : null,
			output: str(item.output) ?? "",
			status: str(item.status) ?? "",
			durationMs: num(item.durationMs),
			exitCode: num(item.exitCode),
			views: viewsOf(item.views),
		});
	}
	return out;
}

export function renderCells(args: Record<string, unknown>, name: string, detailCells: DetailCell[]): EvalCell[] {
	const cells = cellsFromArgs(args, name);
	if (cells.length > 0) return cells;
	return detailCells.map(c => ({ lang: c.lang ?? "py", title: c.title, attrs: [], code: c.code }));
}
