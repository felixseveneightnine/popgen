import { parsePop, findEntry, collectValues, extractTemplates, serializePopEntries } from "./parsers/popParser.js";
import {
  SKILLS,
  TANK_TEMPLATE,
  TANK_DEFAULTS,
  isTankSlot,
  createRobotSlot,
  normalizeRobotSlot,
  createWaveSpawn,
  createWave,
  createMission,
  mergeDefaults,
  clampIndex,
} from "./model/factories.js";
import {
  filledSlots,
  syncSquadCount,
  applyTankConstraints,
  countWaveRobots,
  waveCurrency,
  activeSupportForWave,
  waveSpawnNameExists,
  isGiantTemplate,
  templateAlwaysCrits,
  robotDisplayName,
  adoptTemplateDefaults,
  missionObjective,
} from "./model/analysis.js";
import {
  SUPPORT_TEMPLATES,
  CLASS_ORDER,
  classRank,
  applyImportedTemplates,
  loadRobots as loadRobotLibrary,
  getRobotGroups,
  getRobotIconByName,
  getRobotTemplateByName,
} from "./robots/robotLibrary.js";
import { loadMaps as loadMapLibrary, refreshMapInfo as refreshMapInfoLibrary, getMapsByName, getMapInfoByMap } from "./maps/mapLibrary.js";
import { robotIcon } from "./ui/robotIcon.js";
import { createStore } from "./state/store.js";
import { saveToStorage, loadFromLocalStorage, loadFromIndexedDbFallback } from "./state/persistence.js";

const missionNameEl = document.getElementById("missionName");
const startingMoneyEl = document.getElementById("startingMoney");
const respawnWaveTimeEl = document.getElementById("respawnWaveTime");
const difficultyEl = document.getElementById("difficulty");
const mapSelectEl = document.getElementById("mapSelect");
const gatebotOverrideEl = document.getElementById("gatebotOverride");
const canBotsAttackInSpawnRoomEl = document.getElementById("canBotsAttackInSpawnRoom");
const halloweenEl = document.getElementById("halloween");
const fixedRespawnWaveTimeEl = document.getElementById("fixedRespawnWaveTime");
const sentryBusterDamageEl = document.getElementById("sentryBusterDamage");
const sentryBusterKillsEl = document.getElementById("sentryBusterKills");
const advancedFlagEl = document.getElementById("advancedFlag");
const waveStartRelayEl = document.getElementById("waveStartRelay");
const waveDoneRelayEl = document.getElementById("waveDoneRelay");
const statusEl = document.getElementById("status");
const waveTabsEl = document.getElementById("waveTabs");
const missionTabsEl = document.getElementById("missionTabs");
const addMissionBtnEl = document.getElementById("addMissionBtn");
const waveContentEl = document.getElementById("waveContent");
const robotTabsEl = document.getElementById("robotTabs");
const robotListEl = document.getElementById("robotList");
const waveBarEl = document.getElementById("waveBar");
const startingCurrencyEl = document.getElementById("startingCurrency");
const waveDrawerEl = document.getElementById("waveDrawer");
const waveDrawerScrimEl = document.getElementById("waveDrawerScrim");
const waveDrawerToggleEl = document.getElementById("waveDrawerToggle");
const waveDrawerCloseEl = document.getElementById("waveDrawerClose");
const importBtnEl = document.getElementById("importBtn");
const importFileInputEl = document.getElementById("importFileInput");
const randomBtnEl = document.getElementById("randomBtn");
const helpBtnEl = document.getElementById("helpBtn");
const helpModalEl = document.getElementById("helpModal");
const helpModalScrimEl = document.getElementById("helpModalScrim");
const helpModalCloseEl = document.getElementById("helpModalClose");
const undoBtnEl = document.getElementById("undoBtn");
const redoBtnEl = document.getElementById("redoBtn");

function setWaveDrawer(open) {
  waveDrawerEl.classList.toggle("open", open);
  waveDrawerScrimEl.hidden = !open;
  waveDrawerToggleEl.setAttribute("aria-expanded", String(open));
}

waveDrawerToggleEl.addEventListener("click", () => {
  setWaveDrawer(!waveDrawerEl.classList.contains("open"));
});
waveDrawerCloseEl.addEventListener("click", () => setWaveDrawer(false));
waveDrawerScrimEl.addEventListener("click", () => setWaveDrawer(false));

// Start from a state JS owns rather than trusting the markup to match.
setWaveDrawer(false);

function setHelpModal(open) {
  helpModalEl.hidden = !open;
  helpModalScrimEl.hidden = !open;
}

helpBtnEl.addEventListener("click", () => setHelpModal(true));
helpModalCloseEl.addEventListener("click", () => setHelpModal(false));
helpModalScrimEl.addEventListener("click", () => setHelpModal(false));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setWaveDrawer(false);
    setHelpModal(false);
  }
});

// Valve's standard tank WaveSpawn wires these three. Only boss_deploy_relay
// actually exists in the stock maps; the other two are convention, and an
// output aimed at a missing entity simply does nothing.
const TANK_SPAWN_RELAY = "boss_spawn_relay";
const TANK_KILLED_RELAY = "boss_dead_relay";
const TANK_BOMB_RELAY = "boss_deploy_relay";

// --- Store -------------------------------------------------------------
// Everything the user actually edits (settings, waves, missions, which
// tab/slot is active, imported templates) lives in one store object,
// mutated only through store.commit(recipe, opts). opts.undoable (default
// true) snapshots the state before the recipe runs, so undo/redo works for
// free; opts.affects lists which render function(s) the change needs, so the
// batching subscriber below can collapse many commits into one repaint.
//
// Reference/library data (maps, robot templates/icons, tank paths, detected
// relays) is NOT here -- it's owned by robotLibrary.js/mapLibrary.js, rebuilt
// wholesale on map/robot load, and has no business on the undo stack.
const STORAGE_KEY = "tf2-popfile-generator/state";

function defaultSettings() {
  return {
    missionName: "MyMission",
    startingMoney: "400",
    respawnWaveTime: "6",
    difficulty: "normal",
    map: "",
    canBotsAttackInSpawnRoom: false,
    halloween: false,
    fixedRespawnWaveTime: false,
    sentryBusterDamage: "",
    sentryBusterKills: "",
    advancedFlag: "",
    waveStartRelay: "",
    waveDoneRelay: "",
  };
}

function readSettingsFromDom() {
  return {
    missionName: missionNameEl.value,
    startingMoney: startingMoneyEl.value,
    respawnWaveTime: respawnWaveTimeEl.value,
    difficulty: difficultyEl.value,
    map: mapSelectEl.value,
    canBotsAttackInSpawnRoom: canBotsAttackInSpawnRoomEl.checked,
    halloween: halloweenEl.checked,
    fixedRespawnWaveTime: fixedRespawnWaveTimeEl.checked,
    sentryBusterDamage: sentryBusterDamageEl.value,
    sentryBusterKills: sentryBusterKillsEl.value,
    advancedFlag: advancedFlagEl.value,
    waveStartRelay: waveStartRelayEl.value,
    waveDoneRelay: waveDoneRelayEl.value,
  };
}

// map's <select> population/value is owned by loadMaps(), so it's skipped
// here -- everything else mirrors the store into the visible inputs.
function writeSettingsToDom(settings) {
  missionNameEl.value = settings.missionName;
  startingMoneyEl.value = settings.startingMoney;
  respawnWaveTimeEl.value = settings.respawnWaveTime;
  difficultyEl.value = settings.difficulty;
  canBotsAttackInSpawnRoomEl.checked = Boolean(settings.canBotsAttackInSpawnRoom);
  halloweenEl.checked = Boolean(settings.halloween);
  fixedRespawnWaveTimeEl.checked = Boolean(settings.fixedRespawnWaveTime);
  sentryBusterDamageEl.value = settings.sentryBusterDamage;
  sentryBusterKillsEl.value = settings.sentryBusterKills;
  advancedFlagEl.value = settings.advancedFlag;
  waveStartRelayEl.value = settings.waveStartRelay;
  waveDoneRelayEl.value = settings.waveDoneRelay;
}

// Turns a saved JSON blob (from either localStorage or the IndexedDB
// fallback -- same shape either way) into a store-ready state object. Pure:
// no DOM writes, so it's safe to call both for the synchronous first-paint
// path and for a late IndexedDB hit that arrives after the UI is already up.
function stateFromSaved(saved) {
  const state = {
    settings: defaultSettings(),
    waves: [createWave()],
    missions: [],
    activeWaveIndex: 0,
    activeMissionIndex: 0,
    activeTabType: "wave",
    importedTemplates: {},
  };

  if (!saved || typeof saved !== "object") return { state, savedMapName: null };

  const s = saved.settings || {};
  if (typeof s.missionName === "string") state.settings.missionName = s.missionName;
  if (typeof s.startingMoney === "string") state.settings.startingMoney = s.startingMoney;
  if (typeof s.respawnWaveTime === "string") state.settings.respawnWaveTime = s.respawnWaveTime;
  if (typeof s.difficulty === "string") state.settings.difficulty = s.difficulty;
  state.settings.canBotsAttackInSpawnRoom = Boolean(s.canBotsAttackInSpawnRoom);
  state.settings.halloween = Boolean(s.halloween);
  state.settings.fixedRespawnWaveTime = Boolean(s.fixedRespawnWaveTime);
  if (typeof s.sentryBusterDamage === "string") state.settings.sentryBusterDamage = s.sentryBusterDamage;
  if (typeof s.sentryBusterKills === "string") state.settings.sentryBusterKills = s.sentryBusterKills;
  if (typeof s.advancedFlag === "string") state.settings.advancedFlag = s.advancedFlag;
  if (typeof s.waveStartRelay === "string") state.settings.waveStartRelay = s.waveStartRelay;
  if (typeof s.waveDoneRelay === "string") state.settings.waveDoneRelay = s.waveDoneRelay;
  const savedMapName = typeof s.map === "string" ? s.map : null;

  if (Array.isArray(saved.waves) && saved.waves.length) {
    state.waves = saved.waves.map((wave) => {
      const spawns = Array.isArray(wave && wave.waveSpawns) && wave.waveSpawns.length
        ? wave.waveSpawns.map((spawn) => mergeDefaults(createWaveSpawn(), spawn))
        : [createWaveSpawn()];
      return {
        waveSpawns: spawns,
        activeWaveSpawnIndex: clampIndex(wave && wave.activeWaveSpawnIndex, spawns.length),
      };
    });
  }

  if (Array.isArray(saved.missions)) {
    state.missions = saved.missions.map((mission) =>
      mergeDefaults(createMission(state.activeWaveIndex + 1), mission)
    );
  }

  state.activeWaveIndex = clampIndex(saved.activeWaveIndex, state.waves.length);
  state.activeMissionIndex = clampIndex(saved.activeMissionIndex, Math.max(state.missions.length, 1));
  state.activeTabType = saved.activeTabType === "mission" && state.missions.length ? "mission" : "wave";

  if (saved.importedTemplates && typeof saved.importedTemplates === "object") {
    state.importedTemplates = saved.importedTemplates;
  }

  return { state, savedMapName };
}

