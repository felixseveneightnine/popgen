export const SKILLS = ["Easy", "Normal", "Hard", "Expert"];

// A Tank is not a bot template -- it becomes a Tank block in the WaveSpawn
// rather than a TFBot -- but it is picked from the robot list the same way, so
// it rides along under this sentinel name.
export const TANK_TEMPLATE = "Tank";
export const TANK_DEFAULTS = { health: 20000, speed: 75, name: "tankboss" };

export function isTankSlot(slot) {
  return Boolean(slot && slot.template === TANK_TEMPLATE);
}

// A slot holds the chosen template plus the per-robot overrides written into
// its TFBot block. Skill and AlwaysCrit are seeded from the template itself
// when a robot is dropped in (see adoptTemplateDefaults), so a Giant Soldier
// keeps its Expert skill instead of being silently reset to Normal.
export function createRobotSlot(template) {
  return {
    template: template || null,
    skill: "Normal",
    alwaysCrit: false,
    tank: { ...TANK_DEFAULTS, node: "" },
  };
}

export function normalizeRobotSlot(value) {
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

export function createWaveSpawn() {
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

export function createWave() {
  return { waveSpawns: [createWaveSpawn()], activeWaveSpawnIndex: 0 };
}

export function createMission(beginAtWave) {
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

export function clampIndex(index, length) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= length) return 0;
  return n;
}

export function mergeDefaults(defaults, saved) {
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
