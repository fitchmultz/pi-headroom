/**
 * Loads the real Posthorse extension into the fitchmultz/pi fork's test harness (faux provider, no API keys).
 * Run with scripts/integration.sh, which copies this file into the fork's packages/coding-agent/test directory
 * so every import below resolves against the fork; POSTHORSE_INDEX points at the extension entry point.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const posthorse = (await import(process.env.POSTHORSE_INDEX!)).default as (pi: ExtensionAPI) => void;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const tool = (name: string, execute: AgentTool["execute"]): AgentTool => ({
	name,
	label: name,
	description: name,
	parameters: Type.Object({}),
	execute,
});
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
const dump = tool("dump", async () => text(`DUMP HEAD ${"r".repeat(600_000)} DUMP TAIL`));
const medium = tool("medium", async () => text(`MEDIUM HEAD ${"m".repeat(20_000)} MEDIUM TAIL`));
const snap = tool("snap", async () => ({
	content: [{ type: "text" as const, text: `SNAP CAPTION ${"s".repeat(80_000)}` }, { type: "image" as const, data: PNG, mimeType: "image/png" }],
	details: {},
}));
const fail = tool("fail", async () => {
	throw new Error("boom");
});

const exactFreshBudget = (pi: ExtensionAPI) => {
	pi.on("before_agent_start", () => {
		const active = new Set(pi.getActiveTools());
		const toolTokens = pi
			.getAllTools()
			.filter((definition) => active.has(definition.name))
			.reduce(
				(total, definition) =>
					total +
					Math.ceil(
						JSON.stringify({
							name: definition.name,
							description: definition.description ?? "",
							parameters: definition.parameters,
						}).length / 4,
					),
				0,
			);
		const promptTokens = 32_768 - 1000 - toolTokens - 2250;
		expect(promptTokens).toBeGreaterThan(0);
		return { systemPrompt: "s".repeat(promptTokens * 4) };
	});
};

const branchTypes = (harness: Harness) => harness.sessionManager.getBranch().map((entry) => entry.type);
const contextWindows = (harness: Harness) => branchTypes(harness).filter((type) => type === "context_window").length;
const forbidSummarizationAuth = (harness: Harness) => {
	(harness.session as unknown as { _getSummarizationRequestAuth: () => Promise<never> })._getSummarizationRequestAuth = async () => {
		throw new Error("summarization auth must not be resolved when Posthorse claims the rollover");
	};
};
/** Id of the newest tool result entry on the branch. */
const lastToolResultId = (harness: Harness) =>
	[...harness.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "toolResult")!.id;

