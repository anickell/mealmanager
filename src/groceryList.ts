interface UnitInfo {
  category: "weight" | "volume";
  factor: number; // multiply quantity by this to get the base unit (grams for weight, ml for volume)
  gramsEach?: number; // rough weight-per-unit, used only to bridge a count unit into a weight total
}

// Approximate on purpose: a "slice" or "piece" has no fixed weight in general, so gramsEach
// values here are rough kitchen estimates used only when merging with an exact weight amount.
const UNIT_TABLE: Record<string, UnitInfo> = {
  g: { category: "weight", factor: 1 },
  gram: { category: "weight", factor: 1 },
  grams: { category: "weight", factor: 1 },
  kg: { category: "weight", factor: 1000 },
  kilogram: { category: "weight", factor: 1000 },
  kilograms: { category: "weight", factor: 1000 },
  oz: { category: "weight", factor: 28.3495 },
  ounce: { category: "weight", factor: 28.3495 },
  ounces: { category: "weight", factor: 28.3495 },
  lb: { category: "weight", factor: 453.592 },
  lbs: { category: "weight", factor: 453.592 },
  pound: { category: "weight", factor: 453.592 },
  pounds: { category: "weight", factor: 453.592 },

  ml: { category: "volume", factor: 1 },
  milliliter: { category: "volume", factor: 1 },
  milliliters: { category: "volume", factor: 1 },
  l: { category: "volume", factor: 1000 },
  liter: { category: "volume", factor: 1000 },
  liters: { category: "volume", factor: 1000 },
  litre: { category: "volume", factor: 1000 },
  litres: { category: "volume", factor: 1000 },
  cup: { category: "volume", factor: 240 },
  cups: { category: "volume", factor: 240 },
  tbsp: { category: "volume", factor: 15 },
  tablespoon: { category: "volume", factor: 15 },
  tablespoons: { category: "volume", factor: 15 },
  tsp: { category: "volume", factor: 5 },
  teaspoon: { category: "volume", factor: 5 },
  teaspoons: { category: "volume", factor: 5 },

  slice: { category: "weight", factor: 0, gramsEach: 25 },
  slices: { category: "weight", factor: 0, gramsEach: 25 },
  clove: { category: "weight", factor: 0, gramsEach: 5 },
  cloves: { category: "weight", factor: 0, gramsEach: 5 },
  piece: { category: "weight", factor: 0, gramsEach: 50 },
  pieces: { category: "weight", factor: 0, gramsEach: 50 },
  can: { category: "weight", factor: 0, gramsEach: 400 },
  cans: { category: "weight", factor: 0, gramsEach: 400 },
};

const PREP_WORDS = [
  "sliced", "diced", "chopped", "minced", "shredded", "grated", "fresh",
  "frozen", "canned", "cooked", "raw", "large", "small", "medium", "ripe", "peeled",
];

interface ParsedLine {
  quantity: number | null;
  unit: string | null; // canonical key into UNIT_TABLE, or null for a bare count / no quantity
  name: string;
  approximate: boolean; // line itself signaled it's a lower bound / estimate ("at least", "about", ...)
}

const LEADING_FILLER = /^\s*(at least|at most|about|approx\.?|approximately|roughly|around)\s+/i;

function parseLeadingQuantity(rawLine: string): { quantity: number | null; rest: string; approximate: boolean } {
  const approximate = LEADING_FILLER.test(rawLine);
  const line = rawLine.replace(LEADING_FILLER, "");
  const m = line.match(/^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s*/);
  if (!m) return { quantity: null, rest: line, approximate };
  const rest = line.slice(m[0].length);
  const qtyStr = m[1].trim();
  let quantity: number;
  if (qtyStr.includes(" ")) {
    const [whole, frac] = qtyStr.split(" ");
    const [num, den] = frac.split("/").map(Number);
    quantity = Number(whole) + num / den;
  } else if (qtyStr.includes("/")) {
    const [num, den] = qtyStr.split("/").map(Number);
    quantity = num / den;
  } else {
    quantity = parseFloat(qtyStr);
  }
  return { quantity, rest, approximate };
}

function parseUnit(rest: string): { unit: string | null; name: string } {
  const m = rest.match(/^\s*([a-zA-Z]+)\.?\s+(of\s+)?/);
  if (m && UNIT_TABLE[m[1].toLowerCase()]) {
    return { unit: m[1].toLowerCase(), name: rest.slice(m[0].length).trim() };
  }
  return { unit: null, name: rest.trim() };
}

