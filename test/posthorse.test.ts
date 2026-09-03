import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import posthorse from "../index.ts";

type Handler = (event: Record<string, unknown>, context: TestContext) => unknown;
type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: TestContext,
	): Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		newContext?: { handoff?: string };
	}>;
};
type TestContext = {
	cwd: string;
	model: { contextWindow: number };
	sessionManager: {
		getBranch(): Record<string, unknown>[];
		getSessionDir(): string;
	};
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	getCompactionSettings(): { enabled: boolean; reserveTokens: number };
	newContext(options?: { handoff?: string }): void;
};

function setup() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const messages: Array<{
		customType?: string;
		content: string;
		display?: boolean;
		details?: { windowId?: string };
	}> = [];
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: (typeof messages)[number]) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	posthorse(api);
	const context: TestContext = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [], getSessionDir: () => tmpdir() },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
		newContext: () => {},
	};
	return { handlers, tools, messages, context };
}

function toolText(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function run(tools: Map<string, Tool>, name: string, params: Record<string, unknown>, context: TestContext) {
	return tools.get(name)!.execute("id", params, new AbortController().signal, () => {}, context);
}

function turnEnd(handlers: Map<string, Handler>, context: TestContext, toolResults: Record<string, unknown>[] = []) {
	handlers.get("turn_end")!({ message: { role: "assistant", stopReason: toolResults.length ? "toolUse" : "stop" }, toolResults }, context);
}

/** A context whose usage sits at `tokens` inside a window of `contextWindow`. */
function usageContext(base: TestContext, contextWindow: number, tokens: number, reserveTokens = 16_384, enabled = true): TestContext {
	return {
		...base,
		model: { contextWindow },
		getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
		getCompactionSettings: () => ({ enabled, reserveTokens }),
	};
}

function automaticHandoff(handlers: Map<string, Handler>, context: TestContext, branchEntries: Record<string, unknown>[]) {
	return (
		handlers.get("session_before_auto_compact")!(
			{ reason: "threshold", branchEntries },
			context,
		) as { newContext: { handoff: string } }
	).newContext.handoff;
}

test("new_context returns an atomic handoff and automatic rollover builds a recovery record", async () => {
	const { handlers, tools, context } = setup();
	const result = await tools
		.get("new_context")!
		.execute("id", { handoff: "continue here" }, new AbortController().signal, () => {}, context);
	assert.deepEqual(result.newContext, { handoff: "continue here" });
	assert.equal(handlers.has("session_before_compact"), false, "manual /compact is left to Pi");

	const handoff = automaticHandoff(handlers, context, [
		{ type: "message", id: "user", timestamp: "2026-09-02T10:00:00Z", message: { role: "user", content: "keep working on the fix" } },
	]);
	assert.match(handoff, /^Automatic context rollover recovery record\./);
	assert.match(handoff, /owner input.*entry user/);
	assert.match(handoff, /keep working on the fix/);
	assert.match(handoff, /not current progress/);

	const prior = automaticHandoff(handlers, context, [
		{ type: "context_window", id: "prior", timestamp: "2026-09-02T10:01:00Z", handoff: "persisted task" },
	]);
	assert.match(prior, /older checkpoint; possibly stale/);
	assert.match(prior, /persisted task/);
	assert.match(prior, /No selected current-window/);

	const nonRecursive = automaticHandoff(handlers, context, [
		{
			type: "context_window",
			id: "prior-auto",
			timestamp: "2026-09-02T10:02:00Z",
			handoff: "Automatic context rollover recovery record.\nSECRET NESTED TEXT",
		},
	]);
	assert.match(nonRecursive, /Prior automatic recovery text is not nested/);
	assert.match(nonRecursive, /entry prior-auto/);
	assert.doesNotMatch(nonRecursive, /SECRET NESTED TEXT/);
});

test("automatic recovery keeps owner anchors and visible coordination without stale transcript guesses", () => {
	const { handlers, context } = setup();
	const branch: Record<string, unknown>[] = [
		{ type: "message", id: "old", message: { role: "user", content: "old completed task" } },
		{ type: "context_window", id: "window-2", timestamp: "2026-09-02T10:00:00Z", handoff: "Original approved goal" },
		{ type: "custom_message", id: "hidden", timestamp: "2026-09-02T10:01:00Z", customType: "todo-list-context", content: "hidden state", display: false },
		{ type: "custom_message", id: "reminder", timestamp: "2026-09-02T10:02:00Z", customType: "headroom-reminder", content: "stale reminder", display: true },
		{ type: "message", id: "owner-start", timestamp: "2026-09-02T10:03:00Z", message: { role: "user", content: `FIRST OWNER REQUEST ${"a".repeat(9_000)} OWNER REQUEST TAIL` } },
		{ type: "message", id: "ordinary-tool", timestamp: "2026-09-02T10:04:00Z", message: { role: "toolResult", toolName: "bash", content: "assistant-derived state" } },
	];
	for (let index = 0; index < 8; index++) {
		branch.push({
			type: "custom_message",
			id: `coord-${index}`,
			timestamp: `2026-09-02T10:${10 + index}:00Z`,
			customType: "intercom_message",
			content: `coordination ${index} ${"x".repeat(3_500)}`,
			display: true,
		});
	}
	branch.push(
		{
			type: "message",
			id: "owner-answer",
			timestamp: "2026-09-02T10:20:00Z",
			message: { role: "toolResult", toolName: "ask_question", isError: false, content: "OWNER APPROVED SHIP" },
		},
		{
			type: "custom_message",
			id: "latest-correction",
			timestamp: "2026-09-02T10:21:00Z",
			customType: "agent-irc",
			content: "LATEST COORDINATION CORRECTION",
			display: true,
		},
	);

	const handoff = automaticHandoff(handlers, context, branch);
	assert.ok(handoff.length <= 20_000);
	assert.match(handoff, /Original approved goal/);
	assert.match(handoff, /FIRST OWNER REQUEST/);
	assert.match(handoff, /OWNER REQUEST TAIL/);
	assert.match(handoff, /middle omitted/);
	assert.match(handoff, /OWNER APPROVED SHIP/);
	assert.match(handoff, /LATEST COORDINATION CORRECTION/);
	assert.match(handoff, /not direct owner input/);
	assert.match(handoff, /Omitted \d+ current-window input/);
	assert.ok(handoff.indexOf("entry owner-start") < handoff.indexOf("entry owner-answer"));
	assert.ok(handoff.indexOf("entry owner-answer") < handoff.indexOf("entry latest-correction"));
	assert.doesNotMatch(handoff, /old completed task|hidden state|stale reminder|assistant-derived state/);
});

test("automatic recovery includes successful ask_question cancellations and excludes errors", () => {
	const { handlers, context } = setup();
	const handoff = automaticHandoff(handlers, context, [
		{ type: "message", id: "cancelled", timestamp: "1", message: { role: "toolResult", toolName: "ask_question", isError: false, content: "Question cancelled by owner" } },
		{ type: "message", id: "failed", timestamp: "2", message: { role: "toolResult", toolName: "ask_question", isError: true, content: "tool crashed" } },
	]);
	assert.match(handoff, /owner answer via ask_question/);
	assert.match(handoff, /Question cancelled by owner/);
	assert.doesNotMatch(handoff, /tool crashed/);
});

test("budget policy sends one best-effort reminder below the line and lets Pi own rollover", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-test-"));
	try {
		// A project file that disagrees with Pi's effective policy must be ignored: Pi decides trust, not Posthorse.
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 1 } }));
		const { handlers, messages } = setup();
		const contextWindow = 100_000;
		const reserve = 64_000;
		const threshold = contextWindow - reserve;
		const rolloverAt = threshold + 1;
		const remindAt = rolloverAt - Math.min(32_000, Math.floor(contextWindow * 0.1));
		let tokens = remindAt - 1;
		const branch: Record<string, unknown>[] = [{ type: "context_window", id: "window-2" }];
		const rollovers: Array<{ handoff?: string }> = [];
		const context: TestContext = {
			cwd: dir,
			model: { contextWindow },
			sessionManager: { getBranch: () => branch, getSessionDir: () => dir },
			getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
			getCompactionSettings: () => ({ enabled: true, reserveTokens: reserve }),
			newContext: (options) => rollovers.push(options ?? {}),
		};

		handlers.get("session_start")!({}, context);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0, "no reminder below the band");
		tokens = remindAt;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolName: "new_context" }] }, context);
		assert.equal(messages.length, 0);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "error" }, toolResults: [] }, context);
		assert.equal(messages.length, 0);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, context);
		assert.equal(messages.length, 0);

		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Checkpoint now/);
		assert.match(messages[0].content, /call new_context now/);
		assert.deepEqual(messages[0].details, { windowId: "window-2", contextWindow, reserveTokens: reserve });
		branch.push({ type: "custom_message", customType: "posthorse-reminder", details: messages[0].details });

		tokens = threshold;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 1, "Pi does not roll at exact threshold equality");
		branch.pop();
		messages.length = 0;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 1, "Posthorse still offers a checkpoint at equality");

		messages.length = 0;
		tokens = rolloverAt;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0, "Pi owns the first token that actually triggers rollover");
		tokens += 1_000;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0, "Posthorse also stays out of Pi's over-threshold path");
		assert.equal(rollovers.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("disabled Pi compaction disables automatic Posthorse behavior but not new_context", async () => {
	const { handlers, messages, tools } = setup();
	const context: TestContext = {
		...setup().context,
		getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
		getCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
	};
	const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base" }, context) as { systemPrompt: string };
	assert.match(guidance.systemPrompt, /Pi compaction is disabled/);
	assert.match(guidance.systemPrompt, /Context self-management \(Posthorse\)/);
	handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
	assert.equal(messages.length, 0);
	const remaining = toolText(await tools.get("get_context_remaining")!.execute("id", {}, new AbortController().signal, () => {}, context));
	assert.match(remaining, /Automatic rollover is disabled/);
	assert.match(remaining, /1,000 tokens until the hard context limit/);
	const result = await tools.get("new_context")!.execute("id", {}, new AbortController().signal, () => {}, context);
	assert.deepEqual(result.newContext, { handoff: undefined });
});

test("context filtering removes reminders from an older window or a different budget, legacy ids included", () => {
	const { handlers, context } = setup();
	const marker = { role: "custom", customType: "context-window", content: "new", details: { windowId: "new" } };
	const current = {
		role: "custom",
		customType: "posthorse-reminder",
		content: "current",
		details: { windowId: "new", contextWindow: 100_000, reserveTokens: 16_384 },
	};
	const legacyCurrent = { role: "custom", customType: "headroom-reminder", content: "legacy current", details: { windowId: "new" } };
	const old = { role: "custom", customType: "posthorse-reminder", content: "old", details: { windowId: "old", contextWindow: 100_000, reserveTokens: 16_384 } };
	const legacyOld = { role: "custom", customType: "headroom-reminder", content: "legacy old", details: { windowId: "old" } };
	const otherModel = { role: "custom", customType: "posthorse-reminder", content: "smaller model", details: { windowId: "new", contextWindow: 50_000, reserveTokens: 16_384 } };
	const otherReserve = { role: "custom", customType: "posthorse-reminder", content: "other reserve", details: { windowId: "new", contextWindow: 100_000, reserveTokens: 64_000 } };
	const other = { role: "custom", customType: "intercom_message", content: "keep" };
	const filtered = handlers.get("context")!(
		{ messages: [marker, old, legacyOld, otherModel, otherReserve, other, current, legacyCurrent] },
		context,
	) as { messages: unknown[] };
	assert.deepEqual(filtered.messages, [marker, other, current, legacyCurrent]);
	assert.equal(handlers.get("context")!({ messages: [marker, other, current, legacyCurrent] }, context), undefined);
	// Before any rollover the window is "initial"; a reminder computed for another model size is still stale.
	const initial = { role: "custom", customType: "posthorse-reminder", content: "initial", details: { windowId: "initial", contextWindow: 100_000, reserveTokens: 16_384 } };
	const filteredInitial = handlers.get("context")!({ messages: [otherModel, initial] }, context) as { messages: unknown[] };
	assert.deepEqual(filteredInitial.messages, [initial]);
});

test("notes from a linked git worktree belong to the main checkout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-notes-test-"));
	try {
		const main = join(dir, "main");
		const worktree = join(dir, "wt");
		const plain = join(dir, "plain");
		mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
		mkdirSync(worktree);
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
		mkdirSync(join(plain, ".git"), { recursive: true });
		const { tools, context } = setup();
		const notes = (cwd: string, params: Record<string, unknown>) =>
			tools.get("notes")!.execute("id", params, new AbortController().signal, () => {}, { ...context, cwd });

		await notes(worktree, { op: "write", path: "state.md", content: "from worktree" });
		assert.equal(readFileSync(join(main, ".pi", "notes", "state.md"), "utf8"), "from worktree");
		assert.equal(existsSync(join(worktree, ".pi")), false);
		assert.equal(toolText(await notes(worktree, { op: "list" })), "state.md");

		await notes(plain, { op: "write", path: "state.md", content: "from plain repo" });
		assert.equal(readFileSync(join(plain, ".pi", "notes", "state.md"), "utf8"), "from plain repo");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history reads current entries without opening every archived session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-history-test-"));
	try {
		mkdirSync(join(dir, "unrelated.jsonl"));
		const { tools, context: base } = setup();
		const context: TestContext = {
			...base,
			sessionManager: {
				getBranch: () => [
					{ type: "message", id: "current", parentId: null, timestamp: "1", message: { role: "user", content: "keep me" } },
				],
				getSessionDir: () => dir,
			},
		};

		const reads = await Promise.all(
			Array.from({ length: 5 }, () =>
				tools.get("history")!.execute("id", { op: "read", id: "current" }, new AbortController().signal, () => {}, context),
			),
		);
		for (const result of reads) assert.match(toolText(result), /keep me/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("all-session history recurses and returns newest matching entries first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-recursive-history-test-"));
	try {
		const nested = join(dir, "subagents");
		mkdirSync(nested);
		const oldFile = join(dir, "old.jsonl");
		const newFile = join(nested, "new.jsonl");
		writeFileSync(oldFile, JSON.stringify({ type: "message", id: "old", parentId: null, timestamp: "1", message: { role: "user", content: "recursive needle old" } }));
		writeFileSync(
			newFile,
			[
				JSON.stringify({ type: "context_window", id: "nested-window", parentId: null, timestamp: "2", handoff: "resume" }),
				JSON.stringify({ type: "message", id: "nested-old", parentId: "nested-window", timestamp: "3", message: { role: "user", content: "recursive needle nested old" } }),
				JSON.stringify({ type: "message", id: "nested-new", parentId: "nested-old", timestamp: "4", message: { role: "user", content: "recursive needle nested newest" } }),
			].join("\n"),
		);
		utimesSync(oldFile, new Date(1_000), new Date(1_000));
		utimesSync(newFile, new Date(2_000), new Date(2_000));
		const { tools, context: base } = setup();
		let mayReadCurrentBranch = false;
		const context: TestContext = {
			...base,
			sessionManager: {
				getBranch: () => {
					assert.ok(mayReadCurrentBranch, "all-session search must not normalize the current branch");
					return [];
				},
				getSessionDir: () => dir,
			},
		};
		const search = await tools.get("history")!.execute(
			"id",
			{ op: "search", query: "recursive needle", all: true, limit: 2 },
			new AbortController().signal,
			() => {},
			context,
		);
		const text = toolText(search);
		assert.match(text, /^subagents\/new\.jsonl .+\[nested-new\].+nested newest/s);
		assert.ok(text.indexOf("nested-new") < text.indexOf("nested-old"));
		assert.doesNotMatch(text, /\[old\]/);
		mayReadCurrentBranch = true;
		const read = await tools.get("history")!.execute(
			"id",
			{ op: "read", id: "nested-new" },
			new AbortController().signal,
			() => {},
			context,
		);
		assert.match(toolText(read), /^subagents\/new\.jsonl .+\[window nested-window\].+nested newest/s);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history searches normalized text and reports native window ids", async () => {
	const { tools, context: base } = setup();
	const branch = [
		{ type: "message", id: "needle-only-in-id", parentId: null, timestamp: "1", message: { role: "user", content: "plain" } },
		{ type: "message", id: "before", parentId: "needle-only-in-id", timestamp: "2", message: { role: "user", content: "needle before" } },
		{ type: "context_window", id: "window-2", parentId: "before", timestamp: "3", handoff: "continue" },
		{ type: "message", id: "after", parentId: "window-2", timestamp: "4", message: { role: "assistant", content: "needle after" } },
		{ type: "message", id: "long", parentId: "after", timestamp: "5", message: { role: "user", content: `${"x".repeat(20_100)}needle tail` } },
	];
	const context: TestContext = {
		...base,
		sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") },
	};
	const result = await tools.get("history")!.execute(
		"id",
		{ op: "search", query: "needle" },
		new AbortController().signal,
		() => {},
		context,
	);
	const text = toolText(result);
	assert.doesNotMatch(text, /needle-only-in-id/);
	assert.ok(text.indexOf("[long]") < text.indexOf("[after]"));
	assert.match(text, /\[window initial\] \[before\]/);
	assert.match(text, /\[window window-2\] \[after\]/);

	const firstPage = await tools.get("history")!.execute(
		"id",
		{ op: "read", id: "long" },
		new AbortController().signal,
		() => {},
		context,
	);
	assert.match(toolText(firstPage), /offset 20000/);
	const secondPage = await tools.get("history")!.execute(
		"id",
		{ op: "read", id: "long", offset: 20_000 },
		new AbortController().signal,
		() => {},
		context,
	);
	assert.match(toolText(secondPage), /needle tail/);
});

test("a persisted legacy headroom-reminder still deduplicates, and a model switch invalidates it", () => {
	const { handlers, messages, context: base } = setup();
	// 100K window, 16,384 reserve: line at 83,617; reminder band starts 10,000 tokens below it.
	const branch: Record<string, unknown>[] = [
		{ type: "context_window", id: "window-2" },
		{ type: "custom_message", id: "legacy", customType: "headroom-reminder", details: { windowId: "window-2" } },
	];
	const context = { ...usageContext(base, 100_000, 75_000), sessionManager: { getBranch: () => branch, getSessionDir: () => tmpdir() } };
	turnEnd(handlers, context);
	assert.equal(messages.length, 0, "legacy reminder in the same window counts");

	branch.pop();
	turnEnd(handlers, context);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].customType, "posthorse-reminder");
	assert.deepEqual(messages[0].details, { windowId: "window-2", contextWindow: 100_000, reserveTokens: 16_384 });
	branch.push({ type: "custom_message", id: "current", customType: "posthorse-reminder", details: messages[0].details });
	turnEnd(handlers, context);
	assert.equal(messages.length, 1, "one reminder per window and budget");

	// Same window, larger model: the stored reminder was computed for another budget and must not suppress the new one.
	const switched = { ...context, ...usageContext(base, 200_000, 175_000), sessionManager: context.sessionManager };
	turnEnd(handlers, switched);
	assert.equal(messages.length, 2);
	assert.deepEqual(messages[1].details, { windowId: "window-2", contextWindow: 200_000, reserveTokens: 16_384 });
});

