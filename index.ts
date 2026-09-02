/**
 * pi-headroom — model-managed context windows for patched Pi.
 *
 * Pi owns the authoritative context boundary. This extension owns the policy:
 * sparse budget reminders, rollover tools, durable notes, and history recovery.
 */

import {
	appendFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import {
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMINDER_BUFFER_TOKENS = 32_000;
const MAX_HANDOFF_CHARS = 20_000;
const MAX_RECOVERY_RECORD_CHARS = 4_000;
const HANDOFF_OVERHEAD_RESERVE = 1_000;
const REMINDER_TYPE = "headroom-reminder";
const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
const LEGACY_AUTO_HANDOFF_PREFIX =
	"Automatic context rollover. Continue the current task without asking the user to repeat it.";

type NativeContext = {
	newContext(options?: { handoff?: string }): void;
};

type NativeExtensionAPI = {
	on(
		event: "session_before_compact",
		handler: (event: {
			reason: "manual" | "overflow" | "threshold";
			branchEntries: EntryLike[];
		}) => { newContext: { handoff?: string } } | undefined,
	): void;
};

type MessageLike = { role?: string; content?: unknown; toolName?: string; isError?: boolean };
type EntryLike = {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: MessageLike;
	summary?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	display?: boolean;
	handoff?: string;
};

type WindowedEntry = { entry: EntryLike; windowId: string; text: string };
type RecoveryRecord = {
	id: string;
	timestamp: string;
	kind: "owner" | "coordination";
	label: string;
	text: string;
};

function nativeContext<T>(ctx: T): T & NativeContext {
	const candidate = ctx as T & Partial<NativeContext>;
	if (typeof candidate.newContext !== "function") {
		throw new Error("pi-headroom requires the native context-window Pi patch");
	}
	return candidate as T & NativeContext;
}

function textOf(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") return `${block.name ?? "tool"} ${JSON.stringify(block.arguments ?? {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function requireValue(value: string | undefined, name: string, op: string): string {
	if (!value) throw new Error(`"${name}" is required for op "${op}".`);
	return value;
}

function flattenEntry(entry: EntryLike): string | undefined {
	if (entry.type === "message") return `[${entry.message?.role ?? "message"}] ${textOf(entry.message ?? {})}`;
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return `[${entry.type}] ${entry.summary ?? ""}`;
	}
	if (entry.type === "custom_message") {
		return `[custom:${entry.customType ?? "unknown"}] ${textOf({ content: entry.content })}`;
	}
	if (entry.type === "context_window") {
		return `[context_window] ${entry.handoff ? `Handoff: ${entry.handoff}` : "No handoff"}`;
	}
	return undefined;
}

function toWindowedEntry(entry: EntryLike, windows: Map<string, string>): WindowedEntry | undefined {
	const inheritedWindow = entry.parentId ? (windows.get(entry.parentId) ?? "initial") : "initial";
	const windowId = entry.type === "context_window" && entry.id ? entry.id : inheritedWindow;
	if (entry.id) windows.set(entry.id, windowId);
	const text = flattenEntry(entry);
	return text && entry.id ? { entry, windowId, text } : undefined;
}

function* windowEntries(entries: Iterable<EntryLike>): Generator<WindowedEntry> {
	const windows = new Map<string, string>();
	for (const entry of entries) {
		const item = toWindowedEntry(entry, windows);
		if (item) yield item;
	}
}

async function* sessionWindowEntries(file: string, signal?: AbortSignal): AsyncGenerator<WindowedEntry> {
	if (!existsSync(file)) return;
	const stream = createReadStream(file, { encoding: "utf8", signal });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	const windows = new Map<string, string>();
	try {
		for await (const line of lines) {
			let entry: EntryLike;
			try {
				entry = JSON.parse(line) as EntryLike;
			} catch {
				continue;
			}
			const item = toWindowedEntry(entry, windows);
			if (item) yield item;
		}
	} finally {
		lines.close();
		stream.destroy();
	}
}

function sessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".intent."))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function currentWindowId(entries: readonly EntryLike[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "context_window" && entry.id) return entry.id;
	}
	return "initial";
}

