# Maps

Drop MvM map files here, named `mvm_<mapname>.bsp`.

After adding or removing a file, update `manifest.json` so the site's map
picker knows what's available — GitHub Pages can't list a folder's contents
on its own. Each entry is:

```json
{ "name": "coaltown", "gatebot": true }
```

- `name` — the map name without the `mvm_` prefix or `.bsp` extension.
- `gatebot` — whether this map supports gate-bot strategies. This can't be
  detected from the .bsp: gate-bot behavior (`nav_prefer_gate1_flank`, etc.)
  depends on nav-mesh area names baked into the map's separate `.nav` file,
  which isn't part of the `.bsp` and isn't in this repo. Set this by hand
  based on what you know about each map. When true, `templates/robot_gatebot.pop`
  is offered in the wave editor's robot list for that map; when false, it's
  hidden.
