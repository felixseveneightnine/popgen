const missionNameEl = document.getElementById("missionName");
const startingMoneyEl = document.getElementById("startingMoney");
const respawnWaveTimeEl = document.getElementById("respawnWaveTime");
const difficultyEl = document.getElementById("difficulty");
const mapSelectEl = document.getElementById("mapSelect");
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setWaveDrawer(false);
});

// Start from a state JS owns rather than trusting the markup to match.
setWaveDrawer(false);

const SKILLS = ["Easy", "Normal", "Hard", "Expert"];

// A Tank is not a bot template -- it becomes a Tank block in the WaveSpawn
// rather than a TFBot -- but it is picked from the robot list the same way, so
// it rides along under this sentinel name.
const TANK_TEMPLATE = "Tank";
const TANK_DEFAULTS = { health: 20000, speed: 75, name: "tankboss" };

// Valve's standard tank WaveSpawn wires these three. Only boss_deploy_relay
// actually exists in the stock maps; the other two are convention, and an
// output aimed at a missing entity simply does nothing.
const TANK_SPAWN_RELAY = "boss_spawn_relay";
const TANK_KILLED_RELAY = "boss_dead_relay";
const TANK_BOMB_RELAY = "boss_deploy_relay";

function isTankSlot(slot) {
  return Boolean(slot && slot.template === TANK_TEMPLATE);
}

// A slot holds the chosen template plus the per-robot overrides written into
// its TFBot block. Skill and AlwaysCrit are seeded from the template itself
// when a robot is dropped in (see adoptTemplateDefaults), so a Giant Soldier
// keeps its Expert skill instead of being silently reset to Normal.
function createRobotSlot(template) {
  return {
    template: template || null,
    skill: "Normal",
    alwaysCrit: false,
    tank: { ...TANK_DEFAULTS, node: "" },
  };
}

function normalizeRobotSlot(value) {
  // Saves written before slots became objects stored a bare template name and
  // carry no overrides, so they are flagged to be seeded from their template
  // once the template bodies have loaded.
  if (typeof value === "string") {
    const legacy = createRobotSlot(value);
    legacy.pendingDefaults = true;
    return legacy;
  }
  if (!value || typeof value !== "object") return createRobotSlot(null);
  const tank = value.tank && typeof value.tank === "object" ? value.tank : {};
  const slot = {
    template: typeof value.template === "string" ? value.template : null,
    skill: SKILLS.includes(value.skill) ? value.skill : "Normal",
    alwaysCrit: Boolean(value.alwaysCrit),
    tank: {
      health: Number.isFinite(tank.health) ? tank.health : TANK_DEFAULTS.health,
      speed: Number.isFinite(tank.speed) ? tank.speed : TANK_DEFAULTS.speed,
      name: typeof tank.name === "string" ? tank.name : TANK_DEFAULTS.name,
      node: typeof tank.node === "string" ? tank.node : "",
    },
  };
  if (value.pendingDefaults) slot.pendingDefaults = true;
  return slot;
}

function createWaveSpawn() {
  return {
    name: "",
    where: "",
    totalCurrency: 100,
    waitForAllDead: false,
    waitForAllDeadName: "",
    waitForAllSpawned: false,
    waitForAllSpawnedName: "",
    spawnCount: 1,
    maxActive: 1,
    totalCount: 1,
    waitBetweenSpawns: 1,
    waitBeforeStarting: 0,
    squad: false,
    robots: [createRobotSlot()],
    activeSlot: 0,
  };
}

function createWave() {
  return { waveSpawns: [createWaveSpawn()], activeWaveSpawnIndex: 0 };
}

function createMission(beginAtWave) {
  return {
    where: "",
    teleportWhere: "",
    beginAtWave,
    runForThisManyWaves: 1,
    cooldownTime: 1,
    desiredCount: 1,
    robots: [createRobotSlot()],
    activeSlot: 0,
  };
}

let waves = [createWave()];
let activeWaveIndex = 0;
let missions = [];
let activeMissionIndex = 0;
let activeTabType = "wave"; // "wave" | "mission"
let mapsByName = {};
let robotGroups = [];
let robotIconByName = {};
let robotTemplateByName = {};
let activeRobotTabIndex = 0;
let missingTemplates = [];
// Read off the selected map's .bsp. The relays fill the two inputs'
// placeholders (a typed value overrides them); the tank paths populate the
// Starting Path Track Node dropdown.
let detectedRelays = { start: "", done: "" };
let tankPaths = [];
const mapInfoByMap = {};

