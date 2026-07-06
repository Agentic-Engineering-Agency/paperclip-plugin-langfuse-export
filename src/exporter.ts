export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export interface PaperclipTraceEvent {
  id?: string;
  type: string;
  timestamp?: string;
  companyId?: string;
  projectId?: string;
  issueId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  heartbeatId?: string;
  toolName?: string;
  level?: string;
  message?: string;
  error?: unknown;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface LangfuseIngestionEvent {
  id: string;
  timestamp: string;
  type: "trace-create" | "span-create" | "generation-create" | "event-create";
  body: Record<string, unknown>;
}

export function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() || "https://cloud.langfuse.com";
  return raw.replace(/\/+$/, "");
}

export function readConfig(source: Record<string, unknown>, env: Record<string, string | undefined> = process.env): LangfuseConfig | null {
  const publicKey = String(source.publicKey || env.LANGFUSE_PUBLIC_KEY || "").trim();
  const secretKey = String(source.secretKey || env.LANGFUSE_SECRET_KEY || "").trim();
  if (!publicKey || !secretKey) return null;
  return {
    publicKey,
    secretKey,
    baseUrl: normalizeBaseUrl(String(source.baseUrl || env.LANGFUSE_BASE_URL || "")),
  };
}

export function mapPaperclipEvent(event: PaperclipTraceEvent): LangfuseIngestionEvent {
  const timestamp = event.timestamp || new Date().toISOString();
  const traceId = event.runId || event.sessionId || event.issueId || event.companyId || "paperclip";
  const name = event.toolName ? `tool:${event.toolName}` : event.type;
  const metadata = {
    companyId: event.companyId,
    projectId: event.projectId,
    issueId: event.issueId,
    agentId: event.agentId,
    sessionId: event.sessionId,
    runId: event.runId,
    heartbeatId: event.heartbeatId,
    level: event.level,
    costUsd: event.costUsd,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...event.metadata,
  };

  if (event.toolName) {
    return {
      id: event.id || `${traceId}:${event.toolName}:${timestamp}`,
      timestamp,
      type: "span-create",
      body: {
        traceId,
        name,
        startTime: timestamp,
        metadata,
        input: event.metadata?.input,
        output: event.metadata?.output,
        statusMessage: event.message,
        level: event.error ? "ERROR" : undefined,
      },
    };
  }

  return {
    id: event.id || `${traceId}:${event.type}:${timestamp}`,
    timestamp,
    type: "event-create",
    body: {
      traceId,
      name,
      startTime: timestamp,
      metadata,
      input: event.metadata,
      output: event.message,
      level: event.error ? "ERROR" : undefined,
      statusMessage: event.error ? String(event.error) : event.message,
    },
  };
}

export class LangfuseExporter {
  private queue: LangfuseIngestionEvent[] = [];
  private flushing = false;

  constructor(
    private readonly config: LangfuseConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  enqueue(event: PaperclipTraceEvent): void {
    this.queue.push(mapPaperclipEvent(event));
  }

  size(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, 50);
    try {
      const credentials = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64");
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch }),
      });
      if (!response.ok) {
        this.queue.unshift(...batch);
        throw new Error(`Langfuse ingestion failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (this.queue[0] !== batch[0]) this.queue.unshift(...batch);
      throw error;
    } finally {
      this.flushing = false;
    }
  }
}
