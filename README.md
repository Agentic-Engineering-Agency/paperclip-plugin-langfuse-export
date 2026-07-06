# @paperclipai/plugin-langfuse-trace-export

Exports Paperclip trace-shaped events to [Langfuse](https://langfuse.com) ingestion, following Langfuse tracing best practices.

## Configuration

Set instance config or environment variables:

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (optional, defaults to `https://cloud.langfuse.com`)
- `LANGFUSE_TRACING_ENVIRONMENT` (optional, defaults to `production`) — tags every trace/observation so you can separate prod/dev in the UI. See https://langfuse.com/docs/tracing-features/environments
- `LANGFUSE_RELEASE` (optional) — release/version tag applied to every trace for version filtering.

Missing keys disable export without failing Paperclip core work.

## What gets traced

Each Paperclip event produces a Langfuse **trace** plus one **observation**, following the baseline instrumentation requirements (model name, token usage, descriptive names, correct observation types, explicit input/output):

| Paperclip event | Langfuse observation | Why |
| --- | --- | --- |
| Has `model` or token counts | `generation-create` | Marks LLM calls as generations so Langfuse computes **cost** from native `usageDetails` ({input, output, total}) and runs model analytics. https://langfuse.com/docs/observability/features/token-and-cost-tracking |
| Has `toolName` | `span-create` (`tool:<name>`) | Nests tool calls as spans in the trace tree. |
| Otherwise | `event-create` | Point-in-time events. |

The **trace** envelope carries the cross-cutting context Langfuse groups and filters on:

- `sessionId` — groups a run's events into one conversation in the **Sessions** view. https://langfuse.com/docs/tracing-features/sessions
- `userId` (falls back to `agentId`) — enables the **Users** view and per-user cost attribution. https://langfuse.com/docs/tracing-features/users
- `tags` — free-form filtering (feature, tier, ...). https://langfuse.com/docs/tracing-features/tags
- `environment` / `release` — deployment separation and version filtering.
- `input` / `output` — set **explicitly** from the event (not a dump of all metadata), so traces stay readable and args/configs are not leaked. Token/cost data lives in `usageDetails`, not metadata.

`traceId` precedence: `runId → sessionId → issueId → companyId → "paperclip"`, so all events from one run land on one trace.

## Worker API

The worker registers the `exportTrace` data action. It accepts a Paperclip trace event (company/project/issue/agent/session/run/heartbeat/tool identifiers, optional `model`/`inputTokens`/`outputTokens`/`modelParameters`, explicit `input`/`output`, `userId`, `tags`, `environment`, cost, error), maps it to trace + observation events, queues them in memory, and posts batches of up to 50 to `/api/public/ingestion`.

Successful Langfuse requests remove the sent batch from the queue. Failed requests put the batch back at the front, keep events queued for a later `exportTrace` call, and log a warning; they never throw through the plugin action. The retry queue is capped at 1000 events so a persistently failing endpoint cannot grow memory unbounded — when full, the oldest events are dropped with a warning. Credentials are only ever used to build the Basic auth header and are never logged.

## Verify

```sh
npm install
npm test
npm run typecheck
```
