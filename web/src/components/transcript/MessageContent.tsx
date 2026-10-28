import type { ImageContent, TextContent } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { Markdown } from "./Markdown";
import { splitMessageMetadata } from "./metadata";

export function MetadataDisclosure({ label, children }: { label: string; children: ReactNode }): ReactNode {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<div className="tr-metadata">
			<button
				type="button"
				className="tr-think-head tr-metadata-head"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(value => !value)}
			>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				{label}
			</button>
			<div id={bodyId} hidden={!open} className="tr-metadata-body">
				{open && children}
			</div>
		</div>
	);
}

function MessageText({ text }: { text: string }): ReactNode {
	const parts = useMemo(() => splitMessageMetadata(text), [text]);
	return parts.map((part, index) =>
		part.type === "text" ? (
			<Markdown key={index} text={part.text} />
		) : (
			<MetadataDisclosure key={index} label={part.tag}>
				<pre className="tr-metadata-source">{part.text}</pre>
			</MetadataDisclosure>
		),
	);
}

/** User and custom content retain attachment order while envelopes stay lazy. */
export function MessageContent({
	content,
	collapseMetadata = true,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	collapseMetadata?: boolean;
}): ReactNode {
	const Text = collapseMetadata ? MessageText : Markdown;
	if (typeof content === "string") return <Text text={content} />;
	return content.map((block, index) => {
		switch (block.type) {
			case "text":
				return <Text key={index} text={block.text} />;
			case "image":
				return (
					<img
						key={index}
						className="tr-msg-img"
						src={`data:${block.mimeType};base64,${block.data}`}
						alt="attachment"
					/>
				);
			default:
				return null;
		}
	});
}