const savedLocal = loadFromLocalStorage(STORAGE_KEY);
const { state: initialState, savedMapName } = stateFromSaved(savedLocal);
const store = createStore(initialState);
writeSettingsToDom(store.getState().settings);

// The common case (localStorage already has the mission) never touches
// IndexedDB and stays fully synchronous. Only when localStorage came back
// empty -- e.g. a previous save was too large and only made it into
// IndexedDB -- does this pay the async cost, applying what it finds as one
// bulk commit after the UI has already painted with defaults.
if (!savedLocal) {
  loadFromIndexedDbFallback(STORAGE_KEY).then((savedIdb) => {
    if (!savedIdb) return;
    const { state: restored } = stateFromSaved(savedIdb);
    store.commit(
      (state) => {
        Object.assign(state, restored);
      },
      { affects: ["render", "robotList"] }
    );
    resyncFromStore();
    statusEl.textContent = "Restored your last mission from backup.";
  });
}

// `waves`/`missions`/`importedTemplates` alias the same objects store.getState()
// holds -- mutating them in place (push/splice/field edits) mutates the live
// store state too, so most commits don't need to touch `state` at all. Only a
// wholesale replace (import, random mission, undo/redo) reassigns these, and
// each of those call sites keeps the alias and the store's copy pointed at
// the same object so no separate resync step is needed.
let waves = store.getState().waves;
let missions = store.getState().missions;
let importedTemplates = store.getState().importedTemplates;

// activeWaveIndex/activeMissionIndex/activeTabType are primitives, so they
// can't be aliased -- read/write them through the store directly everywhere.
function getActiveWaveIndex() {
  return store.getState().activeWaveIndex;
}
function getActiveMissionIndex() {
  return store.getState().activeMissionIndex;
}
function getActiveTabType() {
  return store.getState().activeTabType;
}

// After undo/redo the store swaps in a whole different snapshot -- resync the
// aliases and the settings inputs so the rest of the app sees the restored
// data instead of stale references.
function resyncFromStore() {
  const state = store.getState();
  waves = state.waves;
  missions = state.missions;
  importedTemplates = state.importedTemplates;
  writeSettingsToDom(state.settings);
}

// --- Persistence -------------------------------------------------------
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

function saveState() {
  clearTimeout(saveTimer);
  try {
    const s = store.getState();
    saveToStorage(STORAGE_KEY, {
      settings: s.settings,
      waves: s.waves,
      missions: s.missions,
      activeWaveIndex: s.activeWaveIndex,
      activeMissionIndex: s.activeMissionIndex,
      activeTabType: s.activeTabType,
      importedTemplates: s.importedTemplates,
    });
  } catch (err) {
    // Storage unavailable (private mode, quota, and the IndexedDB fallback
    // also failed) — editing still works, it just won't survive a reload.
  }
}

// --- Render batching -----------------------------------------------------
// Every commit carries an `affects` list. Rather than re-render on each one
// individually, accumulate them and flush once per animation frame, so a
// burst of commits (random-mission generation, an import) repaints once.
let pendingAffects = new Set();
let renderScheduled = false;

function scheduleRender(affects) {
  affects.forEach((a) => pendingAffects.add(a));
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const affectsNow = pendingAffects;
    pendingAffects = new Set();
    flushRender(affectsNow);
  });
}

function flushRender(affects) {
  if (affects.has("all") || affects.has("render")) {
    render();
  } else if (affects.has("waveSpawns")) {
    renderWaveSpawns(); // also repaints the wave bar at its end
  } else if (affects.has("waveBar")) {
    renderWaveBar();
  }
  // render()/renderWaveSpawns() don't repaint the robot picker themselves, so
  // it needs its own call whenever a commit says it changed.
  if (affects.has("robotList")) {
    renderRobotList();
  }
}

function updateUndoRedoButtons() {
  undoBtnEl.disabled = !store.canUndo();
  redoBtnEl.disabled = !store.canRedo();
}

store.subscribe((affects) => {
  scheduleRender(affects);
  scheduleSave();
  updateUndoRedoButtons();
});
updateUndoRedoButtons();

// A snapshot captures activeWaveIndex/activeMissionIndex/activeTabType as
// they were at commit time too, since they live on the same state object as
// the data. But navigation isn't supposed to be on the undo timeline at all
// -- restoring a snapshot verbatim would otherwise silently also "undo"
// whichever tab the user has since clicked to. So undo/redo restore the data
// from the snapshot but keep wherever the user currently is, just re-clamped
// in case the restored waves/missions are now a different length.
function captureNav() {
  const s = store.getState();
  return {
    activeWaveIndex: s.activeWaveIndex,
    activeMissionIndex: s.activeMissionIndex,
    activeTabType: s.activeTabType,
  };
}

function restoreNav(nav) {
  const s = store.getState();
  s.activeWaveIndex = clampIndex(nav.activeWaveIndex, s.waves.length);
  s.activeMissionIndex = clampIndex(nav.activeMissionIndex, Math.max(s.missions.length, 1));
  s.activeTabType = nav.activeTabType === "mission" && s.missions.length ? "mission" : "wave";
}

function performUndo() {
  const nav = captureNav();
  if (!store.undo()) return;
  restoreNav(nav);
  resyncFromStore();
}
function performRedo() {
  const nav = captureNav();
  if (!store.redo()) return;
  restoreNav(nav);
  resyncFromStore();
}

undoBtnEl.addEventListener("click", performUndo);
redoBtnEl.addEventListener("click", performRedo);

document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if (!(e.ctrlKey || e.metaKey)) return;
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    performUndo();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    performRedo();
  }
});

// --- Settings inputs -------------------------------------------------------
// Plain field edits never render anything (matches every generic field
// before this refactor); startingMoney is the one exception, since the wave
// bar echoes it live.
const SETTINGS_FIELDS = [
  [missionNameEl, "missionName", false, []],
  [startingMoneyEl, "startingMoney", false, ["waveBar"]],
  [respawnWaveTimeEl, "respawnWaveTime", false, []],
  [difficultyEl, "difficulty", false, []],
  [mapSelectEl, "map", false, []],
  [canBotsAttackInSpawnRoomEl, "canBotsAttackInSpawnRoom", true, []],
  [halloweenEl, "halloween", true, []],
  [fixedRespawnWaveTimeEl, "fixedRespawnWaveTime", true, []],
  [sentryBusterDamageEl, "sentryBusterDamage", false, []],
  [sentryBusterKillsEl, "sentryBusterKills", false, []],
  [advancedFlagEl, "advancedFlag", false, []],
  [waveStartRelayEl, "waveStartRelay", false, []],
  [waveDoneRelayEl, "waveDoneRelay", false, []],
];

SETTINGS_FIELDS.forEach(([el, key, isCheckbox, affects]) => {
  let snapshotted = false;
  const commitField = () => {
    const value = isCheckbox ? el.checked : el.value;
    store.commit(
      (state) => {
        state.settings[key] = value;
      },
      { undoable: !snapshotted, affects }
    );
    snapshotted = true;
  };
  el.addEventListener("input", commitField);
  el.addEventListener("change", commitField);
  el.addEventListener("blur", () => {
    snapshotted = false;
  });
});

loadMaps().then(() => {
  loadRobots();
  refreshMapInfo();
});
mapSelectEl.addEventListener("change", () => {
  // The manifest's gatebot flag is per-map; a session-only override doesn't
  // carry over to a different map, so it resets rather than sticking.
  gatebotOverrideEl.checked = false;
  loadRobots();
  refreshMapInfo();
});
gatebotOverrideEl.addEventListener("change", () => loadRobots());

async function loadMaps() {
  const result = await loadMapLibrary(mapSelectEl, savedMapName);
  if (result.error) {
    statusEl.textContent = `Couldn't load the map list (${result.error}).`;
  }
}

async function refreshMapInfo() {
  const mapName = mapSelectEl.value;
  if (!mapName) return;

  if (!getMapInfoByMap()[mapName]) {
    waveStartRelayEl.placeholder = "reading map...";
    waveDoneRelayEl.placeholder = "reading map...";
  }

  const info = await refreshMapInfoLibrary(mapName);

  // The map may have been changed again while the .bsp was in flight.
  if (mapSelectEl.value !== mapName) return;

  detectedRelays = info.relays;
  tankPaths = info.tankPaths;
  waveStartRelayEl.placeholder = detectedRelays.start || "none found in map";
  waveDoneRelayEl.placeholder = detectedRelays.done || "none found in map";
  if (info.error) {
    statusEl.textContent = `Couldn't read mvm_${mapName}.bsp (${info.error}) — relay/tank-path detection unavailable. Reselect the map to retry.`;
  }

  // The tank path dropdown, and whether the Tank is offered at all, can only be
  // settled once the .bsp has been read. Not a store commit -- library data
  // changed, not mission data -- so it renders directly.
  render();
  renderRobotList();
}

// Read off the selected map's .bsp. The relays fill the two inputs'
// placeholders (a typed value overrides them); the tank paths populate the
// Starting Path Track Node dropdown.
let detectedRelays = { start: "", done: "" };
let tankPaths = [];

async function loadRobots() {
  robotListEl.innerHTML = `<p class="robot-list-empty">Loading robots...</p>`;

  const selectedMap = getMapsByName()[mapSelectEl.value];
  // The manifest's per-map flag is usually right, but a community map the
  // manifest hasn't been updated for yet can still support Gatebot -- the
  // checkbox lets a user turn the tab on for this session without editing
  // maps/manifest.json.
  const supportsGatebot = Boolean((selectedMap && selectedMap.gatebot) || gatebotOverrideEl.checked);

  await loadRobotLibrary(supportsGatebot, importedTemplates);

  activeRobotTabIndex = 0;
  applyPendingSlotDefaults();

  // Everything drawn before this point was drawn without template metadata:
  // the first render() runs synchronously at startup while this fetch is still
  // in flight, so a restored save had no icons, no giant/crit styling and no
  // derived Skill. Repaint now that robotIconByName is populated. Not a store
  // commit -- library data changed, not mission data.
  render();
  renderRobotList();
}

// Fills in overrides for slots restored from a save that predates them. This
// is a one-time hydration of legacy data, not a deliberate user edit, so it
// isn't pushed onto the undo stack -- it just mutates the same waves/missions
// objects the store already holds, and schedules a save directly since no
// commit fires to do that automatically.
function applyPendingSlotDefaults() {
  const spawns = missions.concat(...waves.map((wave) => wave.waveSpawns));
  let changed = false;

  spawns.forEach((spawn) => {
    spawn.robots.forEach((slot) => {
      if (!slot.pendingDefaults) return;
      adoptTemplateDefaults(slot);
      delete slot.pendingDefaults;
      changed = true;
    });
  });

  if (changed) scheduleSave();
  return changed;
}

let lastRobotContext = null;
let activeRobotTabIndex = 0;

// Which tabs the robot picker offers depends on what is being filled in: a
// WaveSpawn takes wave robots, a Mission takes support robots.
const WAVE_ROBOT_TABS = ["Common", "Minigiants", "Giant", "Boss", "Gatebot", "Imported"];
const MISSION_ROBOT_TABS = ["Support", "Gatebot", "Imported"];

