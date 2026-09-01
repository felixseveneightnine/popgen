// Reads the entity lump out of a Source .bsp without downloading the whole map.
//
// A BSP starts with "VBSP", a version int, then 64 lump entries of
// { fileofs, filelen, version, fourCC } — 1036 bytes in all. Lump 0 is the
// entity list, plain text. Two small Range requests get us there, which matters
// because these maps run 16–44 MB.

const BSP_HEADER_BYTES = 1036;

async function fetchBspRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = await res.arrayBuffer();
  // 206 means the server honoured the range. Servers that don't support Range
  // (python -m http.server among them) answer 200 with the entire file, so the
  // caller slices what it needs out of that instead.
  return { buffer, ranged: res.status === 206 };
}

async function readBspEntityLump(url) {
  const head = await fetchBspRange(url, 0, BSP_HEADER_BYTES - 1);

  const header = head.ranged ? head.buffer : head.buffer.slice(0, BSP_HEADER_BYTES);
  const view = new DataView(header);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== "VBSP") throw new Error(`${url} is not a VBSP file`);

  const offset = view.getInt32(8, true);
  const length = view.getInt32(12, true);
  if (offset <= 0 || length <= 0) throw new Error(`${url} has no entity lump`);

  // Without Range support the first response already holds the whole map, so
  // re-requesting would just download it a second time.
  const lump = head.ranged
    ? (await fetchBspRange(url, offset, offset + length - 1)).buffer
    : head.buffer.slice(offset, offset + length);

  return new TextDecoder("latin1").decode(lump);
}

// The lump is a flat list of { "key" "value" } blocks.
function parseBspEntities(text) {
  const entities = [];
  const blocks = /\{([^{}]*)\}/g;
  let block;

  while ((block = blocks.exec(text))) {
    const pairs = /"([^"]*)"\s+"([^"]*)"/g;
    const entity = {};
    let pair;
    while ((pair = pairs.exec(block[1]))) entity[pair[1].toLowerCase()] = pair[2];
    entities.push(entity);
  }

  return entities;
}

function bspRelayNames(text) {
  return parseBspEntities(text)
    .filter((e) => e.classname === "logic_relay" && e.targetname)
    .map((e) => e.targetname);
}

// Maps don't agree on these names: mannhattan finishes on
// wave_finished_reset_spawns, rottenburg starts on wave_start_relay_classic,
// and mannworks has no wave_start_* relay at all -- it starts a wave on
// bombpath_arrows_clear_relay. Each list runs most- to least-specific and the
// alternate game modes are skipped, so a map's "normal" relay wins over its
// ironman/boss variant.
const WAVE_START_MATCHERS = [
  (n) => n === "wave_start_relay",
  (n) => /^wave_start/.test(n) && !/(ironman|boss|666)/.test(n),
  (n) => /^wave_start/.test(n),
  (n) => /^bombpath_arrows_clear/.test(n) && !/(ironman|boss|666)/.test(n),
  (n) => /^bombpath_arrows_clear/.test(n),
];

const WAVE_DONE_MATCHERS = [
  (n) => n === "wave_finished_relay",
  (n) => /^wave_finish/.test(n) && !/(ironman|boss|666)/.test(n),
  (n) => /wave.?finish/.test(n),
  (n) => /^wave_complete/.test(n),
];

// path_track entities chain through their `target`, so the node nothing points
// at is where a route begins. Maps name their tank routes boss_path_* or
// tank_path_*, which is what separates them from lighting rigs and trains
// (bigrock's vista1_tracktrain_path0, rottenburg's barricade_lightorigin).
const TANK_PATH_NAME = /(boss|tank)_path/i;

function findTankPathStarts(text) {
  const tracks = parseBspEntities(text).filter(
    (e) => e.classname === "path_track" && e.targetname
  );
  const targeted = new Set(tracks.map((t) => t.target).filter(Boolean));

  return tracks
    .map((t) => t.targetname)
    .filter((name) => !targeted.has(name) && TANK_PATH_NAME.test(name))
    // Shortest first, so a map's primary route (boss_path_1) comes before its
    // alternate (boss_path2_1) and lands as the default.
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function pickRelay(names, matchers) {
  for (const matches of matchers) {
    // Shortest wins a tie: the plainer name is the base one.
    const hits = names.filter(matches).sort((a, b) => a.length - b.length);
    if (hits.length) return hits[0];
  }
  return "";
}

function findWaveRelays(names) {
  return {
    start: pickRelay(names, WAVE_START_MATCHERS),
    done: pickRelay(names, WAVE_DONE_MATCHERS),
  };
}
