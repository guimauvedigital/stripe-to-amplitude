import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StripeEntity } from "@stripe-to-amplitude/core";

interface State {
  /** Last `created` Unix-second value successfully processed for this entity. */
  cursor: Record<string, number>;
  completedEntities: StripeEntity[];
}

/**
 * The backfill paginates Stripe in ascending `created` order and persists the
 * highest seen timestamp after each successful page. A relaunch resumes from
 * that watermark, so re-running after an interruption never replays already
 * sent events (and Amplitude would dedupe them anyway via `insert_id`).
 */
export class StateStore {
  private state: State = { cursor: {}, completedEntities: [] };
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, "state.json");
  }

  async load(): Promise<void> {
    try {
      const buf = await readFile(this.file, "utf8");
      this.state = JSON.parse(buf) as State;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  cursorFor(entity: StripeEntity): number | undefined {
    return this.state.cursor[entity];
  }

  isCompleted(entity: StripeEntity): boolean {
    return this.state.completedEntities.includes(entity);
  }

  async setCursor(entity: StripeEntity, value: number): Promise<void> {
    this.state.cursor[entity] = value;
    await this.persist();
  }

  async markCompleted(entity: StripeEntity): Promise<void> {
    if (!this.state.completedEntities.includes(entity)) {
      this.state.completedEntities.push(entity);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(this.file.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}