function getVisibleRobotGroups() {
  const allowed = getActiveTabType() === "mission" ? MISSION_ROBOT_TABS : WAVE_ROBOT_TABS;
  return getRobotGroups().filter((g) => allowed.includes(g.label));
}

function renderRobotTabs() {
  const tabType = getActiveTabType();
  if (lastRobotContext !== tabType) {
    activeRobotTabIndex = 0;
    lastRobotContext = tabType;
  }

  const groups = getVisibleRobotGroups();
  if (activeRobotTabIndex >= groups.length) {
    activeRobotTabIndex = Math.max(0, groups.length - 1);
  }

  robotTabsEl.innerHTML = "";

  groups.forEach((group, i) => {
    const tab = document.createElement("div");
    const rtActive = i === activeRobotTabIndex;
    tab.className = "robot-tab" + (rtActive ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(rtActive));
    tab.textContent = group.label;
    tab.addEventListener("click", () => {
      activeRobotTabIndex = i;
      renderRobotList();
    });
    robotTabsEl.appendChild(tab);
  });
}

function renderRobotList() {
  renderRobotTabs();

  robotListEl.innerHTML = "";

  const groups = getVisibleRobotGroups();
  const group = groups[activeRobotTabIndex];
  const activeTarget = getActiveRobotTarget();
  const selectedRobot = activeTarget ? activeTarget.robots[activeTarget.activeSlot] : null;

  // A Medic only does anything paired with the robot it heals, so it stays out
  // of the list until the WaveSpawn is set to a Squad.
  const allowMedics = Boolean(activeTarget && activeTarget.squad);
  const names = (group ? group.names : []).filter((name) => {
    // Nothing to drive a Tank along on a map with no tank path, so it is not
    // offered at all. Filtered here rather than at load time because the paths
    // arrive from the .bsp after the robot list is built.
    if (name === TANK_TEMPLATE) return tankPaths.length > 0;
    return allowMedics || classRank(name) !== CLASS_ORDER.indexOf("medic");
  });

  if (!names.length) {
    const empty = document.createElement("p");
    empty.className = "robot-list-empty";
    empty.textContent = group
      ? "No robots in this tab. Enable Squad to use Medics."
      : "No robot templates found in /templates.";
    robotListEl.appendChild(empty);
    return;
  }

  names.forEach((name) => {
    const item = document.createElement("div");
    item.className = "robot-item" + (name === selectedRobot ? " active" : "");
    const icon = robotIcon(name);
    if (icon) item.appendChild(icon);
    const itemName = document.createElement("span");
    itemName.className = "robot-item-name";
    itemName.textContent = robotDisplayName(name);
    item.appendChild(itemName);
    item.title = robotDisplayName(name);
    item.draggable = true;
    item.addEventListener("click", () => selectRobot(name));
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", name);
      e.dataTransfer.effectAllowed = "copy";
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    robotListEl.appendChild(item);
  });
}

function getActiveRobotTarget() {
  if (getActiveTabType() === "wave") {
    const wave = waves[getActiveWaveIndex()];
    return wave ? wave.waveSpawns[wave.activeWaveSpawnIndex] : null;
  }
  if (getActiveTabType() === "mission") {
    return missions[getActiveMissionIndex()] || null;
  }
  return null;
}

function selectRobot(name) {
  const target = getActiveRobotTarget();
  if (!target) return;
  store.commit(
    () => {
      const slot = target.robots[target.activeSlot];
      slot.template = name;
      adoptTemplateDefaults(slot);
      applyTankConstraints(target);
      syncSquadCount(target);
    },
    { affects: ["waveSpawns", "robotList"] }
  );
}

