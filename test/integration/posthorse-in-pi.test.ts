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
const snap = tool("snap", async () => ({
	content: [{ type: "text" as const, text: `SNAP CAPTION ${"s".repeat(80_000)}` }, { type: "image" as const, data: PNG, mimeType: "image/png" }],
	details: {},
}));
const fail = tool("fail", async () => {
	throw new Error("boom");
});

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
		expect(handoff).toMatch(/\[tool dump result \| entry [^\]]+\]\nDUMP HEAD r+\n… middle omitted …\nr+ DUMP TAIL/);
		expect(handoff).not.toContain("OLD ASSISTANT PROSE");
		expect(handoff.length).toBeLessThanOrEqual(20_000);

		// The fresh window read the oversized result back through the append-only transcript.
		const recovered = harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "history");
		expect(getMessageText(recovered)).toMatch(/\[chars 0-\d+ of 600\d+\] \[toolResult\] DUMP HEAD/);
		expect(getMessageText(recovered)).toMatch(/More remains; call history read with id ".+" and offset \d+\./);
		expect(harness.getPendingResponseCount()).toBe(0);
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
		expect(handoff).toMatch(/\[tool snap result \| entry ([^\]]+)\]\nSNAP CAPTION[\s\S]*\[1 image: image\/png\] — recover with history read id \1/);
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