test("new_context beside a failed sibling tool does not suppress the reminder", () => {
	const { handlers, messages, context: base } = setup();
	const context = usageContext(base, 100_000, 75_000);
	turnEnd(handlers, context, [{ toolName: "new_context" }, { toolName: "bash", isError: true }]);
	assert.equal(messages.length, 1, "Pi will not commit the boundary, so the checkpoint reminder still applies");
	messages.length = 0;
	turnEnd(handlers, context, [{ toolName: "new_context" }, { toolName: "bash", isError: false }]);
	assert.equal(messages.length, 0, "a fully successful batch rolls over; no reminder needed");
});

test("automatic handoff carries only the trailing unconsumed tool batch, with entry ids and no base64", () => {
	const { handlers, context } = setup();
	const image = { type: "image", data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", mimeType: "image/png" };
	const batch: Record<string, unknown>[] = [
		{ type: "message", id: "owner", timestamp: "1", message: { role: "user", content: "run the checks" } },
		{
			type: "message",
			id: "assistant-1",
			timestamp: "2",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "ASSISTANT PROSE" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "missing.txt" } },
					{ type: "toolCall", id: "call-3", name: "screenshot", arguments: {} },
				],
			},
		},
		{ type: "message", id: "result-1", timestamp: "3", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: `3 tests failed FAILURE DETAIL ${"z".repeat(30_000)} FAILURE TAIL` }] } },
		{ type: "message", id: "result-2", timestamp: "4", message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: true, content: "ENOENT missing.txt" } },
		{ type: "message", id: "result-3", timestamp: "5", message: { role: "toolResult", toolCallId: "call-3", toolName: "screenshot", content: [image] } },
	];
	const handoff = automaticHandoff(handlers, context, batch);
	assert.ok(handoff.length <= 20_000);
	assert.match(handoff, /Unconsumed tool batch \(completed after the last assistant response; no model has seen these results\)/);
	assert.match(handoff, /\[tool bash call \| entry assistant-1\]\n\{"command":"npm test"\}/);
	assert.match(handoff, /\[tool bash result \| entry result-1\]\n3 tests failed FAILURE DETAIL/);
	assert.match(handoff, /middle omitted[\s\S]*FAILURE TAIL/);
	assert.match(handoff, /\[tool read error \| entry result-2\]\nENOENT missing.txt/);
	assert.match(handoff, /\[tool screenshot result \| entry result-3\]\n\[1 image: image\/png\] — recover with history read id result-3/);
	assert.doesNotMatch(handoff, /ASSISTANT PROSE|QUJDREVG/);
	assert.ok(handoff.indexOf("entry result-1") < handoff.indexOf("entry result-2"), "results keep their order");

	const consumed = automaticHandoff(handlers, context, [
		...batch,
		{ type: "message", id: "assistant-2", timestamp: "6", message: { role: "assistant", content: "All done." } },
	]);
	assert.doesNotMatch(consumed, /Unconsumed tool batch|FAILURE DETAIL|ENOENT/);
	assert.match(consumed, /run the checks/);
});

