import { findEntry } from "../parsers/popParser.js";
import { getRobotIconByName, getRobotTemplateByName, SUPPORT_TEMPLATES } from "../robots/robotLibrary.js";
import { SKILLS, TANK_TEMPLATE, isTankSlot } from "./factories.js";

// The slots that actually carry a robot, in slot order.
export function filledSlots(spawn) {
  return spawn.robots.filter((slot) => slot && slot.template);
}

// A Squad spawns as one group, so all three counts follow the number of robots
// in it -- a squad of five is TotalCount 5 / MaxActive 5 / SpawnCount 5, i.e.
// one squad on the field at a time. Non-squad WaveSpawns are untouched, and
// this only runs when squad membership actually changes, so manual edits
// survive until the next robot is added or removed.
export function syncSquadCount(spawn) {
  if (!spawn || !spawn.squad) return;
  const count = filledSlots(spawn).length;
  if (!count) return;
  spawn.totalCount = count;
  spawn.maxActive = count;
  spawn.spawnCount = count;
}

// A Tank is not a bot: it cannot be squadded, and a WaveSpawn carries exactly
// one. Dropping one in collapses the WaveSpawn to that single slot.
export function applyTankConstraints(spawn) {
  if (!spawn || spawn.squad === undefined) return;

  const tank = spawn.robots.find(isTankSlot);
  if (!tank) return;

  spawn.squad = false;
  spawn.robots = [tank];
  spawn.activeSlot = 0;
}

// TotalCount counts individual bots, not squads. A Squad puts SpawnCount bots
// on the field at a time -- one full squad -- so the WaveSpawn holds
// TotalCount / SpawnCount squads and each slot contributes that many bots. A
// squad of five at TotalCount 5 is one squad: one bot per slot, not five.
// A non-squad WaveSpawn only ever uses its first robot, TotalCount times.
export function countWaveRobots(wave) {
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
export function waveCurrency(wave) {
  return wave.waveSpawns.reduce((sum, spawn) => sum + (spawn.totalCurrency || 0), 0);
}

// WaitForAllDead/WaitForAllSpawned reference another WaveSpawn in the same
// Wave by its Name -- a typo or a since-renamed/removed sibling leaves it
// pointing at nothing, so the WaveSpawn just fires immediately instead of
// waiting. An empty name isn't "dangling", just not filled in yet.
export function waveSpawnNameExists(wave, name, excludeSpawn) {
  const trimmed = (name || "").trim();
  if (!trimmed) return true;
  return wave.waveSpawns.some((s) => s !== excludeSpawn && s.name.trim() === trimmed);
}

export function activeSupportForWave(missions, waveNumber) {
  return missions.filter((mission) => {
    const start = mission.beginAtWave;
    const span = mission.runForThisManyWaves || 1;
    return waveNumber >= start && waveNumber < start + span;
  });
}

// Giants (Attributes MiniBoss) are fixed-skill by design, so their Skill is
// shown but not editable.
export function isGiantTemplate(name) {
  const meta = getRobotIconByName()[name];
  return Boolean(meta && meta.giant);
}

// A template that already declares AlwaysCrit can never have it taken away by
// the TFBot block, so the toggle is shown ticked but locked rather than
// pretending it can be turned off.
export function templateAlwaysCrits(name) {
  const meta = getRobotIconByName()[name];
  return Boolean(meta && meta.crit);
}

// The template's own internal identifier (T_TFBot_Scout_Bonk) is meaningless
// to a player; the in-game "Name" the bot displays over its head is what
// actually identifies it. Falls back to the Class when a template sets no
// Name of its own, and to the raw template name for anything with no body
// at all (the Tank, or a template this session never loaded).
export function robotDisplayName(name) {
  if (!name || name === TANK_TEMPLATE) return name;
  const body = getRobotTemplateByName()[name];
  if (!body) return name;
  const displayName = findEntry(body, "Name");
  if (typeof displayName === "string" && displayName.trim()) return displayName;
  const className = findEntry(body, "Class");
  if (typeof className === "string" && className.trim()) return className;
  return name;
}

// Seeds a slot's overrides from the template it was just given, so the form
// shows what the robot really is rather than a blanket "Normal".
export function adoptTemplateDefaults(slot) {
  if (!slot || !slot.template) return;
  const body = getRobotTemplateByName()[slot.template];
  const skill = body ? findEntry(body, "Skill") : undefined;
  slot.skill = SKILLS.includes(skill) ? skill : "Normal";
  const meta = getRobotIconByName()[slot.template];
  slot.alwaysCrit = Boolean(meta && meta.crit);
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

export function missionObjective(mission) {
  const slot = filledSlots(mission)[0];
  if (!slot) return "";
  if (SUPPORT_TEMPLATES.includes(slot.template)) return "DestroySentries";
  const meta = getRobotIconByName()[slot.template];
  return OBJECTIVE_BY_CLASS[meta ? meta.className : ""] || "Sniper";
}
