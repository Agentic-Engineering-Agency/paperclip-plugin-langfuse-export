import { describe, expect, it, vi } from "vitest";

import { LangfuseExporter, mapPaperclipEvent, readConfig } from "./exporter.js";

describe("Langfuse trace export", () => {
  it("maps Paperclip tool events to trace plus Langfuse span", () => {
    const mapped = mapPaperclipEvent({
      type: "tool_call",
      timestamp: "2026-07-04T05:00:00.000Z",
      companyId: "company-1",
      issueId: "issue-1",
      runId: "run-1",
      toolName: "read",
      metadata: { input: { path: "README.md" }, output: "ok" },
    });

    expect(mapped).toHaveLength(2);
    expect(mapped[0].type).toBe("trace-create");
    expect(mapped[0].body).toMatchObject({
      id: "run-1",
      name: "tool_call",
      input: { path: "README.md" },
      output: "ok",
      metadata: { companyId: "company-1", issueId: "issue-1" },
    });
    expect(mapped[1].type).toBe("span-create");
    expect(mapped[1].body.traceId).toBe("run-1");
    expect(mapped[1].body.name).toBe("tool:read");
    expect(mapped[1].body.metadata).toMatchObject({ companyId: "company-1", issueId: "issue-1", runId: "run-1" });
  });

  it("maps non-tool events to trace plus Langfuse event creates", () => {
    const mapped = mapPaperclipEvent({
      type: "heartbeat",
      timestamp: "2026-07-04T05:00:00.000Z",
      runId: "run-1",
      message: "still running",
      metadata: { phase: "work" },
    });

    expect(mapped).toHaveLength(2);
    expect(mapped[0].type).toBe("trace-create");
    expect(mapped[0].body).toMatchObject({
      id: "run-1",
      name: "heartbeat",
      output: "still running",
    });
    expect(mapped[1].type).toBe("event-create");
    expect(mapped[1].body.traceId).toBe("run-1");
    expect(mapped[1].body.name).toBe("heartbeat");
    expect(mapped[1].body.output).toBe("still running");
    expect(mapped[1].body.metadata).toMatchObject({ runId: "run-1", phase: "work" });
  });

  it("maps model token events to generations with native Langfuse usage", () => {
    const mapped = mapPaperclipEvent({
      type: "llm_response",
      timestamp: "2026-07-04T05:00:00.000Z",
      runId: "run-1",
      model: "gpt-4.1",
      modelParameters: { temperature: 0.2 },
      inputTokens: 12,
      outputTokens: 30,
      completionStartTime: "2026-07-04T05:00:01.000Z",
      metadata: { inputTokens: 999, costUsd: 1.23 },
    });

    expect(mapped[1].type).toBe("generation-create");
    expect(mapped[1].body).toMatchObject({
      model: "gpt-4.1",
      modelParameters: { temperature: 0.2 },
      completionStartTime: "2026-07-04T05:00:01.000Z",
      usageDetails: { input: 12, output: 30, total: 42 },
    });
    expect(mapped[1].body.metadata).not.toMatchObject({ inputTokens: 12, outputTokens: 30 });
  });

  it("maps token-only events to generations with usage details", () => {
    const mapped = mapPaperclipEvent({
      type: "llm_usage",
      timestamp: "2026-07-04T05:00:00.000Z",
      runId: "run-1",
      inputTokens: 7,
      outputTokens: 5,
    });

    expect(mapped[1].type).toBe("generation-create");
    expect(mapped[1].body.model).toBeUndefined();
    expect(mapped[1].body.usageDetails).toEqual({ input: 7, output: 5, total: 12 });
  });

  it("sets trace session, explicit user, fallback user, and non-empty tags", () => {
    const withUser = mapPaperclipEvent({
      type: "agent_step",
      runId: "run-1",
      sessionId: "session-1",
      userId: "user-1",
      agentId: "agent-1",
      tags: ["tier:pro"],
    });
    const withFallback = mapPaperclipEvent({
      type: "agent_step",
      runId: "run-2",
      agentId: "agent-2",
      tags: [],
    });

    expect(withUser[0].body).toMatchObject({
      sessionId: "session-1",
      userId: "user-1",
      tags: ["tier:pro"],
    });
    expect(withFallback[0].body.userId).toBe("agent-2");
    expect(withFallback[0].body.tags).toBeUndefined();
  });

  it("applies default environment to trace and observation unless the event overrides it", () => {
    const fromDefaults = mapPaperclipEvent({ type: "heartbeat", runId: "run-1" }, { environment: "Production" });
    const fromEvent = mapPaperclipEvent({ type: "heartbeat", runId: "run-2", environment: "Staging" }, { environment: "Production" });

    expect(fromDefaults[0].body.environment).toBe("production");
    expect(fromDefaults[1].body.environment).toBe("production");
    expect(fromEvent[0].body.environment).toBe("staging");
    expect(fromEvent[1].body.environment).toBe("staging");
  });

  it("prefers explicit input and output over metadata-derived values", () => {
    const mapped = mapPaperclipEvent({
      type: "heartbeat",
      runId: "run-1",
      input: { prompt: "safe input" },
      output: "explicit output",
      message: "message output",
      metadata: { input: { secret: "metadata input" }, output: "metadata output" },
    });

    expect(mapped[0].body.input).toEqual({ prompt: "safe input" });
    expect(mapped[0].body.output).toBe("explicit output");
    expect(mapped[1].body.input).toEqual({ prompt: "safe input" });
    expect(mapped[1].body.output).toBe("explicit output");
  });

  it("drains one successful batch from the queue", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test", environment: "production" }, fetchImpl as typeof fetch);

    exporter.enqueue({ type: "heartbeat", runId: "run-1" });
    expect(exporter.size()).toBe(2);
    await exporter.flush();

    expect(exporter.size()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flushes at most 50 queued events per batch", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test", environment: "production" }, fetchImpl as typeof fetch);

    for (let i = 0; i < 25; i += 1) {
      exporter.enqueue({ type: "heartbeat", runId: `run-${i}` });
    }

    await exporter.flush();

    expect(exporter.size()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.batch).toHaveLength(50);
  });

  it("drops the oldest event and logs a warning when the queue is full", () => {
    const logger = { warn: vi.fn() };
    const exporter = new LangfuseExporter(
      { publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test", environment: "production" },
      vi.fn() as unknown as typeof fetch,
      logger,
    );

    for (let i = 0; i < 1001; i += 1) {
      exporter.enqueue({ type: "heartbeat", runId: `run-${i}` });
    }

    expect(exporter.size()).toBe(1000);
    expect(logger.warn).toHaveBeenLastCalledWith("Langfuse export queue full; dropped 2 oldest events; queued=1000");
  });

  it("does not start a second send while a flush is in flight", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    }));
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test", environment: "production" }, fetchImpl as typeof fetch);

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
    const exporter = new LangfuseExporter({ publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.test", environment: "production" }, fetchImpl as typeof fetch);

    exporter.enqueue({ type: "heartbeat", runId: "run-1" });
    await expect(exporter.flush()).rejects.toThrow("Langfuse ingestion failed: 503 Unavailable");

    expect(exporter.size()).toBe(2);
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
      environment: "production",
      release: undefined,
    });
  });

  it("reads tracing environment and release from env-backed config", () => {
    expect(readConfig({}, {
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://langfuse.test/",
      LANGFUSE_TRACING_ENVIRONMENT: "Staging",
      LANGFUSE_RELEASE: "2026.07.04",
    })).toEqual({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "https://langfuse.test",
      environment: "staging",
      release: "2026.07.04",
    });
  });
});