export function parseIngredientLine(line: string): ParsedLine {
  const { quantity, rest, approximate } = parseLeadingQuantity(line);
  if (quantity === null) return { quantity: null, unit: null, name: line.trim(), approximate };
  const { unit, name } = parseUnit(rest);
  return { quantity, unit, name, approximate };
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const TRAILING_PHRASES = ["to taste", "for serving", "as needed", "optional"];

export function normalizeIngredientName(name: string): string {
  let n = name.toLowerCase().trim().replace(/^of\s+/, "");
  n = n.replace(/[(),]/g, " ");
  for (const phrase of TRAILING_PHRASES) {
    n = n.replace(new RegExp(`\\s*\\b${phrase}\\b\\s*`, "g"), " ");
  }
  for (const prep of PREP_WORDS) {
    n = n.replace(new RegExp(`\\b${prep}\\b`, "g"), " ");
  }
  // Preparation manner adverbs ("coarsely", "finely", "thinly", "roughly grated", etc.)
  // aren't enumerable, so strip trailing -ly words as a heuristic rather than listing each one.
  n = n.replace(/\b\w+ly\b/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  return singularize(n);
}

function formatWeight(grams: number): string {
  return grams >= 1000 ? `${(grams / 1000).toFixed(1).replace(/\.0$/, "")}kg` : `${Math.round(grams)}g`;
}

function formatVolume(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(1).replace(/\.0$/, "")}L` : `${Math.round(ml)}ml`;
}

function formatCount(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

export interface GroceryItem {
  text: string;
  count: number;
}

export function buildGroceryList(lines: string[]): GroceryItem[] {
  const groups = new Map<
    string,
    { displayName: string; parsed: ParsedLine[]; rawLines: string[] }
  >();

  for (const rawLine of lines) {
    const parsed = parseIngredientLine(rawLine);
    const key = normalizeIngredientName(parsed.name) || rawLine.toLowerCase().trim();
    const candidateName = parsed.name || rawLine;
    const group = groups.get(key);
    if (group) {
      group.parsed.push(parsed);
      group.rawLines.push(rawLine);
      // Prefer the shortest raw name seen for this ingredient — descriptor-laden
      // variants ("cheese, shredded") tend to be longer than the plain form ("cheese").
      if (candidateName.length < group.displayName.length) group.displayName = candidateName;
    } else {
      groups.set(key, { displayName: candidateName, parsed: [parsed], rawLines: [rawLine] });
    }
  }

  const items: GroceryItem[] = [];
  for (const { displayName, parsed, rawLines } of groups.values()) {
    const quantified = parsed.filter((p) => p.quantity !== null);
    if (quantified.length === 0) {
      // Nothing parseable — fall back to just listing the distinct original lines.
      const distinct = Array.from(new Set(rawLines));
      items.push({ text: distinct.join("; "), count: rawLines.length });
      continue;
    }

    let gramsTotal = 0;
    let hasGrams = false;
    let gramsApprox = false;
    let mlTotal = 0;
    let hasMl = false;
    let mlApprox = false;
    let bareCountTotal = 0;
    let hasBareCount = false;
    let bareCountApprox = false;

    for (const p of quantified) {
      if (p.unit && UNIT_TABLE[p.unit]) {
        const info = UNIT_TABLE[p.unit];
        if (info.category === "weight") {
          hasGrams = true;
          if (info.gramsEach) {
            gramsTotal += p.quantity! * info.gramsEach;
            gramsApprox = true; // bridging a count unit (slice/piece/...) into grams is itself an estimate
          } else {
            gramsTotal += p.quantity! * info.factor;
          }
          if (p.approximate) gramsApprox = true;
        } else {
          mlTotal += p.quantity! * info.factor;
          hasMl = true;
          if (p.approximate) mlApprox = true;
        }
      } else {
        bareCountTotal += p.quantity!;
        hasBareCount = true;
        if (p.approximate) bareCountApprox = true;
      }
    }

    const parts: string[] = [];
    if (hasGrams) parts.push((gramsApprox ? "at least " : "") + formatWeight(gramsTotal));
    if (hasMl) parts.push((mlApprox ? "at least " : "") + formatVolume(mlTotal));
    if (hasBareCount) parts.push((bareCountApprox ? "at least " : "") + formatCount(bareCountTotal));

    const unquantifiedRaw = parsed
      .map((p, i) => (p.quantity === null ? rawLines[i] : null))
      .filter((x): x is string => x !== null);

    const quantitySummary = parts.join(" + ");
    const text = unquantifiedRaw.length
      ? `${quantitySummary} ${displayName} (also see: ${Array.from(new Set(unquantifiedRaw)).join("; ")})`
      : `${quantitySummary} ${displayName}`;

    items.push({ text: text.trim(), count: rawLines.length });
  }

  return items.sort((a, b) => a.text.localeCompare(b.text));
}
