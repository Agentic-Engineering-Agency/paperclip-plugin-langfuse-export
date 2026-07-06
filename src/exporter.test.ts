import { describe, expect, it, vi } from "vitest";

import { LangfuseExporter, mapPaperclipEvent, readConfig } from "./exporter.js";

describe("Langfuse trace export", () => {
  it("maps Paperclip tool events to Langfuse spans", () => {
    const mapped = mapPaperclipEvent({
      type: "tool_call",
      timestamp: "2026-07-04T05:00:00.000Z",
      companyId: "company-1",
      issueId: "issue-1",
      runId: "run-1",
      toolName: "read",
      metadata: { input: { path: "README.md" }, output: "ok" },
    });

    expect(mapped.type).toBe("span-create");
    expect(mapped.body.traceId).toBe("run-1");
    expect(mapped.body.name).toBe("tool:read");
    expect(mapped.body.metadata).toMatchObject({ companyId: "company-1", issueId: "issue-1" });
  });

  it("keeps failed exports queued without throwing from enqueue", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" }, fetchImpl as typeof fetch);

    exporter.enqueue({ type: "heartbeat", runId: "run-1" });
    await expect(exporter.flush()).rejects.toThrow("Langfuse ingestion failed: 503 Unavailable");

    expect(exporter.size()).toBe(1);
  });

  it("reads env-backed config and normalizes base URL", () => {
    expect(readConfig({}, {
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://langfuse.test/",
    })).toEqual({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://langfuse.test",
    });
  });
});
