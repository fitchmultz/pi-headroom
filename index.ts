/**
 * Posthorse — fresh context, same journey.
 *
 * Native no-summary context windows for the fitchmultz/pi fork. Pi owns the persisted
 * boundary. Posthorse owns the policy: sparse budget reminders, rollover tools, durable
 * notes, and history recovery.
 */

import {
	appendFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMINDER_BUFFER_TOKENS = 32_000;
/** Absolute ceiling for handoffs and read pages; pages shrink to the live remaining budget. */
const MAX_HANDOFF_CHARS = 20_000;
const MAX_RECOVERY_RECORD_CHARS = 4_000;
const HANDOFF_OVERHEAD_RESERVE = 1_000;
const PAGE_MARGIN_TOKENS = 1_000;
const MIN_PAGE_CHARS = 1_000;
const ESTIMATED_IMAGE_CHARS = 4_800;
/** A window must hold the largest handoff (~5,000 tokens) plus equal working room below Pi's line. */
const MIN_USABLE_TOKENS = Math.ceil(MAX_HANDOFF_CHARS / 4) * 2;
const REMINDER_TYPE = "posthorse-reminder";
/** Persisted by pi-headroom transcripts before the rename; still recognized everywhere. */
const LEGACY_REMINDER_TYPE = "headroom-reminder";
const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
const LEGACY_AUTO_HANDOFF_PREFIX =
	"Automatic context rollover. Continue the current task without asking the user to repeat it.";

type CompactionPolicy = { enabled: boolean; reserveTokens: number };
type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
/** Fork-only ExtensionContext members; the published Pi types do not declare them. */
type NativeContext = {
	model?: { contextWindow: number };
	newContext(options?: { handoff?: string }): void;
	getCompactionSettings(): CompactionPolicy;
	getContextUsage(): ContextUsage | undefined;
	getSystemPrompt(): string;
};

type NativeExtensionAPI = {
	on(
		event: "session_before_auto_compact",
		handler: (
			event: { reason: "overflow" | "threshold"; branchEntries: EntryLike[]; pendingMessages?: MessageLike[] },
			ctx: unknown,
		) => { newContext: { handoff?: string } } | undefined,
	): void;
};

type ImageLike = { type: "image"; data: string; mimeType: string };
type MessageLike = {
	role?: string;
	stopReason?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	excludeFromContext?: boolean;
};
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

type WindowedEntry = { entry: EntryLike; windowId: string; text: string; images: ImageLike[] };
type RecoveryRecord = {
	id: string;
	timestamp: string;
	kind: "owner" | "coordination";
	label: string;
	text: string;
};
type ReminderFingerprint = { windowId: string; contextWindow?: number; reserveTokens?: number };
type Budget = {
	contextWindow: number;
	reserveTokens: number;
	enabled: boolean;
	usable: number;
	rolloverAt: number;
	supported: boolean;
};

function nativeContext<T>(ctx: T): T & NativeContext {
	const candidate = ctx as T & Partial<NativeContext>;
	if (
		typeof candidate.newContext !== "function" ||
		typeof candidate.getCompactionSettings !== "function" ||
		typeof candidate.getSystemPrompt !== "function"
	) {
		throw new Error("Posthorse requires the fitchmultz/pi fork with native context windows (see README).");
	}
	return candidate as T & NativeContext;
}

function isReminderType(customType: unknown): boolean {
	return customType === REMINDER_TYPE || customType === LEGACY_REMINDER_TYPE;
}

function isImage(part: unknown): part is ImageLike {
	const block = part as Partial<ImageLike> | null;
	return typeof block === "object" && block !== null && block.type === "image" && typeof block.data === "string";
}

function imagesOf(content: unknown): ImageLike[] {
	return Array.isArray(content) ? content.filter(isImage) : [];
}

function imageSummary(images: ImageLike[]): string {
	if (!images.length) return "";
	const types = [...new Set(images.map((image) => image.mimeType || "unknown type"))].join(", ");
	return `[${images.length} image${images.length === 1 ? "" : "s"}: ${types}]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
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
			if (block.type === "toolCall") return `${block.name ?? "tool"} ${safeJsonStringify(block.arguments ?? {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function textResult(text: string, images: ImageLike[] = []) {
	return { content: [{ type: "text" as const, text }, ...images], details: undefined };
}

/**
 * Notes belong to the repository root, walking up from cwd. A linked worktree's `.git` is a file
 * ("gitdir: <main>/.git/worktrees/<name>"); its notes belong to the main checkout so every worktree
 * shares them and they outlive the worktree. Outside Git, cwd is the root.
 */
function notesRoot(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const marker = join(dir, ".git");
		if (existsSync(marker)) {
			try {
				const gitdir = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
				const main = gitdir && resolve(dir, gitdir).match(/^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/)?.[1];
				if (main) return main;
			} catch {}
			return dir;
		}
		if (dirname(dir) === dir) return cwd;
	}
}

function requireValue(value: string | undefined, name: string, op: string): string {
	if (value === undefined || value === "") throw new Error(`"${name}" is required for op "${op}".`);
	return value;
}

function excerptAround(text: string, index: number, before: number, length: number): string {
	const start = Math.max(0, index - before);
	const end = Math.min(text.length, start + length);
	return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function flattenEntry(entry: EntryLike): string | undefined {
	if (entry.type === "message") {
		const message = entry.message ?? {};
		if (message.role === "bashExecution") {
			// Pi keeps these out of every model's input on purpose; do not smuggle them back in through history.
			if (message.excludeFromContext === true) return "[bashExecution] (excluded from model context by Pi)";
			return `[bashExecution] $ ${message.command ?? ""}\n${message.output ?? ""}`;
		}
		return `[${message.role ?? "message"}] ${[textOf(message), imageSummary(imagesOf(message.content))].filter(Boolean).join("\n")}`;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return `[${entry.type}] ${entry.summary ?? ""}`;
	}
	if (entry.type === "custom_message") {
		return `[custom:${entry.customType ?? "unknown"}] ${[textOf({ content: entry.content }), imageSummary(imagesOf(entry.content))].filter(Boolean).join("\n")}`;
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
	if (!text || !entry.id) return undefined;
	const images = imagesOf(entry.type === "message" ? entry.message?.content : entry.content);
	return { entry, windowId, text, images };
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
	if (limit <= marker.length) return text.slice(0, limit);
	const head = Math.floor((limit - marker.length) / 2);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}

function boundedBlock(header: string, text: string, limit: number): string {
	const textLimit = Math.max(0, limit - header.length - 1);
	return textLimit ? `${header}\n${excerpt(text, textLimit)}` : header;
}

function recoveryRecord(entry: EntryLike): RecoveryRecord | undefined {
	let kind: RecoveryRecord["kind"];
	let label: string;
	let text: string;
	let images: ImageLike[] = [];
	if (entry.type === "message" && entry.message?.role === "user") {
		kind = "owner";
		label = "owner input";
		text = textOf(entry.message).trim();
		images = imagesOf(entry.message.content);
	} else if (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === "ask_question" &&
		entry.message.isError !== true
	) {
		kind = "owner";
		label = "owner answer via ask_question";
		text = textOf(entry.message).trim();
	} else if (entry.type === "custom_message" && entry.display === true && !isReminderType(entry.customType)) {
		kind = "coordination";
		label = `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`;
		text = textOf({ content: entry.content }).trim();
		images = imagesOf(entry.content);
	} else {
		return undefined;
	}
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const summary = imageSummary(images);
	return {
		id,
		timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
		kind,
		label,
		text: [text, summary && `${summary} — recover with history read id ${id}`].filter(Boolean).join("\n") || "(non-text content; recover the entry from history)",
	};
}

function formatRecoveryRecord(record: RecoveryRecord, limit: number): string {
	return boundedBlock(`[${record.label} | ${record.timestamp} | entry ${record.id}]`, record.text, limit);
}

function formatPriorCheckpoint(entry: EntryLike | undefined, limit: number): string | undefined {
	const handoff = entry?.handoff?.trim();
	if (!entry || !handoff) return undefined;
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const header = `[older checkpoint; possibly stale | context-window entry ${id}]`;
	if (handoff.startsWith(AUTO_HANDOFF_PREFIX) || handoff.startsWith(LEGACY_AUTO_HANDOFF_PREFIX)) {
		return boundedBlock(header, `Prior automatic recovery text is not nested here. Use history read with entry ${id} if needed.`, limit);
	}
	return boundedBlock(header, handoff, limit);
}

/**
 * The trailing tool batch no model has consumed yet: an assistant tool-call message followed only by
 * its completed results (and non-message entries). Pi can roll over right after tools finish, so the
 * result that triggered the rollover would otherwise vanish before any model saw it.
 */
function unconsumedToolBatch(
	entries: readonly EntryLike[],
): { callId: string; blocks: Array<{ header: string; text: string }> } | undefined {
	const results: EntryLike[] = [];
	let call: EntryLike | undefined;
	for (let i = entries.length - 1; i >= 0 && !call; i--) {
		const entry = entries[i];
		const role = entry.type === "message" ? entry.message?.role : undefined;
		if (role === "toolResult") {
			results.unshift(entry);
		} else if (role === "assistant") {
			const invalid =
				entry.message?.stopReason === "error" ||
				entry.message?.stopReason === "aborted" ||
				entry.message?.stopReason === "length";
			if (invalid) {
				if (results.length) return undefined;
			} else {
				call = entry;
			}
		}
	}
	if (!call || !results.length) return undefined;
	const calls = Array.isArray(call.message?.content)
		? (call.message.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>).filter(
				(block) => block?.type === "toolCall",
			)
		: [];
	const blocks = results.map((result) => {
		const message = result.message ?? {};
		const matching = calls.find((block) => block.id === message.toolCallId);
		const name = (message.toolName ?? matching?.name ?? "tool").slice(0, 80);
		const resultId = (result.id ?? "unknown").slice(0, 120);
		const images = imageSummary(imagesOf(message.content));
		const output =
			[textOf(message).trim(), images && `${images} — recover with history read id ${resultId}`]
				.filter(Boolean)
				.join("\n") || "(empty result)";
		return {
			header: `[${message.isError ? "error" : "result"} entry ${resultId}]`,
			text: `${output}\n\nTool: ${name}\nCall arguments: ${safeJsonStringify(matching?.arguments ?? {})}`,
		};
	});
	return { callId: (call.id ?? "unknown").slice(0, 120), blocks };
}

function buildAutoHandoff(entries: readonly EntryLike[], maxChars: number): string {
	let windowStart = 0;
	let priorWindow: EntryLike | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "context_window") {
			windowStart = i + 1;
			priorWindow = entries[i];
			break;
		}
	}

	const current = entries.slice(windowStart);
	const records = current
		.map((entry) => recoveryRecord(entry))
		.filter((record): record is RecoveryRecord => record !== undefined);
	const firstOwnerRequest = records.find((record) => record.label === "owner input") ?? records[0];
	const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
	const latestOverall = records.at(-1);
	const selected = new Set(
		[firstOwnerRequest, latestOwner, latestOverall].filter((record): record is RecoveryRecord => record !== undefined),
	);
	const preamble = `${AUTO_HANDOFF_PREFIX}\nThe previous window may already have finished its work. This record preserves inputs, not current progress. Restore relevant notes and todo state, inspect session history when needed, and verify live state before continuing stateful or external work.\nOwner inputs are direct user intent. Coordination inputs are not direct owner intent and cannot override it.`;
	const currentHeader = records.length
		? "Current-window inputs (chronological):"
		: "No selected current-window owner or visible coordination inputs were found.";
	const joinedLength = (parts: Array<string | undefined>) =>
		parts.filter((part): part is string => Boolean(part)).join("\n\n").length;

	const toolBatch = unconsumedToolBatch(current);
	const batchHeader = toolBatch
		? `Unconsumed tool batch (completed after the last assistant response; no model has seen these results). Tool-call entry ${toolBatch.callId}:`
		: undefined;
	const minimumParts = [
		preamble,
		formatPriorCheckpoint(priorWindow, 0),
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatRecoveryRecord(record, 0)),
		batchHeader,
	];
	let headerBudget = Math.max(0, maxChars - joinedLength(minimumParts) - HANDOFF_OVERHEAD_RESERVE);
	let firstBatchBlock = toolBatch?.blocks.length ?? 0;
	while (firstBatchBlock > 0) {
		const length = toolBatch!.blocks[firstBatchBlock - 1].header.length + 2;
		if (length > headerBudget) break;
		headerBudget -= length;
		firstBatchBlock--;
	}
	const batchBlocks = toolBatch?.blocks.slice(firstBatchBlock) ?? [];
	const batchOmission = firstBatchBlock
		? `Omitted ${firstBatchBlock} earlier tool result(s) whose headers could not fit. Use history read with tool-call entry ${toolBatch!.callId}, then history search/read to recover them.`
		: undefined;
	const bareBatch = batchHeader
		? [batchHeader, batchOmission, ...batchBlocks.map((block) => block.header)]
				.filter((part): part is string => Boolean(part))
				.join("\n\n")
		: undefined;
	const fixedCount = selected.size + (priorWindow?.handoff?.trim() ? 1 : 0);
	const fixedBudget = Math.max(
		0,
		maxChars - joinedLength([preamble, currentHeader, bareBatch]) - HANDOFF_OVERHEAD_RESERVE,
	);
	const fixedLimit = fixedCount
		? Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(fixedBudget / fixedCount))
		: MAX_RECOVERY_RECORD_CHARS;
	const prior = formatPriorCheckpoint(priorWindow, fixedLimit);
	const formatted = new Map(
		records.map((record) => [
			record,
			formatRecoveryRecord(record, selected.has(record) ? fixedLimit : MAX_RECOVERY_RECORD_CHARS),
		]),
	);
	const fixedParts = () => [
		preamble,
		prior,
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatted.get(record)!),
	];

	let batch: string | undefined;
	if (batchHeader && bareBatch) {
		const availableText = Math.max(
			0,
			maxChars -
				joinedLength([...fixedParts(), bareBatch]) -
				HANDOFF_OVERHEAD_RESERVE -
				batchBlocks.length,
		);
		const perBlock = Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(availableText / batchBlocks.length));
		batch = [
			batchHeader,
			batchOmission,
			...batchBlocks.map((block) => (perBlock ? `${block.header}\n${excerpt(block.text, perBlock)}` : block.header)),
		]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
	}

	let optionalBudget = Math.max(0, maxChars - joinedLength([...fixedParts(), batch]) - HANDOFF_OVERHEAD_RESERVE);
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
	return [...fixedParts(), omission, batch].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Legacy reminders carry only windowId; they match on it alone until the model changes. */
function reminderMatches(details: unknown, fingerprint: ReminderFingerprint): boolean {
	const stored = (details ?? {}) as Partial<ReminderFingerprint>;
	return (
		stored.windowId === fingerprint.windowId &&
		(stored.contextWindow ?? fingerprint.contextWindow) === fingerprint.contextWindow &&
		(stored.reserveTokens ?? fingerprint.reserveTokens) === fingerprint.reserveTokens
	);
}

function reminderIsStale(
	customType: unknown,
	details: unknown,
	fingerprint: ReminderFingerprint,
	branch: readonly EntryLike[],
): boolean {
	if (!reminderMatches(details, fingerprint)) return true;
	const stored = (details ?? {}) as Partial<ReminderFingerprint>;
	if (customType !== LEGACY_REMINDER_TYPE || stored.contextWindow !== undefined || stored.reserveTokens !== undefined) {
		return false;
	}
	let reminderIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (
			entry.type === "custom_message" &&
			entry.customType === LEGACY_REMINDER_TYPE &&
			((entry.details ?? {}) as Partial<ReminderFingerprint>).windowId === stored.windowId
		) {
			reminderIndex = i;
		}
	}
	return reminderIndex !== -1 && branch.slice(reminderIndex + 1).some((entry) => entry.type === "model_change");
}

