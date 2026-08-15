import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.MEALMANAGER_DB_PATH || path.join(__dirname, "..", "mealmanager.db");
export const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    ingredients TEXT NOT NULL,
    instructions TEXT NOT NULL,
    spoonacular_id INTEGER,
    image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

{
  // SQLite's ALTER TABLE ADD COLUMN can't declare UNIQUE directly, so the
  // column is added plain and uniqueness is enforced via a separate index.
  const cols = db.prepare("PRAGMA table_info(recipes)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "spoonacular_id")) {
    db.exec("ALTER TABLE recipes ADD COLUMN spoonacular_id INTEGER");
  }
  if (!cols.some((c) => c.name === "image_url")) {
    db.exec("ALTER TABLE recipes ADD COLUMN image_url TEXT");
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_spoonacular_id ON recipes(spoonacular_id)");

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recipe_tags (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, tag_id)
  )
`);

// Migrate legacy free-text `tags` column (comma-separated) into the tags/recipe_tags tables.
const recipeColumns = db.prepare("PRAGMA table_info(recipes)").all() as { name: string }[];
if (recipeColumns.some((c) => c.name === "tags")) {
  const migrate = db.transaction(() => {
    const findOrCreateTag = db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
    const getTagId = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE");
    const linkTag = db.prepare("INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id) VALUES (?, ?)");

    const legacyRecipes = db.prepare("SELECT id, tags FROM recipes").all() as { id: number; tags: string }[];
    for (const recipe of legacyRecipes) {
      const names = recipe.tags.split(",").map((t) => t.trim()).filter(Boolean);
      for (const name of names) {
        findOrCreateTag.run(name);
        const { id: tagId } = getTagId.get(name) as { id: number };
        linkTag.run(recipe.id, tagId);
      }
    }

    db.exec("ALTER TABLE recipes DROP COLUMN tags");
  });
  migrate();
}

export const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

db.exec(`
  CREATE TABLE IF NOT EXISTS meal_plan (
    day TEXT PRIMARY KEY,
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL
  )
`);
{
  const seedDay = db.prepare("INSERT OR IGNORE INTO meal_plan (day, recipe_id) VALUES (?, NULL)");
  for (const day of DAYS_OF_WEEK) seedDay.run(day);
}

export interface Recipe {
  id: number;
  title: string;
  ingredients: string;
  instructions: string;
  spoonacular_id: number | null;
  image_url: string | null;
  created_at: string;
}

export interface Tag {
  id: number;
  name: string;
}