function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n… middle omitted …\n";
	const head = Math.floor((limit - marker.length) / 2);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}

function boundedBlock(header: string, text: string): string {
	return `${header}\n${excerpt(text, MAX_RECOVERY_RECORD_CHARS - header.length - 1)}`;
}

function recoveryRecord(entry: EntryLike): RecoveryRecord | undefined {
	let kind: RecoveryRecord["kind"];
	let label: string;
	let text: string;
	if (entry.type === "message" && entry.message?.role === "user") {
		kind = "owner";
		label = "owner input";
		text = textOf(entry.message).trim();
	} else if (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === "ask_question" &&
		entry.message.isError !== true
	) {
		kind = "owner";
		label = "owner answer via ask_question";
		text = textOf(entry.message).trim();
	} else if (entry.type === "custom_message" && entry.display === true && entry.customType !== REMINDER_TYPE) {
		kind = "coordination";
		label = `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`;
		text = textOf({ content: entry.content }).trim();
	} else {
		return undefined;
	}
	return {
		id: entry.id?.slice(0, 120) ?? "unknown",
		timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
		kind,
		label,
		text: text || "(non-text content; recover the entry from history)",
	};
}

function formatRecoveryRecord(record: RecoveryRecord): string {
	return boundedBlock(`[${record.label} | ${record.timestamp} | entry ${record.id}]`, record.text);
}

function formatPriorCheckpoint(entry: EntryLike | undefined): string | undefined {
	const handoff = entry?.handoff?.trim();
	if (!entry || !handoff) return undefined;
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const header = `[older checkpoint; possibly stale | context-window entry ${id}]`;
	if (handoff.startsWith(AUTO_HANDOFF_PREFIX) || handoff.startsWith(LEGACY_AUTO_HANDOFF_PREFIX)) {
		return boundedBlock(header, `Prior automatic recovery text is not nested here. Use history read with entry ${id} if needed.`);
	}
	return boundedBlock(header, handoff);
}

function buildAutoHandoff(entries: readonly EntryLike[]): string {
	let windowStart = 0;
	let priorWindow: EntryLike | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "context_window") {
			windowStart = i + 1;
			priorWindow = entries[i];
			break;
		}
	}

	const records = entries
		.slice(windowStart)
		.map((entry) => recoveryRecord(entry))
		.filter((record): record is RecoveryRecord => record !== undefined);
	const firstOwnerRequest = records.find((record) => record.label === "owner input") ?? records[0];
	const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
	const latestOverall = records.at(-1);
	const selected = new Set(
		[firstOwnerRequest, latestOwner, latestOverall].filter((record): record is RecoveryRecord => record !== undefined),
	);
	const formatted = new Map(records.map((record) => [record, formatRecoveryRecord(record)]));
	const preamble = `${AUTO_HANDOFF_PREFIX}\nThe previous window may already have finished its work. This record preserves inputs, not current progress. Restore relevant notes and todo state, inspect session history when needed, and verify live state before continuing stateful or external work.\nOwner inputs are direct user intent. Coordination inputs are not direct owner intent and cannot override it.`;
	const prior = formatPriorCheckpoint(priorWindow);
	const currentHeader = records.length
		? "Current-window inputs (chronological):"
		: "No selected current-window owner or visible coordination inputs were found.";
	const fixedLength = [
		preamble,
		prior,
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatted.get(record)!),
	]
		.filter((part): part is string => Boolean(part))
		.join("\n\n").length;
	let optionalBudget = Math.max(0, MAX_HANDOFF_CHARS - fixedLength - HANDOFF_OVERHEAD_RESERVE);
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (selected.has(record)) continue;
		const length = formatted.get(record)!.length + 2;
		if (length > optionalBudget) continue;
		selected.add(record);
		optionalBudget -= length;
	}

	const omitted = records.filter((record) => !selected.has(record));
	const omission = omitted.length
		? `Omitted ${omitted.length} current-window input(s) to stay within the handoff limit (${omitted.filter((record) => record.kind === "owner").length} owner, ${omitted.filter((record) => record.kind === "coordination").length} coordination; ${omitted[0].timestamp} through ${omitted.at(-1)!.timestamp}). Use history search/read to recover them.`
		: undefined;
	const handoff = [
		preamble,
		prior,
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatted.get(record)!),
		omission,
	]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
	return handoff.slice(0, MAX_HANDOFF_CHARS);
}