function hasReminder(entries: readonly EntryLike[], fingerprint: ReminderFingerprint): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			isReminderType(entry.customType) &&
			!reminderIsStale(entry.customType, entry.details, fingerprint, entries),
	);
}

function budgetFor(ctx: NativeContext, contextWindow = ctx.model?.contextWindow): Budget | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	const { enabled, reserveTokens } = ctx.getCompactionSettings();
	const usable = contextWindow - reserveTokens;
	return { contextWindow, reserveTokens, enabled, usable, rolloverAt: usable + 1, supported: !enabled || usable >= MIN_USABLE_TOKENS };
}

/** Half the fresh capacity after prompt/tool/input overhead remains for continued work. */
function freshPayloadChars(ctx: NativeContext, toolTokens: number, pendingMessages: readonly MessageLike[] = []): number {
	const contextWindow = ctx.model?.contextWindow;
	if (!contextWindow || contextWindow <= 0) return MAX_HANDOFF_CHARS;
	const budget = budgetFor(ctx, contextWindow);
	const line = budget?.enabled && budget.supported ? budget.rolloverAt : contextWindow;
	const promptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
	const pendingTokens = pendingMessages.reduce(
		(total, message) => total + Math.ceil(textOf(message).length / 4) + imagesOf(message.content).length * (ESTIMATED_IMAGE_CHARS / 4),
		0,
	);
	return Math.min(
		MAX_HANDOFF_CHARS,
		Math.max(0, Math.floor((line - PAGE_MARGIN_TOKENS - promptTokens - toolTokens - pendingTokens) / 2)) * 4,
	);
}

