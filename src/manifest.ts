import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "langfuse-trace-export";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Langfuse Trace Export",
  description: "Exports Paperclip trace events to Langfuse without blocking core work.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      publicKey: {
        type: "string",
        title: "Langfuse public key",
        description: "Defaults to LANGFUSE_PUBLIC_KEY.",
        default: "",
      },
      secretKey: {
        type: "string",
        title: "Langfuse secret key",
        description: "Defaults to LANGFUSE_SECRET_KEY.",
        default: "",
      },
      baseUrl: {
        type: "string",
        title: "Langfuse base URL",
        description: "Defaults to LANGFUSE_BASE_URL or https://cloud.langfuse.com.",
        default: "",
      },
    },
  },
};

export default manifest;