document.getElementById("addWaveBtn").addEventListener("click", () => {
  store.commit(
    (state) => {
      state.waves.push(createWave());
      state.activeWaveIndex = state.waves.length - 1;
      state.activeTabType = "wave";
    },
    { affects: ["render", "robotList"] }
  );
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  const popfile = generatePopfile();
  const filename = buildFileName();

  const blob = new Blob([popfile], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  statusEl.textContent = missingTemplates.length
    ? `Downloaded ${filename} — no definition loaded for ${missingTemplates.join(", ")}`
    : `Downloaded ${filename}`;
});

function buildFileName() {
  const settings = store.getState().settings;
  const mapName = settings.map || "map";
  const difficulty = settings.difficulty || "normal";
  const missionName = settings.missionName.trim() || "mission";

  return `mvm_${mapName}_${difficulty}_${missionName}.pop`.toLowerCase();
}

// --- Import ------------------------------------------------------------
// Parses a .pop file back into the editor's own state shape so a mission can
// be re-opened for editing. Understands both what this tool writes and the
// common hand-authored shape (Template-based TFBots, inline Squad/Tank blocks).

importBtnEl.addEventListener("click", () => importFileInputEl.click());

importFileInputEl.addEventListener("change", async () => {
  const file = importFileInputEl.files[0];
  importFileInputEl.value = ""; // allow re-picking the same file later
  if (!file) return;

  if (!window.confirm(`Import ${file.name}? This replaces the current mission.`)) {
    return;
  }

  try {
    const text = await file.text();
    await importPopfile(text, file.name);
    const notes = [];
    if (missingCustomTemplates.length) {
      notes.push(`no definition found for ${missingCustomTemplates.join(", ")}`);
    }
    if (importWarnings.length) {
      notes.push(importWarnings.join("; "));
    }
    statusEl.textContent = notes.length
      ? `Imported ${file.name} — ${notes.join(" — ")}`
      : `Imported ${file.name}`;
  } catch (err) {
    statusEl.textContent = `Import failed: ${err.message}`;
  }
});

let missingCustomTemplates = [];
// Non-fatal: things the parser noticed but recovered from gracefully rather
// than rejecting the whole file (an import is tolerant by design).
let importWarnings = [];

// A counter suffix keeps synthesized names unique within one import; reset
// each time so re-importing the same file produces the same names.
function uniqueTemplateName(base, taken) {
  let name = base;
  let n = 1;
  while (taken.has(name)) {
    n += 1;
    name = `${base}_${n}`;
  }
  taken.add(name);
  return name;
}

// A TFBot block that names a Template just points at it. One with no
// Template (a raw Class/Skill/Attributes definition written inline) has no
// name of its own, so one is made up and the whole block is kept as its body.
function resolveTfBotTemplate(block, takenNames) {
  const templateName = findEntry(block, "Template");
  if (typeof templateName === "string" && templateName) return templateName;

  const className = findEntry(block, "Class") || "Unknown";
  const classIcon = findEntry(block, "ClassIcon");
  const attributes = collectValues(block, "Attributes").map((a) => String(a).toLowerCase());
  const name = uniqueTemplateName(`Custom_${className}`, takenNames);
  importedTemplates[name] = { body: block, className, classIcon, attributes };
  return name;
}

function buildSlotFromTfBotBlock(block, takenNames) {
  const name = resolveTfBotTemplate(block, takenNames);
  const slot = createRobotSlot(name);

  const skill = findEntry(block, "Skill");
  if (SKILLS.includes(skill)) {
    slot.skill = skill;
  } else {
    // No explicit Skill on this TFBot -- a hand-written file can rely on the
    // template's own default instead of restating it.
    const templateBody = getRobotTemplateByName()[name] || (importedTemplates[name] || {}).body;
    const templateSkill = templateBody ? findEntry(templateBody, "Skill") : undefined;
    slot.skill = SKILLS.includes(templateSkill) ? templateSkill : "Normal";
  }

  slot.alwaysCrit = collectValues(block, "Attributes").some(
    (a) => String(a).toLowerCase() === "alwayscrit"
  );
  return slot;
}

function parseTankBlock(tankBody) {
  const slot = createRobotSlot(TANK_TEMPLATE);
  const health = parseInt(findEntry(tankBody, "Health"), 10);
  const speed = parseInt(findEntry(tankBody, "Speed"), 10);
  const name = findEntry(tankBody, "Name");
  const node = findEntry(tankBody, "StartingPathTrackNode");
  slot.tank = {
    health: Number.isFinite(health) ? health : TANK_DEFAULTS.health,
    speed: Number.isFinite(speed) ? speed : TANK_DEFAULTS.speed,
    name: typeof name === "string" ? name : TANK_DEFAULTS.name,
    node: typeof node === "string" ? node : "",
  };
  return slot;
}

function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseWaveSpawnBlock(entries, takenNames) {
  const spawn = createWaveSpawn();
  spawn.name = findEntry(entries, "Name") || "";

  const waitDead = findEntry(entries, "WaitForAllDead");
  if (waitDead !== undefined) {
    spawn.waitForAllDead = true;
    spawn.waitForAllDeadName = String(waitDead);
  }
  const waitSpawned = findEntry(entries, "WaitForAllSpawned");
  if (waitSpawned !== undefined) {
    spawn.waitForAllSpawned = true;
    spawn.waitForAllSpawnedName = String(waitSpawned);
  }

  spawn.where = findEntry(entries, "Where") || "";
  spawn.totalCurrency = parseIntOr(findEntry(entries, "TotalCurrency"), spawn.totalCurrency);
  spawn.totalCount = parseIntOr(findEntry(entries, "TotalCount"), spawn.totalCount);
  spawn.maxActive = parseIntOr(findEntry(entries, "MaxActive"), spawn.maxActive);
  spawn.spawnCount = parseIntOr(findEntry(entries, "SpawnCount"), spawn.spawnCount);
  spawn.waitBeforeStarting = parseIntOr(findEntry(entries, "WaitBeforeStarting"), spawn.waitBeforeStarting);
  spawn.waitBetweenSpawns = parseIntOr(findEntry(entries, "WaitBetweenSpawns"), spawn.waitBetweenSpawns);

  const tank = findEntry(entries, "Tank");
  const squad = findEntry(entries, "Squad");
  const tfbot = findEntry(entries, "TFBot");

  if (Array.isArray(tank)) {
    spawn.squad = false;
    spawn.robots = [parseTankBlock(tank)];
  } else if (Array.isArray(squad)) {
    spawn.squad = true;
    const bots = squad.filter(([k]) => k.toLowerCase() === "tfbot").map(([, v]) => v);
    spawn.robots = bots.length
      ? bots.map((b) => buildSlotFromTfBotBlock(b, takenNames))
      : [createRobotSlot()];
  } else if (Array.isArray(tfbot)) {
    spawn.squad = false;
    spawn.robots = [buildSlotFromTfBotBlock(tfbot, takenNames)];
  } else {
    importWarnings.push(
      `WaveSpawn "${spawn.name.trim() || "(unnamed)"}" has no Tank/Squad/TFBot block — left with an empty slot`
    );
  }

  spawn.activeSlot = 0;
  return spawn;
}

function parseWaveBlock(entries, takenNames) {
  const spawnBlocks = entries.filter(([k]) => k.toLowerCase() === "wavespawn").map(([, v]) => v);
  const waveSpawns = spawnBlocks.length
    ? spawnBlocks.map((b) => parseWaveSpawnBlock(b, takenNames))
    : [createWaveSpawn()];
  return { waveSpawns, activeWaveSpawnIndex: 0 };
}

function parseMissionBlock(entries, takenNames) {
  const mission = createMission(parseIntOr(findEntry(entries, "BeginAtWave"), 1));
  mission.where = findEntry(entries, "Where") || "";
  mission.teleportWhere = findEntry(entries, "TeleportWhere") || "";
  mission.runForThisManyWaves = parseIntOr(findEntry(entries, "RunForThisManyWaves"), 1);
  mission.cooldownTime = parseIntOr(findEntry(entries, "CooldownTime"), 1);
  mission.desiredCount = parseIntOr(findEntry(entries, "DesiredCount"), 1);

  const tfbot = findEntry(entries, "TFBot");
  mission.robots = Array.isArray(tfbot) ? [buildSlotFromTfBotBlock(tfbot, takenNames)] : [createRobotSlot()];
  mission.activeSlot = 0;
  return mission;
}

const DIFFICULTY_VALUES = ["normal", "intermediate", "advanced", "expert"];

// Recovers map/difficulty/mission name from the filename convention this tool
// writes (mvm_<map>_<difficulty>_<name>.pop) -- the .pop body itself carries
// none of the three.
function parsePopFilename(filename) {
  const base = filename.replace(/\.pop$/i, "");
  const parts = base.split("_");
  if (!parts.length || parts[0].toLowerCase() !== "mvm") return {};

  const rest = parts.slice(1);
  const diffIndex = rest.findIndex((p) => DIFFICULTY_VALUES.includes(p.toLowerCase()));
  if (diffIndex <= 0) return {};

  return {
    mapName: rest.slice(0, diffIndex).join("_"),
    difficulty: rest[diffIndex].toLowerCase(),
    missionName: rest.slice(diffIndex + 1).join("_"),
  };
}

async function importPopfile(text, filename) {
  const root = parsePop(text);
  const schedule = findEntry(root, "WaveSchedule");
  if (!Array.isArray(schedule)) {
    throw new Error("no WaveSchedule block found");
  }

  const waveBlocks = schedule.filter(([k]) => k.toLowerCase() === "wave").map(([, v]) => v);
  if (!waveBlocks.length) {
    throw new Error("no Wave blocks found");
  }
  const missionBlocks = schedule.filter(([k]) => k.toLowerCase() === "mission").map(([, v]) => v);

  // Fresh per import: names must stay stable within this file's own Custom_*
  // bots but nothing here needs to survive across separate imports.
  importedTemplates = {};
  importWarnings = [];
  const takenNames = new Set();

  // The file's own Templates block, if it has one, takes priority over
  // whatever this session already knew about a template with the same name.
  extractTemplates(text).forEach((t) => {
    importedTemplates[t.name] = {
      body: t.body,
      className: t.className,
      classIcon: t.classIcon,
      attributes: t.attributes,
    };
    takenNames.add(t.name);
  });

  const newWaves = waveBlocks.map((b) => parseWaveBlock(b, takenNames));
  const newMissions = missionBlocks.map((b) => parseMissionBlock(b, takenNames));

  const startingCurrency = findEntry(schedule, "StartingCurrency");
  if (startingCurrency !== undefined) startingMoneyEl.value = startingCurrency;
  const respawnWaveTime = findEntry(schedule, "RespawnWaveTime");
  if (respawnWaveTime !== undefined) respawnWaveTimeEl.value = respawnWaveTime;
  const canAttack = findEntry(schedule, "CanBotsAttackWhileInSpawnRoom");
  canBotsAttackInSpawnRoomEl.checked = String(canAttack).toLowerCase() === "yes";
  halloweenEl.checked = String(findEntry(schedule, "EventPopfile")).toLowerCase() === "halloween";
  fixedRespawnWaveTimeEl.checked = ["yes", "1", "true"].includes(
    String(findEntry(schedule, "FixedRespawnWaveTime")).toLowerCase()
  );
  const sentryDamage = findEntry(schedule, "AddSentryBusterWhenDamageDealtExceeds");
  sentryBusterDamageEl.value = sentryDamage !== undefined ? sentryDamage : "";
  const sentryKills = findEntry(schedule, "AddSentryBusterWhenKillCountExceeds");
  sentryBusterKillsEl.value = sentryKills !== undefined ? sentryKills : "";
  const advanced = findEntry(schedule, "Advanced");
  advancedFlagEl.value = advanced !== undefined ? advanced : "";

  // Both relays are written identically on every wave, so the first one found
  // stands in for the whole mission -- that is all the single input fields hold.
  const firstWave = waveBlocks[0];
  const startOutput = findEntry(firstWave, "StartWaveOutput");
  waveStartRelayEl.value = Array.isArray(startOutput) ? findEntry(startOutput, "Target") || "" : "";
  const doneOutput = findEntry(firstWave, "DoneOutput");
  waveDoneRelayEl.value = Array.isArray(doneOutput) ? findEntry(doneOutput, "Target") || "" : "";

  waves = newWaves;
  missions = newMissions;

  const { mapName, difficulty, missionName } = parsePopFilename(filename || "");
  if (missionName) missionNameEl.value = missionName;
  if (difficulty && DIFFICULTY_VALUES.includes(difficulty)) difficultyEl.value = difficulty;
  if (mapName && getMapsByName()[mapName] && mapSelectEl.value !== mapName) {
    mapSelectEl.value = mapName;
    await loadRobots();
    refreshMapInfo();
  }

  // usedTemplateNames() only sees robots actually placed in a wave/mission, so
  // this reports what got left with no body rather than every unresolved name.
  applyImportedTemplates(getRobotGroups(), importedTemplates);
  missingCustomTemplates = usedTemplateNames().filter((name) => !getRobotTemplateByName()[name]);

  // One commit for the whole import: everything it touched (mission data and
  // settings) reverts together on a single undo.
  store.commit(
    (state) => {
      state.waves = waves;
      state.missions = missions;
      state.activeWaveIndex = 0;
      state.activeMissionIndex = 0;
      state.activeTabType = "wave";
      state.importedTemplates = importedTemplates;
      state.settings = readSettingsFromDom();
    },
    { affects: ["render", "robotList"] }
  );
}

// --- Random Mission ------------------------------------------------------
// Loosely modeled on real MvM advanced missions (rottenburg/bigrock/decoy):
// currency ramps up wave over wave, Minigiants/Giants/Tanks unlock only once
// the mission is partway through, and skill trends from Easy up to Expert.
// Always builds from whatever robot library is already loaded for the
// current map, so it never offers a Tank with no path or a Gatebot the map
// doesn't support.

const RANDOM_WAVE_MIN = 6;
const RANDOM_WAVE_MAX = 7;
const RANDOM_BUDGET_MIN = 5000;
const RANDOM_BUDGET_MAX = 6000;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function robotGroupNames(label) {
  const group = getRobotGroups().find((g) => g.label === label);
  return group ? group.names.filter((n) => n !== TANK_TEMPLATE) : [];
}

function namesOfClass(names, className) {
  return names.filter((n) => (getRobotIconByName()[n] || {}).className === className);
}

// tier runs 0 (wave 1) to 1 (final wave): Easy/Normal dominate early, Hard/Expert late.
function randomSkillForTier(tier) {
  const weights =
    tier < 0.34
      ? { Easy: 0.5, Normal: 0.4, Hard: 0.1, Expert: 0 }
      : tier < 0.67
      ? { Easy: 0.1, Normal: 0.45, Hard: 0.35, Expert: 0.1 }
      : { Easy: 0, Normal: 0.15, Hard: 0.45, Expert: 0.4 };
  let roll = Math.random();
  for (const skill of SKILLS) {
    roll -= weights[skill] || 0;
    if (roll <= 0) return skill;
  }
  return "Normal";
}

// Splits a wave's currency budget across its (non-finale) spawns. The last
// spawn absorbs whatever rounding left over so the wave lands on its budget.
function distributeWaveCurrency(spawns, budget) {
  if (!spawns.length) return;
  const weights = spawns.map(() => 0.6 + Math.random() * 0.8);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let allocated = 0;
  spawns.forEach((spawn, i) => {
    if (i === spawns.length - 1) {
      spawn.totalCurrency = Math.max(0, budget - allocated);
      return;
    }
    const amount = Math.max(25, roundToStep((weights[i] / weightSum) * budget, 25));
    spawn.totalCurrency = amount;
    allocated += amount;
  });
}

function buildRandomWave(waveIndex, numWaves, budget, pools) {
  const tier = numWaves > 1 ? waveIndex / (numWaves - 1) : 1;
  const isFinal = waveIndex === numWaves - 1;

  // Waves start plain; Minigiants and Giants phase in roughly a
  // quarter/two-fifths of the way through, never on wave 1.
  const giantUnlockWave = Math.max(1, Math.round(numWaves * 0.4));
  const minigiantUnlockWave = Math.max(0, Math.round(numWaves * 0.25));

  const giantsUnlocked =
    waveIndex >= giantUnlockWave &&
    pools.giants.length &&
    (pools.giantMedics.length || pools.commonMedics.length);
  const minigiantsUnlocked = waveIndex >= minigiantUnlockWave && pools.minigiants.length;

  // Reference missions (rottenburg/bigrock/decoy advanced) never put a tank
  // on wave 1, and even after that only about half of waves get one -- not
  // "whenever it feels like it" on every wave. The decision is made once per
  // wave, not re-rolled per spawn (a per-spawn roll compounds across the many
  // spawns in a wave into tanks showing up far more often than the source
  // material). Most tank waves get one; a couple of the references had two
  // or, rarely, three in the same wave.
  const tankEligible = pools.tankAvailable && waveIndex > 0;
  const waveHasTank = tankEligible && Math.random() < 0.5;
  let tanksToPlace = 0;
  if (waveHasTank) {
    const countRoll = Math.random();
    tanksToPlace = countRoll < 0.7 ? 1 : countRoll < 0.9 ? 2 : 3;
  }

  // A subwave is a group of WaveSpawns sharing one Name -- they spawn
  // together, and the next subwave waits (WaitForAllDead) for that name to
  // be fully cleared before it opens up. Each wave gets 2-4 subwaves, and
  // each subwave gets 1-4 differently-composed WaveSpawns under that name.
  const numSubwaves = randomInt(2, 4);
  const spawns = [];
  let previousSubwaveName = null;

  for (let sub = 0; sub < numSubwaves; sub++) {
    const subwaveName = `Wave${waveIndex + 1}Sub${sub + 1}`;
    const waitForPrevious = previousSubwaveName;
    const numSpawnsInSubwave = randomInt(1, 4);

    for (let k = 0; k < numSpawnsInSubwave; k++) {
      const spawn = createWaveSpawn();
      spawn.name = subwaveName;
      spawn.waitBetweenSpawns = randomInt(2, 6);
      spawn.waitBeforeStarting = sub === 0 ? 0 : randomInt(0, 5);
      if (waitForPrevious) {
        spawn.waitForAllDead = true;
        spawn.waitForAllDeadName = waitForPrevious;
      }

      const roll = Math.random();

      if (giantsUnlocked && roll < 0.5) {
        // A Giant almost never travels alone -- pair it with one or two
        // Medics, the same way every reference mission escorts its giants.
        const giant = randomPick(pools.giants);
        const medicPool = pools.giantMedics.length ? pools.giantMedics : pools.commonMedics;
        const escortCount = randomInt(1, 2);
        const slots = [createRobotSlot(giant)];
        for (let e = 0; e < escortCount; e++) slots.push(createRobotSlot(randomPick(medicPool)));
        slots.forEach(adoptTemplateDefaults);
        slots.forEach((slot) => {
          if (!isGiantTemplate(slot.template)) slot.skill = randomSkillForTier(tier);
        });
        spawn.squad = true;
        spawn.robots = slots;
        syncSquadCount(spawn);
      } else {
        const pool =
          minigiantsUnlocked && Math.random() < 0.35 && pools.minigiants.length
            ? pools.minigiants
            : pools.commonNonMedic;
        const bot = randomPick(pool.length ? pool : pools.commonNonMedic);
        const slot = createRobotSlot(bot);
        adoptTemplateDefaults(slot);
        slot.skill = randomSkillForTier(tier);
        spawn.squad = false;
        spawn.robots = [slot];
        spawn.totalCount = randomInt(6, 16) + Math.round(tier * 10);
        spawn.maxActive = randomInt(2, 4);
        spawn.spawnCount = randomInt(1, 3);
      }

      spawns.push(spawn);
    }

    previousSubwaveName = subwaveName;
  }

  // Tanks land as their own subwave after the rest of the wave, rather than
  // competing for one of the random per-spawn rolls above -- that guarantees
  // a wave that decided to have a tank actually gets one, instead of "maybe,
  // if the dice happened to land on the right spawn."
  if (tanksToPlace > 0) {
    const tankSubwaveName = `Wave${waveIndex + 1}Tank`;
    for (let t = 0; t < tanksToPlace; t++) {
      const spawn = createWaveSpawn();
      spawn.name = tankSubwaveName;
      spawn.waitBetweenSpawns = randomInt(2, 6);
      spawn.waitBeforeStarting = randomInt(0, 5);
      if (previousSubwaveName) {
        spawn.waitForAllDead = true;
        spawn.waitForAllDeadName = previousSubwaveName;
      }
      const slot = createRobotSlot(TANK_TEMPLATE);
      slot.tank.name = `tankboss_wave${waveIndex + 1}_${t + 1}`;
      spawn.squad = false;
      spawn.robots = [slot];
      spawn.totalCount = 1;
      spawn.maxActive = 1;
      spawn.spawnCount = 1;
      spawns.push(spawn);
    }
    previousSubwaveName = tankSubwaveName;
  }

  // A boss finale is a treat, not a guarantee -- only the last wave is ever
  // eligible, and even then it's a coin flip. When it happens it's its own
  // subwave that waits for the wave's last subwave to clear first.
  let finaleSpawn = null;
  if (isFinal && pools.boss.length && Math.random() < 0.5) {
    finaleSpawn = createWaveSpawn();
    finaleSpawn.name = `Wave${waveIndex + 1}Boss`;
    finaleSpawn.waitForAllDead = true;
    finaleSpawn.waitForAllDeadName = previousSubwaveName;
    const slot = createRobotSlot(randomPick(pools.boss));
    adoptTemplateDefaults(slot);
    slot.skill = "Expert";
    finaleSpawn.squad = false;
    finaleSpawn.robots = [slot];
    finaleSpawn.totalCount = 1;
    finaleSpawn.maxActive = 1;
    finaleSpawn.spawnCount = 1;
    finaleSpawn.totalCurrency = 0;
  }

  distributeWaveCurrency(spawns, budget);

  return {
    waveSpawns: finaleSpawn ? [...spawns, finaleSpawn] : spawns,
    activeWaveSpawnIndex: 0,
  };
}

// Sentry Busters are non-negotiable: on duty for the whole mission so a
// turtling team is punished on every wave, not just whichever one a random
// roll happened to cover. Everything else in Support (Sniper/Spy/Engineer)
// is genuinely randomized -- how many extra supports, which robots, and what
// stretch of the mission each one covers.
function buildRandomSupportMissions(numWaves, supportNames) {
  const result = [];
  const sentryBusterName = supportNames.find((n) => SUPPORT_TEMPLATES.includes(n));
  const otherSupport = supportNames.filter((n) => !SUPPORT_TEMPLATES.includes(n));

  if (sentryBusterName) {
    const mission = createMission(1);
    mission.robots = [createRobotSlot(sentryBusterName)];
    mission.runForThisManyWaves = numWaves;
    mission.cooldownTime = randomInt(20, 40);
    mission.desiredCount = randomInt(1, 2);
    mission.activeSlot = 0;
    result.push(mission);
  }

  if (otherSupport.length) {
    const extraCount = randomInt(1, Math.min(3, otherSupport.length));
    const shuffled = [...otherSupport].sort(() => Math.random() - 0.5);
    for (let i = 0; i < extraCount; i++) {
      const beginAtWave = randomInt(1, numWaves);
      const span = randomInt(1, numWaves - beginAtWave + 1);

      const mission = createMission(beginAtWave);
      mission.robots = [createRobotSlot(shuffled[i % shuffled.length])];
      mission.runForThisManyWaves = span;
      mission.cooldownTime = randomInt(15, 35);
      mission.desiredCount = randomInt(1, 2);
      mission.activeSlot = 0;
      result.push(mission);
    }
  }

  return result;
}

function generateRandomMission() {
  const numWaves = randomInt(RANDOM_WAVE_MIN, RANDOM_WAVE_MAX);
  const totalBudget = randomInt(RANDOM_BUDGET_MIN, RANDOM_BUDGET_MAX);
  const startingCurrency = roundToStep(totalBudget * (0.12 + Math.random() * 0.08), 50);
  const waveBudgetTotal = totalBudget - startingCurrency;

  // Increasing weights per wave so later waves pay out more -- currency
  // scales up alongside the tougher robots those waves unlock.
  const weights = [];
  for (let i = 0; i < numWaves; i++) {
    const tier = numWaves > 1 ? i / (numWaves - 1) : 0;
    weights.push(0.7 + tier * 0.9 + (Math.random() * 0.2 - 0.1));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const waveBudgets = weights.map((w) => roundToStep((w / weightSum) * waveBudgetTotal, 25));
  const drift = waveBudgetTotal - waveBudgets.reduce((a, b) => a + b, 0);
  waveBudgets[waveBudgets.length - 1] = Math.max(0, waveBudgets[waveBudgets.length - 1] + drift);

  const commonNames = robotGroupNames("Common");
  const commonMedics = namesOfClass(commonNames, "medic");
  const giantNames = robotGroupNames("Giant");
  const giantMedics = namesOfClass(giantNames, "medic");

  const pools = {
    commonNonMedic: commonNames.filter((n) => !commonMedics.includes(n)),
    commonMedics,
    minigiants: robotGroupNames("Minigiants"),
    giants: giantNames.filter((n) => !giantMedics.includes(n)),
    giantMedics,
    boss: robotGroupNames("Boss"),
    tankAvailable: tankPaths.length > 0,
  };

  const newWaves = [];
  for (let w = 0; w < numWaves; w++) {
    newWaves.push(buildRandomWave(w, numWaves, waveBudgets[w], pools));
  }

  const missionsResult = buildRandomSupportMissions(numWaves, robotGroupNames("Support"));

  return {
    waves: newWaves,
    missions: missionsResult,
    startingCurrency,
    // The global thresholds are the mechanism that actually makes Sentry
    // Busters mandatory: unlike a Mission's BeginAtWave/RunForThisManyWaves,
    // these have no wave scoping at all -- once set they watch every wave.
    sentryBusterDamage: randomInt(15, 30) * 100,
    sentryBusterKills: randomInt(8, 20),
  };
}

randomBtnEl.addEventListener("click", () => {
  if (!getRobotGroups().length) {
    statusEl.textContent = "Robots are still loading — try again in a moment.";
    return;
  }
  if (!window.confirm("Generate a random mission? This replaces the current mission.")) {
    return;
  }

  const result = generateRandomMission();
  waves = result.waves;
  missions = result.missions;
  startingMoneyEl.value = result.startingCurrency;
  sentryBusterDamageEl.value = result.sentryBusterDamage;
  sentryBusterKillsEl.value = result.sentryBusterKills;

  store.commit(
    (state) => {
      state.waves = waves;
      state.missions = missions;
      state.activeWaveIndex = 0;
      state.activeMissionIndex = 0;
      state.activeTabType = "wave";
      state.settings = readSettingsFromDom();
    },
    { affects: ["render", "robotList"] }
  );

  const total = result.startingCurrency + waves.reduce((sum, wave) => sum + waveCurrency(wave), 0);
  statusEl.textContent = `Generated a random ${waves.length}-wave mission (${total} total currency).`;
});

function selectWave(index) {
  store.commit(
    (state) => {
      state.activeWaveIndex = index;
      state.activeTabType = "wave";
    },
    { undoable: false, affects: ["render", "robotList"] }
  );
  setWaveDrawer(false);
}

function removeWave(index) {
  if (waves.length <= 1) return;
  store.commit(
    (state) => {
      state.waves.splice(index, 1);
      if (state.activeWaveIndex >= state.waves.length) {
        state.activeWaveIndex = state.waves.length - 1;
      }
    },
    { affects: ["render", "robotList"] }
  );
}

function render() {
  const activeTabType = getActiveTabType();
  const activeWaveIndex = getActiveWaveIndex();
  waveTabsEl.innerHTML = "";

  waves.forEach((_, i) => {
    const tab = document.createElement("div");
    const active = activeTabType === "wave" && i === activeWaveIndex;
    tab.className = "wave-tab" + (active ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.addEventListener("click", () => selectWave(i));

    const label = document.createElement("span");
    label.className = "wave-tab-label";
    label.textContent = `Wave #${i + 1}`;
    tab.appendChild(label);

    if (waves.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "wave-tab-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", `Remove Wave #${i + 1}`);
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeWave(i);
      });
      tab.appendChild(removeBtn);
    }

    waveTabsEl.appendChild(tab);
  });

  renderMissionTabs();
  renderWaveSpawns();
}

