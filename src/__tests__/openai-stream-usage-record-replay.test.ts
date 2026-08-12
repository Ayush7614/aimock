/**
 * Record & replay of provider-reported OpenAI/OpenRouter stream usage (#368).
 *
 * Before this, collapsing an SSE chat completion dropped the final usage frame
 * (empty `choices` → `continue`), so a recorded fixture could only ever replay
 * ESTIMATED token counts (`ceil(len/4)`) and OpenRouter's `usage.cost` was never
 * captured at all — making consumer billing paths untestable from a tape.
 *
 * These tests pin the full round trip: capture (collapser) → persist (recorder)
 * → replay (OpenRouter-shaped usage chunk / completion envelope).
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapseOpenAISSE } from "../stream-collapse.js";
import { createServer, type ServerInstance } from "../server.js";
import { validateFixtures } from "../fixture-loader.js";
import type { Fixture, FixtureFile, SSEChunk, TextResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpPost(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Split an SSE body into data-frame JSON objects (skips comments + [DONE]). */
function parseSSE(body: string): SSEChunk[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)) as SSEChunk);
}

const OR = "/api/v1/chat/completions";

/** Stand-in upstream that replies with a fixed body + content-type. */
function createUpstream(
  servers: http.Server[],
  body: string,
  contentType: string,
): Promise<string> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      servers.push(srv);
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

/** The single fixture the recorder wrote into `dir`. */
function readRecordedFixture(dir: string): Fixture {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const file = JSON.parse(readFileSync(join(dir, files[0]), "utf-8")) as FixtureFile;
  expect(file.fixtures).toHaveLength(1);
  return file.fixtures[0];
}

/**
 * A real OpenRouter streaming body: content deltas, a finish chunk, then the
 * final EMPTY-`choices` usage frame carrying token counts AND `cost`.
 */
