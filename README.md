# obsidian-vessel

Obsidian plugin that registers as a vessel in the substrate.
Exposes vault content (notes, search, canvas, backlinks, frontmatter,
daily notes, graph queries) as impulse resolvers on a local HTTP server
and registers with discovery-vessel so other vessels can route shape
queries here.

**Multi-instance:** several obsidian-vessels can be registered at once — each
vault+human is a distinct vessel instance with its own **unique vessel id**
(settings; never reuse an id across instances), endpoint, and local information.
Only an instance with a present human advertises `human_input`/`human_judgment`,
so discovery distinguishes which surfaces have a live human resolver. See
`docs/INTERACTION_MODEL.md` §1.1 and §6 (identity, presence, and keeping
instance versions in line — the advertised shape list, not the manifest version,
is the trustworthy version signal).

## Installation (one command)

The plugin is distributed outside the community marketplace (it runs an HTTP server
and spawns a libp2p sidecar, which the marketplace guidelines likely disallow).
`install.sh` is the supported path — it selects or creates a vault, installs the
plugin, materializes the federation sidecar, and writes `data.json` with the two
point-and-go values below:

```bash
./install.sh                                             # interactive
./install.sh --vault ~/vaults/mine \
    --discovery https://<discovery-endpoint> --api-key <api-key>
./install.sh --vault ~/vaults/new --local               # local substrate (:18100)
```

**Point-and-go.** The plugin's entire network surface is two values —
`{ discoveryVesselEndpoint, apiKey }`. You point it at a substrate **discovery
endpoint** (a full `scheme://host:port` URL) and hand it an **API key**; that is all.
At start the federation sidecar fetches `<discovery>/bootstrap` and reads the relay
anchor, identity endpoint, and preferred transport from it, reserves a p2p circuit
over the overlay, and registers itself — a valid API key is the sole gate. Nothing
else is pinned at install time, so nothing goes stale.

Prompts: vault directory → discovery endpoint → API key. The installer verifies the
discovery endpoint is reachable and that `<discovery>/bootstrap` returns the expected
body before writing anything, and confirms before overwriting an existing install.
Retrieve the operator API key from the substrate host with
`docker exec substrate-live substrate-key show`. Host needs `curl`, `jq`, and `bun`
(https://bun.sh) for the libp2p sidecar; `--no-federation` installs the plugin
without it. Then open the vault in Obsidian and allow community plugins once.

> **Advanced — relay override.** Pass `--relay <multiaddr>` only to pin the relay
> anchor when `/bootstrap` is unavailable. It is not the normal path: a hand-pinned
> relay peer-id goes stale on every relay restart, which is exactly the failure the
> `/bootstrap` fetch prevents. Leave it unset and let the sidecar resolve the relay
> live.

## Installation (manual fallback)

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

The config surface is two required settings, set in the plugin's settings tab (or
written by `install.sh`, persisted to the plugin's `data.json`):

| Required setting | Value |
|---|---|
| Discovery endpoint | The substrate discovery endpoint, a full URL (`http://localhost:18100` for a local substrate, `https://<discovery-endpoint>` for a hub) |
| API key | The credential the substrate issued you — `docker exec substrate-live substrate-key show` for the operator key |

Everything else — the relay anchor, identity endpoint, activity/concept/goal-host
endpoints — is resolved from `<discovery>/bootstrap` at start; you do not set it by
hand. Because the discovery endpoint is a full URL, a substrate on a non-default
`PORT_OFFSET` just needs its actual port in that one value; there are no other fleet
ports to keep in sync.

Optional settings:

| Optional setting | Default / note |
|---|---|
| Server port | `27182` — the local HTTP server (verify: `curl -s http://localhost:27182/health`) |
| Sidecar health port | `8402` — the federation sidecar (verify: `curl -s http://127.0.0.1:8402/health`) |
| Relay override (advanced) | Empty. Pin a relay multiaddr **only** when `/bootstrap` is unavailable; a hand-pinned relay peer-id goes stale on relay restart |

**Remote / behind NAT:** the libp2p **federation sidecar** makes the plugin
discovery-reachable over the relay while it stays a plain local HTTP server. It starts
whenever a discovery endpoint is configured: with no relay override it fetches
`<discovery>/bootstrap`, takes the relay anchor, and reserves a circuit — a valid API
key is the sole gate. `install.sh` sets this up; after a manual install, just set the
discovery endpoint and API key in the plugin settings tab. Verify the sidecar with
`curl -s http://127.0.0.1:8402/health`.

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
