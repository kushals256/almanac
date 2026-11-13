import { z } from "zod";

/**
 * Required: the primary LLM (Groq) and primary search (Exa). Optional: each fallback — without it the agent runs
 * and degrades in a defined way instead of refusing to boot (see degradedFeatures()).
 */
const REQUIRED_KEYS = {
  GROQ_API_KEY: "https://console.groq.com/keys",
  EXA_API_KEY: "https://dashboard.exa.ai",
} as const;
const OPTIONAL_KEYS = {
  NVIDIA_API_KEY: "fallback LLMs + meaning-based recall (embeddings)",
  TAVILY_API_KEY: "backup search provider",
  OPENROUTER_API_KEY: "Jev decision model (judge layer; the LLM judges instead)",
} as const;
const optionalKey = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().min(10).optional());

const EnvSchema = z.object({
  GROQ_API_KEY: z.string().min(10),
  NVIDIA_API_KEY: optionalKey,
  EXA_API_KEY: z.string().min(10),
  TAVILY_API_KEY: optionalKey,
  OPENROUTER_API_KEY: optionalKey,
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  DB_PATH: z.string().default("data/agent.db"),
  /** Test-only clock override (ISO date-time). Not a user feature. */
  AGENT_NOW: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = Object.keys(REQUIRED_KEYS).filter((k) => !env[k] || env[k]!.trim() === "");
  if (missing.length) {
    const lines = missing.map((k) => `  - ${k}  (get one at ${REQUIRED_KEYS[k as keyof typeof REQUIRED_KEYS]})`);
    throw new Error(`Missing required API keys in .env:\n${lines.join("\n")}\nCopy .env.example to .env and fill them in.`);
  }
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.message}`);
  return parsed.data;
}

/** What runs degraded because an optional key is missing (logged at boot, shown on /health). */
export function degradedFeatures(cfg: Config): string[] {
  return (Object.keys(OPTIONAL_KEYS) as Array<keyof typeof OPTIONAL_KEYS>).filter((k) => !cfg[k]).map((k) => `no ${k}: ${OPTIONAL_KEYS[k]} unavailable`);
}

export type Provider = "groq" | "nvidia";
export type ModelRef = { provider: Provider; model: string; /** Typical time to first token, measured in the bake-off. */ ttftMs: number };
export type Job = "planner" | "answer_quick" | "answer_deep" | "extractor" | "verifier_llm";

/** Ordered fallback chains from the 2026-11-12 bake-off (SPEC §2). */
export const MODEL_CHAINS: Record<Job, ModelRef[]> = {
  planner: [
    { provider: "groq", model: "qwen/qwen3.8-27b", ttftMs: 150 },
    { provider: "groq", model: "openai/gpt-oss-20b", ttftMs: 600 },
    // A strong second-family planner before the small NVIDIA one: the planner reads meaning (past refs,
    // premises), and the small model returns thin readings (no premises, missed follow-ups).
    { provider: "groq", model: "openai/gpt-oss-120b", ttftMs: 450 },
    { provider: "nvidia", model: "nvidia/nemotron-3.5-bolt-e4b", ttftMs: 300 },
  ],
  // Each Groq model has its own 8k TPM budget, so jobs start on different models to spread load.
  answer_quick: [
    { provider: "groq", model: "qwen/qwen3.8-27b", ttftMs: 150 },
    { provider: "groq", model: "openai/gpt-oss-20b", ttftMs: 600 },
    { provider: "groq", model: "openai/gpt-oss-120b", ttftMs: 450 },
    { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", ttftMs: 4_000 },
  ],
  answer_deep: [
    { provider: "groq", model: "openai/gpt-oss-120b", ttftMs: 450 },
    { provider: "groq", model: "openai/gpt-oss-20b", ttftMs: 600 },
    { provider: "groq", model: "qwen/qwen3.8-27b", ttftMs: 150 },
    { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", ttftMs: 4_000 },
  ],
  extractor: [
    { provider: "groq", model: "openai/gpt-oss-20b", ttftMs: 600 },
    { provider: "groq", model: "qwen/qwen3.8-27b", ttftMs: 150 },
    { provider: "nvidia", model: "nvidia/nemotron-3.5-bolt-e4b", ttftMs: 300 },
  ],
  verifier_llm: [
    { provider: "groq", model: "qwen/qwen3.8-27b", ttftMs: 150 },
    { provider: "nvidia", model: "nvidia/nemotron-3.5-bolt-e4b", ttftMs: 300 },
  ],
};

export const PROVIDER_URLS: Record<Provider, string> = {
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
};

/** Per-route turn deadlines in ms (SPEC §3 step 0). */
/** Time budgets (ms): memory = the whole memory leg (gather + judge); others = retrieval for that route (recheck v2 shares its budget from turn start). */
export const DEADLINES_MS = { memory: 8_000, quick: 10_000, research: 45_000, recheck: 45_000 } as const;
