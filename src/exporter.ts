export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

const LANGFUSE_BATCH_SIZE = 50;
const LANGFUSE_MAX_QUEUE_SIZE = 1000;

export interface LangfuseExporterLogger {
  warn(message: string): void;
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
    private readonly logger: LangfuseExporterLogger = console,
  ) {}

  enqueue(event: PaperclipTraceEvent): void {
    if (this.queue.length >= LANGFUSE_MAX_QUEUE_SIZE) {
      this.queue.shift();
      this.logger.warn(`Langfuse export queue full; dropped oldest event; queued=${this.queue.length}`);
    }
    this.queue.push(mapPaperclipEvent(event));
  }

  size(): number {
    return this.queue.length;
  }

  private requeueBatch(batch: LangfuseIngestionEvent[]): void {
    this.queue.unshift(...batch);
    if (this.queue.length <= LANGFUSE_MAX_QUEUE_SIZE) return;

    const dropped = this.queue.length - LANGFUSE_MAX_QUEUE_SIZE;
    this.queue.splice(0, dropped);
    this.logger.warn(`Langfuse export queue full; dropped ${dropped} oldest event${dropped === 1 ? "" : "s"}; queued=${this.queue.length}`);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, LANGFUSE_BATCH_SIZE);
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
        this.requeueBatch(batch);
        throw new Error(`Langfuse ingestion failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (this.queue[0] !== batch[0]) this.requeueBatch(batch);
      throw error;
    } finally {
      this.flushing = false;
    }
  }
}
