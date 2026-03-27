/**
 * Autonomous Consolidation – Phase 3: "Sleep Cycle".
 *
 * Runs at the end of each successful conversation (agent_end hook) when the
 * user is effectively idle. Extracts key insights from the conversation,
 * writes new Zettelkasten notes, and links them to existing ones.
 *
 * Design constraints:
 *   - Uses optimistic locking (rename-swap) to avoid lock contention.
 *   - Skips consolidation if another run is already in progress (idempotent).
 *   - Never reads notes that are already being written (write-then-index).
 */

import { randomUUID } from "node:crypto";
import type { EideticConfig } from "./config.js";
import type { ZettelNote } from "./zettelkasten.js";
import { ZettelkastenStore } from "./zettelkasten.js";

// ============================================================================
// Types
// ============================================================================

type RawMessage = {
  role?: string;
  content?: unknown;
};

type InsightCandidate = {
  title: string;
  tags: string[];
  body: string;
  linkedTitles: string[];
};

// ============================================================================
// Message extraction
// ============================================================================

/** Extract plain text from a single message object (OpenClaw unknown[] format). */
function extractText(msg: unknown): string {
  if (!msg || typeof msg !== "object") {
    return "";
  }
  const m = msg as RawMessage;
  if (typeof m.content === "string") {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    return m.content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** Extract all user/assistant text pairs from the conversation. */
function extractConversation(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as RawMessage;
    if (m.role === "user" || m.role === "assistant") {
      const text = extractText(msg);
      if (text.trim()) {
        parts.push(`[${m.role?.toUpperCase()}]: ${text.trim()}`);
      }
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// Insight extraction heuristics
// ============================================================================

const MIN_BODY_LENGTH = 40;
const MAX_NOTES_PER_RUN = 5;

/**
 * Simple heuristic: split conversation at assistant turns, treat each
 * substantial assistant answer as a candidate insight to record.
 *
 * In production the Hippocampus (Tiny LLM) should perform this step;
 * here we use a lightweight rule-based fallback that works without Ollama.
 */
export function extractInsights(
  messages: unknown[],
  existingNotes: ZettelNote[],
): InsightCandidate[] {
  const candidates: InsightCandidate[] = [];
  const existingTitles = existingNotes.map((n) => n.frontmatter.title.toLowerCase());

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as RawMessage;
    if (m.role !== "assistant") {
      continue;
    }
    const text = extractText(msg).trim();
    if (text.length < MIN_BODY_LENGTH) {
      continue;
    }

    // Derive a short title from the first non-trivial sentence
    const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? "";
    const title = firstSentence.slice(0, 80) || `Insight ${randomUUID().slice(0, 8)}`;

    // Skip if a very similar note already exists
    if (existingTitles.some((t) => t === title.toLowerCase())) {
      continue;
    }

    // Derive tags from capitalised words (naive NER)
    const tags = Array.from(
      new Set(
        text
          .match(/\b[A-Z][a-z]{2,}\b/g)
          ?.slice(0, 5)
          .map((w) => w.toLowerCase()) ?? [],
      ),
    );

    // Find linked existing notes (notes whose title appears in the text)
    const linkedTitles = existingNotes
      .filter((n) => text.toLowerCase().includes(n.frontmatter.title.toLowerCase()))
      .map((n) => n.frontmatter.title);

    candidates.push({ title, tags, body: text, linkedTitles });
    if (candidates.length >= MAX_NOTES_PER_RUN) {
      break;
    }
  }
  return candidates;
}

// ============================================================================
// Consolidator
// ============================================================================

export class Consolidator {
  private readonly store: ZettelkastenStore;
  private running = false;

  constructor(storeFactory: () => ZettelkastenStore) {
    this.store = storeFactory();
  }

  /**
   * Run the consolidation cycle.
   * Thread-safety: returns immediately if another consolidation is in progress.
   */
  async consolidate(messages: unknown[], logger?: { info: (msg: string) => void }): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.store.load();
      const existing = await this.store.allNotes();
      const insights = extractInsights(messages, existing);

      if (insights.length === 0) {
        return;
      }

      let written = 0;
      for (const ins of insights) {
        // Resolve linked note IDs
        const links: string[] = [];
        for (const title of ins.linkedTitles) {
          const found = await this.store.resolve(title);
          if (found) {
            links.push(found.frontmatter.id);
          }
        }

        await this.store.upsert({
          title: ins.title,
          tags: ins.tags,
          links,
          body: ins.body,
        });
        written++;
      }

      if (written > 0) {
        logger?.info(`eidetic: consolidation wrote ${written} new notes`);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Linker pass: scan all existing notes for shared tags and add mutual links.
   * This strengthens the knowledge graph by surfacing implicit connections.
   */
  async linkBySharedTags(): Promise<number> {
    await this.store.load();
    const notes = await this.store.allNotes();
    let linked = 0;

    for (const note of notes) {
      if (note.frontmatter.tags.length === 0) {
        continue;
      }
      const siblings = notes.filter(
        (n) =>
          n.frontmatter.id !== note.frontmatter.id &&
          n.frontmatter.tags.some((t) => note.frontmatter.tags.includes(t)),
      );
      const newLinks = siblings
        .map((s) => s.frontmatter.id)
        .filter((id) => !note.frontmatter.links.includes(id));

      if (newLinks.length > 0) {
        await this.store.upsert({
          id: note.frontmatter.id,
          title: note.frontmatter.title,
          tags: note.frontmatter.tags,
          links: [...note.frontmatter.links, ...newLinks],
          body: note.body,
        });
        linked += newLinks.length;
      }
    }
    return linked;
  }
}

// ============================================================================
// Conversation summariser (used by consolidation)
// ============================================================================

export { extractConversation };
