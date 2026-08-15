import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { db, Recipe, Tag, DAYS_OF_WEEK } from "./db";
import { buildGroceryList, GroceryItem } from "./groceryList";
import { mergeGroceryLinesWithClaude, ClaudeUnavailableError } from "./claudeGroceryMerge";

export const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = process.env.MEALMANAGER_UPLOADS_DIR || path.join(PUBLIC_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const THUMBNAIL_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = THUMBNAIL_MIME_TYPES[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!Object.prototype.hasOwnProperty.call(THUMBNAIL_MIME_TYPES, file.mimetype)) {
      return cb(new Error("Thumbnail must be a JPEG, PNG, WEBP, or GIF image"));
    }
    cb(null, true);
  },
});

function deleteUploadedFileIfLocal(imageUrl: string | null) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/")) return;
  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(imageUrl)));
  } catch {
    // Already gone; nothing to clean up.
  }
}

app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  if (!req.body) req.body = {};
  next();
});
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

function tagsForRecipe(recipeId: number): Tag[] {
  return db
    .prepare(
      `SELECT tags.id, tags.name FROM tags
       JOIN recipe_tags ON recipe_tags.tag_id = tags.id
       WHERE recipe_tags.recipe_id = ?
       ORDER BY tags.name`
    )
    .all(recipeId) as Tag[];
}

function setRecipeTags(recipeId: number, tagIds: number[]) {
  db.prepare("DELETE FROM recipe_tags WHERE recipe_id = ?").run(recipeId);
  const link = db.prepare("INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id) VALUES (?, ?)");
  for (const tagId of tagIds) {
    link.run(recipeId, tagId);
  }
}

function parseTagIds(raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.map((v) => Number(v)).filter((n) => Number.isInteger(n));
}

// --- Tags ---

app.get("/api/tags", (_req, res) => {
  const tags = db.prepare("SELECT * FROM tags ORDER BY name").all() as Tag[];
  res.json(tags);
});

app.post("/api/tags", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const result = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name);
    res.status(201).json({ id: result.lastInsertRowid, name });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "A tag with that name already exists" });
    }
    throw err;
  }
});

app.put("/api/tags/:id", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const result = db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Tag not found" });
    res.status(204).end();
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "A tag with that name already exists" });
    }
    throw err;
  }
});

app.delete("/api/tags/:id", (req, res) => {
  const result = db.prepare("DELETE FROM tags WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Tag not found" });
  res.status(204).end();
});

// --- Meal Plan ---

app.get("/api/meal-plan", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT meal_plan.day, recipes.id, recipes.title FROM meal_plan
       LEFT JOIN recipes ON recipes.id = meal_plan.recipe_id`
    )
    .all() as { day: string; id: number | null; title: string | null }[];
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.id ? { id: r.id, title: r.title } : null]));
  res.json(DAYS_OF_WEEK.map((day) => ({ day, recipe: byDay[day] })));
});

app.get("/api/meal-plan/grocery-list", async (_req, res) => {
  const rows = db
    .prepare(
      `SELECT meal_plan.day, recipes.id, recipes.title, recipes.ingredients FROM meal_plan
       JOIN recipes ON recipes.id = meal_plan.recipe_id`
    )
    .all() as { day: string; id: number; title: string; ingredients: string }[];

  const allLines = rows.flatMap((row) =>
    row.ingredients.split("\n").map((l) => l.trim()).filter(Boolean)
  );

  let items: GroceryItem[];
  let mergeMethod: "claude" | "heuristic" = "heuristic";
  let mergeError: string | undefined;

  if (allLines.length === 0) {
    items = [];
  } else {
    try {
      console.log("[grocery-list] lines before Claude merge:", allLines);
      const merged = await mergeGroceryLinesWithClaude(allLines);
      console.log("[grocery-list] lines after Claude merge:", merged);
      items = merged.map((text) => ({ text, count: 1 }));
      mergeMethod = "claude";
    } catch (err) {
      if (!(err instanceof ClaudeUnavailableError)) {
        console.error("Grocery merge via Claude failed:", err);
        mergeError = "AI grocery merge failed; used the built-in combiner instead";
      }
      items = buildGroceryList(allLines);
    }
  }

  const recipes = rows.map((r) => ({ day: r.day, title: r.title }));
  res.json({ items, recipes, mergeMethod, ...(mergeError ? { mergeError } : {}) });
});

app.put("/api/meal-plan/:day", (req, res) => {
  const { day } = req.params;
  if (!DAYS_OF_WEEK.includes(day)) {
    return res.status(400).json({ error: `day must be one of: ${DAYS_OF_WEEK.join(", ")}` });
  }
  const recipeId = req.body.recipeId ? Number(req.body.recipeId) : null;
  if (req.body.recipeId && !Number.isInteger(recipeId)) {
    return res.status(400).json({ error: "recipeId must be an integer" });
  }
  try {
    db.prepare("UPDATE meal_plan SET recipe_id = ? WHERE day = ?").run(recipeId, day);
    res.status(204).end();
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return res.status(400).json({ error: "recipeId does not exist" });
    }
    throw err;
  }
});

// --- Recipes ---

app.get("/api/recipes", (req, res) => {
  const tagId = req.query.tagId ? Number(req.query.tagId) : undefined;
  const recipes = (
    tagId
      ? db
          .prepare(
            `SELECT recipes.* FROM recipes
             JOIN recipe_tags ON recipe_tags.recipe_id = recipes.id
             WHERE recipe_tags.tag_id = ?
             ORDER BY recipes.created_at DESC`
          )
          .all(tagId)
      : db.prepare("SELECT * FROM recipes ORDER BY created_at DESC").all()
  ) as Recipe[];
  res.json(recipes.map((r) => ({ ...r, tags: tagsForRecipe(r.id) })));
});

interface OnlineRecipe {
  id: number;
  title: string;
  image: string;
  usedIngredientCount: number;
  missedIngredientCount: number;
  url: string;
}

async function fetchOnlineRecipes(onHand: string[]): Promise<OnlineRecipe[]> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    ingredients: onHand.join(","),
    number: "10",
    ranking: "2",
    apiKey,
  });
  const response = await fetch(`https://api.spoonacular.com/recipes/findByIngredients?${params}`);
  if (!response.ok) {
    throw new Error(`Spoonacular request failed: ${response.status}`);
  }
  const results = (await response.json()) as any[];
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    image: r.image,
    usedIngredientCount: r.usedIngredientCount,
    missedIngredientCount: r.missedIngredientCount,
    url: `https://spoonacular.com/recipes/${encodeURIComponent(r.title.replace(/\s+/g, "-"))}-${r.id}`,
  }));
}