function renderMissionTabs() {
  const activeTabType = getActiveTabType();
  const activeMissionIndex = getActiveMissionIndex();
  missionTabsEl.innerHTML = "";

  missions.forEach((_, i) => {
    const tab = document.createElement("div");
    const active = activeTabType === "mission" && i === activeMissionIndex;
    tab.className = "wave-tab" + (active ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.addEventListener("click", () => {
      store.commit(
        (state) => {
          state.activeMissionIndex = i;
          state.activeTabType = "mission";
        },
        { undoable: false, affects: ["render", "robotList"] }
      );
    });

    const label = document.createElement("span");
    label.className = "wave-tab-label";
    label.textContent = `Support #${i + 1}`;
    tab.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "wave-tab-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove Support #${i + 1}`);
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      store.commit(
        (state) => {
          state.missions.splice(i, 1);
          if (state.activeMissionIndex >= state.missions.length) {
            state.activeMissionIndex = state.missions.length - 1;
          }
          if (!state.missions.length) state.activeTabType = "wave";
        },
        { affects: ["render", "robotList"] }
      );
    });
    tab.appendChild(removeBtn);

    missionTabsEl.appendChild(tab);
  });

  // The label only earns its space while the row is empty; once a Support tab
  // is there to name the section, the bare + is enough.
  const labelled = missions.length === 0;
  addMissionBtnEl.className = "wave-tab-add" + (labelled ? " with-label" : "");
  addMissionBtnEl.textContent = labelled ? "+ Support" : "+";
}

