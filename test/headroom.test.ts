import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	const messages: Array<{ content: string; details?: { windowId?: string } }> = [];
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: { content: string; details?: { windowId?: string } }) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	headroom(api);
	return { handlers, tools, messages };
}

function toolText(result: { content: Array<{ text: string }> }): string {
	return result.content.map((part) => part.text).join("\n");
}

test("new_context returns a native atomic handoff and no context hook is registered", async () => {
	const { handlers, tools } = setup();
	assert.equal(handlers.has("context"), false);
	const context = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [], getSessionDir: () => tmpdir() },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		newContext: () => {},
	};
	const result = await tools
		.get("new_context")!
		.execute("id", { handoff: "continue here" }, new AbortController().signal, () => {}, context);
	assert.deepEqual(result.newContext, { handoff: "continue here" });
	assert.equal(handlers.get("session_before_compact")!({ reason: "manual" }, context), undefined);
	const automaticHandoff = (branchEntries: Record<string, unknown>[]) =>
		(
			handlers.get("session_before_compact")!(
				{ reason: "threshold", branchEntries },
				context,
			) as { newContext: { handoff: string } }
		).newContext.handoff;
	const currentHandoff = automaticHandoff([
		{ type: "message", id: "user", message: { role: "user", content: "keep working on the fix" } },
	]);
	assert.match(currentHandoff, /Automatic context rollover/);
	assert.match(currentHandoff, /keep working on the fix/);
	assert.equal(automaticHandoff([{ type: "context_window", id: "prior", handoff: "persisted task" }]), "persisted task");
	assert.match(
		automaticHandoff([
			{ type: "context_window", id: "prior", handoff: "persisted task" },
			{ type: "message", id: "image", message: { role: "user", content: [{ type: "image" }] } },
		]),
		/Automatic context rollover/,
	);
});

test("budget policy sends one reminder then requests automatic rollover", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-headroom-test-"));
	try {
		const { handlers, messages } = setup();
		const contextWindow = 100_000;
		const reserve = SettingsManager.create(dir, getAgentDir()).getCompactionSettings().reserveTokens;
		const rolloverAt = contextWindow - Math.min(reserve, Math.floor(contextWindow / 2));
		const tokens = rolloverAt;
		const branch: Record<string, unknown>[] = [
			{ type: "message", id: "old-user", message: { role: "user", content: "old completed task" } },
			{ type: "context_window", id: "window-2" },
			{
				type: "message",
				id: "current-user-1",
				message: {
					role: "user",
					content: `Test production only. Do not contact other agents. ${"a".repeat(11_000)}`,
				},
			},
			{
				type: "message",
				id: "current-user-2",
				message: { role: "user", content: `${"b".repeat(11_000)} Write the three prompts.` },
			},
		];
		const rollovers: Array<{ handoff?: string }> = [];
		const context: TestContext = {
			cwd: dir,
			model: { contextWindow },
			sessionManager: { getBranch: () => branch, getSessionDir: () => dir },
			getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
			newContext: (options) => rollovers.push(options ?? {}),
		};

		handlers.get("session_start")!({}, context);
		handlers.get("turn_end")!(
			{
				message: { role: "assistant", stopReason: "toolUse" },
				toolResults: [{ toolName: "new_context" }],
			},
			context,
		);
		assert.equal(messages.length, 0);
		handlers.get("turn_end")!(
			{ message: { role: "assistant", stopReason: "error" }, toolResults: [] },
			context,
		);
		assert.equal(messages.length, 0);
		assert.equal(rollovers.length, 0);

		handlers.get("turn_end")!(
			{ message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
			context,
		);
		assert.equal(messages.length, 1);
		assert.equal(rollovers.length, 0);
		branch.push({
			type: "custom_message",
			customType: "headroom-reminder",
			details: messages[0].details,
		});

		handlers.get("turn_end")!(
			{ message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
			context,
		);
		assert.equal(messages.length, 1);
		assert.equal(rollovers.length, 1);
		const handoff = rollovers[0].handoff ?? "";
		assert.match(handoff, /Automatic context rollover/);
		assert.match(handoff, /Test production only\. Do not contact other agents\./);
		assert.match(handoff, /Write the three prompts\./);
		assert.doesNotMatch(handoff, /old completed task/);
		assert.match(handoff, /middle user messages omitted/);
		assert.equal(handoff.length, 20_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
				tools
					.get("history")!
					.execute("id", { op: "read", id: "current" }, new AbortController().signal, () => {}, context),
			),
		);
		for (const result of reads) assert.match(toolText(result), /keep me/);

		rmSync(join(dir, "unrelated.jsonl"), { recursive: true });
		writeFileSync(
			join(dir, "archived.jsonl"),
			[
				"not json",
				JSON.stringify({ type: "context_window", id: "archived-window", parentId: null, timestamp: "2", handoff: "resume" }),
				JSON.stringify({ type: "message", id: "archived", parentId: "archived-window", timestamp: "3", message: { role: "user", content: "archived needle" } }),
			].join("\n"),
		);
		const archived = await tools
			.get("history")!
			.execute("id", { op: "read", id: "archived" }, new AbortController().signal, () => {}, context);
		assert.match(toolText(archived), /^archived\.jsonl .+\[window archived-window\].+archived needle/s);
		const search = await tools
			.get("history")!
			.execute("id", { op: "search", query: "archived needle", all: true }, new AbortController().signal, () => {}, context);
		assert.match(toolText(search), /^archived\.jsonl .+\[window archived-window\].+archived needle/s);
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
		{ type: "message", id: "sibling", parentId: "before", timestamp: "5", message: { role: "user", content: "needle sibling" } },
		{
			type: "message",
			id: "long",
			parentId: "after",
			timestamp: "6",
			message: { role: "user", content: `${"x".repeat(20_100)}needle tail` },
		},
	];
	const context: TestContext = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		newContext: () => {},
	};
	const result = await tools
		.get("history")!
		.execute("id", { op: "search", query: "needle" }, new AbortController().signal, () => {}, context);
	const text = toolText(result);
	assert.doesNotMatch(text, /needle-only-in-id/);
	assert.match(text, /\[window initial\] \[before\]/);
	assert.match(text, /\[window window-2\] \[after\]/);
	assert.match(text, /\[window initial\] \[sibling\]/);

	const tailSearch = await tools
		.get("history")!
		.execute("id", { op: "search", query: "needle tail" }, new AbortController().signal, () => {}, context);
	assert.match(toolText(tailSearch), /needle tail/);
	const firstPage = await tools
		.get("history")!
		.execute("id", { op: "read", id: "long" }, new AbortController().signal, () => {}, context);
	assert.match(toolText(firstPage), /offset 20000/);
	const secondPage = await tools
		.get("history")!
		.execute("id", { op: "read", id: "long", offset: 20_000 }, new AbortController().signal, () => {}, context);
	assert.match(toolText(secondPage), /needle tail/);
});
