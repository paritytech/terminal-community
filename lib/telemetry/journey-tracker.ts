/**
 * User-journey tracking, written to the local log.
 *
 * A "journey" is a multi-step user-perceived flow (e.g. terminal-payment:
 * QR generated → payment detected → sale saved → receipt rendered → done).
 * Each milestone is logged as it happens, and the journey's end is logged
 * with its total duration, milestones and attributes.
 *
 * The exported `journeyTracker` is a module-level singleton so any component
 * or hook can record milestones without prop-drilling the instance.
 */

"use client";

// --- App-specific journey catalog ---

export type AppJourneyType =
  | "page-load"
  | "items-checkout"
  | "terminal-payment"
  | "daily-report-save"
  | "daily-report-finalize"
  | "report-decrypt"
  | "bulletin-index-read"
  | "encryption-key-set"
  | "authenticate";

// --- Generic tracker — only edit the catalog above. ---

interface ActiveJourney<T> {
  type: T;
  startedAt: number;
  milestones: Map<string, number>;
  attributes: Record<string, string | number | boolean>;
  sad: boolean;
}

export class JourneyTracker<T extends string> {
  private active = new Map<T, ActiveJourney<T>>();

  start(
    type: T,
    attributes: Record<string, string | number | boolean> = {},
    startedAt?: number,
  ): void {
    this.active.set(type, {
      type,
      startedAt: startedAt ?? performance.now(),
      milestones: new Map(),
      attributes,
      sad: false,
    });
    console.info(`[Journey:${type}] started`);
  }

  reclassify(from: T, to: T): void {
    const journey = this.active.get(from);
    if (!journey || from === to) return;
    this.active.delete(from);
    journey.type = to;
    this.active.set(to, journey);
    console.info(`[Journey] reclassified ${from} -> ${to}`);
  }

  milestone(type: T, name: string): void {
    const journey = this.active.get(type);
    if (!journey) return;
    if (journey.milestones.has(name)) return;
    const elapsed = performance.now() - journey.startedAt;
    journey.milestones.set(name, elapsed);
    console.info(`[Journey:${type}] ${name} +${elapsed.toFixed(0)}ms`);
  }

  /** Mark an in-flight journey as "sad" (completed but with friction). */
  markSad(type: T): void {
    const journey = this.active.get(type);
    if (journey) journey.sad = true;
  }

  addAttributes(
    type: T,
    attrs: Record<string, string | number | boolean>,
  ): void {
    const journey = this.active.get(type);
    if (!journey) return;
    Object.assign(journey.attributes, attrs);
  }

  complete(type: T): void {
    const journey = this.active.get(type);
    if (!journey) return;
    this.active.delete(type);

    const totalMs = performance.now() - journey.startedAt;
    console.info(`[Journey:${type}] completed in ${totalMs.toFixed(0)}ms`, this._summary(journey));
  }

  fail(type: T, reason?: string): void {
    const journey = this.active.get(type);
    if (!journey) return;
    this.active.delete(type);

    journey.sad = true;
    const totalMs = performance.now() - journey.startedAt;
    console.info(
      `[Journey:${type}] failed after ${totalMs.toFixed(0)}ms: ${reason ?? "unknown"}`,
      this._summary(journey),
    );
  }

  abandon(type: T): void {
    if (this.active.has(type)) {
      console.info(`[Journey:${type}] abandoned`);
      this.active.delete(type);
    }
  }

  isActive(type: T): boolean {
    return this.active.has(type);
  }

  private _summary(journey: ActiveJourney<T>): Record<string, string | number | boolean> {
    const summary: Record<string, string | number | boolean> = { sad: journey.sad, ...journey.attributes };
    for (const [name, elapsed] of journey.milestones) summary[`${name}_ms`] = Math.round(elapsed);
    return summary;
  }
}

export const journeyTracker = new JourneyTracker<AppJourneyType>();
