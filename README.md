# @paperclipai/plugin-langfuse-trace-export

Exports Paperclip trace-shaped events to Langfuse ingestion.

## Configuration

Set instance config or environment variables:

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (optional, defaults to `https://cloud.langfuse.com`)

Missing keys disable export without failing Paperclip core work.

## Worker API

The worker registers `exportTrace` data action. It accepts a Paperclip trace event containing company/project/issue/agent/session/run/heartbeat/tool/cost/error metadata, maps tool events to Langfuse spans, maps other events to Langfuse events, queues them in memory, and posts batches of up to 50 events to `/api/public/ingestion`.

Successful Langfuse requests remove the sent batch from the queue. Failed Langfuse requests put the batch back at the front, keep events queued for a later `exportTrace` call, and log a warning; they do not throw through the plugin action. The retry queue is capped at 1000 events so a persistently failing endpoint cannot grow memory unbounded. When the queue is full, the oldest event is dropped and a warning is logged.

## Verify

```sh
npm install
npm test
npm run typecheck
```
