import { extractTemplates } from "../parsers/popParser.js";
import { TANK_TEMPLATE } from "../model/factories.js";

// Tab order follows this list.
export const ROBOT_SOURCES = [
  { file: "templates/robot_standard.pop", label: "Common", requiresGatebot: false },
  { file: "templates/robot_minigiant.pop", label: "Minigiants", requiresGatebot: false },
  { file: "templates/robot_giant.pop", label: "Giant", requiresGatebot: false },
  { file: "templates/robot_boss.pop", label: "Boss", requiresGatebot: false },
  { file: "templates/robot_standard_support.pop", label: "Support", requiresGatebot: false },
  { file: "templates/robot_gatebot.pop", label: "Gatebot", requiresGatebot: true },
];

// Which tabs the robot picker offers depends on what is being filled in: a
// WaveSpawn takes wave robots, a Mission takes support robots.
export const WAVE_ROBOT_TABS = ["Common", "Minigiants", "Giant", "Boss", "Gatebot", "Imported"];
export const MISSION_ROBOT_TABS = ["Support", "Gatebot", "Imported"];

// Templates that belong in Support regardless of the file they live in (the
// Sentry Buster sits in robot_giant.pop but is only ever used via a
// DestroySentries Mission).
export const SUPPORT_TEMPLATES = ["T_TFBot_SentryBuster"];

// Whole classes that are only ever used as support. Engineers are still defined
// in robot_standard.pop, but they belong under Support, not Common.
export const SUPPORT_ONLY_CLASSES = ["engineer"];

// Every robot list is grouped by class in this order.
export const CLASS_ORDER = [
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
export const CLASS_ALIASES = { demo: "demoman", heavy: "heavyweapons" };

// Icon files are named leaderboard_class_<icon>.png, while ClassIcon values in
// the .pop files omit that prefix. Giant variants (scout_giant, scout_stun_giant_armored)
// have no file of their own and reuse the non-giant art, and templates with no
// ClassIcon at all fall back to their Class's default icon.
export const CLASS_DEFAULT_ICON = {
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

export function normalizeClass(className) {
  const c = (className || "").toLowerCase();
  return CLASS_ALIASES[c] || c;
}

let robotGroups = [];
let robotIconByName = {};
let robotTemplateByName = {};

export function getRobotGroups() {
  return robotGroups;
}
export function getRobotIconByName() {
  return robotIconByName;
}
export function getRobotTemplateByName() {
  return robotTemplateByName;
}

function classRank(name) {
  const meta = robotIconByName[name];
  const index = CLASS_ORDER.indexOf(meta ? meta.className : "");
  return index === -1 ? CLASS_ORDER.length : index;
}
export { classRank };

// Stable sort, so templates keep their file order within a class.
export function sortByClass(names) {
  return names
    .map((name, i) => ({ name, i }))
    .sort((a, b) => classRank(a.name) - classRank(b.name) || a.i - b.i)
    .map((entry) => entry.name);
}

export function iconCandidates(classIcon, className) {
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

// Folds importedTemplates (from a loaded .pop file) into the freshly-fetched
// stock robot groups. Runs every time loadRobots() rebuilds its maps, since a
// map change wipes robotTemplateByName/robotIconByName from scratch.
export function applyImportedTemplates(groups, importedTemplates) {
  const names = Object.keys(importedTemplates || {});
  if (!names.length) return;

  let imported = groups.find((g) => g.label === "Imported");

  names.forEach((name) => {
    const tpl = importedTemplates[name];
    const attrs = (tpl.attributes || []).map((a) => String(a).toLowerCase());
    robotTemplateByName[name] = tpl.body || [];
    robotIconByName[name] = {
      candidates: iconCandidates(tpl.classIcon, tpl.className),
      className: normalizeClass(tpl.className),
      giant: attrs.includes("miniboss"),
      crit: attrs.some((a) => a.startsWith("alwayscrit")),
    };

    const alreadyListed = groups.some((g) => g.names.includes(name));
    if (alreadyListed) return;

    if (!imported) {
      imported = { label: "Imported", names: [] };
      groups.push(imported);
    }
    if (!imported.names.includes(name)) imported.names.push(name);
  });

  if (imported) imported.names = sortByClass(imported.names);
}

// Fetches every stock robot_*.pop source (gated by whether the map supports
// Gatebot), rebuilds robotIconByName/robotTemplateByName from scratch, and
// folds in importedTemplates (from a loaded .pop file, if any) on top. Returns
// the same shape it stores internally so a caller doesn't have to reach into
// getters immediately after awaiting this.
export async function loadRobots(supportsGatebot, importedTemplates) {
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

  applyImportedTemplates(groups, importedTemplates);

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

  return { groups: robotGroups, iconByName: robotIconByName, templateByName: robotTemplateByName };
}
