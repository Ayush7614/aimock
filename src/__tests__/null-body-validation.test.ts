import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { isJsonObject } from "../helpers.js";

/**
 * A JSON body of `null` parses successfully, so the malformed-JSON branch
 * never runs — but the first field read (`body.prompt`, `body.messages`,
 * …) then throws a TypeError that the server answers with a generic 500.
 * Every JSON handler must reject a non-object body with a 400 instead.
 */

let mock: LLMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function start(): Promise<string> {
  mock = new LLMock({ port: 0 });
  await mock.start();
  return mock.url;
}

async function postRaw(
  url: string,
  rawBody: string,
): Promise<{ status: number; message: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  const json = (await res.json()) as { error?: { message?: unknown } };
  return { status: res.status, message: json?.error?.message };
}

async function expect400ObjectBody(url: string): Promise<void> {
  const { status, message } = await postRaw(url, "null");
  expect(status).toBe(400);
  expect(message).toBe("Request body must be a JSON object");
}

describe("isJsonObject", () => {
  test("accepts plain objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ prompt: "hi" })).toBe(true);
  });

  test("rejects null, arrays, and scalars", () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ prompt: "hi" }])).toBe(false);
    expect(isJsonObject("hi")).toBe(false);
    expect(isJsonObject(123)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
  });
});

describe("null JSON body returns 400, not 500", () => {
  test("POST /v1/images/generations", async () => {
    await expect400ObjectBody(`${await start()}/v1/images/generations`);
  });

  test("POST /v1/audio/speech", async () => {
    await expect400ObjectBody(`${await start()}/v1/audio/speech`);
  });

  test("POST /v1/videos", async () => {
    await expect400ObjectBody(`${await start()}/v1/videos`);
  });

  test("POST /v1/embeddings", async () => {
    await expect400ObjectBody(`${await start()}/v1/embeddings`);
  });

  test("POST /v1/moderations", async () => {
    await expect400ObjectBody(`${await start()}/v1/moderations`);
  });

  test("POST /search", async () => {
    await expect400ObjectBody(`${await start()}/search`);
  });

  test("POST /v2/rerank", async () => {
    await expect400ObjectBody(`${await start()}/v2/rerank`);
  });

  test("POST /fal/queue/submit/{model} (fal-audio)", async () => {
    await expect400ObjectBody(`${await start()}/fal/queue/submit/fal-ai/stable-audio`);
  });

  test("POST /fal/run/{model} (fal-audio)", async () => {
    await expect400ObjectBody(`${await start()}/fal/run/fal-ai/stable-audio`);
  });

  test("POST /v1/text-to-speech/{voice_id} (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/text-to-speech/eleven_multilingual_v2`);
  });

  test("POST /v1/sound-generation (elevenlabs)", async () => {
    await expect400ObjectBody(`${await start()}/v1/sound-generation`);
  });
});

describe("non-object JSON bodies are rejected with the same 400", () => {
  test("array body on POST /v1/images/generations", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/images/generations`, '[{"prompt":"hi"}]');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("scalar body on POST /v1/embeddings", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/v1/embeddings`, '"hi"');
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("numeric body on POST /search", async () => {
    const base = await start();
    const { status, message } = await postRaw(`${base}/search`, "123");
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });
});
