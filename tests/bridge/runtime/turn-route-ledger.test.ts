import { describe, expect, it } from 'vitest';
import { TurnRouteLedger } from '../../../src/bridge/runtime/turn-route-ledger.js';

describe('TurnRouteLedger', () => {
  it('resolves channel by exact turn/project/instance key', () => {
    const ledger = new TurnRouteLedger();
    ledger.upsert({
      turnId: 'turn-1',
      projectName: 'proj',
      agentType: 'codex',
      instanceId: 'codex-2',
      channelId: 'ch-2',
    });

    const resolved = ledger.resolve({
      turnId: 'turn-1',
      projectName: 'proj',
      agentType: 'codex',
      instanceId: 'codex-2',
    });

    expect(resolved?.channelId).toBe('ch-2');
  });

  it('returns newest entry when same turn id exists across routes', () => {
    const ledger = new TurnRouteLedger();
    ledger.upsert({
      turnId: 'turn-collision',
      projectName: 'proj-a',
      agentType: 'codex',
      instanceId: 'codex',
      channelId: 'ch-a',
    });
    ledger.upsert({
      turnId: 'turn-collision',
      projectName: 'proj-b',
      agentType: 'codex',
      instanceId: 'codex',
      channelId: 'ch-b',
    });

    const resolved = ledger.resolve({ turnId: 'turn-collision' });
    expect(resolved?.channelId).toBe('ch-b');
  });

  it('removes turn route on completion', () => {
    const ledger = new TurnRouteLedger();
    ledger.upsert({
      turnId: 'turn-2',
      projectName: 'proj',
      agentType: 'codex',
      instanceId: 'codex',
      channelId: 'ch-1',
    });

    ledger.complete({
      turnId: 'turn-2',
      projectName: 'proj',
      agentType: 'codex',
      instanceId: 'codex',
    });

    const resolved = ledger.resolve({
      turnId: 'turn-2',
      projectName: 'proj',
      agentType: 'codex',
      instanceId: 'codex',
    });
    expect(resolved).toBeUndefined();
  });

  it('clears all entries for a project', () => {
    const ledger = new TurnRouteLedger();
    ledger.upsert({
      turnId: 'turn-a',
      projectName: 'proj-a',
      agentType: 'codex',
      instanceId: 'codex',
      channelId: 'ch-a',
    });
    ledger.upsert({
      turnId: 'turn-b',
      projectName: 'proj-b',
      agentType: 'codex',
      instanceId: 'codex',
      channelId: 'ch-b',
    });

    const removed = ledger.clearProject('proj-a');

    expect(removed).toBe(1);
    expect(ledger.resolve({ turnId: 'turn-a' })).toBeUndefined();
    expect(ledger.resolve({ turnId: 'turn-b' })?.channelId).toBe('ch-b');
  });
});