test("history returns stored images for a requested entry and summarizes them elsewhere", async () => {
	const { handlers, tools, context: base } = setup();
	const png = { type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" };
	const jpeg = { type: "image", data: "SlBFR0RBVEE=", mimeType: "image/jpeg" };
	const webp = { type: "image", data: "V0VCUERBVEE=", mimeType: "image/webp" };
	const branch = [
		{ type: "message", id: "img-user", parentId: null, timestamp: "1", message: { role: "user", content: [png] } },
		{ type: "message", id: "img-tool", parentId: "img-user", timestamp: "2", message: { role: "toolResult", toolName: "screenshot", content: [jpeg] } },
		{ type: "message", id: "mixed", parentId: "img-tool", timestamp: "3", message: { role: "user", content: [{ type: "text", text: "look at this" }, webp, { type: "text", text: "and fix it" }] } },
	];
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };

	const user = await run(tools, "history", { op: "read", id: "img-user" }, context);
	assert.match(user.content[0].text!, /\[user\] \[1 image: image\/png\]/);
	assert.deepEqual(user.content.slice(1), [png]);
	const tool = await run(tools, "history", { op: "read", id: "img-tool" }, context);
	assert.match(tool.content[0].text!, /\[toolResult\] \[1 image: image\/jpeg\]/);
	assert.deepEqual(tool.content.slice(1), [jpeg]);
	const mixed = await run(tools, "history", { op: "read", id: "mixed" }, context);
	assert.match(mixed.content[0].text!, /look at this\nand fix it\n\[1 image: image\/webp\]/);
	assert.deepEqual(mixed.content.slice(1), [webp]);
	const laterPage = await run(tools, "history", { op: "read", id: "mixed", offset: 5 }, context);
	assert.equal(laterPage.content.length, 1, "images ride along with the first page only");

	const search = toolText(await run(tools, "history", { op: "search", query: "image/" }, context));
	assert.match(search, /\[img-tool\] \[toolResult\] \[1 image: image\/jpeg\]/);
	assert.match(search, /\[img-user\] \[user\] \[1 image: image\/png\]/);
	assert.doesNotMatch(search, /UE5HREFUQQ|SlBFR0RBVEE/);

	const handoff = automaticHandoff(handlers, context, branch);
	assert.match(handoff, /\[owner input \| 1 \| entry img-user\]\n\[1 image: image\/png\] — recover with history read id img-user/);
	assert.match(handoff, /look at this\nand fix it\n\[1 image: image\/webp\] — recover with history read id mixed/);
	assert.doesNotMatch(handoff, /UE5HREFUQQ|SlBFR0RBVEE|V0VCUERBVEE/);
});