// --- Persistence -----------------------------------------------------------
// The whole editor state lives in localStorage so a refresh picks up where the
// user left off. Saved waves/missions are merged onto freshly created defaults
// so states written before a field existed still load.
const STORAGE_KEY = "tf2-popfile-generator/state";
let savedMapName = null;
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

function saveState() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        settings: {
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
        },
        waves,
        missions,
        activeWaveIndex,
        activeMissionIndex,
        activeTabType,
      })
    );
  } catch (err) {
    // Storage unavailable (private mode, quota) — editing still works.
  }
}

function mergeDefaults(defaults, saved) {
  if (!saved || typeof saved !== "object") return defaults;
  const out = { ...defaults };
  Object.keys(defaults).forEach((key) => {
    if (saved[key] !== undefined && saved[key] !== null) out[key] = saved[key];
  });
  if (Array.isArray(out.robots)) {
    out.robots = out.robots.map(normalizeRobotSlot);
  }
  if (!Array.isArray(out.robots) || !out.robots.length) out.robots = [createRobotSlot()];
  out.activeSlot = clampIndex(out.activeSlot, out.robots.length);
  return out;
}

function clampIndex(index, length) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= length) return 0;
  return n;
}

function loadState() {
  let saved;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!saved || typeof saved !== "object") return;

  const settings = saved.settings || {};
  if (typeof settings.missionName === "string") missionNameEl.value = settings.missionName;
  if (typeof settings.startingMoney === "string") startingMoneyEl.value = settings.startingMoney;
  if (typeof settings.respawnWaveTime === "string") respawnWaveTimeEl.value = settings.respawnWaveTime;
  if (typeof settings.difficulty === "string") difficultyEl.value = settings.difficulty;
  canBotsAttackInSpawnRoomEl.checked = Boolean(settings.canBotsAttackInSpawnRoom);
  halloweenEl.checked = Boolean(settings.halloween);
  fixedRespawnWaveTimeEl.checked = Boolean(settings.fixedRespawnWaveTime);
  if (typeof settings.sentryBusterDamage === "string") sentryBusterDamageEl.value = settings.sentryBusterDamage;
  if (typeof settings.sentryBusterKills === "string") sentryBusterKillsEl.value = settings.sentryBusterKills;
  if (typeof settings.advancedFlag === "string") advancedFlagEl.value = settings.advancedFlag;
  if (typeof settings.waveStartRelay === "string") waveStartRelayEl.value = settings.waveStartRelay;
  if (typeof settings.waveDoneRelay === "string") waveDoneRelayEl.value = settings.waveDoneRelay;
  // The map <select> is still empty here; loadMaps() applies this once filled.
  savedMapName = typeof settings.map === "string" ? settings.map : null;

  if (Array.isArray(saved.waves) && saved.waves.length) {
    waves = saved.waves.map((wave) => {
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
    missions = saved.missions.map((mission) =>
      mergeDefaults(createMission(activeWaveIndex + 1), mission)
    );
  }

  activeWaveIndex = clampIndex(saved.activeWaveIndex, waves.length);
  activeMissionIndex = clampIndex(saved.activeMissionIndex, Math.max(missions.length, 1));
  activeTabType = saved.activeTabType === "mission" && missions.length ? "mission" : "wave";
}

[
  missionNameEl,
  startingMoneyEl,
  respawnWaveTimeEl,
  difficultyEl,
  mapSelectEl,
  canBotsAttackInSpawnRoomEl,
  halloweenEl,
  fixedRespawnWaveTimeEl,
  sentryBusterDamageEl,
  sentryBusterKillsEl,
  advancedFlagEl,
  waveStartRelayEl,
  waveDoneRelayEl,
].forEach((el) => {
  el.addEventListener("input", scheduleSave);
  el.addEventListener("change", scheduleSave);
});

// Starting Currency is echoed above the wave bars.
startingMoneyEl.addEventListener("input", renderWaveBar);

loadState();

// Tab order follows this list.
const ROBOT_SOURCES = [
  { file: "templates/robot_standard.pop", label: "Common", requiresGatebot: false },
  { file: "templates/robot_minigiant.pop", label: "Minigiants", requiresGatebot: false },
  { file: "templates/robot_giant.pop", label: "Giant", requiresGatebot: false },
  { file: "templates/robot_boss.pop", label: "Boss", requiresGatebot: false },
  { file: "templates/robot_standard_support.pop", label: "Support", requiresGatebot: false },
  { file: "templates/robot_gatebot.pop", label: "Gatebot", requiresGatebot: true },
];

// Which tabs the robot picker offers depends on what is being filled in: a
// WaveSpawn takes wave robots, a Mission takes support robots.
const WAVE_ROBOT_TABS = ["Common", "Minigiants", "Giant", "Boss", "Gatebot"];
const MISSION_ROBOT_TABS = ["Support", "Gatebot"];

// Templates that belong in Support regardless of the file they live in (the
// Sentry Buster sits in robot_giant.pop but is only ever used via a
// DestroySentries Mission).
const SUPPORT_TEMPLATES = ["T_TFBot_SentryBuster"];

// Whole classes that are only ever used as support. Engineers are still defined
// in robot_standard.pop, but they belong under Support, not Common.
const SUPPORT_ONLY_CLASSES = ["engineer"];

// Every robot list is grouped by class in this order.
const CLASS_ORDER = [
  "scout",
  "soldier",
  "pyro",
  "demoman",
  "heavyweapons",
  "engineer",
  "medic",
  "sniper",
  "spy",
];

// The .pop files spell a few classes more than one way.
const CLASS_ALIASES = { demo: "demoman", heavy: "heavyweapons" };

// The slots that actually carry a robot, in slot order.
function filledSlots(spawn) {
  return spawn.robots.filter((slot) => slot && slot.template);
}

// Seeds a slot's overrides from the template it was just given, so the form
// shows what the robot really is rather than a blanket "Normal".
function adoptTemplateDefaults(slot) {
  if (!slot || !slot.template) return;
  const body = robotTemplateByName[slot.template];
  const skill = body ? findEntry(body, "Skill") : undefined;
  slot.skill = SKILLS.includes(skill) ? skill : "Normal";
  const meta = robotIconByName[slot.template];
  slot.alwaysCrit = Boolean(meta && meta.crit);
}

// A Tank is not a bot: it cannot be squadded, and a WaveSpawn carries exactly
// one. Dropping one in collapses the WaveSpawn to that single slot.
function applyTankConstraints(spawn) {
  if (!spawn || spawn.squad === undefined) return;

  const tank = spawn.robots.find(isTankSlot);
  if (!tank) return;

  spawn.squad = false;
  spawn.robots = [tank];
  spawn.activeSlot = 0;
}

// Giants (Attributes MiniBoss) are fixed-skill by design, so their Skill is
// shown but not editable.
function isGiantTemplate(name) {
  const meta = robotIconByName[name];
  return Boolean(meta && meta.giant);
}

// A template that already declares AlwaysCrit can never have it taken away by
// the TFBot block, so the toggle is shown ticked but locked rather than
// pretending it can be turned off.
function templateAlwaysCrits(name) {
  const meta = robotIconByName[name];
  return Boolean(meta && meta.crit);
}

// Fills in overrides for slots restored from a save that predates them.
// Returns whether anything changed, so the form can be redrawn.
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

  return changed;
}