function unsupportedMessage(budget: Budget): string {
	const n = (value: number) => value.toLocaleString("en-US");
	return `Posthorse: unsupported configuration. The model's context window (${n(budget.contextWindow)} tokens) minus Pi's compaction.reserveTokens (${n(budget.reserveTokens)}) leaves ${n(budget.usable)} usable tokens; Posthorse needs at least ${n(MIN_USABLE_TOKENS)}. Automatic rollover and checkpoint reminders are off for this model. Lower compaction.reserveTokens in Pi settings or use a larger-context model. new_context remains available with a model-aware handoff limit.`;
}

/** Characters that fit before Pi's automatic line (or the hard limit), capped at the absolute ceiling. */
function requirePage(ctx: NativeContext, offset: number, imageCount: number, toolTokens: number): number {
	const usage = ctx.getContextUsage();
	let chars: number;
	if (!usage || usage.tokens == null) {
		chars = Math.max(0, freshPayloadChars(ctx, toolTokens) - imageCount * ESTIMATED_IMAGE_CHARS);
	} else {
		const budget = budgetFor(ctx, usage.contextWindow);
		const line = budget?.enabled && budget.supported ? budget.rolloverAt : usage.contextWindow;
		chars = Math.min(
			MAX_HANDOFF_CHARS,
			Math.max(0, line - usage.tokens - PAGE_MARGIN_TOKENS) * 4 - imageCount * ESTIMATED_IMAGE_CHARS,
		);
	}
	if (chars < MIN_PAGE_CHARS) {
		throw new Error(
			`Too little context remains to read a page safely. Call new_context first, then retry with offset ${offset}.`,
		);
	}
	return chars;
}