test("small-context configurations are unsupported; larger ones derive honest budgets", async () => {
	for (const contextWindow of [8_192, 16_384]) {
		const { handlers, tools, messages, context: base } = setup();
		const context = usageContext(base, contextWindow, contextWindow - 500);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base" }, context) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /unsupported configuration/);
		assert.match(guidance.systemPrompt, /Lower compaction.reserveTokens in Pi settings or use a larger-context model/);
		assert.doesNotMatch(guidance.systemPrompt, /% used/);
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, `${contextWindow}: no reminder`);
		assert.equal(handlers.get("session_before_auto_compact")!({ reason: "threshold", branchEntries: [] }, context), undefined, `${contextWindow}: Pi keeps its own compaction`);
		const remaining = toolText(await run(tools, "get_context_remaining", {}, context));
		assert.match(remaining, /unsupported configuration/);
		assert.match(remaining, /500 tokens until the hard context limit/);
		const rollover = await run(tools, "new_context", { handoff: "still works" }, context);
		assert.deepEqual(rollover.newContext, { handoff: "still works" });
	}

	{
		const { handlers, messages, context: base } = setup();
		// 32,768 - 16,384 leaves 16,384 usable: line at 16,385 (50%), band 3,276 tokens wide.
		const context = usageContext(base, 32_768, 13_200);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base" }, context) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /rollover line \(50% used\)/);
		turnEnd(handlers, context);
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /3,185 tokens remain/);
		assert.ok(handlers.get("session_before_auto_compact")!({ reason: "threshold", branchEntries: [] }, context));
	}

	{
		const { handlers, tools, context: base } = setup();
		const large = usageContext(base, 400_000, 1_000, 64_000);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base" }, large) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /rollover line \(84% used\)/);
		assert.match(guidance.systemPrompt, /best available native estimate/);
		// The owner's primary model: gpt-5.6-sol, 272K window with a 64K reserve → line at 208,001 (76%).
		const sol = usageContext(base, 272_000, 205_000, 64_000);
		assert.match((handlers.get("before_agent_start")!({ systemPrompt: "base" }, sol) as { systemPrompt: string }).systemPrompt, /rollover line \(76% used\)/);
		assert.match(toolText(await run(tools, "get_context_remaining", {}, sol)), /^≈3,001 tokens until automatic rollover \(line at 208,001\); ≈67,000 tokens until the hard context limit/);
		const remaining = toolText(await run(tools, "get_context_remaining", {}, usageContext(base, 100_000, 36_000, 64_000)));
		assert.match(remaining, /^≈1 tokens until automatic rollover \(line at 36,001\); ≈64,000 tokens until the hard context limit \(36,000\/100,000 used, 36%\)\. Best available native estimate\.$/);
		const unknown = toolText(await run(tools, "get_context_remaining", {}, { ...base, getContextUsage: () => undefined }));
		assert.match(unknown, /not known until the next model response/);
	}
});