function normalizeClass(className) {
  const c = (className || "").toLowerCase();
  return CLASS_ALIASES[c] || c;
}

function classRank(name) {
  const meta = robotIconByName[name];
  const index = CLASS_ORDER.indexOf(meta ? meta.className : "");
  return index === -1 ? CLASS_ORDER.length : index;
}

// Stable sort, so templates keep their file order within a class.
function sortByClass(names) {
  return names
    .map((name, i) => ({ name, i }))
    .sort((a, b) => classRank(a.name) - classRank(b.name) || a.i - b.i)
    .map((entry) => entry.name);
}

loadMaps().then(() => {
  loadRobots();
  refreshMapInfo();
});
mapSelectEl.addEventListener("change", () => {
  loadRobots();
  refreshMapInfo();
});

async function loadMaps() {
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
  } catch (err) {
    mapSelectEl.innerHTML = `<option value="" disabled selected>Failed to load maps</option>`;
  }
}

async function refreshMapInfo() {
  const mapName = mapSelectEl.value;
  if (!mapName) return;

  if (!mapInfoByMap[mapName]) {
    waveStartRelayEl.placeholder = "reading map...";
    waveDoneRelayEl.placeholder = "reading map...";
    try {
      const text = await readBspEntityLump(`maps/mvm_${mapName}.bsp`);
      mapInfoByMap[mapName] = {
        relays: findWaveRelays(bspRelayNames(text)),
        tankPaths: findTankPathStarts(text),
      };
    } catch (err) {
      mapInfoByMap[mapName] = { relays: { start: "", done: "" }, tankPaths: [] };
    }
  }

  // The map may have been changed again while the .bsp was in flight.
  if (mapSelectEl.value !== mapName) return;

  const info = mapInfoByMap[mapName];
  detectedRelays = info.relays;
  tankPaths = info.tankPaths;
  waveStartRelayEl.placeholder = detectedRelays.start || "none found in map";
  waveDoneRelayEl.placeholder = detectedRelays.done || "none found in map";

  // The tank path dropdown, and whether the Tank is offered at all, can only be
  // settled once the .bsp has been read.
  render();
  renderRobotList();
}