app.get("/api/recipes/suggest", async (req, res) => {
  const raw = typeof req.query.ingredients === "string" ? req.query.ingredients : "";
  const onHand = raw
    .split(",")
    .map((i) => i.trim().toLowerCase())
    .filter(Boolean);
  if (onHand.length === 0) {
    return res.status(400).json({ error: "ingredients query param is required (comma-separated)" });
  }

  const recipes = db.prepare("SELECT * FROM recipes").all() as Recipe[];
  const local = recipes
    .map((r) => {
      const lines = r.ingredients.split("\n").map((l) => l.trim()).filter(Boolean);
      const have: string[] = [];
      const missing: string[] = [];
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (onHand.some((i) => lower.includes(i))) {
          have.push(line);
        } else {
          missing.push(line);
        }
      }
      const matchScore = lines.length ? have.length / lines.length : 0;
      return { ...r, tags: tagsForRecipe(r.id), have, missing, matchScore };
    })
    .filter((s) => s.have.length > 0)
    .sort((a, b) => b.matchScore - a.matchScore || b.have.length - a.have.length);

  let online: OnlineRecipe[] = [];
  let onlineError: string | undefined;
  try {
    online = await fetchOnlineRecipes(onHand);
  } catch (err) {
    onlineError = "Online recipe search is temporarily unavailable";
  }

  res.json({ local, online, onlineError });
});

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function fetchSpoonacularDetail(spoonacularId: number) {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("Online recipe search is not configured"), { status: 503 });
  }
  const response = await fetch(
    `https://api.spoonacular.com/recipes/${spoonacularId}/information?${new URLSearchParams({ apiKey })}`
  );
  if (!response.ok) {
    throw Object.assign(new Error(`Spoonacular request failed: ${response.status}`), { status: 502 });
  }
  const data = (await response.json()) as any;

  const ingredients = (data.extendedIngredients || [])
    .map((i: any) => i.original)
    .filter(Boolean)
    .join("\n");

  const steps = data.analyzedInstructions?.[0]?.steps;
  const instructions = steps?.length
    ? steps.map((s: any) => `${s.number}. ${s.step}`).join("\n")
    : stripHtml(data.instructions || "");

  return { title: data.title as string, ingredients, instructions, imageUrl: (data.image as string) || null };
}

