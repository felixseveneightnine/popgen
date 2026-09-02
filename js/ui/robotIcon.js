import { getRobotIconByName } from "../robots/robotLibrary.js";

// `alwaysCrit` overrides the template's own crit state, so a bot given
// AlwaysCrit in its slot still gets the crit ring. Omit it to use the template.
export function robotIcon(name, alwaysCrit) {
  const meta = getRobotIconByName()[name];
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