const OPENROUTER_SSE = [
  `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
  })}`,
  "",
  `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: " world" } }],
  })}`,
  "",
  `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}`,
  "",
  `data: ${JSON.stringify({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
      cost: 0.0042,
      cost_details: {
        upstream_inference_cost: 0.004,
        upstream_inference_prompt_cost: 0.001,
        upstream_inference_completions_cost: 0.003,
      },
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 34 },
      is_byok: false,
      native_tokens_prompt: 1200,
      native_tokens_completion: 550,
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

let instance: ServerInstance | null = null;
let servers: http.Server[] = [];
let tmpDir: string | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => instance!.server.close(() => resolve()));
    instance = null;
  }
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ---------------------------------------------------------------------------
// 1. Capture — collapseOpenAISSE
// ---------------------------------------------------------------------------

describe("collapseOpenAISSE usage capture (#368)", () => {
  it("captures the final empty-choices usage frame verbatim, including cost", () => {
    const result = collapseOpenAISSE(OPENROUTER_SSE);
    expect(result.content).toBe("Hello world");
    expect(result.usage).toEqual({
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
      cost: 0.0042,
      cost_details: {
        upstream_inference_cost: 0.004,
        upstream_inference_prompt_cost: 0.001,
        upstream_inference_completions_cost: 0.003,
      },
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 34 },
      is_byok: false,
      native_tokens_prompt: 1200,
      native_tokens_completion: 550,
    });
  });

  it("captures usage alongside tool calls", () => {
    const body = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const result = collapseOpenAISSE(body);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it("keeps the LAST usage frame when a provider emits more than one", () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }], usage: { cost: 1 } })}`,
      "",
      `data: ${JSON.stringify({ choices: [], usage: { cost: 2 } })}`,
      "",
    ].join("\n");
    expect(collapseOpenAISSE(body).usage).toEqual({ cost: 2 });
  });

  it("leaves usage undefined when the stream carries none (byte-identical to pre-#368)", () => {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const result = collapseOpenAISSE(body);
    expect(result).toEqual({ content: "hi" });
  });

  it("does not mistake a transcription stream's usage for chat usage", () => {
    const result = collapseOpenAISSE(
      `data: ${JSON.stringify({
        type: "transcript.text.done",
        text: "hello",
        usage: { type: "duration", seconds: 3 },
      })}\n\n`,
    );
    expect(result.transcription?.usage).toEqual({ type: "duration", seconds: 3 });
    expect(result.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Persist — the recorder writes response.usage
// ---------------------------------------------------------------------------

describe("recorder persists provider usage (#368)", () => {
  it("writes the streamed usage (incl. cost) onto the recorded fixture", async () => {
    const upstreamUrl = await createUpstream(servers, OPENROUTER_SSE, "text/event-stream");
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-usage-"));
    instance = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(res.status).toBe(200);

    const fixture = readRecordedFixture(tmpDir);
    const response = fixture.response as TextResponse;
    expect(response.content).toBe("Hello world");
    expect(response.usage).toEqual({
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
      cost: 0.0042,
      cost_details: {
        upstream_inference_cost: 0.004,
        upstream_inference_prompt_cost: 0.001,
        upstream_inference_completions_cost: 0.003,
      },
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 34 },
      is_byok: false,
      native_tokens_prompt: 1200,
      native_tokens_completion: 550,
    });
    // A fixture the recorder writes must always pass load-time validation.
    expect(validateFixtures([fixture]).filter((r) => r.severity === "error")).toEqual([]);
  });

  it("writes usage from a NON-streaming completion envelope too", async () => {
    const upstreamUrl = await createUpstream(
      servers,
      JSON.stringify({
        id: "gen-2",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "hey" } }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, cost: 0.5 },
      }),
      "application/json",
    );
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-usage-"));
    instance = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    const res = await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const response = readRecordedFixture(tmpDir).response as TextResponse;
    expect(response.content).toBe("hey");
    expect(response.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
      cost: 0.5,
    });
  });

  it("omits usage entirely when upstream reported none", async () => {
    const noUsageSSE = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "plain" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const upstreamUrl = await createUpstream(servers, noUsageSSE, "text/event-stream");
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-usage-"));
    instance = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    const response = readRecordedFixture(tmpDir).response as TextResponse;
    expect(response).toEqual({ content: "plain" });
  });

  it("drops non-numeric usage fields so the recorded fixture still validates", async () => {
    const oddSSE = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }] })}`,
      "",
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 3,
          // Shapes the fixture contract does not accept — must not be persisted.
          model: "some/model",
          buckets: [1, 2],
          nested: { note: "text", tokens: 5 },
          cost: null,
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const upstreamUrl = await createUpstream(servers, oddSSE, "text/event-stream");
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-usage-"));
    instance = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });

    await httpPost(`${instance.url}/v1/chat/completions`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    const fixture = readRecordedFixture(tmpDir);
    expect((fixture.response as TextResponse).usage).toEqual({ prompt_tokens: 3 });
    expect(validateFixtures([fixture]).filter((r) => r.severity === "error")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Replay — recorded usage reaches the wire
// ---------------------------------------------------------------------------

describe("replay of recorded usage (#368)", () => {
  const recorded: Fixture = {
    match: { userMessage: "hi" },
    response: {
      content: "Hello world",
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 567,
        total_tokens: 1801,
        cost: 0.0042,
        cost_details: {
          upstream_inference_cost: 0.004,
          upstream_inference_prompt_cost: 0.001,
          upstream_inference_completions_cost: 0.003,
        },
        prompt_tokens_details: { cached_tokens: 12 },
        completion_tokens_details: { reasoning_tokens: 34 },
        native_tokens_prompt: 1200,
      },
    },
  };

  it("emits the recorded token counts and cost on the final stream usage chunk", async () => {
    instance = await createServer([recorded]);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    const usageChunk = parseSSE(res.body).find((c) => c.usage !== undefined);
    expect(usageChunk).toBeDefined();
    // Real recorded counts, NOT the ceil(len/4) estimate.
    expect(usageChunk!.usage!.prompt_tokens).toBe(1234);
    expect(usageChunk!.usage!.completion_tokens).toBe(567);
    expect(usageChunk!.usage!.total_tokens).toBe(1801);
    expect(usageChunk!.usage!.cost).toBe(0.0042);
    expect(usageChunk!.usage!.cost_details).toEqual({
      upstream_inference_cost: 0.004,
      upstream_inference_prompt_cost: 0.001,
      upstream_inference_completions_cost: 0.003,
    });
    expect(usageChunk!.usage!.prompt_tokens_details).toEqual({ cached_tokens: 12 });
    expect(usageChunk!.usage!.completion_tokens_details).toEqual({ reasoning_tokens: 34 });
    // Unmodelled provider fields pass through verbatim.
    expect(usageChunk!.usage!.native_tokens_prompt).toBe(1200);
  });

  it("emits the recorded usage on the non-streaming completion envelope", async () => {
    instance = await createServer([recorded]);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body) as { usage: Record<string, unknown> };
    expect(json.usage.prompt_tokens).toBe(1234);
    expect(json.usage.completion_tokens).toBe(567);
    expect(json.usage.total_tokens).toBe(1801);
    expect(json.usage.cost).toBe(0.0042);
    expect(json.usage.native_tokens_prompt).toBe(1200);
  });

  it("round-trips record → replay end to end (cost survives the tape)", async () => {
    const upstreamUrl = await createUpstream(servers, OPENROUTER_SSE, "text/event-stream");
    tmpDir = mkdtempSync(join(tmpdir(), "aimock-usage-"));
    const recorder = await createServer([], {
      port: 0,
      record: { providers: { openai: upstreamUrl }, fixturePath: tmpDir },
    });
    // Register with the afterEach-drained cleanup so an early assertion throw
    // before the explicit close below can't leak the listening socket.
    servers.push(recorder.server);
    await httpPost(`${recorder.url}/v1/chat/completions`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    await new Promise<void>((resolve) => recorder.server.close(() => resolve()));

    instance = await createServer([readRecordedFixture(tmpDir)]);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const usageChunk = parseSSE(res.body).find((c) => c.usage !== undefined);
    expect(usageChunk!.usage!.cost).toBe(0.0042);
    expect(usageChunk!.usage!.prompt_tokens).toBe(1234);
    expect(usageChunk!.usage!.completion_tokens).toBe(567);
  });

  it("still estimates tokens for a fixture without recorded usage", async () => {
    instance = await createServer([{ match: { userMessage: "hi" }, response: { content: "yo" } }]);
    const res = await httpPost(`${instance.url}${OR}`, {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    const json = JSON.parse(res.body) as { usage: Record<string, unknown> };
    expect(json.usage.completion_tokens).toBe(1);
    expect(json.usage.cost).toBeUndefined();
  });
});