test("read pages shrink to the remaining budget and refuse unsafe pages while preserving the offset", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-page-test-"));
	try {
		const { tools, context: base } = setup();
		const branch = [{ type: "message", id: "long", parentId: null, timestamp: "1", message: { role: "user", content: "h".repeat(5_000) } }];
		const withBranch = (context: TestContext) => ({ ...context, cwd: dir, sessionManager: { getBranch: () => branch, getSessionDir: () => dir } });
		await run(tools, "notes", { op: "write", path: "long.md", content: "n".repeat(5_000) }, withBranch(base));

		// Line at 83,617; 1,500 tokens short of it leaves 500 tokens after the margin: a 2,000-character page.
		const tight = withBranch(usageContext(base, 100_000, 82_117));
		const note = toolText(await run(tools, "notes", { op: "read", path: "long.md" }, tight));
		assert.match(note, /^n{2000}\n\[chars 0-2000 of 5000; continue with offset 2000\]$/);
		const entry = toolText(await run(tools, "history", { op: "read", id: "long" }, tight));
		assert.match(entry, /\[chars 0-2000 of 5007\] \[user\] h{1993}\nMore remains; call history read with id "long" and offset 2000\.$/);

		const tighter = withBranch(usageContext(base, 100_000, 82_517));
		await assert.rejects(run(tools, "notes", { op: "read", path: "long.md", offset: 2000 }, tighter), /Call new_context first, then retry with offset 2000/);
		await assert.rejects(run(tools, "history", { op: "read", id: "long", offset: 2000 }, tighter), /Call new_context first, then retry with offset 2000/);

		// Disabled compaction measures against the hard limit instead of the rollover line.
		const disabled = withBranch(usageContext(base, 100_000, 98_000, 16_384, false));
		assert.match(toolText(await run(tools, "notes", { op: "read", path: "long.md" }, disabled)), /continue with offset 4000/);
		const unknown = withBranch({ ...base, getContextUsage: () => undefined });
		assert.doesNotMatch(toolText(await run(tools, "notes", { op: "read", path: "long.md" }, unknown)), /continue with offset/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notes resolve the repository root from nested directories, worktrees, and plain folders", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-root-test-"));
	try {
		const repo = join(dir, "repo");
		const main = join(dir, "main");
		const worktree = join(dir, "wt");
		const plain = join(dir, "plain", "sub");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "packages", "app"), { recursive: true });
		mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
		mkdirSync(join(worktree, "packages", "app"), { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
		mkdirSync(plain, { recursive: true });
		const { tools, context } = setup();
		const write = (cwd: string) => run(tools, "notes", { op: "write", path: "state.md", content: cwd }, { ...context, cwd });

		await write(join(repo, "packages", "app"));
		assert.equal(readFileSync(join(repo, ".pi", "notes", "state.md"), "utf8"), join(repo, "packages", "app"));
		assert.equal(existsSync(join(repo, "packages", "app", ".pi")), false);
		await write(join(worktree, "packages", "app"));
		assert.equal(readFileSync(join(main, ".pi", "notes", "state.md"), "utf8"), join(worktree, "packages", "app"));
		assert.equal(existsSync(join(worktree, ".pi")), false);
		await write(plain);
		assert.equal(readFileSync(join(plain, ".pi", "notes", "state.md"), "utf8"), plain);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("long notes page fully, empty writes clear, appends stay separated, and search centers on the match", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-notes-ops-test-"));
	try {
		const { tools, context: base } = setup();
		const context = { ...base, cwd: dir };
		const notes = (params: Record<string, unknown>) => run(tools, "notes", params, context);
		const body = `${"a".repeat(20_000)}${"b".repeat(20_000)}${"c".repeat(5_000)}`;
		await notes({ op: "write", path: "big.md", content: body });
		const first = toolText(await notes({ op: "read", path: "big.md" }));
		assert.match(first, /^a{20000}\n\[chars 0-20000 of 45000; continue with offset 20000\]$/);
		const second = toolText(await notes({ op: "read", path: "big.md", offset: 20_000 }));
		assert.match(second, /^b{20000}\n\[chars 20000-40000 of 45000; continue with offset 40000\]$/);
		const third = toolText(await notes({ op: "read", path: "big.md", offset: 40_000 }));
		assert.equal(third, "c".repeat(5_000));
		await assert.rejects(notes({ op: "read", path: "big.md", offset: 45_000 }), /past the end/);

		await notes({ op: "write", path: "big.md", content: "" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "big.md"), "utf8"), "");
		assert.equal(toolText(await notes({ op: "read", path: "big.md" })), "");
		await assert.rejects(notes({ op: "write", path: "big.md" }), /"content" is required for op "write"/);

		await notes({ op: "append", path: "log.md", content: "A" });
		await notes({ op: "append", path: "log.md", content: "B\n" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "log.md"), "utf8"), "A\nB\n");
		await notes({ op: "write", path: "log.md", content: "X" });
		await notes({ op: "append", path: "log.md", content: "Y" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "log.md"), "utf8"), "X\nY\n");
		await assert.rejects(notes({ op: "append", path: "log.md", content: "" }), /"content" is required/);

		await notes({ op: "write", path: "search.md", content: `${"x".repeat(250)} needle-here ${"y".repeat(100)}\nsecond line` });
		const hits = toolText(await notes({ op: "search", query: "NEEDLE-here" }));
		assert.match(hits, /^search\.md:1: …x{49} needle-here y{100}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history flattens bashExecution entries and honors excludeFromContext", async () => {
	const { tools, context: base } = setup();
	const branch = [
		{ type: "message", id: "sh", parentId: null, timestamp: "1", message: { role: "bashExecution", command: "ls -la", output: "total 0\nnotes.md" } },
		{ type: "message", id: "hidden", parentId: "sh", timestamp: "2", message: { role: "bashExecution", command: "cat token", output: "TOPSECRET", excludeFromContext: true } },
	];
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };
	assert.match(toolText(await run(tools, "history", { op: "search", query: "notes.md" }, context)), /\[sh\] \[bashExecution\] \$ ls -la\ntotal 0\nnotes\.md/);
	assert.match(toolText(await run(tools, "history", { op: "read", id: "sh" }, context)), /\[bashExecution\] \$ ls -la\ntotal 0\nnotes\.md$/);
	assert.match(toolText(await run(tools, "history", { op: "search", query: "TOPSECRET" }, context)), /No history matches/);
	assert.match(toolText(await run(tools, "history", { op: "search", query: "cat token" }, context)), /No history matches/);
	const hidden = toolText(await run(tools, "history", { op: "read", id: "hidden" }, context));
	assert.match(hidden, /\[bashExecution\] \(excluded from model context by Pi\)$/);
	assert.doesNotMatch(hidden, /TOPSECRET|cat token/);
});

