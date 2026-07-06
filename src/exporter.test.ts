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

  it("maps non-tool events to Langfuse event creates", () => {
    const mapped = mapPaperclipEvent({
      type: "heartbeat",
      timestamp: "2026-07-04T05:00:00.000Z",
      runId: "run-1",
      message: "still running",
      metadata: { phase: "work" },
    });

    expect(mapped.type).toBe("event-create");
    expect(mapped.body.traceId).toBe("run-1");
    expect(mapped.body.name).toBe("heartbeat");
    expect(mapped.body.output).toBe("still running");
    expect(mapped.body.metadata).toMatchObject({ runId: "run-1", phase: "work" });
  });

  it("drains one successful batch from the queue", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" }, fetchImpl as typeof fetch);

    exporter.enqueue({ type: "heartbeat", runId: "run-1" });
    await exporter.flush();

    expect(exporter.size()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flushes at most 50 queued events per batch", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" }, fetchImpl as typeof fetch);

    for (let i = 0; i < 51; i += 1) {
      exporter.enqueue({ type: "heartbeat", runId: `run-${i}` });
    }

    await exporter.flush();

    expect(exporter.size()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.batch).toHaveLength(50);
  });

  it("drops the oldest event and logs a warning when the queue is full", () => {
    const logger = { warn: vi.fn() };
    const exporter = new LangfuseExporter(
      { publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" },
      vi.fn() as unknown as typeof fetch,
      logger,
    );

    for (let i = 0; i < 1001; i += 1) {
      exporter.enqueue({ type: "heartbeat", runId: `run-${i}` });
    }

    expect(exporter.size()).toBe(1000);
    expect(logger.warn).toHaveBeenCalledWith("Langfuse export queue full; dropped oldest event; queued=999");
  });

  it("does not start a second send while a flush is in flight", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test" }, fetchImpl as typeof fetch);

    exporter.enqueue({ type: "heartbeat", runId: "run-1" });
    const firstFlush = exporter.flush();
    await exporter.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFirst(new Response("ok", { status: 200 }));
    await firstFlush;
    expect(exporter.size()).toBe(0);
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