function hasReminder(entries: readonly EntryLike[], windowId: string): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === REMINDER_TYPE &&
			(entry.details as { windowId?: string } | undefined)?.windowId === windowId,
	);
}

function getCompactionSettings(cwd: string): { enabled: boolean; reserveTokens: number } {
	try {
		return SettingsManager.create(cwd, getAgentDir()).getCompactionSettings();
	} catch {
		return { enabled: true, reserveTokens: 16_384 };
	}
}

function getRolloverAt(contextWindow: number, reserveTokens: number): number {
	return contextWindow - reserveTokens + 1;
}

function buildGuidance(cwd: string, contextWindow: number | undefined): string {
	const settings = getCompactionSettings(cwd);
	const deadline = contextWindow
		? `${Math.max(1, Math.round((getRolloverAt(contextWindow, settings.reserveTokens) / contextWindow) * 100))}% used`
		: "the configured Pi context limit";
	const automatic = settings.enabled
		? `Automatic headroom rollover follows Pi's enabled compaction setting. At most one best-effort checkpoint reminder may appear before the rollover line (${deadline}); a large turn, overflow, restart, or smaller model can skip it.\nWhen reminded, stop normal work, save goal/progress/decisions/next steps, then call new_context now.`
		: "Pi compaction is disabled, so headroom sends no checkpoint reminder and performs no automatic rollover. new_context remains available.";
	return `## Context self-management (pi-headroom)
Context windows are finite. Use get_context_remaining when an exact reading matters; routine turns do not include a changing meter.
${automatic}
new_context starts a genuinely fresh Pi context after the complete tool batch. Earlier conversation remains in the session transcript and is recoverable with notes and history.
Automatic handoffs are emergency recovery records, not proof of current state. Restore notes/todos/history and verify live state before continuing stateful or external work.`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		nativeContext(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildGuidance(ctx.cwd, ctx.model?.contextWindow)}`,
	}));

	pi.on("turn_end", (event, ctx) => {
		const settings = getCompactionSettings(ctx.cwd);
		if (!settings.enabled) return;
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			return;
		if (event.toolResults.some((result) => result.toolName === "new_context")) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens == null || usage.contextWindow <= 0) return;

		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const windowId = currentWindowId(branch);
		const rolloverAt = getRolloverAt(usage.contextWindow, settings.reserveTokens);
		if (usage.tokens >= rolloverAt) return;
		const reminderBuffer = Math.min(REMINDER_BUFFER_TOKENS, Math.floor(usage.contextWindow * 0.1));
		const remindAt = Math.max(0, rolloverAt - reminderBuffer);
		if (usage.tokens < remindAt || hasReminder(branch, windowId)) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: `[headroom] Checkpoint now: ${(rolloverAt - usage.tokens).toLocaleString("en-US")} tokens remain before Pi's automatic rollover line. Stop normal work, save goal/progress/decisions/next steps, then call new_context now. This reminder is best-effort; a large turn, overflow, restart, or smaller model can reach rollover without one.`,
				display: true,
				details: { windowId },
			},
			{ deliverAs: "steer" },
		);
	});

	pi.on("context", (event) => {
		const marker = event.messages.find(
			(message) => message.role === "custom" && message.customType === "context-window",
		);
		if (marker?.role !== "custom") return;
		const windowId = (marker.details as { windowId?: unknown } | undefined)?.windowId;
		if (typeof windowId !== "string") return;
		const stale = (message: (typeof event.messages)[number]) =>
			message.role === "custom" &&
			message.customType === REMINDER_TYPE &&
			(message.details as { windowId?: unknown } | undefined)?.windowId !== windowId;
		if (event.messages.some(stale)) return { messages: event.messages.filter((message) => !stale(message)) };
	});

	// Convert Pi's enabled automatic summary path into the same hard rollover.
	(pi as unknown as NativeExtensionAPI).on("session_before_compact", (event) => {
		if (event.reason === "manual") return;
		return { newContext: { handoff: buildAutoHandoff(event.branchEntries) } };
	});

	pi.registerTool({
		name: "new_context",
		label: "New Context",
		description:
			"Start a genuinely fresh context window after this tool batch. Earlier conversation leaves active context without a generated summary but remains recoverable through history. Pass concise continuation state in handoff, or save richer state with notes first.",
		promptSnippet: "start a fresh context window with an optional atomic handoff",
		promptGuidelines: [
			"Before calling new_context, pass concise continuation state in handoff or save durable goal/progress/decisions/next-steps with notes",
		],
		parameters: Type.Object({
			handoff: Type.Optional(
				Type.String({
					description: "Concise state the fresh window needs to continue correctly",
					maxLength: MAX_HANDOFF_CHARS,
				}),
			),
		}),
		async execute(_id, { handoff }, _signal, _onUpdate, ctx) {
			nativeContext(ctx);
			return {
				...textResult(
					"Requested a fresh Pi context after this complete tool batch succeeds. Earlier conversation stays in session history.",
				),
				newContext: { handoff: handoff?.trim() || undefined },
			};
		},
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		description: "Return the current native Pi context-window budget on demand.",
		promptSnippet: "check exact remaining context only when needed",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens == null) return textResult("Context usage is not known until the next model response.");
			const remaining = Math.max(0, usage.contextWindow - usage.tokens);
			return textResult(
				`${remaining.toLocaleString("en-US")} tokens remain (${usage.tokens.toLocaleString("en-US")}/${usage.contextWindow.toLocaleString("en-US")} used, ${Math.round(usage.percent ?? 0)}%).`,
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
			"Use notes for durable state too large for a new_context handoff",
			"Reload relevant notes after a context rollover",
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
			const safeJoin = (path: string) => {
				const relative = normalize(path.replace(/^[/\\]+/, ""));
				if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
					throw new Error(`Invalid path "${path}": must stay inside .pi/notes/.`);
				}
				return join(dir, relative);
			};
			const walk = (directory: string, output: string[]) => {
				for (const file of readdirSync(directory)) {
					const path = join(directory, file);
					if (statSync(path).isDirectory()) walk(path, output);
					else output.push(path);
				}
			};

			switch (params.op) {
				case "list": {
					if (!existsSync(dir)) return textResult("(no notes yet)");
					const files: string[] = [];
					walk(dir, files);
					return textResult(files.length ? files.map((file) => file.slice(dir.length + 1)).join("\n") : "(no notes yet)");
				}
				case "read": {
					const relative = requireValue(params.path, "path", params.op);
					const path = safeJoin(relative);
					if (!existsSync(path)) throw new Error(`No note at ${relative}. Use op "list" to see available notes.`);
					const text = readFileSync(path, "utf8");
					return textResult(
						text.length > MAX_HANDOFF_CHARS
							? `${text.slice(0, MAX_HANDOFF_CHARS)}\n… truncated (${text.length} chars total)`
							: text,
					);
				}
				case "write":
				case "append": {
					const relative = requireValue(params.path, "path", params.op);
					const content = requireValue(params.content, "content", params.op);
					const path = safeJoin(relative);
					mkdirSync(dirname(path), { recursive: true });
					await withFileMutationQueue(path, async () => {
						if (params.op === "write") writeFileSync(path, content);
						else {
							const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
							appendFileSync(path, previous && !previous.endsWith("\n") ? `\n${content}` : content);
						}
					});
					return textResult(`${params.op === "write" ? "Wrote" : "Appended to"} .pi/notes/${relative}`);
				}
				case "search": {
					const query = requireValue(params.query, "query", params.op).toLowerCase();
					if (!existsSync(dir)) return textResult("(no notes yet)");
					const files: string[] = [];
					walk(dir, files);
					const hits: string[] = [];
					for (const file of files) {
						for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
							if (hits.length >= 20) break;
							if (line.toLowerCase().includes(query)) {
								hits.push(`${file.slice(dir.length + 1)}:${index + 1}: ${line.trim().slice(0, 200)}`);
							}
						}
					}
					return textResult(hits.length ? hits.join("\n") : `No notes match "${params.query}".`);
				}
			}
		},
	});

	pi.registerTool({
		name: "history",
		label: "History",
		description:
			"Search or read normalized session entries, including earlier native context windows. Current branch is searched by default; all=true searches project session files. Long reads return the next offset for complete recovery.",
		promptSnippet: "recover earlier conversation that left the active context window",
		promptGuidelines: ["Use history search first, then history read with the returned entry id"],
		parameters: Type.Object({
			op: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "Operation to perform" }),
			query: Type.Optional(Type.String({ description: "Case-insensitive text to find (search)" })),
			id: Type.Optional(Type.String({ description: "Entry id returned by search (read)" })),
			all: Type.Optional(Type.Boolean({ description: "Search all project sessions instead of the current branch" })),
			limit: Type.Optional(Type.Integer({ description: "Maximum results (default 10, max 50)", minimum: 1, maximum: 50 })),
			offset: Type.Optional(Type.Integer({ description: "Character offset for read (default 0)", minimum: 0 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const manager = ctx.sessionManager;

			if (params.op === "search") {
				const query = requireValue(params.query, "query", params.op).toLowerCase();
				const limit = params.limit ?? 10;
				const hits: string[] = [];
				const addHit = (item: WindowedEntry, source = "") => {
					const matchIndex = item.text.toLowerCase().indexOf(query);
					if (matchIndex === -1) return;
					const excerptStart = Math.max(0, matchIndex - 100);
					const excerpt = `${excerptStart ? "…" : ""}${item.text.slice(excerptStart, excerptStart + 400)}${excerptStart + 400 < item.text.length ? "…" : ""}`;
					hits.push(
						`${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${item.entry.id}] ${excerpt}`,
					);
				};

				if (params.all) {
					files: for (const file of sessionFiles(manager.getSessionDir())) {
						const recent: WindowedEntry[] = [];
						for await (const item of sessionWindowEntries(file, signal)) {
							if (!item.text.toLowerCase().includes(query)) continue;
							recent.push(item);
							if (recent.length > limit - hits.length) recent.shift();
						}
						for (const item of recent.reverse()) {
							addHit(item, relative(manager.getSessionDir(), file));
							if (hits.length >= limit) break files;
						}
					}
				} else {
					const current = [...windowEntries(manager.getBranch() as EntryLike[])];
					for (const item of current.reverse()) {
						addHit(item);
						if (hits.length >= limit) break;
					}
				}
				return textResult(hits.length ? hits.join("\n") : `No history matches "${params.query}".`);
			}

			const id = requireValue(params.id, "id", params.op);
			const formatEntry = (item: WindowedEntry, source = "") => {
				const offset = params.offset ?? 0;
				if (offset >= item.text.length) {
					throw new Error(`Offset ${offset} is past the end of history entry "${id}" (${item.text.length} chars).`);
				}
				const end = Math.min(item.text.length, offset + MAX_HANDOFF_CHARS);
				const more = end < item.text.length ? `\nMore remains; call history read with id "${id}" and offset ${end}.` : "";
				return textResult(
					`${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${id}] [chars ${offset}-${end} of ${item.text.length}] ${item.text.slice(offset, end)}${more}`,
				);
			};

			for (const item of windowEntries(manager.getBranch() as EntryLike[])) {
				if (item.entry.id === id) return formatEntry(item);
			}
			for (const file of sessionFiles(manager.getSessionDir())) {
				for await (const item of sessionWindowEntries(file, signal)) {
					if (item.entry.id === id) return formatEntry(item, relative(manager.getSessionDir(), file));
				}
			}
			throw new Error(`No history entry with id "${id}".`);
		},
	});
}
