import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SSEChunk, ChatCompletion } from "../types.js";
import { LLMock } from "../llmock.js";
import { CATALOG_ROUTES, buildOpenApiDocument } from "../openapi.js";
import { ROUTE_DEFINITIONS, matchRouteDefinition, templateToRegExp } from "../route-registry.js";
import * as registry from "../route-registry.js";

// Only the catalog fields used by the live streaming contract probes.
interface StreamCatalogSchema {
  type?: string;
  description?: string;
  required?: string[];
  enum?: string[];
  properties?: { [name: string]: StreamCatalogSchema };
  items?: StreamCatalogSchema;
  "x-sse-data-schema"?: { $ref: string };
}
interface StreamCatalog {
  components: { schemas: { [name: string]: StreamCatalogSchema } };
  paths: {
    [path: string]: {
      post: {
        responses: { "200": { content: { [media: string]: { schema: { $ref: string } } } } };
      };
    };
  };
}

// Keep framing separate from JSON decoding: [DONE] is not a JSON value.
function sseDataFrames(text: string) {
  expect(text.endsWith("\n\n")).toBe(true);
  return text
    .trimEnd()
    .split("\n\n")
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return frame.slice(6);
    });
}

describe("OpenAPI route catalog", () => {
  let mock: LLMock;
  beforeEach(async () => {
    // metrics:true so GET /metrics is served (otherwise it 404s by design).
    mock = new LLMock({ port: 0, metrics: true });
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  const ollamaEmbeddingInputs = [
    { label: "legacy prompt", fields: { prompt: "hello" } },
    { label: "text input", fields: { input: "hello" } },
    { label: "text array", fields: { input: ["hello", "world"] } },
    { label: "numeric array", fields: { input: [1, 2] } },
    { label: "numeric matrix", fields: { input: [[1, 2], [3]] } },
    { label: "both fields", fields: { prompt: "hello", input: "world" } },
  ];

  it.each(
    ["/api/embeddings", "/api/embed"].flatMap((path) =>
      ollamaEmbeddingInputs.map((input) => ({ path, ...input })),
    ),
  )("describes real Ollama embeddings for $path with $label", async ({ path, fields }) => {
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const response = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", ...fields }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["embedding", "model"]);
    expect(body.model).toBe("nomic-embed-text");
    expect(Array.isArray(body.embedding)).toBe(true);
    expect(body.embedding.length).toBeGreaterThan(0);
    for (const value of body.embedding) expect(typeof value).toBe("number");

    const operation = doc.paths[path].post;
    expect(operation.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/OllamaEmbedRequest",
    });
    expect(operation.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/OllamaEmbedResponse",
    });
    expect.soft(doc.components.schemas.OllamaEmbedRequest).toEqual({
      type: "object",
      required: ["model"],
      anyOf: [{ required: ["prompt"] }, { required: ["input"] }],
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        input: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
            { type: "array", items: { type: "number" } },
            { type: "array", items: { type: "array", items: { type: "number" } } },
          ],
        },
      },
    });
    expect.soft(doc.components.schemas.OllamaEmbedResponse).toEqual({
      type: "object",
      required: ["model", "embedding"],
      properties: {
        model: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
      },
    });
  });

  it.each(["completed", "failed"] as const)(
    "describes real Grok video submit and %s polling responses",
    async (status) => {
      mock.addFixture({
        match: { userMessage: "catalog Grok clip", endpoint: "video" },
        response: {
          video: {
            id: "video_catalog_grok",
            status,
            url: "https://example.com/v.mp4",
            duration: 6,
            cost: 0.05,
            error: "generation failed",
          },
        },
      });
      const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const submit = await fetch(`${mock.url}/v1/videos/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "catalog Grok clip" }),
      });
      expect(submit.status).toBe(200);
      const created = await submit.json();
      expect(created).toEqual({ request_id: expect.any(String) });
      const poll = await fetch(`${mock.url}/v1/videos/${created.request_id}`);
      expect(poll.status).toBe(200);
      const body = await poll.json();
      expect(body).toMatchObject({
        request_id: created.request_id,
        status: status === "completed" ? "done" : "failed",
        progress: expect.any(Number),
      });
      if (status === "completed") {
        expect(body.video).toEqual({ url: "https://example.com/v.mp4", duration: 6 });
        expect(body.usage).toEqual({ cost_in_usd_ticks: 500_000_000 });
      } else {
        expect(body).toMatchObject({ code: "generation_failed", error: "generation failed" });
      }
      expect(
        doc.paths["/v1/videos/generations"].post.responses["200"].content["application/json"]
          .schema,
      ).toEqual({ $ref: "#/components/schemas/GrokVideoSubmitResponse" });
      expect(doc.components.schemas.GrokVideoSubmitResponse).toEqual({
        type: "object",
        required: ["request_id"],
        properties: { request_id: { type: "string" } },
      });
      expect(
        doc.paths["/v1/videos/{id}"].get.responses["200"].content["application/json"].schema,
      ).toEqual({ $ref: "#/components/schemas/VideoStatusResponse" });
      expect(doc.components.schemas.VideoStatusResponse).toEqual({
        oneOf: [
          { $ref: "#/components/schemas/VideoJob" },
          { $ref: "#/components/schemas/GrokVideoJob" },
        ],
      });
      const grok = doc.components.schemas.GrokVideoJob;
      expect(grok.required).toEqual(["request_id", "status"]);
      expect(grok.properties).toEqual({
        request_id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "done", "failed", "expired"] },
        progress: { type: "number" },
        video: {
          type: "object",
          properties: { url: { type: "string" }, duration: { type: "number" } },
        },
        usage: {
          type: "object",
          properties: { cost_in_usd_ticks: { type: "number" } },
        },
        code: { type: "string" },
        error: { type: "string" },
      });
      expect(grok.properties.status.enum).toContain(body.status);
    },
  );

  it("preserves Sora video submit and shared polling contracts", async () => {
    mock.addFixture({
      match: { userMessage: "catalog Sora clip", endpoint: "video" },
      response: { video: { id: "video_catalog_sora", status: "completed" } },
    });
    const doc = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
    const submit = await fetch(`${mock.url}/v1/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "catalog Sora clip" }),
    });
    expect(submit.status).toBe(200);
    const created = await submit.json();
    const poll = await fetch(`${mock.url}/v1/videos/${created.id}`);
    expect(poll.status).toBe(200);
    const body = await poll.json();
    expect(created).toMatchObject({ id: "video_catalog_sora", status: "completed" });
    expect(body).toMatchObject({ id: created.id, status: created.status });
    expect(
      doc.paths["/v1/videos"].post.responses["200"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/VideoJob" });
    expect(doc.components.schemas.VideoStatusResponse.oneOf).toContainEqual({
      $ref: "#/components/schemas/VideoJob",
    });
    expect(doc.components.schemas.VideoJob.required).toEqual(["id", "status"]);
    expect(doc.components.schemas.VideoJob.properties.id).toEqual({ type: "string" });
    expect(doc.components.schemas.VideoJob.properties.status.enum).toContain(body.status);
  });

  it("derives the catalog from the router registry (no hand-maintained copy)", () => {
    expect(CATALOG_ROUTES.length).toBe(ROUTE_DEFINITIONS.length);
    const registryKeys = new Set(ROUTE_DEFINITIONS.map((r) => `${r.method} ${r.path}`));
    for (const r of CATALOG_ROUTES) {
      expect(registryKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
  });

  it("covers the previously-missing surfaces", () => {
    const paths = new Set(CATALOG_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const required of [
      // Core OpenAI-shaped routes carry real schemas (asserted below).
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "POST /v1/messages",
      "POST /v1/embeddings",
      "GET /v1/models",
      // Previously missing (review): ollama current path, legacy journal,
      // azure, gemini predict/embed/interactions, vertex, bedrock x4,
      // grok/veo/openrouter/byteplus video, openrouter discovery, elevenlabs,
      // fal families, control reset aliases.
      "POST /api/embed",
      "GET /v1/_requests",
      "DELETE /v1/_requests",
      "POST /openai/deployments/{deploymentId}/chat/completions",
      "POST /openai/deployments/{deploymentId}/embeddings",
      "POST /v1beta/models/{model}:predict",
      "POST /v1beta/models/{model}:embedContent",
      "POST /v1beta/interactions",
      "POST /v1beta/models/{model}:predictLongRunning",
      "GET /v1beta/operations/{name}",
      "POST /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
      "POST /model/{modelId}/invoke",
      "POST /model/{modelId}/invoke-with-response-stream",
      "POST /model/{modelId}/converse",
      "POST /model/{modelId}/converse-stream",
      "POST /v1/videos/generations",
      "GET /v1/videos/{id}",
      "POST /api/v1/videos",
      "GET /api/v1/videos/models",
      "GET /api/v1/videos/{jobId}",
      "GET /api/v1/videos/{jobId}/content",
      "GET /api/v1/models",
      "GET /api/v1/key",
      "GET /api/v1/credits",
      "POST /v1/sound-generation",
      "POST /v1/text-to-speech/{voice_id}",
      "POST /fal/queue/submit/{model}",
      "GET /fal/queue/requests/{requestId}",
      "POST /fal/run/{model}",
      // New on main after the PR opened: Files API, fine-tuning jobs,
      // ElevenLabs Voice Design slots, Batches API.
      "GET /v1/files",
      "POST /v1/files",
      "GET /v1/files/{file_id}",
      "DELETE /v1/files/{file_id}",
      "GET /v1/files/{file_id}/content",
      "POST /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs/{job_id}",
      "POST /v1/fine_tuning/jobs/{job_id}/cancel",
      "GET /v1/fine_tuning/jobs/{job_id}/events",
      "POST /v1/text-to-voice/design",
      "POST /v1/text-to-voice",
      "GET /v1/voices/{voice_id}",
      "DELETE /v1/voices/{voice_id}",
      "POST /v1/batches",
      "GET /v1/batches",
      "GET /v1/batches/{batch_id}",
      "POST /v1/batches/{batch_id}/cancel",
      "POST /__aimock/reset/journal",
      "GET /__aimock/journal",
      "GET /__aimock/openapi.json",
      "GET /__aimock/routes",
    ]) {
      expect(paths.has(required)).toBe(true);
    }
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
  });

  it("emits real request/response schemas for OpenAI-shaped routes", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const chat = doc.paths["/v1/chat/completions"]?.post as Record<string, unknown>;
    expect(chat).toBeDefined();
    const requestBody = chat.requestBody as {
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/ChatCompletionRequest",
    );
    const ok = (chat.responses as Record<string, { content?: Record<string, unknown> }>)["200"];
    expect(ok.content?.["application/json"]).toBeDefined();
    expect(doc.components.schemas.ChatCompletionRequest).toBeDefined();
    expect(doc.components.schemas.ChatCompletionResponse).toBeDefined();
    expect(doc.components.schemas.EmbeddingRequest).toBeDefined();
  });

  const streamRoutes = [
    { family: "chat", path: "/v1/chat/completions", actual: "/v1/chat/completions" },
    {
      family: "chat",
      path: "/openai/deployments/{deploymentId}/chat/completions",
      actual: "/openai/deployments/test/chat/completions",
    },
    {
      family: "gemini",
      path: "/v1beta/models/{model}:streamGenerateContent",
      actual: "/v1beta/models/gemini-test:streamGenerateContent",
    },
    {
      family: "gemini",
      path: "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent",
      actual:
        "/v1/projects/test/locations/us/publishers/google/models/gemini-test:streamGenerateContent",
    },
  ] as const;

  it.each(streamRoutes)(
    "advertises live SSE framing and chunks for $path",
    async ({ family, path, actual }) => {
      mock.addFixture({
        match: { userMessage: "catalog stream" },
        response: { content: "hello stream" },
        chunkSize: 3,
      });
      const doc: StreamCatalog = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const response = await fetch(`${mock.url}${actual}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          family === "chat"
            ? {
                model: "test",
                messages: [{ role: "user", content: "catalog stream" }],
                stream: true,
              }
            : { contents: [{ role: "user", parts: [{ text: "catalog stream" }] }] },
        ),
      });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = sseDataFrames(wire);
      const content = doc.paths[path].post.responses["200"].content;
      console.log(
        JSON.stringify({
          path,
          observedMedia: response.headers.get("content-type"),
          advertisedMedia: Object.keys(content),
          wire,
        }),
      );
      expect(content["text/event-stream"]).toBeDefined();
      const schema =
        doc.components.schemas[content["text/event-stream"].schema.$ref.split("/").at(-1)!];
      expect(schema.type).toBe("string");
      expect(schema.description).toContain("data:");
      expect(schema.description).toContain("blank line");
      const chunkRef = schema["x-sse-data-schema"]?.$ref;
      expect(chunkRef).toBeDefined();
      const chunkSchema = doc.components.schemas[chunkRef!.split("/").at(-1)!];
      expect(chunkSchema.type).toBe("object");
      if (family === "chat") {
        expect(content["application/json"].schema.$ref).toBe(
          "#/components/schemas/ChatCompletionResponse",
        );
        expect(schema.description).toContain("[DONE]");
        expect(frames.pop()).toBe("[DONE]");
        const chunks: SSEChunk[] = frames.map((frame) => JSON.parse(frame));
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.object).toBe("chat.completion.chunk");
          expect(chunk.choices[0].delta).toBeDefined();
          expect(chunk.choices[0]).not.toHaveProperty("message");
        }
        expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe(
          "hello stream",
        );
        expect(chunkSchema.properties?.object.enum).toEqual(["chat.completion.chunk"]);
        expect(chunkSchema.properties?.choices.items?.required).toContain("delta");
        expect(chunkSchema.properties?.choices.items?.required).not.toContain("message");
      } else {
        expect(content["application/json"]).toBeUndefined();
        expect(frames).not.toContain("[DONE]");
        expect(chunkRef).toBe("#/components/schemas/GeminiGenerateResponse");
        const chunks: {
          candidates: { content: { parts: { text: string }[] }; finishReason?: string }[];
        }[] = frames.map((frame) => JSON.parse(frame));
        expect(chunks.map((chunk) => chunk.candidates[0].content.parts[0].text).join("")).toBe(
          "hello stream",
        );
        expect(chunks.at(-1)?.candidates[0].finishReason).toBe("STOP");
        expect(
          chunkSchema.properties?.candidates.items?.properties?.content.properties?.parts.type,
        ).toBe("array");
      }
    },
  );

  it.each(streamRoutes)(
    "preserves nonstreaming JSON for $path",
    async ({ family, path, actual }) => {
      mock.addFixture({
        match: { userMessage: "catalog json" },
        response: { content: "hello json" },
      });
      const doc: StreamCatalog = await (await fetch(`${mock.url}/__aimock/openapi.json`)).json();
      const jsonPath = path.replace("streamGenerateContent", "generateContent");
      const response = await fetch(
        `${mock.url}${actual.replace("streamGenerateContent", "generateContent")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            family === "chat"
              ? {
                  model: "test",
                  messages: [{ role: "user", content: "catalog json" }],
                  stream: false,
                }
              : { contents: [{ role: "user", parts: [{ text: "catalog json" }] }] },
          ),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(
        doc.paths[jsonPath].post.responses["200"].content["application/json"].schema.$ref,
      ).toBe(
        `#/components/schemas/${family === "chat" ? "ChatCompletionResponse" : "GeminiGenerateResponse"}`,
      );
      if (family === "chat") {
        const body: ChatCompletion = await response.json();
        expect(body.object).toBe("chat.completion");
        expect(body.choices[0].message.content).toBe("hello json");
      } else {
        const body = await response.json();
        expect(body.candidates[0].content.parts[0].text).toBe("hello json");
      }
    },
  );

  it("serves /__aimock/openapi.json and /__aimock/routes consistently", async () => {
    const openapi = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(openapi.status).toBe(200);
    const doc = (await openapi.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/chat/completions"]).toBeDefined();
    expect(doc.paths["/__aimock/journal"]).toBeDefined();

    const routes = await fetch(`${mock.url}/__aimock/routes`);
    expect(routes.status).toBe(200);
    const body = (await routes.json()) as {
      count: number;
      routes: { method: string; path: string }[];
    };
    // Served catalog matches the derived registry (not a second copy).
    expect(body.count).toBe(ROUTE_DEFINITIONS.length);
    expect(body.routes.length).toBe(ROUTE_DEFINITIONS.length);
    const servedKeys = new Set(body.routes.map((r) => `${r.method} ${r.path}`));
    for (const r of ROUTE_DEFINITIONS) {
      expect(servedKeys.has(`${r.method} ${r.path}`)).toBe(true);
    }
    // Every openapi path is backed by a routes entry.
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        expect(servedKeys.has(`${method.toUpperCase()} ${path}`)).toBe(true);
      }
    }
  });

  it("every catalog entry is mounted on the live router (no drift)", async () => {
    for (const r of ROUTE_DEFINITIONS) {
      const probePath = r.examplePath ?? r.path;
      const url = `${mock.url}${probePath}`;
      const res =
        r.method === "GET" || r.method === "DELETE"
          ? await fetch(url, { method: r.method })
          : await fetch(url, {
              method: r.method,
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
      // Drain the body so the socket can be reused.
      const text = await res.text();
      // POST /v1/images/variations was removed upstream (dall-e-2,
      // 2026-05-12) and aimock replays the removal: a 404 with a zero-byte
      // body and no JSON envelope (see images.ts + the deprecation policy).
      // The route is still registered and journaled — assert the replay
      // itself instead of the generic routed check below.
      if (r.method === "POST" && r.path === "/v1/images/variations") {
        expect(res.status).toBe(404);
        expect(text).toBe("");
        continue;
      }
      // A routed-but-empty result (e.g. unknown video job id) still proves the
      // route is mounted; only the dispatcher's generic miss means drift.
      let message: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed?.error?.message === "string") message = parsed.error.message;
      } catch {
        // Non-JSON (204/200-text) is always a routed response.
      }
      const genericMiss =
        res.status === 404 &&
        (message === "Not found" ||
          (typeof message === "string" && message.startsWith("Unknown control endpoint")));
      expect(
        genericMiss,
        `${r.method} ${probePath} hit the generic 404 — catalog drifted from router`,
      ).toBe(false);
    }
  }, 60000);

  it("every dispatch pattern has a catalog entry (router → catalog, no drift)", () => {
    // The reverse direction of the probe above: the dispatcher matches
    // against the `*_PATH` / `*_RE` bindings imported from route-registry.ts,
    // so each of those bindings must resolve to at least one catalog entry.
    // A new dispatch branch that forgets its ROUTE_DEFINITIONS entry fails
    // here instead of silently drifting.
    //
    // Deliberately NOT covered (documented in route-registry.ts): the
    // WebSocket-only upgrade paths (no HTTP method, so no OpenAPI operation),
    // CONTROL_PREFIX (a prefix, not a route), and FAL_ROUTE_RE (a
    // header-gated upstream mirror, not a fixed route).
    const WS_ONLY = new Set(["REALTIME_PATH", "GEMINI_LIVE_PATH", "LIVE_PATH"]);
    const NON_ROUTES = new Set(["CONTROL_PREFIX", "FAL_ROUTE_RE"]);
    const catalogPaths = new Set(ROUTE_DEFINITIONS.map((r) => `${r.method} ${r.path}`));
    const catalogExamples = ROUTE_DEFINITIONS.map((r) => ({
      key: `${r.method} ${r.path}`,
      method: r.method,
      probe: r.examplePath ?? r.path,
    }));

    for (const [name, value] of Object.entries(registry)) {
      if (NON_ROUTES.has(name) || WS_ONLY.has(name)) continue;
      if (typeof value === "string" && name.endsWith("_PATH")) {
        const covered = ROUTE_DEFINITIONS.some((r) => r.path === value);
        expect(covered, `dispatch path ${name} (${value}) has no catalog entry`).toBe(true);
      } else if (value instanceof RegExp && name.endsWith("_RE")) {
        const covered = catalogExamples.filter((e) => value.test(e.probe));
        expect(
          covered.length > 0,
          `dispatch pattern ${name} (${value}) matches no catalog examplePath`,
        ).toBe(true);
      }
    }
    // Sanity: the loop above actually inspected the dispatch surface.
    const pathCount = Object.keys(registry).filter((k) => k.endsWith("_PATH")).length;
    expect(pathCount).toBeGreaterThan(20);
    expect(catalogPaths.size).toBe(ROUTE_DEFINITIONS.length);
  });

  it("every catalog operation carries a real schema (no bare paths)", async () => {
    const res = await fetch(`${mock.url}/__aimock/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const schemas = doc.components.schemas;

    // Every $ref in the document resolves.
    const refs = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
          if (key === "$ref" && typeof entry === "string") refs.add(entry);
          else collect(entry);
        }
      }
    };
    collect(doc.paths);
    expect(refs.size).toBeGreaterThan(20);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(schemas[name] !== undefined, `unresolved $ref ${ref}`).toBe(true);
    }

    // No operation is a bare path: each has a requestBody, a success body, or
    // an explicit non-200 success status (replayed removals, 204 clears).
    // In particular the review-flagged families must have real schemas.
    const mustHaveSchemas = [
      "POST /v1/messages",
      "GET /v1/batches",
      "POST /v1/batches",
      "GET /v1/batches/{batch_id}",
      "POST /v1/batches/{batch_id}/cancel",
      "GET /v1/files",
      "POST /v1/files",
      "GET /v1/files/{file_id}",
      "DELETE /v1/files/{file_id}",
      "GET /v1/files/{file_id}/content",
      "POST /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs",
      "GET /v1/fine_tuning/jobs/{job_id}",
      "POST /v1/fine_tuning/jobs/{job_id}/cancel",
      "GET /v1/fine_tuning/jobs/{job_id}/events",
    ];
    for (const r of ROUTE_DEFINITIONS) {
      const operation = doc.paths[r.path]?.[r.method.toLowerCase()] as
        | Record<string, unknown>
        | undefined;
      if (operation === undefined) throw new Error(`missing operation ${r.method} ${r.path}`);
      const responses = operation.responses as Record<string, unknown>;
      // 400 is always the validation error; anything else (200, 204, or the
      // documented 404 replay of a removed route) is the success outcome.
      const successKey = Object.keys(responses).find((s) => s !== "400");
      expect(successKey !== undefined, `no success response for ${r.method} ${r.path}`).toBe(true);
      const hasRequest = operation.requestBody !== undefined;
      const success = responses[successKey!] as { content?: unknown };
      const hasSuccessBody = success.content !== undefined;
      const nonJsonSuccess = successKey !== "200";
      expect(
        hasRequest || hasSuccessBody || nonJsonSuccess,
        `${r.method} ${r.path} is a bare path with no schema`,
      ).toBe(true);
      if (mustHaveSchemas.includes(`${r.method} ${r.path}`)) {
        expect(hasRequest || hasSuccessBody).toBe(true);
      }
    }
  });

  it("matchRouteDefinition agrees with the registry table", () => {
    // Exact paths resolve.
    expect(matchRouteDefinition("POST", "/v1/chat/completions")?.service).toBe("openai");
    expect(matchRouteDefinition("get", "/health")?.service).toBe("ops");
    // Templates resolve their example paths.
    expect(matchRouteDefinition("POST", "/v1/text-to-speech/test-voice")?.service).toBe(
      "elevenlabs",
    );
    expect(matchRouteDefinition("GET", "/v1/fine_tuning/jobs/ftjob-test123/events")?.service).toBe(
      "fine-tuning",
    );
    // Method mismatches and unknown paths miss.
    expect(matchRouteDefinition("GET", "/v1/chat/completions")).toBeUndefined();
    expect(matchRouteDefinition("POST", "/v1/_requests")).toBeUndefined();
    expect(matchRouteDefinition("GET", "/nope/not-a-route")).toBeUndefined();
    // Self-consistency: every entry's probe path resolves to an entry.
    for (const r of ROUTE_DEFINITIONS) {
      const hit = matchRouteDefinition(r.method, r.examplePath ?? r.path);
      expect(hit !== undefined, `${r.method} ${r.examplePath ?? r.path} misses`).toBe(true);
    }
    // templateToRegExp compiles single-segment params and literal actions.
    expect(
      templateToRegExp("/v1beta/models/{model}:predict").test("/v1beta/models/a:predict"),
    ).toBe(true);
    expect(
      templateToRegExp("/v1beta/models/{model}:predict").test("/v1beta/models/a/b:predict"),
    ).toBe(false);
  });
});
