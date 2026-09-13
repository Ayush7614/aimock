import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { validateChatMessages, validateToolsField } from "../helpers.js";

/**
 * Wrong-typed fields used to throw inside the provider converters
 * (`content.filter` on a number, `.map` on a string `tools`, `msg.role` on
 * a null entry, `createHash().update()` on a numeric text) and surface as
 * generic 500s. Handlers now answer 400 with a precise message, and
 * legitimate null content (assistant tool-call messages) still converts.
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

interface ErrorEnvelope {
  error?: { message?: unknown };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; message: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ErrorEnvelope;
  return { status: res.status, message: json?.error?.message };
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
  const json = (await res.json()) as ErrorEnvelope;
  return { status: res.status, message: json?.error?.message };
}

describe("validateChatMessages", () => {
  test("accepts valid shapes", () => {
    expect(validateChatMessages([])).toBeNull();
    expect(
      validateChatMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
    ).toBeNull();
  });

  test("rejects non-array messages", () => {
    expect(validateChatMessages(undefined)).toBe("messages array is required");
    expect(validateChatMessages("hi")).toBe("messages array is required");
  });

  test("rejects non-object entries and wrong-typed fields", () => {
    expect(validateChatMessages([null])).toBe("messages[0] must be an object");
    expect(validateChatMessages(["hi"])).toBe("messages[0] must be an object");
    expect(validateChatMessages([{ role: "user", content: 123 }])).toBe(
      "messages[0].content must be a string or an array",
    );
    expect(validateChatMessages([{ role: "user", content: [null] }])).toBe(
      "messages[0].content must be a string or an array",
    );
    expect(validateChatMessages([{ role: "user", content: "hi", tool_calls: "x" }])).toBe(
      "messages[0].tool_calls must be an array",
    );
    expect(validateChatMessages([{ role: "user", content: "hi", tool_calls: [null] }])).toBe(
      "messages[0].tool_calls entries must be objects",
    );
    expect(
      validateChatMessages([{ role: "assistant", content: null, tool_calls: [{ id: "1" }] }]),
    ).toBe("messages[0].tool_calls entries must have a function object");
  });
});

describe("validateToolsField", () => {
  test("accepts absent or array tools", () => {
    expect(validateToolsField(undefined)).toBeNull();
    expect(validateToolsField(null)).toBeNull();
    expect(validateToolsField([])).toBeNull();
    expect(validateToolsField([{ type: "function" }])).toBeNull();
  });

  test("rejects non-array tools and non-object entries", () => {
    expect(validateToolsField("hi")).toBe("tools must be an array");
    expect(validateToolsField([null])).toBe("tools[0] must be an object");
  });
});

describe("POST /v2/chat (cohere) wrong-type fields", () => {
  test("null body returns 400", async () => {
    const { status, message } = await postRaw(`${await start()}/v2/chat`, "null");
    expect(status).toBe(400);
    expect(message).toBe("Request body must be a JSON object");
  });

  test("numeric content returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/v2/chat`, {
      model: "command-r",
      messages: [{ role: "user", content: 123 }],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: messages[0].content must be a string or an array");
  });

  test("null message entry returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/v2/chat`, {
      model: "command-r",
      messages: [null],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: messages[0] must be an object");
  });

  test("string tools returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/v2/chat`, {
      model: "command-r",
      messages: [{ role: "user", content: "hi" }],
      tools: "hi",
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: tools must be an array");
  });

  test("null assistant content with tool calls does not crash", async () => {
    const { status } = await postJson(`${await start()}/v2/chat`, {
      model: "command-r",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
    });
    // No fixture registered, so 404 — the point is it is not a 500.
    expect(status).toBe(404);
  });
});

describe("POST /v2/embed (cohere) wrong-type fields", () => {
  test("numeric text returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/v2/embed`, {
      model: "embed-english-v3.0",
      texts: [123],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: texts must be an array of strings");
  });
});

describe("ollama wrong-type fields", () => {
  test("numeric content on /api/chat returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: 123 }],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: messages[0].content must be a string or an array");
  });

  test("string tools on /api/chat returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/api/chat`, {
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      tools: "hi",
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: tools must be an array");
  });

  test("numeric prompt on /api/embeddings returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/api/embeddings`, {
      model: "llama3",
      prompt: 123,
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: prompt field must be a string");
  });

  test("numeric input on /api/embeddings returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}/api/embeddings`, {
      model: "llama3",
      input: 123,
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: input field must be a string or an array of strings");
  });
});

describe("gemini wrong-type fields", () => {
  const path = "/v1beta/models/gemini-2.0-flash:generateContent";

  test("string contents returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}${path}`, {
      contents: "hi",
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid argument: contents must be an array");
  });

  test("content without parts does not crash", async () => {
    const { status } = await postJson(`${await start()}${path}`, {
      contents: [{ role: "user" }],
    });
    expect(status).toBe(404);
  });

  test("empty systemInstruction does not crash", async () => {
    const { status } = await postJson(`${await start()}${path}`, {
      systemInstruction: {},
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(status).toBe(404);
  });

  test("string tools returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}${path}`, {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: "hi",
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid argument: tools must be an array");
  });
});

describe("bedrock wrong-type fields", () => {
  const invoke = "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke";
  const stream = "/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream";

  test("numeric content returns 400, not 500", async () => {
    for (const p of [invoke, stream]) {
      const { status, message } = await postJson(`${await start()}${p}`, {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 512,
        messages: [{ role: "user", content: 123 }],
      });
      expect(status).toBe(400);
      expect(message).toBe("Invalid request: messages[0].content must be a string or an array");
    }
  });

  test("null message entry returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}${invoke}`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [null],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: messages[0] must be an object");
  });

  test("numeric system returns 400, not 500", async () => {
    const { status, message } = await postJson(`${await start()}${invoke}`, {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      system: 123,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(status).toBe(400);
    expect(message).toBe("Invalid request: system must be a string or an array");
  });
});