function buildGuidance(ctx: NativeContext): string {
	const budget = budgetFor(ctx);
	const enabled = budget?.enabled ?? ctx.getCompactionSettings().enabled;
	let automatic: string;
	if (!enabled) {
		automatic =
			"Pi compaction is disabled, so Posthorse sends no checkpoint reminder and performs no automatic rollover. new_context remains available.";
	} else if (budget && !budget.supported) {
		automatic = unsupportedMessage(budget);
	} else {
		const deadline = budget
			? `${Math.max(1, Math.round((budget.rolloverAt / budget.contextWindow) * 100))}% used`
			: "the configured Pi context limit";
		automatic = `Automatic Posthorse rollover follows Pi's enabled compaction setting. At most one best-effort checkpoint reminder may appear before the rollover line (${deadline}); a large turn, overflow, restart, or smaller model can skip it.\nWhen reminded, stop normal work, save goal/progress/decisions/next steps, then call new_context now.`;
	}
	return `## Context self-management (Posthorse)
Context windows are finite. Use get_context_remaining for the best available native estimate when it matters; routine turns do not include a changing meter.
${automatic}
new_context starts a genuinely fresh Pi context after the complete tool batch. Earlier conversation remains in the session transcript and is recoverable with notes and history.
Automatic handoffs are emergency recovery records, not proof of current state. Restore notes/todos/history and verify live state before continuing stateful or external work.`;
}