test("all-session search reports a fork-copied entry once, from the newest-modified session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-fork-test-"));
	try {
		const original = join(dir, "original.jsonl");
		const fork = join(dir, "fork.jsonl");
		const shared = JSON.stringify({ type: "message", id: "shared", parentId: null, timestamp: "1", message: { role: "user", content: "fork needle shared" } });
		writeFileSync(original, shared);
		writeFileSync(fork, [shared, JSON.stringify({ type: "message", id: "fork-new", parentId: "shared", timestamp: "2", message: { role: "user", content: "fork needle newer" } })].join("\n"));
		utimesSync(original, new Date(1_000), new Date(1_000));
		utimesSync(fork, new Date(2_000), new Date(2_000));
		const { tools, context: base } = setup();
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		const text = toolText(await run(tools, "history", { op: "search", query: "fork needle", all: true, limit: 5 }, context));
		assert.deepEqual(
			text.split("\n").map((line) => line.split(" ").slice(0, 1)[0] + line.match(/\[[a-z-]+\] \[/)?.[0]),
			["fork.jsonl[fork-new] [", "fork.jsonl[shared] ["],
		);
		assert.equal(text.match(/\[shared\]/g)?.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appends from concurrent Pi processes never merge records", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-concurrent-append-"));
	try {
		// Each child loads the real extension and appends 200 records to one shared note as fast as it can.
		const script = `
			const { default: posthorse } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
			const tools = new Map();
			posthorse({ on() {}, registerTool: (tool) => tools.set(tool.name, tool), sendMessage() {} });
			const [cwd, letter] = process.argv.slice(1);
			const context = { cwd, newContext() {}, getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }), getContextUsage: () => undefined };
			for (let i = 0; i < 200; i++) {
				await tools.get("notes").execute("id", { op: "append", path: "shared.md", content: letter.repeat(300) }, undefined, () => {}, context);
			}
		`;
		await Promise.all(
			["A", "B"].map(
				(letter) =>
					new Promise<void>((resolve, reject) => {
						execFile(process.execPath, ["--input-type=module", "-e", script, dir, letter], (error, _stdout, stderr) =>
							error ? reject(new Error(stderr || error.message)) : resolve(),
						);
					}),
			),
		);
		const lines = readFileSync(join(dir, ".pi", "notes", "shared.md"), "utf8").split("\n");
		assert.equal(lines.pop(), "", "file ends with a newline");
		assert.equal(lines.length, 400);
		assert.ok(lines.every((line) => line === "A".repeat(300) || line === "B".repeat(300)), "every record is intact");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