async function loadRobots() {
  robotListEl.innerHTML = `<p class="robot-list-empty">Loading robots...</p>`;

  const selectedMap = mapsByName[mapSelectEl.value];
  const supportsGatebot = Boolean(selectedMap && selectedMap.gatebot);

  const sources = ROBOT_SOURCES.filter((s) => !s.requiresGatebot || supportsGatebot);

  const fetched = await Promise.all(
    sources.map(async (source) => {
      try {
        const res = await fetch(source.file);
        const text = await res.text();
        return { label: source.label, templates: extractTemplates(text) };
      } catch (err) {
        return { label: source.label, templates: [] };
      }
    })
  );

  robotIconByName = {};
  robotTemplateByName = {};
  const strays = [];
  const groups = fetched.map(({ label, templates }) => {
    const robots = [];
    templates.forEach(({ name, className, classIcon, attributes, body }) => {
      const attrs = attributes || [];
      robotTemplateByName[name] = body || [];
      robotIconByName[name] = {
        candidates: iconCandidates(classIcon, className),
        className: normalizeClass(className),
        giant: attrs.includes("miniboss"),
        crit: attrs.some((a) => a.startsWith("alwayscrit")),
      };
      const supportOnly =
        SUPPORT_TEMPLATES.includes(name) ||
        SUPPORT_ONLY_CLASSES.includes(normalizeClass(className));
      if (supportOnly && label !== "Support") {
        strays.push(name);
      } else {
        robots.push(name);
      }
    });
    return { label, names: robots };
  });

  // The Engineers are defined in both robot_standard.pop and
  // robot_standard_support.pop, so a name can arrive twice — list it once.
  const supportGroup = groups.find((g) => g.label === "Support");
  if (supportGroup) {
    strays.forEach((name) => {
      if (!supportGroup.names.includes(name)) supportGroup.names.push(name);
    });
  } else if (strays.length) {
    groups.push({ label: "Support", names: [...new Set(strays)] });
  }

  groups.forEach((group) => {
    group.names = sortByClass(group.names);
  });

  // Added after sorting so it heads the tab: the Tank has no class to sort by.
  robotIconByName[TANK_TEMPLATE] = {
    candidates: ["icons/leaderboard_class_tank.png"],
    className: "",
    giant: true,
    crit: false,
  };
  const bossGroup = groups.find((g) => g.label === "Boss");
  if (bossGroup) bossGroup.names.unshift(TANK_TEMPLATE);

  robotGroups = groups;
  activeRobotTabIndex = 0;
  applyPendingSlotDefaults();

  // Everything drawn before this point was drawn without template metadata:
  // the first render() runs synchronously at startup while this fetch is still
  // in flight, so a restored save had no icons, no giant/crit styling and no
  // derived Skill. Repaint now that robotIconByName is populated.
  render();
  renderRobotList();
}

// Icon files are named leaderboard_class_<icon>.png, while ClassIcon values in
// the .pop files omit that prefix. Giant variants (scout_giant, scout_stun_giant_armored)
// have no file of their own and reuse the non-giant art, and templates with no
// ClassIcon at all fall back to their Class's default icon.
const CLASS_DEFAULT_ICON = {
  scout: "scout",
  soldier: "soldier",
  pyro: "pyro",
  demoman: "demo",
  demo: "demo",
  heavyweapons: "heavy",
  heavy: "heavy",
  engineer: "engineer",
  medic: "medic",
  sniper: "sniper",
  spy: "spy",
};

