import { describe, test, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { VectorMock } from "../vector-mock.js";
import { A2AMock } from "../a2a-mock.js";
import { MCPMock } from "../mcp-mock.js";
import { AGUIMock } from "../agui-mock.js";
import { LLMock } from "../llmock.js";
import { Journal } from "../journal.js";

/**
 * Every response path through the mountable/standalone wrappers must leave
 * a journal entry. These paths previously skipped journaling: vector
 * malformed-JSON 400s (mountable + standalone) and standalone 404s, the A2A
 * agent-card fetch, A2A JSON-RPC parse errors, unmatched A2A streaming
 * messages, and the MCP/AG-UI standalone 500 catch blocks.
 */

function rawRequest(
  url: string,
  path: string,
  method: string,
  rawBody?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> =
      rawBody !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(rawBody)),
          }
        : {};
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (rawBody !== undefined) req.write(rawBody);
    req.end();
  });
}

describe("vector wrapper journal coverage", () => {
  let vector: VectorMock | null = null;

  afterEach(async () => {
    await vector?.stop().catch(() => {});
    vector = null;
  });

  test("standalone malformed JSON journals the 400", async () => {
    vector = new VectorMock();
    const journal = new Journal();
    vector.setJournal(journal);
    const url = await vector.start();

    const res = await rawRequest(url, "/query", "POST", "{not valid");
    expect(res.status).toBe(400);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("vector");
    expect(entries[0].response.status).toBe(400);
  });

  test("standalone unknown path journals the 404", async () => {
    vector = new VectorMock();
    const journal = new Journal();
    vector.setJournal(journal);
    const url = await vector.start();

    const res = await rawRequest(url, "/no-such-path", "GET");
    expect(res.status).toBe(404);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("vector");
    expect(entries[0].response.status).toBe(404);
  });

  test("mountable malformed JSON journals the 400", async () => {
    vector = new VectorMock();
    vector.addCollection("default", { dimension: 3 });

    const llm = new LLMock();
    llm.mount("/vector", vector);
    await llm.start();
    try {
      const res = await rawRequest(llm.url, "/vector/query", "POST", "{not valid");
      expect(res.status).toBe(400);

      // Mounted services share the server journal (server re-points the
      // mount's journal on start), so assert there.
      const entries = llm
        .getRequests()
        .filter((e) => e.service === "vector" && e.response.status === 400);
      expect(entries).toHaveLength(1);
    } finally {
      await llm.stop();
    }
  });
});

describe("a2a wrapper journal coverage", () => {
  let a2a: A2AMock | null = null;

  afterEach(async () => {
    await a2a?.stop().catch(() => {});
    a2a = null;
  });

  test("agent-card fetch is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "card-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(url, "/.well-known/agent-card.json", "GET");
    expect(res.status).toBe(200);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });

  test("JSON-RPC parse error is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "parse-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(url, "/", "POST", "{not valid");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32700);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });

  test("unmatched streaming message is journaled", async () => {
    a2a = new A2AMock();
    a2a.registerAgent({ name: "stream-agent" });
    const journal = new Journal();
    a2a.setJournal(journal);
    const url = await a2a.start();

    const res = await rawRequest(
      url,
      "/",
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "SendStreamingMessage",
        params: { message: { parts: [{ text: "nothing matches this" }] } },
        id: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).error.code).toBe(-32000);

    const entries = journal.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].service).toBe("a2a");
    expect(entries[0].response.status).toBe(200);
  });
});

describe("mcp/agui standalone 500 journal coverage", () => {
  test("mcp handler fault journals the 500", async () => {
    const mcp = new MCPMock();
    const journal = new Journal();
    mcp.setJournal(journal);
    // Fault injection: the standalone catch only runs when the inner
    // handler rejects, which well-formed dispatch never does.
    (
      mcp as unknown as {
        requestHandler: (req: unknown, res: unknown, body: string) => Promise<void>;
      }
    ).requestHandler = async () => {
      throw new Error("boom");
    };
    const url = await mcp.start();
    try {
      const res = await rawRequest(url, "/", "POST", JSON.stringify({ jsonrpc: "2.0" }));
      expect(res.status).toBe(500);

      const entries = journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("mcp");
      expect(entries[0].response.status).toBe(500);
    } finally {
      await mcp.stop();
    }
  });

  test("agui handler fault journals the 500", async () => {
    const agui = new AGUIMock();
    const journal = new Journal();
    agui.setJournal(journal);
    // Fault injection: the standalone catch only runs when handleRequest
    // throws, which the validated paths never do.
    vi.spyOn(agui, "handleRequest").mockRejectedValueOnce(new Error("boom"));
    const url = await agui.start();
    try {
      const res = await rawRequest(url, "/", "POST", JSON.stringify({}));
      expect(res.status).toBe(500);

      const entries = journal.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].service).toBe("agui");
      expect(entries[0].response.status).toBe(500);
    } finally {
      await agui.stop();
    }
  });
});