app.post("/api/recipes/import/:spoonacularId", async (req, res) => {
  const spoonacularId = Number(req.params.spoonacularId);
  if (!Number.isInteger(spoonacularId)) {
    return res.status(400).json({ error: "spoonacularId must be an integer" });
  }

  const existing = db
    .prepare("SELECT id FROM recipes WHERE spoonacular_id = ?")
    .get(spoonacularId) as { id: number } | undefined;
  if (existing) {
    return res.status(200).json({ id: existing.id, alreadySaved: true });
  }

  const tagIds = parseTagIds(req.body?.tagIds);
  try {
    const detail = await fetchSpoonacularDetail(spoonacularId);
    if (!detail.ingredients || !detail.instructions) {
      return res.status(422).json({ error: "That recipe is missing ingredients or instructions upstream" });
    }
    const createRecipe = db.transaction(() => {
      const result = db
        .prepare(
          "INSERT INTO recipes (title, ingredients, instructions, spoonacular_id, image_url) VALUES (?, ?, ?, ?, ?)"
        )
        .run(detail.title, detail.ingredients, detail.instructions, spoonacularId, detail.imageUrl);
      setRecipeTags(Number(result.lastInsertRowid), tagIds);
      return result.lastInsertRowid;
    });
    res.status(201).json({ id: createRecipe() });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return res.status(400).json({ error: "One or more tagIds do not exist" });
    }
    res.status(err.status || 500).json({ error: err.message || "Failed to import recipe" });
  }
});

app.get("/api/recipes/:id", (req, res) => {
  const recipe = db.prepare("SELECT * FROM recipes WHERE id = ?").get(req.params.id) as Recipe | undefined;
  if (!recipe) return res.status(404).json({ error: "Recipe not found" });
  res.json({ ...recipe, tags: tagsForRecipe(recipe.id) });
});

app.post("/api/recipes", (req, res) => {
  const { title, ingredients, instructions } = req.body;
  if (!title || !ingredients || !instructions) {
    return res.status(400).json({ error: "title, ingredients, and instructions are required" });
  }
  const tagIds = parseTagIds(req.body.tagIds);
  try {
    const createRecipe = db.transaction(() => {
      const result = db
        .prepare("INSERT INTO recipes (title, ingredients, instructions) VALUES (?, ?, ?)")
        .run(title, ingredients, instructions);
      setRecipeTags(Number(result.lastInsertRowid), tagIds);
      return result.lastInsertRowid;
    });
    res.status(201).json({ id: createRecipe() });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return res.status(400).json({ error: "One or more tagIds do not exist" });
    }
    throw err;
  }
});

app.put("/api/recipes/:id", (req, res) => {
  const { title, ingredients, instructions } = req.body;
  if (!title || !ingredients || !instructions) {
    return res.status(400).json({ error: "title, ingredients, and instructions are required" });
  }
  const tagIds = parseTagIds(req.body.tagIds);
  try {
    const updateRecipe = db.transaction(() => {
      const result = db
        .prepare("UPDATE recipes SET title = ?, ingredients = ?, instructions = ? WHERE id = ?")
        .run(title, ingredients, instructions, req.params.id);
      if (result.changes === 0) return false;
      setRecipeTags(Number(req.params.id), tagIds);
      return true;
    });
    if (!updateRecipe()) return res.status(404).json({ error: "Recipe not found" });
    res.status(204).end();
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return res.status(400).json({ error: "One or more tagIds do not exist" });
    }
    throw err;
  }
});

app.post("/api/recipes/:id/thumbnail", (req, res) => {
  upload.single("thumbnail")(req, res, (err) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "Thumbnail must be 5MB or smaller"
          : err.message;
      return res.status(400).json({ error: message });
    }

    const recipeId = Number(req.params.id);
    if (!req.file) {
      return res.status(400).json({ error: "thumbnail file is required" });
    }
    if (!Number.isInteger(recipeId)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "id must be an integer" });
    }

    const existing = db.prepare("SELECT image_url FROM recipes WHERE id = ?").get(recipeId) as
      | { image_url: string | null }
      | undefined;
    if (!existing) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Recipe not found" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    db.prepare("UPDATE recipes SET image_url = ? WHERE id = ?").run(imageUrl, recipeId);
    deleteUploadedFileIfLocal(existing.image_url);
    res.status(200).json({ image_url: imageUrl });
  });
});

app.delete("/api/recipes/:id", (req, res) => {
  const existing = db.prepare("SELECT image_url FROM recipes WHERE id = ?").get(req.params.id) as
    | { image_url: string | null }
    | undefined;
  db.prepare("DELETE FROM recipes WHERE id = ?").run(req.params.id);
  if (existing) deleteUploadedFileIfLocal(existing.image_url);
  res.status(204).end();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Meal Manager running at http://localhost:${PORT}`);
  });
}