function iconCandidates(classIcon, className) {
  const names = [];
  if (classIcon) {
    names.push(classIcon);
    if (classIcon.includes("_giant")) names.push(classIcon.replace("_giant", ""));
    if (classIcon.endsWith("_g")) names.push(classIcon.slice(0, -2));
  }
  const fallback = CLASS_DEFAULT_ICON[(className || "").toLowerCase()];
  if (fallback) names.push(fallback);

  return [...new Set(names)].map((n) => `icons/leaderboard_class_${n}.png`);
}

// `alwaysCrit` overrides the template's own crit state, so a bot given
// AlwaysCrit in its slot still gets the crit ring. Omit it to use the template.
function robotIcon(name, alwaysCrit) {
  const meta = robotIconByName[name];
  const candidates = meta ? meta.candidates : null;
  if (!candidates || !candidates.length) return null;

  const crit = alwaysCrit === undefined ? meta.crit : alwaysCrit;
  const img = document.createElement("img");
  img.className =
    "robot-icon" + (meta.giant ? " giant" : "") + (crit ? " crit" : "");
  img.alt = "";

  let index = 0;
  img.src = candidates[index];
  img.addEventListener("error", () => {
    index += 1;
    if (index < candidates.length) {
      img.src = candidates[index];
    } else {
      img.remove();
    }
  });

  return img;
}

let lastRobotContext = null;

function getVisibleRobotGroups() {
  const allowed = activeTabType === "mission" ? MISSION_ROBOT_TABS : WAVE_ROBOT_TABS;
  return robotGroups.filter((g) => allowed.includes(g.label));
}

