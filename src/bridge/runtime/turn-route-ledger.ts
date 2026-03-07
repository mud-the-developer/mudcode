interface TurnRouteLedgerEntry {
  turnId: string;
  projectName: string;
  agentType: string;
  instanceId?: string;
  channelId: string;
  order: number;
  createdAtMs: number;
  updatedAtMs: number;
}

interface TurnRouteLedgerUpsertParams {
  turnId: string;
  projectName: string;
  agentType: string;
  instanceId?: string;
  channelId: string;
}

interface TurnRouteLedgerResolveParams {
  turnId?: string;
  projectName?: string;
  agentType?: string;
  instanceId?: string;
}

export class TurnRouteLedger {
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private order = 0;
  private entryByKey = new Map<string, TurnRouteLedgerEntry>();
  private keysByTurnId = new Map<string, Set<string>>();

  constructor() {
    this.retentionMs = this.resolveRetentionMs();
    this.maxEntries = this.resolveMaxEntries();
  }

  upsert(params: TurnRouteLedgerUpsertParams): void {
    const turnId = params.turnId.trim();
    const channelId = params.channelId.trim();
    if (!turnId || !channelId) return;
    const projectName = params.projectName.trim();
    const agentType = params.agentType.trim();
    if (!projectName || !agentType) return;
    const instanceKey = (params.instanceId || agentType).trim();
    if (!instanceKey) return;

    const now = Date.now();
    this.prune(now);

    const key = this.compositeKey(projectName, instanceKey, turnId);
    const current = this.entryByKey.get(key);
    const createdAtMs = current?.createdAtMs || now;
    const entry: TurnRouteLedgerEntry = {
      turnId,
      projectName,
      agentType,
      ...(params.instanceId ? { instanceId: params.instanceId } : {}),
      channelId,
      order: current?.order || ++this.order,
      createdAtMs,
      updatedAtMs: now,
    };
    this.entryByKey.set(key, entry);
    this.rememberTurnKey(turnId, key);

    while (this.entryByKey.size > this.maxEntries) {
      const oldest = this.entryByKey.keys().next();
      if (oldest.done) return;
      this.removeByKey(oldest.value);
    }
  }

  resolve(params: TurnRouteLedgerResolveParams): TurnRouteLedgerEntry | undefined {
    const turnId = params.turnId?.trim();
    if (!turnId) return undefined;
    const now = Date.now();
    this.prune(now);

    const projectName = params.projectName?.trim();
    const instanceId = params.instanceId?.trim();
    const agentType = params.agentType?.trim();
    if (projectName && (instanceId || agentType)) {
      const key = this.compositeKey(projectName, instanceId || agentType!, turnId);
      const direct = this.entryByKey.get(key);
      if (direct) return direct;
    }

    const keys = this.keysByTurnId.get(turnId);
    if (!keys || keys.size === 0) return undefined;
    const candidates: TurnRouteLedgerEntry[] = [];
    for (const key of keys) {
      const entry = this.entryByKey.get(key);
      if (!entry) continue;
      if (projectName && entry.projectName !== projectName) continue;
      if (instanceId && entry.instanceId !== instanceId) continue;
      if (agentType && entry.agentType !== agentType) continue;
      candidates.push(entry);
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    candidates.sort((a, b) => (b.updatedAtMs !== a.updatedAtMs ? b.updatedAtMs - a.updatedAtMs : b.order - a.order));
    return candidates[0];
  }

  complete(params: TurnRouteLedgerResolveParams): void {
    const turnId = params.turnId?.trim();
    if (!turnId) return;
    const projectName = params.projectName?.trim();
    const instanceId = params.instanceId?.trim();
    const agentType = params.agentType?.trim();

    if (projectName && (instanceId || agentType)) {
      const key = this.compositeKey(projectName, instanceId || agentType!, turnId);
      this.removeByKey(key);
      return;
    }

    const keys = this.keysByTurnId.get(turnId);
    if (!keys) return;
    for (const key of Array.from(keys)) {
      this.removeByKey(key);
    }
  }

  clearProject(projectName: string): number {
    const normalizedProject = projectName.trim();
    if (!normalizedProject) return 0;

    this.prune(Date.now());

    let removed = 0;
    for (const [key, entry] of Array.from(this.entryByKey.entries())) {
      if (entry.projectName !== normalizedProject) continue;
      this.removeByKey(key);
      removed += 1;
    }
    return removed;
  }

  private compositeKey(projectName: string, instanceKey: string, turnId: string): string {
    return `${projectName}:${instanceKey}:${turnId}`;
  }

  private rememberTurnKey(turnId: string, key: string): void {
    const set = this.keysByTurnId.get(turnId) || new Set<string>();
    set.add(key);
    this.keysByTurnId.set(turnId, set);
  }

  private removeByKey(key: string): void {
    const entry = this.entryByKey.get(key);
    if (!entry) return;
    this.entryByKey.delete(key);
    const turnSet = this.keysByTurnId.get(entry.turnId);
    if (!turnSet) return;
    turnSet.delete(key);
    if (turnSet.size === 0) {
      this.keysByTurnId.delete(entry.turnId);
    }
  }

  private prune(nowMs: number): void {
    if (this.entryByKey.size === 0) return;
    for (const [key, entry] of this.entryByKey.entries()) {
      if (nowMs - entry.updatedAtMs > this.retentionMs) {
        this.removeByKey(key);
      }
    }
  }

  private resolveRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_TURN_ROUTE_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 60_000 && fromEnv <= 86_400_000) {
      return Math.trunc(fromEnv);
    }
    return 6 * 60 * 60 * 1000;
  }

  private resolveMaxEntries(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_TURN_ROUTE_MAX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 100 && fromEnv <= 200_000) {
      return Math.trunc(fromEnv);
    }
    return 20_000;
  }
}