describe("Posthorse inside the Pi fork", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("rolls over an oversized text tool result, carries the unconsumed batch, and recovers it through history", async () => {
		const harness = await createHarness({ tools: [dump], extensionFactories: [posthorse] });
		harnesses.push(harness);
		forbidSummarizationAuth(harness);
		let freshTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: "OLD ASSISTANT PROSE" }, fauxToolCall("dump", {})], { stopReason: "toolUse" }),
			(context) => {
				freshTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage(fauxToolCall("history", { op: "read", id: lastToolResultId(harness) }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("dump everything");

		expect(contextWindows(harness)).toBe(1);
		expect(branchTypes(harness).filter((type) => type === "compaction")).toEqual([]);
		expect(freshTexts).toHaveLength(1);
		const handoff = freshTexts[0];
		expect(handoff).toContain("Automatic context rollover recovery record.");
		expect(handoff).toContain("dump everything");
		expect(handoff).toContain("Unconsumed tool batch");
		expect(handoff).toMatch(/\[result entry [^\]]+\]\nDUMP HEAD r+\n… middle omitted …\nr+ DUMP TAIL/);
		expect(handoff).not.toContain("OLD ASSISTANT PROSE");
		expect(handoff.length).toBeLessThanOrEqual(20_000);

		// The fresh window read the oversized result back through the append-only transcript.
		const recovered = harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "history");
		expect(getMessageText(recovered)).toMatch(/\[chars 0-\d+ of 600\d+\] \[toolResult\] DUMP HEAD/);
		expect(getMessageText(recovered)).toMatch(/More remains; call history read with id ".+" and offset \d+\./);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("carries a tool batch when the next provider request overflows", async () => {
		const harness = await createHarness({ tools: [medium], extensionFactories: [posthorse] });
		harnesses.push(harness);
		let freshTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("medium", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 300000 tokens > 128000 maximum",
			}),
			(context) => {
				freshTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("continued");
			},
		]);

		await harness.session.prompt("run medium");

		expect(contextWindows(harness)).toBe(1);
		expect(freshTexts).toHaveLength(1);
		expect(freshTexts[0]).toContain("Unconsumed tool batch");
		expect(freshTexts[0]).toMatch(/MEDIUM HEAD m+[\s\S]*MEDIUM TAIL/);
		expect(freshTexts[0]).toContain(`entry ${lastToolResultId(harness)}`);
	});

	it("keeps an image tool result recoverable after the rollover it triggered", async () => {
		const harness = await createHarness({
			tools: [snap],
			extensionFactories: [posthorse],
			settings: { compaction: { reserveTokens: 128_000 - 16_000 } },
		});
		harnesses.push(harness);
		let handoff = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("snap", {}), { stopReason: "toolUse" }),
			(context) => {
				handoff = getMessageText(context.messages[0]);
				return fauxAssistantMessage(fauxToolCall("history", { op: "read", id: lastToolResultId(harness) }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("take a screenshot");

		expect(contextWindows(harness)).toBe(1);
		expect(handoff).toMatch(/\[result entry ([^\]]+)\]\nSNAP CAPTION[\s\S]*\[1 image: image\/png\] — recover with history read id \1/);
		expect(handoff).not.toContain(PNG.slice(0, 20));
		const recovered = harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "history");
		expect(getMessageText(recovered)).toContain("[toolResult] SNAP CAPTION");
		expect(recovered?.content).toContainEqual({ type: "image", data: PNG, mimeType: "image/png" });
	});

	it("rolls over a single oversized first owner turn on overflow and retries once", async () => {
		const harness = await createHarness({ extensionFactories: [posthorse] });
		harnesses.push(harness);
		forbidSummarizationAuth(harness);
		let retryTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 128000 maximum" }),
			(context) => {
				retryTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("continued");
			},
		]);

		await harness.session.prompt(`OWNER HEAD ${"x".repeat(600_000)} OWNER TAIL`);

		expect(contextWindows(harness)).toBe(1);
		expect(retryTexts).toHaveLength(1);
		expect(retryTexts[0]).toMatch(/\[owner input \|[^\]]+\]\nOWNER HEAD x+\n… middle omitted …\nx+ OWNER TAIL/);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
	});

	it("retains newly submitted input across preflight without copying it into the handoff", async () => {
		const harness = await createHarness({ extensionFactories: [posthorse] });
		harnesses.push(harness);
		forbidSummarizationAuth(harness);
		let freshTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("ready"),
			(context) => {
				freshTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("p".repeat(350_000));
		expect(contextWindows(harness)).toBe(0);

		const request = `LIVE INPUT ${"q".repeat(100_000)}`;
		await harness.session.prompt(request);

		expect(contextWindows(harness)).toBe(1);
		expect(freshTexts).toHaveLength(2);
		expect(freshTexts[0]).toContain("Automatic context rollover recovery record.");
		expect(freshTexts[0]).not.toContain("LIVE INPUT");
		expect(freshTexts[1]).toBe(request);
	});

	it("uses the real prompt and active tool schemas to accept 4K but reject a 5K handoff", async () => {
		const harness = await createHarness({
			models: [{ id: "budget", contextWindow: 32_768, maxTokens: 1000 }],
			settings: { compaction: { enabled: false } },
			extensionFactories: [posthorse, exactFreshBudget],
		});
		harnesses.push(harness);
		let freshTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: "x".repeat(5000) }), { stopReason: "toolUse" }),
			(context) => {
				const rejected = context.messages.at(-1);
				expect(rejected).toMatchObject({ role: "toolResult", toolName: "new_context", isError: true });
				expect(getMessageText(rejected)).toMatch(/too large.*limit 4,500/i);
				return fauxAssistantMessage(fauxToolCall("new_context", { handoff: "y".repeat(4000) }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				freshTexts = context.messages.map(getMessageText);
				return fauxAssistantMessage("fresh");
			},
		]);

		await harness.session.prompt("roll over");

		expect(contextWindows(harness)).toBe(1);
		expect(freshTexts).toEqual([expect.stringContaining("y".repeat(4000))]);
	});

	it("commits an explicit new_context only after a fully successful tool batch; resume stays inside the new window", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "posthorse-resume-"));
		harnesses.push({ cleanup: () => rmSync(sessionDir, { recursive: true, force: true }) } as Harness);
		const harness = await createHarness({
			tools: [dump, fail],
			extensionFactories: [posthorse],
			sessionManager: SessionManager.create(process.cwd(), sessionDir),
		});
		harnesses.push(harness);
		let afterFailure: string[] = [];
		let afterRollover: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("new_context", { handoff: "not yet" }), fauxToolCall("fail", {})], { stopReason: "toolUse" }),
			(context) => {
				afterFailure = context.messages.map((message) => message.role);
				return fauxAssistantMessage(fauxToolCall("new_context", { handoff: "carry this forward" }), { stopReason: "toolUse" });
			},
			(context) => {
				afterRollover = context.messages.map(getMessageText);
				return fauxAssistantMessage("fresh");
			},
		]);

		await harness.session.prompt("before the boundary");

		expect(contextWindows(harness)).toBe(1);
		expect(afterFailure).toEqual(["user", "assistant", "toolResult", "toolResult"]);
		expect(afterRollover).toEqual([expect.stringContaining("carry this forward")]);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);

		const resumed = SessionManager.open(harness.sessionManager.getSessionFile()!, sessionDir);
		const resumedTexts = resumed.buildSessionContext().messages.map(getMessageText);
		expect(resumedTexts).toEqual([expect.stringContaining("carry this forward"), "fresh"]);
		expect(resumed.getBranch().map((entry) => entry.type)).toEqual(branchTypes(harness));
	});

	it("leaves Pi alone when compaction is disabled but keeps new_context available", async () => {
		const harness = await createHarness({
			tools: [dump],
			extensionFactories: [posthorse],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fresh"),
		]);

		await harness.session.prompt("dump everything");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(branchTypes(harness)).toEqual(["message", "message", "message", "message", "message", "context_window", "message"]);
	});
});