export default function (pi: ExtensionAPI) {
	const activeToolTokens = () => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.reduce(
				(total, tool) =>
					total +
					Math.ceil(
						safeJsonStringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters })
							.length / 4,
					),
				0,
			);
	};

	pi.on("session_start", (_event, ctx) => {
		nativeContext(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildGuidance(nativeContext(ctx))}`,
	}));

	pi.on("turn_end", (event, ctx) => {
		const native = nativeContext(ctx);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			return;
		// Pi commits a new_context request only when every tool in the batch succeeded.
		if (
			event.toolResults.some((result) => result.toolName === "new_context") &&
			!event.toolResults.some((result) => result.isError)
		)
			return;
		const usage = native.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) return;
		const budget = budgetFor(native, usage.contextWindow);
		if (!budget || !budget.enabled || !budget.supported) return;

		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const fingerprint: ReminderFingerprint = {
			windowId: currentWindowId(branch),
			contextWindow: budget.contextWindow,
			reserveTokens: budget.reserveTokens,
		};
		if (usage.tokens >= budget.rolloverAt) return;
		const reminderBuffer = Math.min(REMINDER_BUFFER_TOKENS, Math.floor(budget.usable * 0.1));
		const remindAt = budget.rolloverAt - reminderBuffer;
		if (usage.tokens < remindAt || hasReminder(branch, fingerprint)) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: `[posthorse] Checkpoint now: ${(budget.rolloverAt - usage.tokens).toLocaleString("en-US")} tokens remain before Pi's automatic rollover line. Stop normal work, save goal/progress/decisions/next steps, then call new_context now. This reminder is best-effort; a large turn, overflow, restart, or smaller model can reach rollover without one.`,
				display: true,
				details: fingerprint,
			},
			{ deliverAs: "steer" },
		);
	});

	// Drop reminders from another window or computed for another context size/reserve from model input.
	pi.on("context", (event, ctx) => {
		const marker = event.messages.find(
			(message) => message.role === "custom" && message.customType === "context-window",
		);
		const windowId = marker?.role === "custom" ? (marker.details as { windowId?: unknown } | undefined)?.windowId : "initial";
		if (typeof windowId !== "string") return;
		const native = nativeContext(ctx);
		const budget = budgetFor(native);
		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const fingerprint: ReminderFingerprint = {
			windowId,
			contextWindow: budget?.contextWindow,
			reserveTokens: budget?.reserveTokens,
		};
		const stale = (message: (typeof event.messages)[number]) =>
			message.role === "custom" &&
			isReminderType(message.customType) &&
			reminderIsStale(message.customType, message.details, fingerprint, branch);
		if (event.messages.some(stale)) return { messages: event.messages.filter((message) => !stale(message)) };
	});

	// Claim Pi's automatic threshold/overflow trigger with a fresh window: no summary, no summarization auth.
	(pi as unknown as NativeExtensionAPI).on("session_before_auto_compact", (event, ctx) => {
		const native = nativeContext(ctx);
		const budget = budgetFor(native);
		// An unsupported budget would roll over every turn; leave Pi's own behavior in place instead.
		if (budget && !budget.supported) return undefined;
		const limit = freshPayloadChars(native, activeToolTokens(), event.pendingMessages);
		if (limit < MIN_PAGE_CHARS) return undefined;
		const handoff = buildAutoHandoff(event.branchEntries, limit);
		if (handoff.length > limit) return undefined;
		return { newContext: { handoff } };
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
			const native = nativeContext(ctx);
			const trimmed = handoff?.trim() || undefined;
			const limit = freshPayloadChars(native, activeToolTokens());
			if (trimmed && trimmed.length > limit) {
				throw new Error(
					`Handoff is too large for the active model (${trimmed.length.toLocaleString("en-US")} characters; limit ${limit.toLocaleString("en-US")}). Save fuller state in notes, then retry with a shorter handoff or no handoff.`,
				);
			}
			return {
				...textResult(
					"Requested a fresh Pi context after this complete tool batch succeeds. Earlier conversation stays in session history.",
				),
				newContext: { handoff: trimmed },
			};
		},
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		description:
			"Best available native estimate of the context budget: tokens until Pi's automatic rollover line and until the model's hard limit.",
		promptSnippet: "check the remaining context budget only when needed",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const native = nativeContext(ctx);
			const usage = native.getContextUsage();
			if (!usage || usage.tokens == null) return textResult("Context usage is not known until the next model response.");
			const n = (value: number) => value.toLocaleString("en-US");
			const budget = budgetFor(native, usage.contextWindow);
			const hard = `≈${n(Math.max(0, usage.contextWindow - usage.tokens))} tokens until the hard context limit (${n(usage.tokens)}/${n(usage.contextWindow)} used, ${Math.round(usage.percent ?? 0)}%). Best available native estimate.`;
			if (!budget?.enabled) return textResult(`Automatic rollover is disabled (Pi compaction.enabled=false). ${hard}`);
			if (!budget.supported) return textResult(`${unsupportedMessage(budget)} ${hard}`);
			return textResult(
				`≈${n(Math.max(0, budget.rolloverAt - usage.tokens))} tokens until automatic rollover (line at ${n(budget.rolloverAt)}); ${hard}`,
			);
		},
	});

	pi.registerTool({
		name: "notes",
		label: "Notes",
		description:
			"Persistent notes in .pi/notes/ that survive context resets. Ops: list, read (paged; pass offset to continue), write (create/replace; empty content clears), append, search (case-insensitive substring over note lines). Inside a Git repository, including nested directories and linked worktrees, notes belong to the main checkout.",
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
			offset: Type.Optional(Type.Integer({ description: "Character offset for read (default 0)", minimum: 0 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = join(notesRoot(ctx.cwd), ".pi", "notes");
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
					const offset = params.offset ?? 0;
					if (offset && offset >= text.length) {
						throw new Error(`Offset ${offset} is past the end of ${relative} (${text.length} chars).`);
					}
					const end = Math.min(text.length, offset + requirePage(nativeContext(ctx), offset, 0, activeToolTokens()));
					const more =
						end < text.length ? `\n[chars ${offset}-${end} of ${text.length}; continue with offset ${end}]` : "";
					return textResult(`${text.slice(offset, end)}${more}`);
				}
				case "write": {
					const relative = requireValue(params.path, "path", params.op);
					if (params.content === undefined) throw new Error(`"content" is required for op "write" (use "" to clear a note).`);
					const path = safeJoin(relative);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, params.content);
					return textResult(`Wrote .pi/notes/${relative}`);
				}
				case "append": {
					const relative = requireValue(params.path, "path", params.op);
					const content = requireValue(params.content, "content", params.op);
					const path = safeJoin(relative);
					mkdirSync(dirname(path), { recursive: true });
					// One O_APPEND write per newline-terminated record, so concurrent Pi processes appending to a
					// shared note never merge records. The separator only matters after a write that left no trailing
					// newline; a torn read of another process's in-flight append costs at most one blank line.
					const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
					const separator = existing && !existing.endsWith("\n") ? "\n" : "";
					appendFileSync(path, `${separator}${content.replace(/\n?$/, "\n")}`);
					return textResult(`Appended to .pi/notes/${relative}`);
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
							const trimmed = line.trim();
							const match = trimmed.toLowerCase().indexOf(query);
							if (match !== -1) {
								hits.push(`${file.slice(dir.length + 1)}:${index + 1}: ${excerptAround(trimmed, match, 50, 200)}`);
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
			"Search or read normalized session entries, including earlier native context windows. Current branch is searched by default; all=true searches every project session file, newest-modified sessions first and newest entries within each session. Reads return stored images and page long text with the next offset.",
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
				// Forks copy ancestor entries under the same ids into new session files; report each id once.
				const seen = new Set<string>();
				const addHit = (item: WindowedEntry, source = "") => {
					const matchIndex = item.text.toLowerCase().indexOf(query);
					if (matchIndex === -1 || seen.has(item.entry.id!)) return;
					seen.add(item.entry.id!);
					hits.push(
						`${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${item.entry.id}] ${excerptAround(item.text, matchIndex, 100, 400)}`,
					);
				};

				if (params.all) {
					files: for (const file of sessionFiles(manager.getSessionDir())) {
						const recent: WindowedEntry[] = [];
						for await (const item of sessionWindowEntries(file, signal)) {
							if (seen.has(item.entry.id!) || !item.text.toLowerCase().includes(query)) continue;
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
				const end = Math.min(
					item.text.length,
					offset + requirePage(nativeContext(ctx), offset, offset === 0 ? item.images.length : 0, activeToolTokens()),
				);
				const more = end < item.text.length ? `\nMore remains; call history read with id "${id}" and offset ${end}.` : "";
				// Stored images ride along with the first page only.
				return textResult(
					`${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${id}] [chars ${offset}-${end} of ${item.text.length}] ${item.text.slice(offset, end)}${more}`,
					offset === 0 ? item.images : [],
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
