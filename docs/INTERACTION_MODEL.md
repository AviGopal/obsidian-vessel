# Obsidian Vessel — Human ↔ Substrate Interaction Model

> How a human interacts with the substrate through Obsidian, and the functionality
> obsidian-vessel provides to enable it. Status as of 2026-06-15: the full
> observe → learn → respond → develop loop is live and verified.

## 1. The model: a co-inhabited workspace

Not "a human uses a tool." Two **vessels** share one surface:

- the **human** is a vessel (human-tier, the operator-vessel),
- the **substrate** is a vessel,
- **Obsidian is the medium they co-inhabit.**

Each models the other with **expectations**. The substrate maintains a forward
model of the human — `P(next-action | workspace-state)` (live; e.g.
`active-leaf-change → active-leaf-change @ 0.64`, `layout-change → active-leaf @ 0.80`).
The human implicitly relies on the substrate's outputs being relevant. Their notes
coexist in one vault, separated by **provenance**: the operator's own notes vs. the
substrate-owned `Substrate/` namespace.

The interaction is the loop, not a request/response: the human works → the substrate
observes and learns → the substrate surfaces value → the human reacts → the substrate
refines. The transient state is the steady state.

## 2. The four interaction channels

| # | Channel | Mode | Who initiates | What happens |
|---|---|---|---|---|
| 1 | **Goal dispatch** | explicit, synchronous | human | Human types a NL goal in the goal-dispatch panel → goal-host executes → task/impulse events stream back live. The "ask the substrate to do something" surface. |
| 2 | **Observation** | implicit, continuous | human (passively) | Human just *works*; `event_observed` captures it (flood-free); the substrate learns the operator's behaviour with zero effort from the human. The most novel channel. |
| 3 | **Proactive delivery** | asynchronous | substrate | Substrate writes value into `Substrate/` on its own schedule; the human reads it whenever. Reflection (`Substrate/Workflow.md`) and assists (`Substrate/Assists/`). |
| 4 | **Capability-gated control** | governance | human | Human sets how far the substrate may reach (`granted_classes`, the `Substrate/`-only write boundary). The trust dial. |

## 3. Functionality / surface inventory (the concrete "what it entails")

Every shape obsidian-vessel exposes, mapped to the interaction it enables.

### Perceive — the substrate sees the vault + live context (reads only)
| Shape | Enables | Status |
|---|---|---|
| `obsidian:workspace_state` | active note, open notes, panel state | live |
| `obsidian:note` | read a note's content | live |
| `obsidian:search` | full-text vault search | live |
| `obsidian:backlinks` | backreferences of a note | live |
| `obsidian:graph_query` | graph-neighbourhood queries | live |
| `obsidian:frontmatter` | note metadata | live |
| `obsidian:canvas`, `obsidian:daily_note` | canvas structure / daily note | live |
| `obsidian:command_catalog` | the controllable action space (every command + permission/reversibility class) | live (204 learned) |

### Observe — the substrate learns the human (channel 2)
| Shape | Enables | Status |
|---|---|---|
| `obsidian:event_observed` | the operator's UI actions (open/edit/navigate), payload-hashed; substrate-write provenance skipped at source | live |
| `obsidian:interaction_episode` | windowed action sequences | live |
| `obsidian:action_effect_model` | `P(post-state \| command)` reversibility learning (probe-gated) | capable |

### Respond — the substrate surfaces value back (channel 3)
| Shape | Enables | Status |
|---|---|---|
| `obsidian:write_note` | write a note — **hard-restricted to `Substrate/`** (refuses any other path; never the operator's notes) | live |
| `obsidian:concept_writeback` | materialise concepts/links into the vault | capable |
| `obsidian:open_note` | bring a note to the operator's attention (UI) | capable |

### Act — the substrate drives the app (channel 4, gated)
| Shape | Enables | Status |
|---|---|---|
| `obsidian:execute_command` | run an Obsidian command, gated by `classifyPermission` + `granted_classes` (default read/navigate) | capable, gated (not yet autonomously driven) |

### Direct — the human directs the substrate (channel 1)
| Surface | Enables | Status |
|---|---|---|
| goal-dispatch panel + `/actions/dispatch-goal` | human submits goals; live execution event stream | live |

## 4. The governance boundary

The unifying principle: **non-intrusive by default, trust earned incrementally.**

- **Perceive broadly, act narrowly.** Reads everything; writes only to `Substrate/`;
  never touches the operator's own notes; executes commands only with explicit
  capability.
- **Learn the human from natural behaviour**, not configuration.
- **The human governs intrusion** via `granted_classes` (read/navigate/mutate/destructive)
  and the `Substrate/` boundary. The substrate's footprint is one clearly-marked,
  wholesale-deletable folder.
- **Escalate only as proven useful and granted more.** (Command-driving the UI is the
  next intrusive tier — opt-in.)

## 5. The development dimension — functionality grows

The functionality is **not a fixed feature list.** The substrate *develops new
obsidian functionality autonomously*, on the side-loop (isolated from core; never
wedges the substrate if Obsidian is closed):

```
observe (behaviour model + command surface)
  → reflect (Substrate/Workflow.md: "what I've learned about your workflow")
  → detect an assist opportunity
  → AUTHOR an assist activity (draft-activity-from-pattern composing a deliver primitive)
  → DELIVER a context-aware, non-intrusive suggestion to Substrate/Assists/
  → observe the human's reaction → Thompson grades it → keep useful, prune useless
```

This loop is **live and verified end-to-end** (2026-06-15): the substrate authored
`proposed_pattern_authored_obsidian_assist_active_note` composing `obsidian_deliver_assist`,
and executing it delivered a real suggestion into the vault. So "what functionality it
entails" is open-ended: the substrate keeps authoring new ways to assist as it learns
the operator.

## What the human actually gets

- **dispatch** goals and watch them execute (active);
- **be understood** without doing anything special (passive observation → behaviour model);
- **receive assistance** — reflections + context-aware suggestions in a namespace they
  fully control (proactive);
- **knowledge enrichment** — concepts, links, summaries materialised into the vault;
- **govern** how much the substrate may touch their environment (capability gate);
- and the set of assists **grows** as the substrate develops new functionality for them.