function renderRobotTabs() {
  if (lastRobotContext !== activeTabType) {
    activeRobotTabIndex = 0;
    lastRobotContext = activeTabType;
  }

  const groups = getVisibleRobotGroups();
  if (activeRobotTabIndex >= groups.length) {
    activeRobotTabIndex = Math.max(0, groups.length - 1);
  }

  robotTabsEl.innerHTML = "";

  groups.forEach((group, i) => {
    const tab = document.createElement("div");
    tab.className = "robot-tab" + (i === activeRobotTabIndex ? " active" : "");
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
    itemName.textContent = name;
    item.appendChild(itemName);
    item.title = name;
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
  if (activeTabType === "wave") {
    const wave = waves[activeWaveIndex];
    return wave ? wave.waveSpawns[wave.activeWaveSpawnIndex] : null;
  }
  if (activeTabType === "mission") {
    return missions[activeMissionIndex] || null;
  }
  return null;
}

function selectRobot(name) {
  const target = getActiveRobotTarget();
  if (!target) return;
  const slot = target.robots[target.activeSlot];
  slot.template = name;
  adoptTemplateDefaults(slot);
  applyTankConstraints(target);
  syncSquadCount(target);
  renderWaveSpawns();
  renderRobotList();
}

document.getElementById("addWaveBtn").addEventListener("click", () => {
  waves.push(createWave());
  activeWaveIndex = waves.length - 1;
  activeTabType = "wave";
  render();
  renderRobotList();
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
  const mapName = mapSelectEl.value || "map";
  const difficulty = difficultyEl.value || "normal";
  const missionName = missionNameEl.value.trim() || "mission";

  return `mvm_${mapName}_${difficulty}_${missionName}.pop`.toLowerCase();
}

function selectWave(index) {
  activeWaveIndex = index;
  activeTabType = "wave";
  setWaveDrawer(false);
  render();
  renderRobotList();
}

function removeWave(index) {
  if (waves.length <= 1) return;
  waves.splice(index, 1);
  if (activeWaveIndex >= waves.length) {
    activeWaveIndex = waves.length - 1;
  }
  render();
  renderRobotList();
}

function render() {
  scheduleSave();
  waveTabsEl.innerHTML = "";

  waves.forEach((_, i) => {
    const tab = document.createElement("div");
    const active = activeTabType === "wave" && i === activeWaveIndex;
    tab.className = "wave-tab" + (active ? " active" : "");
    tab.addEventListener("click", () => selectWave(i));

    const label = document.createElement("span");
    label.className = "wave-tab-label";
    label.textContent = `Wave #${i + 1}`;
    tab.appendChild(label);

    if (waves.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "wave-tab-remove";
      removeBtn.textContent = "×";
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
  missionTabsEl.innerHTML = "";

  missions.forEach((_, i) => {
    const tab = document.createElement("div");
    const active = activeTabType === "mission" && i === activeMissionIndex;
    tab.className = "wave-tab" + (active ? " active" : "");
    tab.addEventListener("click", () => {
      activeMissionIndex = i;
      activeTabType = "mission";
      render();
      renderRobotList();
    });

    const label = document.createElement("span");
    label.className = "wave-tab-label";
    label.textContent = `Support #${i + 1}`;
    tab.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "wave-tab-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      missions.splice(i, 1);
      if (activeMissionIndex >= missions.length) {
        activeMissionIndex = missions.length - 1;
      }
      if (!missions.length) activeTabType = "wave";
      render();
      renderRobotList();
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
  missions.push(createMission(activeWaveIndex + 1));
  activeMissionIndex = missions.length - 1;
  activeTabType = "mission";
  render();
  renderRobotList();
});

function renderWaveSpawns() {
  scheduleSave();
  waveContentEl.innerHTML = "";

  const wave = waves[activeWaveIndex];

  const bar = document.createElement("div");
  bar.className = "wavespawn-tab-bar";

  const addBtn = document.createElement("button");
  addBtn.className = "wavespawn-tab-add";
  addBtn.title = "Add WaveSpawn";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    wave.waveSpawns.push(createWaveSpawn());
    wave.activeWaveSpawnIndex = wave.waveSpawns.length - 1;
    activeTabType = "wave";
    render();
    renderRobotList();
  });
  bar.appendChild(addBtn);

  const tabsWrap = document.createElement("div");
  tabsWrap.className = "wavespawn-tabs";

  wave.waveSpawns.forEach((_, i) => {
    const tab = document.createElement("div");
    tab.className = "wavespawn-tab" + (activeTabType === "wave" && i === wave.activeWaveSpawnIndex ? " active" : "");
    tab.addEventListener("click", () => {
      wave.activeWaveSpawnIndex = i;
      activeTabType = "wave";
      render();
      renderRobotList();
    });

    const label = document.createElement("span");
    label.textContent = `WaveSpawn #${i + 1}`;
    tab.appendChild(label);

    if (wave.waveSpawns.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "wavespawn-tab-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        wave.waveSpawns.splice(i, 1);
        if (wave.activeWaveSpawnIndex >= wave.waveSpawns.length) {
          wave.activeWaveSpawnIndex = wave.waveSpawns.length - 1;
        }
        renderWaveSpawns();
        renderRobotList();
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

function textInput(value, onInput, placeholder) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.spellcheck = false;
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", (e) => {
    onInput(e.target.value);
    scheduleSave();
  });
  return input;
}

function selectInput(options, value, onChange) {
  const select = document.createElement("select");
  options.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt;
    optionEl.textContent = opt;
    if (opt === value) optionEl.selected = true;
    select.appendChild(optionEl);
  });
  select.addEventListener("change", (e) => {
    onChange(e.target.value);
    scheduleSave();
  });
  return select;
}

function numberInput(value, onInput, min, placeholder) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  if (min !== undefined) input.min = min;
  if (placeholder !== undefined) input.placeholder = placeholder;
  input.addEventListener("input", (e) => {
    onInput(parseInt(e.target.value, 10) || 0);
    scheduleSave();
  });
  return input;
}

function checkboxRow(labelText, checked, onChange) {
  const row = document.createElement("label");
  row.className = "checkbox-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", (e) => {
    onChange(e.target.checked);
    scheduleSave();
  });
  row.appendChild(input);
  row.appendChild(document.createTextNode(labelText));
  return row;
}

// TotalCount counts individual bots, not squads. A Squad puts SpawnCount bots
// on the field at a time -- one full squad -- so the WaveSpawn holds
// TotalCount / SpawnCount squads and each slot contributes that many bots. A
// squad of five at TotalCount 5 is one squad: one bot per slot, not five.
// A non-squad WaveSpawn only ever uses its first robot, TotalCount times.
function countWaveRobots(wave) {
  // Keyed by template *and* crit state: the same robot with and without crits
  // reads as two different threats, so they get their own entries.
  const counts = new Map();

  const add = (slot, amount) => {
    const crit = Boolean(slot.alwaysCrit);
    const key = `${slot.template}|${crit}`;
    const entry = counts.get(key) || { template: slot.template, crit, count: 0 };
    entry.count += amount;
    counts.set(key, entry);
  };

  wave.waveSpawns.forEach((spawn) => {
    const slots = filledSlots(spawn);
    if (!slots.length) return;

    const total = spawn.totalCount || 0;

    if (spawn.squad && slots.length > 1) {
      const perSquad = spawn.spawnCount || slots.length;
      const squads = Math.max(1, Math.floor(total / perSquad));
      slots.forEach((slot) => add(slot, squads));
      return;
    }

    add(slots[0], total);
  });

  return counts;
}

// A wave's payout is what its WaveSpawns hand out; Missions carry no currency.
function waveCurrency(wave) {
  return wave.waveSpawns.reduce((sum, spawn) => sum + (spawn.totalCurrency || 0), 0);
}

function activeSupportForWave(waveNumber) {
  return missions.filter((mission) => {
    const start = mission.beginAtWave;
    const span = mission.runForThisManyWaves || 1;
    return waveNumber >= start && waveNumber < start + span;
  });
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
  const starting = parseInt(startingMoneyEl.value, 10) || 0;
  startingCurrencyEl.textContent = `Starting Currency: $${starting}`;

  waveBarEl.innerHTML = "";
  waves.forEach((wave, i) => waveBarEl.appendChild(buildWaveBar(wave, i)));
}

function buildWaveBar(wave, index) {
  const waveNumber = index + 1;
  const counts = countWaveRobots(wave);
  const support = activeSupportForWave(waveNumber);

  const bar = document.createElement("div");
  bar.className = "wavebar" + (index === activeWaveIndex ? " active" : "");
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
    const title = `${template} x${count}${crit ? " (crits)" : ""}`;
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
      icons.appendChild(waveBarRobot(label, "∞", `${label} (${objective || "no robot"})`));
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
    checkboxRow("Wait For All Dead", spawn.waitForAllDead, (checked) => {
      spawn.waitForAllDead = checked;
      renderWaveSpawns();
    })
  );
  if (spawn.waitForAllDead) {
    form.appendChild(
      formRow(
        "WaveSpawn Name",
        textInput(spawn.waitForAllDeadName, (v) => {
          spawn.waitForAllDeadName = v;
        }),
        "indent"
      )
    );
  }

  form.appendChild(
    checkboxRow("Wait For All Spawned", spawn.waitForAllSpawned, (checked) => {
      spawn.waitForAllSpawned = checked;
      renderWaveSpawns();
    })
  );
  if (spawn.waitForAllSpawned) {
    form.appendChild(
      formRow(
        "WaveSpawn Name",
        textInput(spawn.waitForAllSpawnedName, (v) => {
          spawn.waitForAllSpawnedName = v;
        }),
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
          renderWaveBar();
        },
        1
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
          renderWaveBar();
        },
        0,
        100
      )
    )
  );
  form.appendChild(timingGroup);

  if (!tankSlot) {
    form.appendChild(
      checkboxRow("Squad", spawn.squad, (checked) => {
      spawn.squad = checked;
      if (!checked) spawn.robots = [spawn.robots[spawn.activeSlot] || spawn.robots[0] || createRobotSlot()];
      spawn.activeSlot = 0;
      syncSquadCount(spawn);
        renderWaveSpawns();
        renderRobotList(); // Medics appear/disappear with the Squad toggle.
      })
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

// A support Mission's Objective is dictated by the robot in it, so it is derived
// rather than chosen: the Sentry Buster is the DestroySentries mission and
// everything else goes by class. A robot with no support role of its own (a
// gatebot, say) falls back to Sniper, the objective that just patrols.
const OBJECTIVE_BY_CLASS = {
  engineer: "Engineer",
  spy: "Spy",
  sniper: "Sniper",
};

function missionObjective(mission) {
  const slot = filledSlots(mission)[0];
  if (!slot) return "";
  if (SUPPORT_TEMPLATES.includes(slot.template)) return "DestroySentries";
  const meta = robotIconByName[slot.template];
  return OBJECTIVE_BY_CLASS[meta ? meta.className : ""] || "Sniper";
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
          renderWaveBar();
        },
        1
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

// A Squad spawns as one group, so all three counts follow the number of robots
// in it -- a squad of five is TotalCount 5 / MaxActive 5 / SpawnCount 5, i.e.
// one squad on the field at a time. Non-squad WaveSpawns are untouched, and
// this only runs when squad membership actually changes, so manual edits
// survive until the next robot is added or removed.
function syncSquadCount(spawn) {
  if (!spawn || !spawn.squad) return;
  const count = filledSlots(spawn).length;
  if (!count) return;
  spawn.totalCount = count;
  spawn.maxActive = count;
  spawn.spawnCount = count;
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
    slotData.alwaysCrit = e.target.checked;
    scheduleSave();
    renderWaveSpawns();
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
      spawn.activeSlot = i;
      renderWaveSpawns();
      renderRobotList();
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
      spawn.robots[i].template = name;
      adoptTemplateDefaults(spawn.robots[i]);
      applyTankConstraints(spawn);
      syncSquadCount(spawn);
      renderWaveSpawns();
      renderRobotList();
    });

    const labelWrap = document.createElement("span");
    labelWrap.className = "robot-slot-label";
    if (robotName) {
      const icon = robotIcon(robotName, slotData.alwaysCrit);
      if (icon) labelWrap.appendChild(icon);
    }
    const slotName = document.createElement("span");
    slotName.className = "robot-slot-name";
    slotName.textContent = robotName || "Click or drag a robot here";
    labelWrap.appendChild(slotName);
    if (robotName) slot.title = robotName;
    slot.appendChild(labelWrap);

    if (spawn.squad && spawn.robots.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "robot-slot-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        spawn.robots.splice(i, 1);
        if (spawn.activeSlot >= spawn.robots.length) {
          spawn.activeSlot = spawn.robots.length - 1;
        }
        syncSquadCount(spawn);
        renderWaveSpawns();
        renderRobotList();
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
      spawn.robots.push(createRobotSlot());
      spawn.activeSlot = spawn.robots.length - 1;
      syncSquadCount(spawn);
      renderWaveSpawns();
      renderRobotList();
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
      const added = createRobotSlot(name);
      adoptTemplateDefaults(added);
      spawn.robots.push(added);
      spawn.activeSlot = spawn.robots.length - 1;
      applyTankConstraints(spawn);
      syncSquadCount(spawn);
      renderWaveSpawns();
      renderRobotList();
    });
    wrap.appendChild(addBtn);
  }

  return wrap;
}

