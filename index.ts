/**
 * pi-headroom — model-managed context windows.
 *
 * Codex-style hard context cutovers for pi, without compaction summaries:
 *  1. A [headroom] meter message shows live context usage before every LLM call.
 *  2. The model calls new_context to drop earlier conversation from context.
 *     The cut is non-destructive: the session file keeps the full transcript.
 *  3. The notes tool persists durable state in .pi/notes/ across resets.
 *  4. The history tool searches/reads dropped conversation from session JSONL.
 *
 * Auto-compaction stays enabled as the fallback if the model never resets.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { Type } from "typebox";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const MARK = "[headroom]";

const GUIDANCE = `## Context self-management (pi-headroom)
A [headroom] message shows live context usage. When the window nears full or stops being useful:
1. Save durable state with the notes tool (.pi/notes/ survives context resets): goal, progress, decisions, next steps.
2. Call new_context. No summary is generated — earlier conversation leaves context but stays on disk.
3. Recover dropped conversation with the history tool; reload saved state with the notes tool.
Never guess about content that left the window — check notes/history instead of answering from memory.
If you never reset, automatic compaction remains the fallback.`;

type AnyMsg = { role: string; content?: unknown };

function textOf(m: AnyMsg): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (p?.type === "text" ? p.text : "")).join("\n");
	return "";
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function need(value: string | undefined, name: string, op: string): string {
	if (!value) throw new Error(`"${name}" is required for op "${op}".`);
	return value;
}

/** Flatten a session JSONL entry to readable text, or null for non-conversation entries. */
function flattenEntry(e: any): string | null {
	if (e?.type === "message") return `[${e.message?.role}] ${textOf(e.message ?? {})}`;
	if (e?.type === "compaction" || e?.type === "branch_summary") return `[${e.type}] ${e.summary ?? ""}`;
	if (e?.type === "custom_message") return `[custom:${e.customType}] ${textOf({ role: "custom", content: e.content })}`;
	return null;
}

function sessionFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl") && !f.includes(".intent."))
		.map((f) => join(dir, f));
}

