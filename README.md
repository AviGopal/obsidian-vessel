# obsidian-vessel

Obsidian plugin that registers as a vessel in the metabob substrate.
Exposes vault content (notes, search, canvas, backlinks, frontmatter,
daily notes, graph queries) as impulse resolvers on a local HTTP server
and registers with discovery-vessel so other vessels can route shape
queries here.

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

Design notes and the staged rollout plan are tracked in
[`openspec/changes/2026-05-30-obsidian-vessel-concept-db-frontend/`](../../openspec/changes/2026-05-30-obsidian-vessel-concept-db-frontend/).
