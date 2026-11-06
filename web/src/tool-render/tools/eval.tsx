/**
 * `eval` (aliases: js, python, notebook) — code cells executed in the
 * persistent kernel (py/js/rb/jl). Args arrive either as the modern single-cell
 * flat shape (`language`/`code`/`title`/`timeout`/`reset`), a legacy `cells`
 * array, or a legacy framed `input` string (`*** Cell`, `*** Begin LANG`,
 * `===== info =====`); all render as discrete highlighted cells. When the result
 * carries typed per-cell details, each cell's output is interleaved beneath its code.
 */
import type { ReactNode } from "react";
import { Badges, CodeBlock, InvalidArg, Note, ResultImages, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { argsDigest, detailsRecord, normalizeWs, str, truncate } from "../util";
import { CellOutput } from "./eval-output";
import { detailCellsOf, renderCells } from "./eval-results";

const HLJS_LANG: Record<string, string> = {
	py: "python",
	js: "javascript",
	ts: "typescript",
	rb: "ruby",
	jl: "julia",
};

function Summary({ name, args, result }: ToolRenderProps): ReactNode {
	const cells = renderCells(args, name, detailCellsOf(detailsRecord(result)));
	if (cells.length === 0) return <span className="tv-muted">{argsDigest(args)}</span>;
	const first = cells[0];
	const label = first.title || normalizeWs(first.code.split("\n").find(l => l.trim() !== "") ?? "");
	const langs = [...new Set(cells.map(c => c.lang))];
	return (
		<>
			{label && <span>{truncate(label, 72)}</span>}
			<Badges items={[cells.length > 1 ? `${cells.length} cells` : null, ...langs]} />
		</>
	);
}

function Body({ name, args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const detailCells = detailCellsOf(details);
	const cells = renderCells(args, name, detailCells);

	if (cells.length === 0) {
		const badArgs = !Array.isArray(args.cells) && str(args.input) === null && str(args.code) === null;
		return (
			<>
				{badArgs && <InvalidArg what="cells" />}
				<ResultImages result={result} />
				<ResultText result={result} maxLines={12} />
			</>
		);
	}

	const notice = str(details?.notice);

	return (
		<>
			<div className="tv-cells">
				{cells.map((cell, i) => {
					const dc = detailCells.find(c => c.index === i) ?? detailCells[i];
					const titleParts: string[] = [];
					if (cell.title) titleParts.push(cell.title);
					titleParts.push(cell.lang);
					titleParts.push(...cell.attrs);
					if (dc) {
						if (dc.durationMs !== null) {
							const ms = dc.durationMs;
							titleParts.push(ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
						}
						if (dc.status === "error")
							titleParts.push(dc.exitCode !== null ? `error (exit ${dc.exitCode})` : "error");
					}
					return (
						<div className="tv-cell" key={`c${i}`}>
							<CodeBlock code={cell.code} lang={HLJS_LANG[cell.lang] ?? null} title={titleParts.join(" · ")} />
							{dc && dc.output !== "" && <CellOutput cell={dc} />}
						</div>
					);
				})}
			</div>
			{notice && <Note>{notice}</Note>}
			<ResultImages result={result} />
			{detailCells.length === 0 && <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const evalRenderer: ToolRenderer = { Summary, Body };
