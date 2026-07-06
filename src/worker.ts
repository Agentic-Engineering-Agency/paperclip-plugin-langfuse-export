import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { LangfuseExporter, readConfig } from "./exporter.js";
import type { PaperclipTraceEvent } from "./exporter.js";

const PLUGIN_NAME = "langfuse-trace-export";


const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    const config = readConfig(await ctx.config.get());
    if (!config) {
      ctx.logger.warn("Langfuse export disabled: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required");
      return;
    }

    const exporter = new LangfuseExporter(config, fetch, ctx.logger);

    ctx.data.register("exportTrace", async (params: Record<string, unknown>) => {
      exporter.enqueue(params as unknown as PaperclipTraceEvent);
      try {
        await exporter.flush();
      } catch (error) {
        ctx.logger.warn(`Langfuse export failed; queued=${exporter.size()}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { queued: exporter.size() };
    });
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
