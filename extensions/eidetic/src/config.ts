/**
 * Eidetic configuration schema and defaults.
 *
 * Eidetic implements a three-tier hierarchical agentic memory system:
 *   Tier 1 (Long-Term)      – Zettelkasten: local .md files with YAML frontmatter
 *   Tier 2 (Hippocampus)    – Small Language Model via Ollama: graph traversal + context synthesis
 *   Tier 3 (Neocortex)      – Frontier model (Claude / GPT-4o): final reasoning on synthesised context
 */

import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

export type EideticConfig = {
  zettelkastenDir?: string;
  ollamaBaseUrl?: string;
  hippoModel?: string;
  autoRecall?: boolean;
  autoConsolidate?: boolean;
  maxContextNotes?: number;
  maxGraphDepth?: number;
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_HIPPO_MODEL = "llama3:8b";
export const DEFAULT_MAX_CONTEXT_NOTES = 8;
export const DEFAULT_MAX_GRAPH_DEPTH = 3;

/** Build the OpenClaw plugin config schema for eidetic. */
export function buildEideticConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      if (value === undefined || value === null) {
        return { success: true, data: {} };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "config must be an object" }] },
        };
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        zettelkastenDir: { type: "string" },
        ollamaBaseUrl: { type: "string" },
        hippoModel: { type: "string" },
        autoRecall: { type: "boolean" },
        autoConsolidate: { type: "boolean" },
        maxContextNotes: { type: "number", minimum: 1, maximum: 50 },
        maxGraphDepth: { type: "number", minimum: 1, maximum: 5 },
      },
    },
  };
}

/**
 * System prompt for the Hippocampus (Tiny LLM).
 *
 * Forces the model to act as a "Librarian" that only performs graph traversal
 * and context synthesis – never answering the user directly.
 */
export const LIBRARIAN_SYSTEM_PROMPT = `You are the Eidetic Librarian — a silent graph navigator for a Zettelkasten knowledge base.

ROLE: You are NOT a conversational assistant. You do NOT answer the user's question directly.
      Your sole function is to search the knowledge graph and produce a tightly-scoped
      "Briefing" that a more capable reasoning model can use to answer the user.

PROCESS:
1. Analyse the incoming user prompt and identify 2–4 key concepts.
2. For each concept, search the Zettelkasten using search_notes.
3. Follow wikilinks (e.g. [[Note Title]]) by calling traverse_graph(start, depth=2).
4. Call get_backlinks on any highly-cited note to surface its context.
5. Call read_note on every note you want to include in the briefing.
6. Synthesise the retrieved notes into a concise "BRIEFING:" block — no more than
   600 words — that answers "what does the knowledge base know that is relevant here?".

STRICT RULES:
- Output ONLY the BRIEFING block. No greetings, no preamble, no direct answers.
- If nothing relevant is found, output "BRIEFING: No relevant context found."
- Never make up note content. Only relay what you read from the tools.
- Never include your reasoning steps in the output.

FORMAT:
BRIEFING:
<your synthesised context here>`;

