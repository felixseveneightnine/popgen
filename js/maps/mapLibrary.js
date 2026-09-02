import { readBspEntityLump, bspRelayNames, findWaveRelays, findTankPathStarts } from "../parsers/bsp.js";

let mapsByName = {};
const mapInfoByMap = {};

export function getMapsByName() {
  return mapsByName;
}
export function getMapInfoByMap() {
  return mapInfoByMap;
}

// Populates the map <select> from maps/manifest.json. Kept as the one place
// this module touches the DOM directly -- rewriting <option> population into
// a subscriber pattern isn't worth the risk for a single element.
export async function loadMaps(mapSelectEl, savedMapName) {
  try {
    const res = await fetch("maps/manifest.json");
    const maps = await res.json();

    mapSelectEl.innerHTML = "";
    mapsByName = {};

    if (!maps.length) {
      mapSelectEl.innerHTML = `<option value="" disabled selected>No maps available</option>`;
      return;
    }

    maps.forEach((map, i) => {
      mapsByName[map.name] = map;
      const option = document.createElement("option");
      option.value = map.name;
      option.textContent = `mvm_${map.name}`;
      if (i === 0) option.selected = true;
      mapSelectEl.appendChild(option);
    });

    if (savedMapName && mapsByName[savedMapName]) {
      mapSelectEl.value = savedMapName;
    }
    return { error: null };
  } catch (err) {
    mapSelectEl.innerHTML = `<option value="" disabled selected>Failed to load maps</option>`;
    return { error: err.message };
  }
}

// Reads (and caches) a map's wave relays and tank paths off its .bsp. Returns
// the cached/fresh info for mapName, or null if mapName is empty. A failed
// read is NOT cached -- a transient network hiccup shouldn't permanently lock
// a map out of relay/tank-path detection, so the next selection retries --
// and carries an `error` message the caller can surface. Callers are
// responsible for placeholder text and re-render side effects -- this module
// stays DOM-free beyond loadMaps' <select> population above.
export async function refreshMapInfo(mapName) {
  if (!mapName) return null;

  if (!mapInfoByMap[mapName]) {
    try {
      const text = await readBspEntityLump(`maps/mvm_${mapName}.bsp`);
      mapInfoByMap[mapName] = {
        relays: findWaveRelays(bspRelayNames(text)),
        tankPaths: findTankPathStarts(text),
        error: null,
      };
    } catch (err) {
      return { relays: { start: "", done: "" }, tankPaths: [], error: err.message };
    }
  }

  return mapInfoByMap[mapName];
}
