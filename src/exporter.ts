export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  /** Deployment environment tag applied to every trace/observation (e.g. "production", "development"). */
  environment: string;
  /** Optional release identifier applied to every trace for version filtering. */
  release?: string;
}

const LANGFUSE_BATCH_SIZE = 50;
const LANGFUSE_MAX_QUEUE_SIZE = 1000;

export interface LangfuseExporterLogger {
  warn(message: string): void;
}

/**
 * A Paperclip trace event. Fields marked "LLM" turn a generic event into a
 * Langfuse `generation-create` observation so Langfuse can compute cost and
 * run model-specific analytics.
 */
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
  /** LLM: model name — presence (with tokens) routes the event to a generation observation. */
  model?: string;
  /** LLM: model parameters (temperature, max_tokens, ...) captured on the generation. */
  modelParameters?: Record<string, unknown>;
  /** End time for span/generation observations (ISO 8601). Defaults to start time. */
  endTime?: string;
  /** Time the first completion token arrived (ISO 8601) — enables time-to-first-token analytics. */
  completionStartTime?: string;
  /** Explicit observation/trace input. Preferred over dumping all metadata (avoids leaking args). */
  input?: unknown;
  /** Explicit observation/trace output. */
  output?: unknown;
  /** Groups this event's trace under a user for the Users view. */
  userId?: string;
  /** Trace tags for filtering (feature, tier, ...). */
  tags?: string[];
  /** Overrides the config-level environment for this event. */
  environment?: string;
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
    environment: String(source.environment || env.LANGFUSE_TRACING_ENVIRONMENT || "production").trim().toLowerCase(),
    release: String(source.release || env.LANGFUSE_RELEASE || "").trim() || undefined,
  };
}

/** Build Langfuse-native usageDetails (integer token counts) so Langfuse computes cost automatically. */
function buildUsageDetails(event: PaperclipTraceEvent): Record<string, number> | undefined {
  const usage: Record<string, number> = {};
  if (typeof event.inputTokens === "number") usage.input = event.inputTokens;
  if (typeof event.outputTokens === "number") usage.output = event.outputTokens;
  if (usage.input !== undefined || usage.output !== undefined) {
    usage.total = (usage.input ?? 0) + (usage.output ?? 0);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Map a Paperclip trace event into Langfuse ingestion events. Always emits a
 * `trace-create` (carrying session/user/tags/environment for the Sessions,
 * Users, and filtering views) plus one observation:
 *   - `generation-create` for LLM events (model/tokens) so cost is computed,
 *   - `span-create` for tool calls,
 *   - `event-create` otherwise.
 */
export function mapPaperclipEvent(
  event: PaperclipTraceEvent,
  defaults: { environment?: string; release?: string } = {},
): LangfuseIngestionEvent[] {
  const timestamp = event.timestamp || new Date().toISOString();
  const traceId = event.runId || event.sessionId || event.issueId || event.companyId || "paperclip";
  const name = event.toolName ? `tool:${event.toolName}` : event.type;
  const environment = (event.environment || defaults.environment || "").trim().toLowerCase() || undefined;
  const level = event.error ? "ERROR" : event.level ? String(event.level).toUpperCase() : undefined;

  // Observation metadata: Paperclip identifiers + caller metadata. Tokens/cost
  // live in usageDetails (below), not here, so Langfuse can price them.
  const metadata = {
    companyId: event.companyId,
    projectId: event.projectId,
    issueId: event.issueId,
    agentId: event.agentId,
    sessionId: event.sessionId,
    runId: event.runId,
    heartbeatId: event.heartbeatId,
    ...event.metadata,
  };

  // Explicit input/output (best practice): prefer the caller's explicit fields
  // over dumping all metadata, which risks leaking configs/args.
  const input = event.input !== undefined ? event.input : event.metadata?.input;
  const output = event.output !== undefined ? event.output : (event.message ?? event.metadata?.output);

  const events: LangfuseIngestionEvent[] = [];

  // 1. Trace envelope — carries the cross-cutting context Langfuse groups on.
  const tags = event.tags && event.tags.length > 0 ? event.tags : undefined;
  events.push({
    id: `${event.id || traceId}:trace:${timestamp}`,
    timestamp,
    type: "trace-create",
    body: {
      id: traceId,
      timestamp,
      name: event.type,
      sessionId: event.sessionId || undefined,
      userId: event.userId || event.agentId || undefined,
      tags,
      environment,
      release: defaults.release || undefined,
      input,
      output,
      metadata: { companyId: event.companyId, projectId: event.projectId, issueId: event.issueId },
    },
  });

  // 2. Observation — generation / span / event.
  const baseBody: Record<string, unknown> = {
    traceId,
    name,
    startTime: timestamp,
    endTime: event.endTime || undefined,
    metadata,
    input,
    output,
    environment,
    level,
    statusMessage: event.error ? String(event.error) : event.message,
  };

  if (event.model || typeof event.inputTokens === "number" || typeof event.outputTokens === "number") {
    events.push({
      id: event.id || `${traceId}:gen:${timestamp}`,
      timestamp,
      type: "generation-create",
      body: {
        ...baseBody,
        model: event.model,
        modelParameters: event.modelParameters,
        completionStartTime: event.completionStartTime || undefined,
        usageDetails: buildUsageDetails(event),
      },
    });
  } else if (event.toolName) {
    events.push({
      id: event.id || `${traceId}:${event.toolName}:${timestamp}`,
      timestamp,
      type: "span-create",
      body: baseBody,
    });
  } else {
    events.push({
      id: event.id || `${traceId}:${event.type}:${timestamp}`,
      timestamp,
      type: "event-create",
      body: baseBody,
    });
  }

  return events;
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
    this.queue.push(...mapPaperclipEvent(event, { environment: this.config.environment, release: this.config.release }));
    if (this.queue.length <= LANGFUSE_MAX_QUEUE_SIZE) return;

    const dropped = this.queue.length - LANGFUSE_MAX_QUEUE_SIZE;
    this.queue.splice(0, dropped);
    this.logger.warn(`Langfuse export queue full; dropped ${dropped} oldest event${dropped === 1 ? "" : "s"}; queued=${this.queue.length}`);
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