addMissionBtnEl.addEventListener("click", () => {
  store.commit(
    (state) => {
      state.missions.push(createMission(state.activeWaveIndex + 1));
      state.activeMissionIndex = state.missions.length - 1;
      state.activeTabType = "mission";
    },
    { affects: ["render", "robotList"] }
  );
});

function renderWaveSpawns() {
  const activeTabType = getActiveTabType();
  const activeWaveIndex = getActiveWaveIndex();
  const activeMissionIndex = getActiveMissionIndex();
  waveContentEl.innerHTML = "";

  const wave = waves[activeWaveIndex];

  const bar = document.createElement("div");
  bar.className = "wavespawn-tab-bar";

  const addBtn = document.createElement("button");
  addBtn.className = "wavespawn-tab-add";
  addBtn.title = "Add WaveSpawn";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    store.commit(
      (state) => {
        wave.waveSpawns.push(createWaveSpawn());
        wave.activeWaveSpawnIndex = wave.waveSpawns.length - 1;
        state.activeTabType = "wave";
      },
      { affects: ["render", "robotList"] }
    );
  });
  bar.appendChild(addBtn);

  const tabsWrap = document.createElement("div");
  tabsWrap.className = "wavespawn-tabs";
  tabsWrap.setAttribute("role", "tablist");
  tabsWrap.setAttribute("aria-label", "WaveSpawns");

  wave.waveSpawns.forEach((_, i) => {
    const tab = document.createElement("div");
    const wsActive = activeTabType === "wave" && i === wave.activeWaveSpawnIndex;
    tab.className = "wavespawn-tab" + (wsActive ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(wsActive));
    tab.addEventListener("click", () => {
      store.commit(
        (state) => {
          wave.activeWaveSpawnIndex = i;
          state.activeTabType = "wave";
        },
        { undoable: false, affects: ["render", "robotList"] }
      );
    });

    const label = document.createElement("span");
    label.textContent = `WaveSpawn #${i + 1}`;
    tab.appendChild(label);

    if (wave.waveSpawns.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "wavespawn-tab-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", `Remove WaveSpawn #${i + 1}`);
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        store.commit(
          () => {
            wave.waveSpawns.splice(i, 1);
            if (wave.activeWaveSpawnIndex >= wave.waveSpawns.length) {
              wave.activeWaveSpawnIndex = wave.waveSpawns.length - 1;
            }
          },
          { affects: ["waveSpawns", "robotList"] }
        );
      });
      tab.appendChild(removeBtn);
    }

    tabsWrap.appendChild(tab);
  });

  bar.appendChild(tabsWrap);

  waveContentEl.appendChild(bar);

  if (activeTabType === "mission" && missions[activeMissionIndex]) {
    waveContentEl.appendChild(buildMissionForm(missions[activeMissionIndex]));
  } else {
    waveContentEl.appendChild(buildWaveSpawnForm(wave.waveSpawns[wave.activeWaveSpawnIndex]));
  }

  renderWaveBar();
}

function formRow(labelText, inputEl, extraClass) {
  const row = document.createElement("div");
  row.className = "form-row" + (extraClass ? ` ${extraClass}` : "");
  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(inputEl);
  return row;
}

// Coalesced undo: the first keystroke/change in an edit session snapshots the
// state, subsequent ones (before blur) don't -- so one Undo reverts the whole
// edit, not one character.
// `validate` (optional) returns an error message string for an invalid value,
// or a falsy value when it's fine. Advisory only, like numberInput's -- it
// flags the field but never blocks the edit.
function textInput(value, onInput, placeholder, affects, validate) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.spellcheck = false;
  if (placeholder) input.placeholder = placeholder;

  function updateValidity(v) {
    if (!validate) return;
    const message = validate(v);
    input.classList.toggle("field-invalid", Boolean(message));
    input.title = message || "";
  }
  updateValidity(value || "");

  let snapshotted = false;
  input.addEventListener("input", (e) => {
    updateValidity(e.target.value);
    store.commit(() => onInput(e.target.value), { undoable: !snapshotted, affects: affects || [] });
    snapshotted = true;
  });
  input.addEventListener("blur", () => {
    snapshotted = false;
  });
  return input;
}

function selectInput(options, value, onChange, affects) {
  const select = document.createElement("select");
  options.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt;
    optionEl.textContent = opt;
    if (opt === value) optionEl.selected = true;
    select.appendChild(optionEl);
  });
  select.addEventListener("change", (e) => {
    store.commit(() => onChange(e.target.value), { affects: affects || [] });
  });
  return select;
}

// Advisory only, not blocking: a value below `min` gets a red outline and a
// tooltip explaining why, but is still accepted and written to the file --
// this is feedback, not validation that rejects the edit.
function updateNumberValidity(input, value, min) {
  const invalid = min !== undefined && value < min;
  input.classList.toggle("field-invalid", invalid);
  input.title = invalid ? `Must be ${min} or more` : "";
}

function numberInput(value, onInput, min, placeholder, affects) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  if (min !== undefined) input.min = min;
  if (placeholder !== undefined) input.placeholder = placeholder;
  updateNumberValidity(input, value, min);
  let snapshotted = false;
  input.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    updateNumberValidity(input, v, min);
    store.commit(() => onInput(v), {
      undoable: !snapshotted,
      affects: affects || [],
    });
    snapshotted = true;
  });
  input.addEventListener("blur", () => {
    snapshotted = false;
  });
  return input;
}

function checkboxRow(labelText, checked, onChange, affects) {
  const row = document.createElement("label");
  row.className = "checkbox-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", (e) => {
    store.commit(() => onChange(e.target.checked), { affects: affects || [] });
  });
  row.appendChild(input);
  row.appendChild(document.createTextNode(labelText));
  return row;
}

function waveBarRobot(robotName, countText, titleText, alwaysCrit) {
  const cell = document.createElement("div");
  cell.className = "wavebar-robot";
  cell.title = titleText || robotName;

  const icon = robotIcon(robotName, alwaysCrit);
  if (icon) cell.appendChild(icon);

  const count = document.createElement("span");
  count.className = "wavebar-robot-count";
  count.textContent = countText;
  cell.appendChild(count);

  return cell;
}

function renderWaveBar() {
  const starting = parseInt(store.getState().settings.startingMoney, 10) || 0;
  startingCurrencyEl.textContent = `Starting Currency: $${starting}`;

  waveBarEl.innerHTML = "";
  waves.forEach((wave, i) => waveBarEl.appendChild(buildWaveBar(wave, i)));
}

function buildWaveBar(wave, index) {
  const waveNumber = index + 1;
  const counts = countWaveRobots(wave);
  const support = activeSupportForWave(missions, waveNumber);

  const bar = document.createElement("div");
  bar.className = "wavebar" + (index === getActiveWaveIndex() ? " active" : "");
  bar.title = `Go to Wave #${waveNumber}`;
  bar.addEventListener("click", () => selectWave(index));

  const progress = document.createElement("div");
  progress.className = "wavebar-progress";
  const fill = document.createElement("div");
  fill.className = "wavebar-progress-fill";
  const label = document.createElement("span");
  label.className = "wavebar-progress-label";
  label.textContent = `WAVE ${waveNumber} / ${waves.length}`;
  progress.appendChild(fill);
  progress.appendChild(label);
  bar.appendChild(progress);

  const currency = document.createElement("div");
  currency.className = "wavebar-currency";
  currency.textContent = `$${waveCurrency(wave)}`;
  bar.appendChild(currency);

  if (!counts.size && !support.length) {
    const empty = document.createElement("div");
    empty.className = "wavebar-empty";
    empty.textContent = "No robots picked yet.";
    bar.appendChild(empty);
    return bar;
  }

  const body = document.createElement("div");
  body.className = "wavebar-body";

  const main = document.createElement("div");
  main.className = "wavebar-group";
  const ordered = [...counts.values()].sort(
    (a, b) => Number(isGiantTemplate(b.template)) - Number(isGiantTemplate(a.template))
  );

  ordered.forEach(({ template, crit, count }) => {
    const title = `${robotDisplayName(template)} x${count}${crit ? " (crits)" : ""}`;
    main.appendChild(waveBarRobot(template, count, title, crit));
  });
  body.appendChild(main);

  if (support.length) {
    const divider = document.createElement("div");
    divider.className = "wavebar-divider";
    body.appendChild(divider);

    const supportGroup = document.createElement("div");
    supportGroup.className = "wavebar-support";

    const icons = document.createElement("div");
    icons.className = "wavebar-support-icons";
    support.forEach((mission) => {
      const found = filledSlots(mission)[0];
      const robot = found ? found.template : null;
      const objective = missionObjective(mission);
      const label = robot || objective || "Support";
      const displayLabel = robot ? robotDisplayName(robot) : label;
      icons.appendChild(waveBarRobot(label, "∞", `${displayLabel} (${objective || "no robot"})`));
    });
    supportGroup.appendChild(icons);

    const supportLabel = document.createElement("span");
    supportLabel.className = "wavebar-support-label";
    supportLabel.textContent = "SUPPORT";
    supportGroup.appendChild(supportLabel);

    body.appendChild(supportGroup);
  }

  bar.appendChild(body);
  return bar;
}

