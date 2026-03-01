import { describe, expect, it } from 'vitest';
import { buildSshExecCommand } from '../../src/infra/ssh.js';

describe('buildSshExecCommand', () => {
  it('builds ssh wrapper command with target only', () => {
    const command = buildSshExecCommand('user@host', 'tmux list-sessions');
    expect(command).toContain("'ssh'");
    expect(command).toContain("'user@host'");
    expect(command).toContain("'tmux list-sessions'");
  });

  it('includes port and identity options when provided', () => {
    const command = buildSshExecCommand('user@host', 'tmux ls', {
      port: 2222,
      identity: '/tmp/id_ed25519',
    });
    expect(command).toContain("'-p'");
    expect(command).toContain("'2222'");
    expect(command).toContain("'-i'");
    expect(command).toContain("'/tmp/id_ed25519'");
  });
});
