import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";
import { buildBytePlusMatchText } from "../byteplus-video.js";

/**
 * The BytePlus submit match key is stuffed into `userMessage`, which the router
 * SUBSTRING-matches by default (`useExactMatch = !!requestTransform`). Two
 * consequences the key itself has to defend against:
 *
 *  1. no key may be a substring of another key built from a different content
 *     array — otherwise a text-only recording shadows the image-to-video job
 *     that shares its prompt, and the caller silently gets the wrong video;
 *  2. no content array may produce `""`, because `buildFixtureMatch` then omits
 *     `userMessage` entirely and mints `{ endpoint: "video", model }` — the
 *     model-wide wildcard this key exists to prevent, which `isEmptyMatch`
 *     cannot catch because `endpoint` is set.
 */

const MODEL = "seedance-1-0-pro-fast-251015";
const SUBMIT = "/api/v3/contents/generations/tasks";
const PROMPT = "a guitar";
const FIRST_FRAME = "https://example.com/frame.png";

const T2V_CONTENT = [{ type: "text", text: PROMPT }];
const I2V_CONTENT = [
  { type: "text", text: PROMPT },
  { type: "image_url", image_url: { url: FIRST_FRAME } },
];

function envelope(videoUrl: string): Record<string, unknown> {
  return {
    model: MODEL,
    status: "succeeded",
    created_at: 1785000000,
    updated_at: Math.floor(Date.now() / 1000),
    content: { video_url: videoUrl },
  };
}

async function submitAndResolve(
  mock: LLMock,
  content: readonly unknown[],
): Promise<Record<string, unknown>> {
  const res = await fetch(`${mock.url}${SUBMIT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, content }),
  });
  const { id } = (await res.json()) as { id: string };
  for (let i = 0; i < 10; i++) {
    const poll = await fetch(`${mock.url}${SUBMIT}/${encodeURIComponent(id)}`);
    const body = (await poll.json()) as Record<string, unknown>;
    if (body.status !== "queued" && body.status !== "running") return body;
  }
  throw new Error("job never reached a terminal status");
}

describe("BytePlus submit match key", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  test("a text-only recording does not shadow an image-to-video request with the same prompt", async () => {
    mock = new LLMock({ port: 0 });
    // Order matters: the t2v fixture is registered first, so substring matching
    // hands it the i2v request unless the keys are made mutually non-prefixing.
    mock.addFixture({
      match: { userMessage: buildBytePlusMatchText(T2V_CONTENT), endpoint: "video", model: MODEL },
      response: { json: envelope("https://x/T2V.mp4") },
    });
    mock.addFixture({
      match: { userMessage: buildBytePlusMatchText(I2V_CONTENT), endpoint: "video", model: MODEL },
      response: { json: envelope("https://x/I2V.mp4") },
    });
    await mock.start();

    const body = await submitAndResolve(mock, I2V_CONTENT);
    expect((body.content as { video_url?: string }).video_url).toBe("https://x/I2V.mp4");
  });

  test("the text-only key is not a prefix of the media key", () => {
    const t2v = buildBytePlusMatchText(T2V_CONTENT);
    const i2v = buildBytePlusMatchText(I2V_CONTENT);
    expect(i2v.includes(t2v)).toBe(false);
    expect(t2v.includes(i2v)).toBe(false);
  });

  test("never returns an empty key, whatever the content array holds", () => {
    const degenerate: readonly unknown[][] = [
      [],
      [{ type: "text", text: "" }],
      [{ type: "image_base64", image_base64: "AAAA" }],
      [{ type: "image_url", image_url: "https://example.com/bare.png" }],
    ];
    const keys = degenerate.map((c) => buildBytePlusMatchText(c));
    expect(keys.filter((k) => k === "")).toEqual([]);
  });

  test("two unrecognised media parts do not collapse to the same key", () => {
    const a = buildBytePlusMatchText([{ type: "image_base64", image_base64: "AAAA" }]);
    const b = buildBytePlusMatchText([{ type: "image_base64", image_base64: "BBBB" }]);
    expect(a).not.toBe(b);
  });
});
