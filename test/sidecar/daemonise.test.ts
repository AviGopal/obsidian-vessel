/**
 * The sidecar must not be a child of Obsidian's renderer.
 *
 * The sidecar deliberately outlives a plugin/window reload so the conduit
 * survives it. But a reload destroys the JS context and with it the
 * ChildProcess handle — the only thing able to waitpid() that child. The old
 * code then SIGKILLed the recorded pid and called it a "reap". Killing a
 * process you parented but cannot wait on leaves it <defunct> forever, and
 * Obsidian's renderer lives for days, so one zombie accumulated per reload.
 * Seventeen were observed in the wild, all with the renderer as parent.
 *
 * These tests exercise the actual shell invocation the manager uses, because
 * the property that matters — "the spawned process is reparented away from us"
 * — is a property of the OS, not of our TypeScript.
 */

import { describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';

/** Run the manager's daemonising command and return the reported pid. */
function daemonise(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // Verbatim the form used in SidecarManager.spawnChild.
    const child = spawn('sh', ['-c', '"$0" "$1" >>"$2" 2>&1 & echo $!', cmd, args[0], '/dev/null'], { stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('exit', () => {
      const pid = parseInt(out.trim(), 10);
      Number.isFinite(pid) && pid > 1 ? resolve(pid) : reject(new Error(`no pid from launcher: ${JSON.stringify(out)}`));
    });
    child.on('error', reject);
  });
}

const ppidOf = async (pid: number): Promise<number> => {
  const { readFileSync } = await import('fs');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // field 4 is ppid; comm (field 2) may contain spaces, so slice past ')'
  return parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('sidecar daemonisation', () => {
  test('the launcher hands back the real pid of the backgrounded process', async () => {
    const pid = await daemonise('sleep', ['5']);
    expect(pid).toBeGreaterThan(1);
    expect(alive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
  });

  test('the spawned process is NOT our child — this is the whole fix', async () => {
    const pid = await daemonise('sleep', ['5']);
    // Reparented to init (pid 1) or to a subreaper — either way, not us.
    const ppid = await ppidOf(pid);
    expect(ppid).not.toBe(process.pid);
    process.kill(pid, 'SIGKILL');
  });

  test('killing it leaves no zombie behind, because we are not its parent', async () => {
    const pid = await daemonise('sleep', ['30']);
    process.kill(pid, 'SIGKILL');
    // Give the real parent a moment to reap.
    await new Promise((r) => setTimeout(r, 400));
    let state = '';
    try {
      const { readFileSync } = await import('fs');
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch { state = 'gone'; }
    // 'Z' would mean the defunct entry survived — exactly the reported bug.
    expect(state).not.toBe('Z');
  });

  test('signal 0 is a correct liveness probe for a process we do not own', async () => {
    const pid = await daemonise('sleep', ['5']);
    expect(alive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(pid)).toBe(false);
  });
});
