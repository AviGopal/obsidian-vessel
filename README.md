# obsidian-vessel

Obsidian plugin that registers as a vessel in the substrate.
Exposes vault content (notes, search, canvas, backlinks, frontmatter,
daily notes, graph queries) as impulse resolvers on a local HTTP server
and registers with discovery-vessel so other vessels can route shape
queries here.

## Installation (manual)

The plugin ships three files — `manifest.json`, `main.js`, `styles.css` — that go in
a folder whose name **must equal the plugin id** (`obsidian-vessel`):

```
<YourVault>/.obsidian/plugins/obsidian-vessel/{manifest.json, main.js, styles.css}
```

1. Settings → Community plugins → **Turn on community plugins** (disables Restricted Mode).
2. Copy the three files into `<YourVault>/.obsidian/plugins/obsidian-vessel/`.
3. Enable **Obsidian Vessel** in the community-plugins list (loads live, no restart).

Build from source with `bun install && bun run build` (produces `main.js`).

## Configuration

Set these in the plugin's settings tab (persisted to the plugin's `data.json`). For a
local substrate:

| Setting | Local-substrate value |
|---|---|
| Activity API URL | `http://localhost:18080` |
| Discovery endpoint | `http://localhost:18100` |
| Goal-host endpoint | `http://localhost:18210` |
| Concept-DB endpoint | `http://localhost:18260` |
| API key | from `make -C scripts/substrate seed-live` |
| Server port | `27182` |
| Advertised host | `host.docker.internal` (same machine) — or a routable IP / the libp2p sidecar for remote |

**Remote / behind NAT:** run the `@avigopal/libp2p-federation-transport` **sidecar** next
to the plugin (pointed at `LOCAL_RESOLVE_URL=http://127.0.0.1:27182/resolve`). The plugin
stays a plain HTTP server; the sidecar makes it discovery-reachable over the relay.

## Concept-db frontend

When enabled, the plugin becomes a bidirectional frontend for
`concept-db`:

- **Substrate → vault**: concept-db concepts materialize as notes under
  `<sync_root>/<source_type>/<short_id>__<slug>.md`. Edges render as a
  `## Related` block with `### <edge_type>` subsections of
  `[[<short_id>]]` wikilinks. Obsidian's graph view renders the
  concept graph; wikilinks navigate to neighbors.
- **Vault → substrate**: saving a note flagged `concept-db: true` posts
  the body back to concept-db via `upsert-by-signature` (and PATCHes
  the content). Adding `[[<short_id>]]` under `### <edge_type>` calls
  `concept_link` to materialize the edge.
- **Live updates**: the plugin subscribes to activity-api's `/ws` bus
  and refreshes affected notes on `concept.created`,
  `concept.linked`, `concept.usage` events.
- **Neighborhood canvas**: the command "Concept Graph: Open Here"
  reads `concept_id` from the active note's frontmatter, pulls the
  2-hop neighborhood, and writes a `.canvas` file colored by edge
  type.

Two new shapes are advertised via discovery so other vessels can
delegate vault-rendered concept reads / writeback:
`obsidian:concept_view` and `obsidian:concept_writeback`.

Settings live under "Concept-DB Frontend" in the plugin settings tab.
Default endpoint is `http://127.0.0.1:18260` (local substrate). Both
sync and writeback are opt-in.

Design notes and the staged rollout plan are tracked in the substrate super-repo
(`openspec/changes/2026-05-30-obsidian-vessel-concept-db-frontend/`).