function buildWaveSpawnForm(spawn) {
  const form = document.createElement("div");
  form.className = "wavespawn-form";

  form.appendChild(
    formRow(
      "Name",
      textInput(spawn.name, (v) => {
        spawn.name = v;
      })
    )
  );

  const tankSlot = spawn.robots.find(isTankSlot);

  // A Tank spawns on its path, not at a bot spawn point, so it has no Where.
  if (!tankSlot) {
    form.appendChild(
      formRow(
        "Where",
        textInput(
          spawn.where,
          (v) => {
            spawn.where = v;
          },
          "spawnbot"
        )
      )
    );
  }

  form.appendChild(
    checkboxRow(
      "Wait For All Dead",
      spawn.waitForAllDead,
      (checked) => {
        spawn.waitForAllDead = checked;
      },
      ["waveSpawns"]
    )
  );
  if (spawn.waitForAllDead) {
    form.appendChild(
      formRow(
        "WaveSpawn Name",
        textInput(
          spawn.waitForAllDeadName,
          (v) => {
            spawn.waitForAllDeadName = v;
          },
          undefined,
          [],
          (v) =>
            waveSpawnNameExists(waves[getActiveWaveIndex()], v, spawn)
              ? null
              : "No other WaveSpawn in this wave has this Name"
        ),
        "indent"
      )
    );
  }

  form.appendChild(
    checkboxRow(
      "Wait For All Spawned",
      spawn.waitForAllSpawned,
      (checked) => {
        spawn.waitForAllSpawned = checked;
      },
      ["waveSpawns"]
    )
  );
  if (spawn.waitForAllSpawned) {
    form.appendChild(
      formRow(
        "WaveSpawn Name",
        textInput(
          spawn.waitForAllSpawnedName,
          (v) => {
            spawn.waitForAllSpawnedName = v;
          },
          undefined,
          [],
          (v) =>
            waveSpawnNameExists(waves[getActiveWaveIndex()], v, spawn)
              ? null
              : "No other WaveSpawn in this wave has this Name"
        ),
        "indent"
      )
    );
  }

  const countGroup = document.createElement("div");
  countGroup.className = "form-row-group";
  countGroup.appendChild(
    formRow(
      "Spawn Count",
      numberInput(
        spawn.spawnCount,
        (v) => {
          spawn.spawnCount = v;
        },
        1
      )
    )
  );
  countGroup.appendChild(
    formRow(
      "Max Active",
      numberInput(
        spawn.maxActive,
        (v) => {
          spawn.maxActive = v;
        },
        1
      )
    )
  );
  countGroup.appendChild(
    formRow(
      "Total Count",
      numberInput(
        spawn.totalCount,
        (v) => {
          spawn.totalCount = v;
        },
        1,
        undefined,
        ["waveBar"]
      )
    )
  );
  form.appendChild(countGroup);

  const timingGroup = document.createElement("div");
  timingGroup.className = "form-row-group";
  timingGroup.appendChild(
    formRow(
      "Wait Between Spawns",
      numberInput(
        spawn.waitBetweenSpawns,
        (v) => {
          spawn.waitBetweenSpawns = v;
        },
        0
      )
    )
  );
  timingGroup.appendChild(
    formRow(
      "Wait Before Starting",
      numberInput(
        spawn.waitBeforeStarting,
        (v) => {
          spawn.waitBeforeStarting = v;
        },
        0
      )
    )
  );
  timingGroup.appendChild(
    formRow(
      "Currency Drop",
      numberInput(
        spawn.totalCurrency,
        (v) => {
          spawn.totalCurrency = v;
        },
        0,
        100,
        ["waveBar"]
      )
    )
  );
  form.appendChild(timingGroup);

  if (!tankSlot) {
    form.appendChild(
      checkboxRow(
        "Squad",
        spawn.squad,
        (checked) => {
          spawn.squad = checked;
          if (!checked) spawn.robots = [spawn.robots[spawn.activeSlot] || spawn.robots[0] || createRobotSlot()];
          spawn.activeSlot = 0;
          syncSquadCount(spawn);
        },
        ["waveSpawns", "robotList"]
      )
    );
  }

  form.appendChild(buildRobotSlots(spawn, !tankSlot));
  if (tankSlot) form.appendChild(buildTankForm(tankSlot));

  return form;
}

// Health, Speed and Name are the user's; the path node comes from the map, with
// the first route detected in the .bsp as the default.
function buildTankForm(slot) {
  const wrap = document.createElement("div");
  wrap.className = "tank-form";

  const heading = document.createElement("label");
  heading.className = "robot-slots-label";
  heading.textContent = "Tank";
  wrap.appendChild(heading);

  const group = document.createElement("div");
  group.className = "form-row-group";
  group.appendChild(
    formRow(
      "Health",
      numberInput(
        slot.tank.health,
        (v) => {
          slot.tank.health = v;
        },
        0,
        TANK_DEFAULTS.health
      )
    )
  );
  group.appendChild(
    formRow(
      "Speed",
      numberInput(
        slot.tank.speed,
        (v) => {
          slot.tank.speed = v;
        },
        0,
        TANK_DEFAULTS.speed
      )
    )
  );
  wrap.appendChild(group);

  wrap.appendChild(
    formRow(
      "Name",
      textInput(
        slot.tank.name,
        (v) => {
          slot.tank.name = v;
        },
        TANK_DEFAULTS.name
      )
    )
  );

  wrap.appendChild(formRow("Starting Path Track Node", tankPathInput(slot)));

  return wrap;
}

function tankPathInput(slot) {
  if (!tankPaths.length) {
    const note = document.createElement("span");
    note.className = "derived-value";
    note.textContent = "No tank path in this map";
    return note;
  }

  return selectInput(tankPaths, tankPathFor(slot), (v) => {
    slot.tank.node = v;
  });
}

// An unset node, or one belonging to a different map, falls back to the map's
// first route rather than writing a path the map does not have.
function tankPathFor(slot) {
  if (slot.tank.node && tankPaths.includes(slot.tank.node)) return slot.tank.node;
  return tankPaths[0] || "";
}

function buildMissionForm(mission) {
  const form = document.createElement("div");
  form.className = "wavespawn-form";

  const objective = missionObjective(mission);

  const objectiveValue = document.createElement("span");
  objectiveValue.className = "derived-value";
  objectiveValue.textContent = objective || "pick a robot below";
  form.appendChild(formRow("Support Type", objectiveValue));

  form.appendChild(
    formRow(
      "Where",
      textInput(
        mission.where,
        (v) => {
          mission.where = v;
        },
        "spawnbot"
      )
    )
  );

  if (objective === "Engineer") {
    form.appendChild(
      formRow(
        "Teleport Robots from This Spawn",
        textInput(
          mission.teleportWhere,
          (v) => {
            mission.teleportWhere = v;
          },
          "spawnbot"
        ),
        "indent"
      )
    );
  }

  const group = document.createElement("div");
  group.className = "form-row-group";
  group.appendChild(
    formRow(
      "Run For This Many Waves",
      numberInput(
        mission.runForThisManyWaves,
        (v) => {
          mission.runForThisManyWaves = v;
        },
        1,
        undefined,
        ["waveBar"]
      )
    )
  );
  group.appendChild(
    formRow(
      "Wait Between Spawns",
      numberInput(
        mission.cooldownTime,
        (v) => {
          mission.cooldownTime = v;
        },
        0
      )
    )
  );
  group.appendChild(
    formRow(
      "Count",
      numberInput(
        mission.desiredCount,
        (v) => {
          mission.desiredCount = v;
        },
        1
      )
    )
  );
  form.appendChild(group);

  form.appendChild(buildRobotSlots(mission));

  return form;
}

// Per-robot overrides, rendered under the slot rather than inside it: the slot
// itself is a click target that re-renders the form, which would tear the
// controls out from under the pointer mid-interaction.
function buildSlotOptions(spawn, slotData) {
  const row = document.createElement("div");
  row.className = "robot-slot-options";

  const giant = isGiantTemplate(slotData.template);

  const skill = document.createElement("label");
  skill.className = "robot-slot-option";
  skill.appendChild(document.createTextNode("Skill"));
  const skillSelect = selectInput(SKILLS, slotData.skill, (v) => {
    slotData.skill = v;
  });
  if (giant) {
    skillSelect.disabled = true;
    skill.title = "Giants use the skill their template sets.";
  }
  skill.appendChild(skillSelect);
  row.appendChild(skill);

  const crit = document.createElement("label");
  crit.className = "robot-slot-option";
  const critInput = document.createElement("input");
  critInput.type = "checkbox";
  critInput.checked = slotData.alwaysCrit;
  if (templateAlwaysCrits(slotData.template)) {
    critInput.checked = true;
    critInput.disabled = true;
    crit.title = "This template always crits.";
  }
  critInput.addEventListener("change", (e) => {
    store.commit(
      () => {
        slotData.alwaysCrit = e.target.checked;
      },
      { affects: ["waveSpawns"] }
    );
  });
  crit.appendChild(critInput);
  crit.appendChild(document.createTextNode("Always Crit"));
  row.appendChild(crit);

  return row;
}

function buildRobotSlots(spawn, showOptions) {
  const wrap = document.createElement("div");
  wrap.className = "robot-slots";

  const heading = document.createElement("label");
  heading.className = "robot-slots-label";
  heading.textContent = spawn.squad ? "Squad Robots" : "Robot";
  wrap.appendChild(heading);

  const list = document.createElement("div");
  list.className = "robot-slot-list";

  spawn.robots.forEach((slotData, i) => {
    const robotName = slotData.template;
    const entry = document.createElement("div");
    entry.className = "robot-slot-entry";

    const slot = document.createElement("div");
    slot.className = "robot-slot" + (i === spawn.activeSlot ? " active" : "");
    slot.addEventListener("click", () => {
      store.commit(
        () => {
          spawn.activeSlot = i;
        },
        { undoable: false, affects: ["waveSpawns", "robotList"] }
      );
    });
    slot.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      slot.classList.remove("drag-over");
      const name = e.dataTransfer.getData("text/plain");
      if (!name) return;
      store.commit(
        () => {
          spawn.robots[i].template = name;
          adoptTemplateDefaults(spawn.robots[i]);
          applyTankConstraints(spawn);
          syncSquadCount(spawn);
        },
        { affects: ["waveSpawns", "robotList"] }
      );
    });

    const labelWrap = document.createElement("span");
    labelWrap.className = "robot-slot-label";
    if (robotName) {
      const icon = robotIcon(robotName, slotData.alwaysCrit);
      if (icon) labelWrap.appendChild(icon);
    }
    const slotName = document.createElement("span");
    slotName.className = "robot-slot-name";
    slotName.textContent = robotName ? robotDisplayName(robotName) : "Click or drag a robot here";
    labelWrap.appendChild(slotName);
    if (robotName) slot.title = robotDisplayName(robotName);
    slot.appendChild(labelWrap);

    if (spawn.squad && spawn.robots.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "robot-slot-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", robotName ? `Remove ${robotDisplayName(robotName)} from squad` : "Remove robot from squad");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        store.commit(
          () => {
            spawn.robots.splice(i, 1);
            if (spawn.activeSlot >= spawn.robots.length) {
              spawn.activeSlot = spawn.robots.length - 1;
            }
            syncSquadCount(spawn);
          },
          { affects: ["waveSpawns", "robotList"] }
        );
      });
      slot.appendChild(removeBtn);
    }

    entry.appendChild(slot);
    if (showOptions && robotName) entry.appendChild(buildSlotOptions(spawn, slotData));
    list.appendChild(entry);
  });

  wrap.appendChild(list);

  if (spawn.squad) {
    const addBtn = document.createElement("button");
    addBtn.className = "secondary-btn robot-slot-add";
    addBtn.textContent = "+ Add Robot";
    addBtn.addEventListener("click", () => {
      store.commit(
        () => {
          spawn.robots.push(createRobotSlot());
          spawn.activeSlot = spawn.robots.length - 1;
          syncSquadCount(spawn);
        },
        { affects: ["waveSpawns", "robotList"] }
      );
    });
    addBtn.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      addBtn.classList.add("drag-over");
    });
    addBtn.addEventListener("dragleave", () => addBtn.classList.remove("drag-over"));
    addBtn.addEventListener("drop", (e) => {
      e.preventDefault();
      addBtn.classList.remove("drag-over");
      const name = e.dataTransfer.getData("text/plain");
      if (!name) return;
      store.commit(
        () => {
          const added = createRobotSlot(name);
          adoptTemplateDefaults(added);
          spawn.robots.push(added);
          spawn.activeSlot = spawn.robots.length - 1;
          applyTankConstraints(spawn);
          syncSquadCount(spawn);
        },
        { affects: ["waveSpawns", "robotList"] }
      );
    });
    wrap.appendChild(addBtn);
  }

  return wrap;
}

