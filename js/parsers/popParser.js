export function stripPopComments(text) {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      out += c;
      continue;
    }
    if (!inQuotes && c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

export function tokenizePop(text) {
  const tokens = [];
  const re = /"([^"]*)"|(\{)|(\})|(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2]) tokens.push("{");
    else if (m[3]) tokens.push("}");
    else tokens.push(m[4]);
  }
  return tokens;
}

export function parsePopBlock(tokens, pos) {
  const entries = [];
  while (pos < tokens.length && tokens[pos] !== "}") {
    const key = tokens[pos++];
    if (tokens[pos] === "{") {
      pos++;
      const result = parsePopBlock(tokens, pos);
      pos = result.pos;
      entries.push([key, result.entries]);
    } else {
      entries.push([key, tokens[pos++]]);
    }
  }
  if (tokens[pos] === "}") pos++;
  return { entries, pos };
}

export function parsePop(text) {
  const tokens = tokenizePop(stripPopComments(text));
  return parsePopBlock(tokens, 0).entries;
}

export function findEntry(entries, key) {
  const found = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
  return found ? found[1] : undefined;
}

// Collects every value for a key anywhere in the subtree. Gate-bot templates nest
// their Attributes inside EventChangeAttributes { Default { ... } }, so a
// top-level lookup would miss them.
export function collectValues(entries, key, out) {
  const results = out || [];
  entries.forEach(([k, v]) => {
    if (Array.isArray(v)) {
      collectValues(v, key, results);
    } else if (k.toLowerCase() === key.toLowerCase()) {
      results.push(v);
    }
  });
  return results;
}

export function extractTemplates(text) {
  const root = parsePop(text);
  const waveSchedule = findEntry(root, "WaveSchedule");
  if (!Array.isArray(waveSchedule)) return [];

  const templates = findEntry(waveSchedule, "Templates");
  if (!Array.isArray(templates)) return [];

  return templates.map(([name, entries]) => {
    const block = Array.isArray(entries) ? entries : [];
    const className = findEntry(block, "Class");
    const classIcon = findEntry(block, "ClassIcon");
    const attributes = collectValues(block, "Attributes").map((a) => String(a).toLowerCase());
    // `body` is the parsed block, kept so the generator can write the template
    // back out into the mission's own Templates section.
    return { name, className, classIcon, attributes, body: block };
  });
}

// Bare tokens stay bare; anything with whitespace, quotes or braces (attribute
// names like "fire rate bonus", or a Name with spaces) gets quoted the way the
// source files write it. Comments are dropped -- the parser strips them.
export function quotePopToken(token) {
  const text = String(token);
  return /^[^\s"{}]+$/.test(text) ? text : `"${text.replace(/"/g, "")}"`;
}

// Turns parsed entries back into pop syntax at the given tab depth.
export function serializePopEntries(entries, depth) {
  const pad = "	".repeat(depth);
  const lines = [];

  entries.forEach(([key, value]) => {
    if (Array.isArray(value)) {
      lines.push(`${pad}${quotePopToken(key)}`);
      lines.push(`${pad}{`);
      lines.push(...serializePopEntries(value, depth + 1));
      lines.push(`${pad}}`);
    } else {
      lines.push(`${pad}${quotePopToken(key)}	${quotePopToken(value)}`);
    }
  });

  return lines;
}

export function extractTemplateNames(text) {
  return extractTemplates(text).map((t) => t.name);
}
