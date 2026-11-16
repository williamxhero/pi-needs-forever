import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "./types.js";

const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "deepseek-v4.1-flash";

function authKeyFromPi(provider: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<
      string,
      { key?: unknown }
    >;
    const key = auth?.[provider]?.key;
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the default model collection used by the CLI. Tests inject their own
 * Models with a faux provider; this helper is only for real runs.
 */
export function createDefaultModels(): Models {
  const models = createModels();
  if (!process.env.OPENCODE_API_KEY) {
    const key = authKeyFromPi(DEFAULT_PROVIDER);
    if (key) process.env.OPENCODE_API_KEY = key;
  }
  models.setProvider(opencodeGoProvider());
  return models;
}

export function resolveModelRef(spec?: string): ModelRef {
  const value = spec?.trim();
  if (!value) return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`model must be "provider/modelId", got "${value}".`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