function generatePopfile() {
  const settings = store.getState().settings;
  const startingMoney = parseInt(settings.startingMoney, 10) || 0;
  const respawnWaveTime = parseInt(settings.respawnWaveTime, 10) || 6;
  const canBotsAttackInSpawnRoom = settings.canBotsAttackInSpawnRoom ? "yes" : "no";

  const optionalLines = [];

  if (settings.halloween) optionalLines.push(`\tEventPopfile\tHalloween`);
  if (settings.fixedRespawnWaveTime) {
    optionalLines.push(`\tFixedRespawnWaveTime\tYes`);
  }

  if (String(settings.sentryBusterDamage).trim() !== "") {
    const v = parseInt(settings.sentryBusterDamage, 10);
    if (!isNaN(v)) optionalLines.push(`\tAddSentryBusterWhenDamageDealtExceeds\t${v}`);
  }

  if (String(settings.sentryBusterKills).trim() !== "") {
    const v = parseInt(settings.sentryBusterKills, 10);
    if (!isNaN(v)) optionalLines.push(`\tAddSentryBusterWhenKillCountExceeds\t${v}`);
  }

  if (parseInt(settings.advancedFlag, 10) === 1) {
    optionalLines.push(`\tAdvanced\t1`);
  }

  const missionBlocks = missions.flatMap((mission) => buildMissionBlock(mission));
  const waveBlocks = waves.flatMap((wave, i) => buildWaveBlock(wave, i + 1));

  // Templates are written into the mission itself rather than pulled in with a
  // #base, so the .pop is self-contained.
  const used = usedTemplateNames();
  const defined = used.filter((name) => getRobotTemplateByName()[name]);
  missingTemplates = used.filter((name) => !getRobotTemplateByName()[name]);

  const lines = [
    `WaveSchedule`,
    `{`,
    `\tStartingCurrency\t${startingMoney}`,
    `\tRespawnWaveTime\t${respawnWaveTime}`,
    `\tCanBotsAttackWhileInSpawnRoom\t${canBotsAttackInSpawnRoom}`,
    ...optionalLines,
    ``,
    ...waveBlocks,
    ...missionBlocks,
    ...buildTemplatesBlock(defined),
    `}`,
  ];

  return lines.join("\n");
}

let missingTemplates = [];

// Only robots that actually reach the file need a definition: a plain WaveSpawn
// writes its first robot, a Squad writes all of them, and a Mission writes its
// first. Order follows first use.
function usedTemplateNames() {
  const names = [];
  const add = (name) => {
    // The Tank is emitted inline as a Tank block, so it has nothing to define.
    if (name && name !== TANK_TEMPLATE && !names.includes(name)) names.push(name);
  };

  missions.forEach((mission) => {
    const slot = filledSlots(mission)[0];
    if (slot) add(slot.template);
  });

  waves.forEach((wave) => {
    wave.waveSpawns.forEach((spawn) => {
      const slots = filledSlots(spawn);
      if (spawn.squad && slots.length > 1) {
        slots.forEach((slot) => add(slot.template));
      } else if (slots.length) {
        add(slots[0].template);
      }
    });
  });

  return names;
}

function buildTemplatesBlock(names) {
  if (!names.length) return [];

  const lines = [`	Templates`, `	{`];
  names.forEach((name, i) => {
    if (i) lines.push(``);
    lines.push(`		${name}`);
    lines.push(`		{`);
    lines.push(...serializePopEntries(getRobotTemplateByName()[name], 3));
    lines.push(`		}`);
  });
  lines.push(`	}`);

  return lines;
}

function buildMissionBlock(mission) {
  const objective = missionObjective(mission);
  // A Mission with no robot has no objective and nothing to spawn, so it is
  // left out of the file rather than written half-formed.
  if (!objective) return [];

  const lines = [];
  lines.push(`\tMission`);
  lines.push(`\t{`);
  lines.push(`\t\tObjective\t${objective}`);
  if (mission.where.trim()) lines.push(`\t\tWhere\t${mission.where.trim()}`);
  if (objective === "Engineer" && mission.teleportWhere.trim()) {
    lines.push(`\t\tTeleportWhere\t${mission.teleportWhere.trim()}`);
  }
  lines.push(`\t\tBeginAtWave\t${mission.beginAtWave}`);
  lines.push(`\t\tRunForThisManyWaves\t${mission.runForThisManyWaves}`);
  lines.push(`\t\tCooldownTime\t${mission.cooldownTime}`);
  lines.push(`\t\tDesiredCount\t${mission.desiredCount}`);

  const slot = filledSlots(mission)[0];
  if (slot) {
    lines.push(`\t\tTFBot`);
    lines.push(`\t\t{`);
    lines.push(`\t\t\tTemplate\t${slot.template}`);
    lines.push(`\t\t}`);
  }

  lines.push(`\t}`);
  lines.push(``);
  return lines;
}

// A typed-in relay name beats whatever was detected off the .bsp. A block whose
// relay is unknown for the selected map is skipped rather than written empty.
function waveOutputLines() {
  const settings = store.getState().settings;
  const start = settings.waveStartRelay.trim() || detectedRelays.start;
  const done = settings.waveDoneRelay.trim() || detectedRelays.done;
  const lines = [];

  const output = (key, target) => {
    lines.push(`\t\t${key}`);
    lines.push(`\t\t{`);
    lines.push(`\t\t\tTarget\t${target}`);
    lines.push(`\t\t\tAction\tTrigger`);
    lines.push(`\t\t}`);
    lines.push(``);
  };

  if (start) output("StartWaveOutput", start);
  if (done) output("DoneOutput", done);

  return lines;
}

function buildWaveBlock(wave, waveNumber) {
  const lines = [];
  lines.push(`\tWave // Wave ${waveNumber}`);
  lines.push(`\t{`);
  lines.push(...waveOutputLines());
  wave.waveSpawns.forEach((spawn) => {
    lines.push(...buildWaveSpawnLines(spawn, 2));
  });
  lines.push(`\t}`);
  lines.push(``);
  return lines;
}

// A slot's Skill is always written out: it is seeded from the template, so it
// matches unless the user changed it. AlwaysCrit is written only when the slot
// adds it -- a template that already declares the attribute needs no restating.
function buildTFBotLines(slot, pad) {
  const lines = [];
  lines.push(`${pad}TFBot`);
  lines.push(`${pad}{`);
  lines.push(`${pad}\tTemplate\t${slot.template}`);
  lines.push(`${pad}\tSkill\t${slot.skill}`);
  if (slot.alwaysCrit && !templateAlwaysCrits(slot.template)) {
    lines.push(`${pad}\tAttributes\tAlwaysCrit`);
  }
  lines.push(`${pad}}`);
  return lines;
}

function buildTankLines(slot, pad) {
  const inner = `${pad}\t`;
  const lines = [];

  const output = (key, target, at) => {
    lines.push(`${at}${key}`);
    lines.push(`${at}{`);
    lines.push(`${at}\tTarget\t${target}`);
    lines.push(`${at}\tAction\tTrigger`);
    lines.push(`${at}}`);
  };

  output("FirstSpawnOutput", TANK_SPAWN_RELAY, pad);
  lines.push(``);

  lines.push(`${pad}Tank`);
  lines.push(`${pad}{`);
  lines.push(`${inner}Health\t${slot.tank.health}`);
  lines.push(`${inner}Speed\t${slot.tank.speed}`);
  lines.push(`${inner}Name\t"${slot.tank.name}"`);

  const node = tankPathFor(slot);
  if (node) lines.push(`${inner}StartingPathTrackNode\t"${node}"`);

  lines.push(``);
  output("OnKilledOutput", TANK_KILLED_RELAY, inner);
  lines.push(``);
  output("OnBombDroppedOutput", TANK_BOMB_RELAY, inner);
  lines.push(`${pad}}`);

  return lines;
}

function buildWaveSpawnLines(spawn, depth) {
  const pad = "\t".repeat(depth);
  const inner = "\t".repeat(depth + 1);
  const lines = [];

  lines.push(`${pad}WaveSpawn`);
  lines.push(`${pad}{`);

  const tankSlot = spawn.robots.find(isTankSlot);

  if (spawn.name.trim()) lines.push(`${inner}Name\t${spawn.name.trim()}`);
  if (spawn.waitForAllDead && spawn.waitForAllDeadName.trim()) {
    lines.push(`${inner}WaitForAllDead\t${spawn.waitForAllDeadName.trim()}`);
  }
  if (spawn.waitForAllSpawned && spawn.waitForAllSpawnedName.trim()) {
    lines.push(`${inner}WaitForAllSpawned\t${spawn.waitForAllSpawnedName.trim()}`);
  }
  // A Tank has no spawn point -- it enters on its path track.
  if (!tankSlot) lines.push(`${inner}Where\t${spawn.where.trim() || "spawnbot"}`);
  lines.push(`${inner}TotalCurrency\t${spawn.totalCurrency}`);
  lines.push(`${inner}TotalCount\t${spawn.totalCount}`);
  lines.push(`${inner}MaxActive\t${spawn.maxActive}`);
  lines.push(`${inner}SpawnCount\t${spawn.spawnCount}`);
  lines.push(`${inner}WaitBeforeStarting\t${spawn.waitBeforeStarting}`);
  lines.push(`${inner}WaitBetweenSpawns\t${spawn.waitBetweenSpawns}`);

  if (tankSlot) {
    lines.push(...buildTankLines(tankSlot, inner));
    lines.push(`${pad}}`);
    return lines;
  }

  const slots = filledSlots(spawn);
  if (spawn.squad && slots.length > 1) {
    lines.push(`${inner}Squad`);
    lines.push(`${inner}{`);
    slots.forEach((slot) => {
      lines.push(...buildTFBotLines(slot, `${inner}\t`));
    });
    lines.push(`${inner}}`);
  } else if (slots.length) {
    lines.push(...buildTFBotLines(slots[0], inner));
  }

  lines.push(`${pad}}`);
  return lines;
}

render();

// Exposed only for this project's ad-hoc Playwright smoke tests (there's no
// test framework here). Not used by the app itself -- safe to ignore.
window.__popgenDebug = {
  generatePopfile,
  getMissingTemplates: () => missingTemplates,
  getState: () => store.getState(),
  store,
  setState: (patch) => {
    store.commit((state) => {
      Object.assign(state, patch);
      waves = state.waves;
      missions = state.missions;
    }, { affects: ["render", "robotList"] });
  },
};
