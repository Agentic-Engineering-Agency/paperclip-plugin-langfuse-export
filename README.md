# @paperclipai/plugin-langfuse-trace-export

Exports Paperclip trace-shaped events to Langfuse ingestion.

## Configuration

Set instance config or environment variables:

- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (optional, defaults to `https://cloud.langfuse.com`)

Missing keys disable export without failing Paperclip core work.

## Worker API

The worker registers `exportTrace` data action. It accepts a Paperclip trace event containing company/project/issue/agent/session/run/heartbeat/tool/cost/error metadata, maps tool events to Langfuse spans, maps other events to Langfuse events, and posts batches to `/api/public/ingestion`.

Failed Langfuse requests keep events queued and log a warning; they do not throw through the plugin action.

## Verify

```sh
npm install
npm test
npm run typecheck
```