function generatePopfile() {
  const startingMoney = parseInt(startingMoneyEl.value, 10) || 0;
  const respawnWaveTime = parseInt(respawnWaveTimeEl.value, 10) || 6;
  const canBotsAttackInSpawnRoom = canBotsAttackInSpawnRoomEl.checked ? "yes" : "no";

  const optionalLines = [];

  if (halloweenEl.checked) optionalLines.push(`\tEventPopfile\tHalloween`);
  if (fixedRespawnWaveTimeEl.checked) {
    optionalLines.push(`\tFixedRespawnWaveTime\tYes`);
  }

  if (sentryBusterDamageEl.value.trim() !== "") {
    const v = parseInt(sentryBusterDamageEl.value, 10);
    if (!isNaN(v)) optionalLines.push(`\tAddSentryBusterWhenDamageDealtExceeds\t${v}`);
  }

  if (sentryBusterKillsEl.value.trim() !== "") {
    const v = parseInt(sentryBusterKillsEl.value, 10);
    if (!isNaN(v)) optionalLines.push(`\tAddSentryBusterWhenKillCountExceeds\t${v}`);
  }

  if (parseInt(advancedFlagEl.value, 10) === 1) {
    optionalLines.push(`\tAdvanced\t1`);
  }

  const missionBlocks = missions.flatMap((mission) => buildMissionBlock(mission));
  const waveBlocks = waves.flatMap((wave, i) => buildWaveBlock(wave, i + 1));

  // Templates are written into the mission itself rather than pulled in with a
  // #base, so the .pop is self-contained.
  const used = usedTemplateNames();
  const defined = used.filter((name) => robotTemplateByName[name]);
  missingTemplates = used.filter((name) => !robotTemplateByName[name]);

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
    lines.push(...serializePopEntries(robotTemplateByName[name], 3));
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
  const start = waveStartRelayEl.value.trim() || detectedRelays.start;
  const done = waveDoneRelayEl.value.trim() || detectedRelays.done;
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
