export type ComponentName = "gmgn" | "security" | "telegram" | "storage";

export interface HealthSnapshot {
  readonly alive: boolean;
  readonly ready: boolean;
  readonly components: Readonly<Record<ComponentName, "unknown" | "healthy" | "degraded" | "failed">>;
  readonly reasons: readonly string[];
}

interface ComponentState {
  status: "unknown" | "healthy" | "degraded" | "failed";
  updatedAt: number;
}

export class HealthMonitor {
  private alive = true;
  private readonly states = new Map<ComponentName, ComponentState>();

  public constructor(
    private readonly telegramRequired: boolean,
    private readonly sourceStaleMs = 10_000,
  ) {}

  public markHealthy(component: ComponentName, now: number): void {
    this.states.set(component, { status: "healthy", updatedAt: now });
  }

  public markDegraded(component: ComponentName, now: number): void {
    this.states.set(component, { status: "degraded", updatedAt: now });
  }

  public markFailed(component: ComponentName, now: number): void {
    this.states.set(component, { status: "failed", updatedAt: now });
  }

  public stop(): void {
    this.alive = false;
  }

  public snapshot(now: number): HealthSnapshot {
    const names: readonly ComponentName[] = ["gmgn", "security", "telegram", "storage"];
    const components = Object.fromEntries(
      names.map((name) => [name, this.states.get(name)?.status ?? "unknown"]),
    ) as Record<ComponentName, "unknown" | "healthy" | "degraded" | "failed">;
    const reasons: string[] = [];
    const gmgn = this.states.get("gmgn");
    if (gmgn === undefined || now - gmgn.updatedAt > this.sourceStaleMs || gmgn.status !== "healthy") {
      reasons.push("gmgn_not_fresh");
    }
    if (components.storage !== "healthy") reasons.push("storage_not_healthy");
    if (this.telegramRequired && components.telegram !== "healthy") {
      reasons.push("telegram_not_healthy");
    }
    if (components.security === "failed") reasons.push("security_failed");
    return {
      alive: this.alive,
      ready: this.alive && reasons.length === 0,
      components,
      reasons,
    };
  }
}
