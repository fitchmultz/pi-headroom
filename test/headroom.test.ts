import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import headroom from "../index.ts";

type Handler = (event: Record<string, unknown>, context: TestContext) => unknown;
type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: TestContext,
	): Promise<{ content: Array<{ type: string; text: string }>; newContext?: { handoff?: string } }>;
};
type TestContext = {
	cwd: string;
	model: { contextWindow: number };
	sessionManager: {
		getBranch(): Record<string, unknown>[];
		getSessionDir(): string;
	};
	getContextUsage(): { tokens: number; contextWindow: number; percent: number };
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
	headroom(api);
	const context: TestContext = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [], getSessionDir: () => tmpdir() },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		newContext: () => {},
	};
	return { handlers, tools, messages, context };
}

function toolText(result: { content: Array<{ text: string }> }): string {
	return result.content.map((part) => part.text).join("\n");
}

function automaticHandoff(handlers: Map<string, Handler>, context: TestContext, branchEntries: Record<string, unknown>[]) {
	return (
		handlers.get("session_before_compact")!(
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
	assert.equal(handlers.get("session_before_compact")!({ reason: "manual" }, context), undefined);

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
	const dir = mkdtempSync(join(tmpdir(), "pi-headroom-test-"));
	try {
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 64_000 } }));
		const { handlers, messages } = setup();
		const contextWindow = 100_000;
		const reserve = SettingsManager.create(dir, getAgentDir()).getCompactionSettings().reserveTokens;
		assert.equal(reserve, 64_000);
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
		branch.push({ type: "custom_message", customType: "headroom-reminder", details: messages[0].details });

		tokens = threshold;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 1, "Pi does not roll at exact threshold equality");
		branch.pop();
		messages.length = 0;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 1, "headroom still offers a checkpoint at equality");

		messages.length = 0;
		tokens = rolloverAt;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0, "Pi owns the first token that actually triggers rollover");
		tokens += 1_000;
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0, "headroom also stays out of Pi's over-threshold path");
		assert.equal(rollovers.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("disabled Pi compaction disables automatic headroom behavior but not new_context", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headroom-disabled-test-"));
	try {
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const { handlers, messages, tools } = setup();
		const context: TestContext = {
			cwd: dir,
			model: { contextWindow: 100_000 },
			sessionManager: { getBranch: () => [], getSessionDir: () => dir },
			getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
			newContext: () => {},
		};
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base" }, context) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /Pi compaction is disabled/);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, context);
		assert.equal(messages.length, 0);
		const result = await tools.get("new_context")!.execute("id", {}, new AbortController().signal, () => {}, context);
		assert.deepEqual(result.newContext, { handoff: undefined });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("context filtering removes only reminders from an older window", () => {
	const { handlers, context } = setup();
	const marker = { role: "custom", customType: "context-window", content: "new", details: { windowId: "new" } };
	const current = { role: "custom", customType: "headroom-reminder", content: "current", details: { windowId: "new" } };
	const old = { role: "custom", customType: "headroom-reminder", content: "old", details: { windowId: "old" } };
	const other = { role: "custom", customType: "intercom_message", content: "keep" };
	const filtered = handlers.get("context")!({ messages: [marker, old, other, current] }, context) as { messages: unknown[] };
	assert.deepEqual(filtered.messages, [marker, other, current]);
	assert.equal(handlers.get("context")!({ messages: [marker, other, current] }, context), undefined);
});

test("history reads current entries without opening every archived session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headroom-history-test-"));
	try {
		mkdirSync(join(dir, "unrelated.jsonl"));
		const { tools } = setup();
		const context: TestContext = {
			cwd: process.cwd(),
			model: { contextWindow: 100_000 },
			sessionManager: {
				getBranch: () => [
					{ type: "message", id: "current", parentId: null, timestamp: "1", message: { role: "user", content: "keep me" } },
				],
				getSessionDir: () => dir,
			},
			getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
			newContext: () => {},
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
	const dir = mkdtempSync(join(tmpdir(), "pi-headroom-recursive-history-test-"));
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
		const { tools } = setup();
		let mayReadCurrentBranch = false;
		const context: TestContext = {
			cwd: process.cwd(),
			model: { contextWindow: 100_000 },
			sessionManager: {
				getBranch: () => {
					assert.ok(mayReadCurrentBranch, "all-session search must not normalize the current branch");
					return [];
				},
				getSessionDir: () => dir,
			},
			getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
			newContext: () => {},
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
	const { tools } = setup();
	const branch = [
		{ type: "message", id: "needle-only-in-id", parentId: null, timestamp: "1", message: { role: "user", content: "plain" } },
		{ type: "message", id: "before", parentId: "needle-only-in-id", timestamp: "2", message: { role: "user", content: "needle before" } },
		{ type: "context_window", id: "window-2", parentId: "before", timestamp: "3", handoff: "continue" },
		{ type: "message", id: "after", parentId: "window-2", timestamp: "4", message: { role: "assistant", content: "needle after" } },
		{ type: "message", id: "long", parentId: "after", timestamp: "5", message: { role: "user", content: `${"x".repeat(20_100)}needle tail` } },
	];
	const context: TestContext = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		newContext: () => {},
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
