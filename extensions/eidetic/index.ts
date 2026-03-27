/**
 * Eidetic – Hierarchical Agentic Memory System
 *
 * Three-tier memory architecture:
 *   Tier 1 (Long-Term)   – Zettelkasten: local .md files with YAML frontmatter + wikilinks
 *   Tier 2 (Hippocampus) – Small Language Model via Ollama: graph traversal + context synthesis
 *   Tier 3 (Neocortex)   – Frontier model (Claude / GPT-4o): final reasoning on synthesised context
 *
 * References: A-Mem: Agentic Memory for LLM Agents
 */

import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import type { EideticConfig } from "./src/config.js";
import { buildEideticConfigSchema } from "./src/config.js";
import { Consolidator } from "./src/consolidation.js";
import { Hippocampus } from "./src/hippocampus.js";
import { createEideticTools } from "./src/tools.js";
import { ZettelkastenStore } from "./src/zettelkasten.js";

export default definePluginEntry({
  id: "eidetic",
  name: "Eidetic Memory",
  description:
    "Hierarchical agentic memory: Zettelkasten (Tier 1) + local Hippocampus LLM (Tier 2) + frontier model (Tier 3)",
  kind: "memory",
  configSchema: buildEideticConfigSchema,

  register(api: OpenClawPluginApi) {
    const rawCfg = (api.pluginConfig ?? {}) as EideticConfig;

    const zettelDir = api.resolvePath(rawCfg.zettelkastenDir ?? "~/.openclaw/zettelkasten");

    /** Lazily create a ZettelkastenStore so the dir is only created when first used. */
    const storeFactory = (): ZettelkastenStore => new ZettelkastenStore(zettelDir);

    const cfg = rawCfg;
    const hippo = new Hippocampus(cfg);
    const consolidator = new Consolidator(storeFactory);

    const maxGraphDepth = cfg.maxGraphDepth ?? 3;
    const autoRecall = cfg.autoRecall !== false; // default true
    const autoConsolidate = cfg.autoConsolidate !== false; // default true

    // =========================================================================
    // Phase 2: Zettelkasten tools (for both the Hippocampus and the main agent)
    // =========================================================================
    const tools = createEideticTools({ storeFactory, config: cfg, maxGraphDepth });
    for (const tool of tools) {
      api.registerTool(() => tool, { names: [tool.name] });
    }

    // =========================================================================
    // Phase 1: Two-pass inference – inject Hippocampus briefing before the
    //          frontier model sees the prompt.
    // =========================================================================
    if (autoRecall) {
      api.on("before_prompt_build", async (event) => {
        const briefingCtx = await hippo.buildContextBlock(event.prompt);
        if (!briefingCtx) {
          return undefined;
        }
        return { prependContext: briefingCtx };
      });
    }

    // =========================================================================
    // Phase 3: Autonomous consolidation after each successful conversation.
    // =========================================================================
    if (autoConsolidate) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }
        try {
          await consolidator.consolidate(event.messages, api.logger);
          // Linker pass: surface implicit connections between notes
          await consolidator.linkBySharedTags();
        } catch (err) {
          api.logger.warn(`eidetic: consolidation error: ${String(err)}`);
        }
      });
    }

    // =========================================================================
    // Service lifecycle logging
    // =========================================================================
    api.registerService({
      id: "eidetic",
      start: async () => {
        await storeFactory().ensureDir();
        api.logger.info(
          `eidetic: initialised (dir: ${zettelDir}, model: ${cfg.hippoModel ?? "llama3:8b"}, autoRecall: ${autoRecall}, autoConsolidate: ${autoConsolidate})`,
        );
      },
      stop: () => {
        api.logger.info("eidetic: stopped");
      },
    });
  },
});
