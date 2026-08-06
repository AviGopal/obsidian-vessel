/**
 * Tests for federation member identity and dispatch labelling.
 *
 * Both exist because the panel was showing the same thing several times over
 * and calling it several things: one substrate reached by three routes counted
 * as three peers, and every dispatch without goal text rendered as an
 * indistinguishable "(no goal)" row. Neither is a cosmetic problem — the first
 * makes the peer count wrong in a way that changes with the network the panel
 * happens to be on, and the second makes a completed run impossible to find.
 */

import { describe, expect, test } from 'bun:test';
import { dedupeMembers, dispatchLabel, peersCaption, distinctVessels, vesselsCaption } from '../../src/views/panel-narrative';

describe('dedupeMembers', () => {
  test('collapses one substrate seen by three routes into one member', () => {
    // Exercises the overlap rule itself: three names, proven to be one box by
    // a shared dispatch id. (In the live fleet the spoke and the hub do NOT
    // share ids — they are genuinely two substrates — which is why identity
    // must be decided by evidence and not by how the names happen to look.)
    const merged = dedupeMembers([
      { substrate: 'local', dispatches: [{ dispatchId: 'a' }, { dispatchId: 'b' }] },
      { substrate: 'spoke-6e240fe0', dispatches: [{ dispatchId: 'b' }, { dispatchId: 'c' }] },
      { substrate: 'localhost:8100', role: 'resolver-hub', vesselCount: 33, dispatches: [{ dispatchId: 'c' }] },
    ]);
    expect(merged).toHaveLength(1);
    // Prefers the name a human can place over the relay id or the address.
    expect(merged[0].substrate).toBe('local');
    // Every distinct dispatch survives the merge, none duplicated.
    expect((merged[0].dispatches as unknown[]).length).toBe(3);
    // Facts carried on any route are kept.
    expect(merged[0].role).toBe('resolver-hub');
    expect(merged[0].vesselCount).toBe(33);
    expect(merged[0].aliases).toContain('localhost:8100');
  });

  test('keeps genuinely distinct substrates apart', () => {
    const merged = dedupeMembers([
      { substrate: 'local', dispatches: [{ dispatchId: 'a' }] },
      { substrate: 'syzygy-hub', dispatches: [{ dispatchId: 'z' }] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test('does not merge idle members that merely share an empty dispatch list', () => {
    // Two silent peers have no evidence of being the same box, so they must
    // stay separate — an empty set must never count as an overlap.
    const merged = dedupeMembers([
      { substrate: 'peer-a', dispatches: [] },
      { substrate: 'peer-b', dispatches: [] },
    ]);
    expect(merged).toHaveLength(2);
  });

  test('the peers caption never presents a bare address as a peer name', () => {
    const canonical = dedupeMembers([
      { substrate: 'local', dispatches: [{ dispatchId: 'a' }] },
      { substrate: 'syzygy-hub', role: 'resolver-hub', vesselCount: 33, dispatches: [{ dispatchId: 'z' }] },
      { substrate: 'localhost:8100', role: 'resolver-hub', dispatches: [{ dispatchId: 'z' }] },
    ]);
    const caption = peersCaption(canonical as never);
    expect(caption).toContain('syzygy-hub');
    expect(caption).not.toContain('localhost:8100');
    // The vessels tile owns "how many vessels"; the peers caption must not put
    // a second, differently-derived answer next to it.
    expect(caption).not.toContain('33 vessels');
  });
});

describe('dispatchLabel', () => {
  test('uses the goal text when there is one', () => {
    expect(dispatchLabel({ goal: 'Edit repos/activity-api/src/routes/impulses.ts' }))
      .toBe('Edit repos/activity-api/src/routes/impulses.ts');
  });

  test('identifies a goal-less dispatch by what is known, and names the omission', () => {
    const label = dispatchLabel({ selectedTemplateId: 'ribosome-extract', trigger: 'boredom' });
    expect(label).toContain('ribosome-extract');
    expect(label).toContain('boredom');
    expect(label).toContain('no goal text');
  });

  test('falls back to the execution id rather than an anonymous row', () => {
    expect(dispatchLabel({ executionId: 'exec_ktorgufj' })).toContain('exec_ktorgufj');
  });
});

describe('dedupeMembers — address-only routing entries', () => {
  test('folds a hub known by address with no work of its own into the named hub', () => {
    // The real observed shape: the hub reported twice, once by name (with its
    // dispatches) and once by address (role only, no dispatches).
    const merged = dedupeMembers([
      { substrate: 'local', dispatches: [{ dispatchId: 'a' }] },
      { substrate: 'syzygy-hub', role: 'resolver-hub', dispatches: [{ dispatchId: 'z' }] },
      { substrate: 'syzygy.host:18100', role: 'resolver-hub', vesselCount: 33, dispatches: [] },
    ]);
    expect(merged).toHaveLength(2);
    const hub = merged.find((m) => m.substrate === 'syzygy-hub')!;
    expect(hub).toBeDefined();
    expect(hub.vesselCount).toBe(33);
    expect(hub.aliases).toContain('syzygy.host:18100');
    expect(merged.map((m) => m.substrate)).not.toContain('syzygy.host:18100');
  });

  test('an address-only peer with nowhere to fold is kept, but never named by its address', () => {
    const merged = dedupeMembers([
      { substrate: 'local', dispatches: [{ dispatchId: 'a' }] },
      { substrate: '10.0.0.4:18100', dispatches: [] },
    ]);
    // It is still a peer we can see, so it must not vanish...
    expect(merged).toHaveLength(2);
    // ...but the caption describes it as an address, not as an identity.
    const caption = peersCaption(merged as never);
    expect(caption).toContain('an unnamed substrate at 10.0.0.4:18100');
  });
});

describe('distinctVessels', () => {
  test('a bare advertisement is a duplicate route, not an extra vessel', () => {
    // The observed registry shape: one process listed bare (resolved directly
    // from here), again under this substrate's relay id, and again via the hub.
    // That is TWO goal-hosts — this one and the hub's — not three.
    const dv = distinctVessels([
      'goal-host-vessel',
      'goal-host-vessel@spoke-6e240fe0',
      'goal-host-vessel@syzygy-hub',
      'concept-db-local',
      'concept-db-local@syzygy-hub',
    ]);
    expect(dv.total).toBe(3);
    expect(dv.byHome.find((h) => h.home === 'spoke-6e240fe0')!.count).toBe(1);
    expect(dv.byHome.find((h) => h.home === 'syzygy-hub')!.count).toBe(2);
  });

  test('a vessel known only from here still counts once', () => {
    const dv = distinctVessels(['local-tools-vessel', 'goal-host-vessel@syzygy-hub'], 'here');
    expect(dv.total).toBe(2);
    expect(dv.byHome.find((h) => h.home === 'here')!.count).toBe(1);
  });

  test('the caption names where the vessels are, so the number reads the same from any route', () => {
    const caption = vesselsCaption(4, [{ home: 'here', count: 2 }, { home: 'syzygy-hub', count: 2 }]);
    expect(caption).toContain('2 here');
    expect(caption).toContain('2 on syzygy-hub');
  });
});