export default function (pi: ExtensionAPI) {
	// When true, every LLM request sees only the current turn (from the last real
	// user message). Sticky until the window is fresh (nothing left to cut).
	let cutActive = false;

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}`,
	}));

	pi.on("context", (event, ctx) => {
		let messages = event.messages;
		let notice = "";
		if (cutActive) {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "user" && !textOf(messages[i]).startsWith(MARK)) {
					if (i > 0) {
						messages = messages.slice(i);
						notice =
							" Started a new context window — earlier conversation dropped from context (still on disk; use the history tool). Notes persist in .pi/notes/.";
					} else {
						cutActive = false; // nothing left to cut; window is fresh
					}
					break;
				}
			}
		}
		const u = ctx.getContextUsage();
		const meter =
			u?.tokens != null
				? `${MARK}${notice} Context ${u.tokens.toLocaleString("en-US")}/${u.contextWindow.toLocaleString("en-US")} tokens (${Math.round(u.percent ?? 0)}% used).`
				: `${MARK}${notice} Context usage unknown right now.`;
		return { messages: [...messages, { role: "user" as const, content: meter, timestamp: Date.now() }] };
	});

	pi.registerTool({
		name: "new_context",
		label: "New Context",
		description:
			"Start a new context window. Earlier conversation leaves context (no summary is generated) but stays on disk — recover it with the history tool. Notes in .pi/notes/ survive. Save durable state with the notes tool BEFORE calling this.",
		promptSnippet: "start a fresh context window when this one is nearly full or no longer useful",
		promptGuidelines: [
			"Always write durable state (goal, progress, decisions, next steps) with the notes tool before calling new_context — new_context does not summarize",
		],
		parameters: Type.Object({}),
		async execute() {
			cutActive = true;
			return textResult(
				"New context window starts on the next request. Earlier conversation is out of context but searchable with the history tool; notes persist in .pi/notes/.",
			);
		},
	});

	pi.registerTool({
		name: "notes",
		label: "Notes",
		description:
			"Persistent notes in .pi/notes/ that survive context resets. Ops: list, read, write (create/replace), append, search (case-insensitive substring over note lines).",
		promptSnippet: "save and recall durable state that survives context resets",
		promptGuidelines: [
			"Use the notes tool to save goal/progress/decisions/next-steps before calling new_context",
			"Use the notes tool after a context reset to reload saved state",
		],
		parameters: Type.Object({
			op: Type.Union(
				[Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("append"), Type.Literal("search")],
				{ description: "Operation to perform" },
			),
			path: Type.Optional(Type.String({ description: "Note path relative to .pi/notes/ (read/write/append)" })),
			content: Type.Optional(Type.String({ description: "Full file content (write) or text to add (append)" })),
			query: Type.Optional(Type.String({ description: "Substring to find in notes (search)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = join(ctx.cwd, ".pi", "notes");
			const safeJoin = (p: string) => {
				const rel = normalize(p.replace(/^[/\\]+/, ""));
				if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
					throw new Error(`Invalid path "${p}": must stay inside .pi/notes/.`);
				}
				return join(dir, rel);
			};
			const walk = (d: string, out: string[]) => {
				for (const f of readdirSync(d)) {
					const p = join(d, f);
					if (statSync(p).isDirectory()) walk(p, out);
					else out.push(p);
				}
			};

			switch (params.op) {
				case "list": {
					if (!existsSync(dir)) return textResult("(no notes yet)");
					const files: string[] = [];
					walk(dir, files);
					return textResult(files.length ? files.map((f) => f.slice(dir.length + 1)).join("\n") : "(no notes yet)");
				}
				case "read": {
					const rel = need(params.path, "path", params.op);
					const p = safeJoin(rel);
					if (!existsSync(p)) throw new Error(`No note at ${rel}. Use op "list" to see available notes.`);
					const text = readFileSync(p, "utf-8");
					return textResult(text.length > 20_000 ? `${text.slice(0, 20_000)}\n… truncated (${text.length} chars total)` : text);
				}
				case "write":
				case "append": {
					const rel = need(params.path, "path", params.op);
					const content = need(params.content, "content", params.op);
					const p = safeJoin(rel);
					mkdirSync(dirname(p), { recursive: true });
					await withFileMutationQueue(p, async () => {
						if (params.op === "write") {
							writeFileSync(p, content);
						} else {
							const prev = existsSync(p) ? readFileSync(p, "utf-8") : "";
							appendFileSync(p, prev && !prev.endsWith("\n") ? `\n${content}` : content);
						}
					});
					return textResult(`${params.op === "write" ? "Wrote" : "Appended to"} .pi/notes/${rel}`);
				}
				case "search": {
					const q = need(params.query, "query", params.op).toLowerCase();
					if (!existsSync(dir)) return textResult("(no notes yet)");
					const files: string[] = [];
					walk(dir, files);
					const hits: string[] = [];
					for (const f of files) {
						for (const [i, line] of readFileSync(f, "utf-8").split("\n").entries()) {
							if (hits.length >= 20) break;
							if (line.toLowerCase().includes(q)) hits.push(`${f.slice(dir.length + 1)}:${i + 1}: ${line.trim().slice(0, 200)}`);
						}
					}
					return textResult(hits.length ? hits.join("\n") : `No notes match "${params.query}".`);
				}
				default:
					throw new Error(`Unknown op "${params.op}".`);
			}
		},
	});

	pi.registerTool({
		name: "history",
		label: "History",
		description:
			"Search and read this session's full transcript — including conversation dropped by new_context — or past sessions of this project. Ops: search, read.",
		promptSnippet: "recover earlier conversation that left the context window",
		promptGuidelines: ["Use history search first, then history read on a specific entry id for full content"],
		parameters: Type.Object({
			op: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "Operation to perform" }),
			query: Type.Optional(Type.String({ description: "Substring to find, case-insensitive (search)" })),
			id: Type.Optional(Type.String({ description: "Entry id from a search result (read)" })),
			all: Type.Optional(Type.Boolean({ description: "Search all sessions of this project, not just the current one (search)" })),
			limit: Type.Optional(Type.Integer({ description: "Max results (default 10, max 50)", minimum: 1, maximum: 50 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sm = ctx.sessionManager;
			const current = sm.getSessionFile();
			const files = params.all
				? sessionFiles(sm.getSessionDir())
				: current
					? [current]
					: sessionFiles(sm.getSessionDir()).slice(-1);
			if (files.length === 0) return textResult("(no persisted session history yet)");

			if (params.op === "search") {
				const q = need(params.query, "query", params.op).toLowerCase();
				const limit = params.limit ?? 10;
				const results: string[] = [];
				for (const file of files) {
					for (const line of readFileSync(file, "utf-8").split("\n")) {
						if (results.length >= limit) break;
						if (!line.toLowerCase().includes(q)) continue;
						let e: any;
						try {
							e = JSON.parse(line);
						} catch {
							continue;
						}
						const flat = flattenEntry(e);
						if (!flat) continue;
						const excerpt = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
						results.push(`${params.all ? `${basename(file)} ` : ""}${e.timestamp ?? ""} [${e.id}] ${excerpt}`);
					}
				}
				return textResult(results.length ? results.join("\n") : `No history matches "${params.query}".`);
			}

			// read: find one entry by id across current + project sessions
			const id = need(params.id, "id", params.op);
			for (const file of params.all ? files : [...files, ...sessionFiles(sm.getSessionDir())]) {
				for (const line of readFileSync(file, "utf-8").split("\n")) {
					if (!line.includes(id)) continue;
					let e: any;
					try {
						e = JSON.parse(line);
					} catch {
						continue;
					}
					if (e?.id !== id) continue;
					const flat = flattenEntry(e) ?? line;
					return textResult(
						`${e.timestamp ?? ""} [${e.id}] ${flat.length > 20_000 ? `${flat.slice(0, 20_000)}… truncated` : flat}`,
					);
				}
			}
			throw new Error(`No history entry with id "${id}".`);
		},
	});
}
