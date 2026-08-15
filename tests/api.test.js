const test = require("node:test");
const assert = require("node:assert/strict");
const { after, beforeEach } = require("node:test");
const { mkdtempSync, rmSync, existsSync } = require("node:fs");
const { IncomingMessage, ServerResponse } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Duplex } = require("node:stream");

const testDirectory = mkdtempSync(join(tmpdir(), "mealmanager-test-"));
process.env.MEALMANAGER_DB_PATH = join(testDirectory, "test.db");
process.env.MEALMANAGER_UPLOADS_DIR = join(testDirectory, "uploads");
process.env.ANTHROPIC_API_KEY = "";
process.env.SPOONACULAR_API_KEY = "";

const { app } = require("../dist/server");
const { db, DAYS_OF_WEEK } = require("../dist/db");

beforeEach(() => {
  db.exec(`
    DELETE FROM recipe_tags;
    DELETE FROM recipes;
    DELETE FROM tags;
    UPDATE meal_plan SET recipe_id = NULL;
  `);
});

after(() => {
  db.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

class MockSocket extends Duplex {
  // ServerResponse expects a socket, but API tests can dispatch through Express
  // without binding a TCP port or Unix socket in restricted test runners.
  _read() {}
  _write(_chunk, _encoding, callback) {
    callback();
  }
}

async function request(path, { method = "GET", form, file } = {}) {
  const headers = {};
  let requestBody;
  if (form) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        body.append(key, String(item));
      }
    }
    requestBody = Buffer.from(body.toString());
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (file) {
    const boundary = "----mealmanagerTestBoundary";
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    requestBody = Buffer.concat([preamble, file.data, epilogue]);
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
  }
  if (requestBody) headers["content-length"] = String(requestBody.length);

  const socket = new MockSocket();
  const incoming = new IncomingMessage(socket);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = headers;
  incoming.push(requestBody || null);
  if (requestBody) incoming.push(null);
  // Node's real HTTP parser sets `complete` once the full message is received; multer/busboy
  // treat a stream ending with `complete` still false as an aborted request and never fire
  // their callback, so this mock request must set it explicitly.
  incoming.complete = true;

  const response = new ServerResponse(incoming);
  response.assignSocket(socket);
  const responseChunks = [];
  const originalEnd = response.end.bind(response);
  response.end = (chunk, encoding, callback) => {
    if (chunk) {
      const characterEncoding = typeof encoding === "string" ? encoding : undefined;
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, characterEncoding));
    }
    return originalEnd(chunk, encoding, callback);
  };

  return new Promise((resolve, reject) => {
    response.once("finish", () => {
      const text = Buffer.concat(responseChunks).toString("utf8");
      resolve({
        status: response.statusCode,
        body: text ? JSON.parse(text) : undefined,
      });
    });
    app.handle(incoming, response, reject);
  });
}

async function createTag(name) {
  const response = await request("/api/tags", { method: "POST", form: { name } });
  assert.equal(response.status, 201);
  return Number(response.body.id);
}

async function createRecipe({ title, ingredients, instructions = "Cook it.", tagIds = [] }) {
  const response = await request("/api/recipes", {
    method: "POST",
    form: { title, ingredients, instructions, tagIds },
  });
  assert.equal(response.status, 201);
  return Number(response.body.id);
}

test("tag endpoints create, reject duplicates, rename, list, and delete tags", async () => {
  const tagId = await createTag("Dinner");

  const duplicate = await request("/api/tags", {
    method: "POST",
    form: { name: "dinner" },
  });
  assert.equal(duplicate.status, 409);

  const renamed = await request(`/api/tags/${tagId}`, {
    method: "PUT",
    form: { name: "Weeknight" },
  });
  assert.equal(renamed.status, 204);

  const listed = await request("/api/tags");
  assert.deepEqual(listed.body, [{ id: tagId, name: "Weeknight" }]);

  assert.equal((await request(`/api/tags/${tagId}`, { method: "DELETE" })).status, 204);
  assert.deepEqual((await request("/api/tags")).body, []);
});

test("recipe endpoints keep tag relationships transactional and support filtering", async () => {
  const quickId = await createTag("Quick");
  const vegetarianId = await createTag("Vegetarian");
  const recipeId = await createRecipe({
    title: "Tomato Pasta",
    ingredients: "2 tomatoes\n200 g pasta",
    tagIds: [quickId, vegetarianId],
  });

  const created = await request(`/api/recipes/${recipeId}`);
  assert.equal(created.status, 200);
  assert.equal(created.body.title, "Tomato Pasta");
  assert.deepEqual(created.body.tags, [
    { id: quickId, name: "Quick" },
    { id: vegetarianId, name: "Vegetarian" },
  ]);

  const filtered = await request(`/api/recipes?tagId=${quickId}`);
  assert.deepEqual(filtered.body.map((recipe) => recipe.id), [recipeId]);

  const updated = await request(`/api/recipes/${recipeId}`, {
    method: "PUT",
    form: {
      title: "Roasted Tomato Pasta",
      ingredients: "3 tomatoes\n200 g pasta",
      instructions: "Roast, then combine.",
      tagIds: [vegetarianId],
    },
  });
  assert.equal(updated.status, 204);

  const afterUpdate = await request(`/api/recipes/${recipeId}`);
  assert.equal(afterUpdate.body.title, "Roasted Tomato Pasta");
  assert.deepEqual(afterUpdate.body.tags, [{ id: vegetarianId, name: "Vegetarian" }]);
  assert.deepEqual((await request(`/api/recipes?tagId=${quickId}`)).body, []);

  assert.equal((await request(`/api/recipes/${recipeId}`, { method: "DELETE" })).status, 204);
  assert.equal((await request(`/api/recipes/${recipeId}`)).status, 404);
});

test("meal planning returns all seven days and generates a heuristic grocery list", async () => {
  const firstRecipeId = await createRecipe({
    title: "Potato Bake",
    ingredients: "1 kg potatoes\n2 cloves garlic",
  });
  const secondRecipeId = await createRecipe({
    title: "Potato Soup",
    ingredients: "500 g diced potatoes\n1 clove garlic",
  });

  assert.equal(
    (await request("/api/meal-plan/Monday", {
      method: "PUT",
      form: { recipeId: firstRecipeId },
    })).status,
    204
  );
  assert.equal(
    (await request("/api/meal-plan/Tuesday", {
      method: "PUT",
      form: { recipeId: secondRecipeId },
    })).status,
    204
  );

  const plan = await request("/api/meal-plan");
  assert.deepEqual(plan.body.map((entry) => entry.day), DAYS_OF_WEEK);
  assert.deepEqual(plan.body[0].recipe, { id: firstRecipeId, title: "Potato Bake" });
  assert.deepEqual(plan.body[1].recipe, { id: secondRecipeId, title: "Potato Soup" });

  const groceryList = await request("/api/meal-plan/grocery-list");
  assert.equal(groceryList.status, 200);
  assert.equal(groceryList.body.mergeMethod, "heuristic");
  assert.deepEqual(groceryList.body.items, [
    { text: "1.5kg potatoes", count: 2 },
    { text: "at least 15g garlic", count: 2 },
  ]);

  await request(`/api/recipes/${firstRecipeId}`, { method: "DELETE" });
  assert.equal((await request("/api/meal-plan")).body[0].recipe, null);
});

test("local suggestions rank recipes by the proportion of ingredients on hand", async () => {
  const pastaId = await createRecipe({
    title: "Pasta",
    ingredients: "tomato\npasta\nbasil",
  });
  await createRecipe({
    title: "Omelet",
    ingredients: "eggs\ncheese",
  });

  const suggestions = await request("/api/recipes/suggest?ingredients=tomato,pasta");
  assert.equal(suggestions.status, 200);
  assert.equal(suggestions.body.local.length, 1);
  assert.equal(suggestions.body.local[0].id, pastaId);
  assert.deepEqual(suggestions.body.local[0].have, ["tomato", "pasta"]);
  assert.deepEqual(suggestions.body.local[0].missing, ["basil"]);
  assert.deepEqual(suggestions.body.online, []);
});

test("importing a Spoonacular recipe saves its image URL and dedupes on re-import", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.SPOONACULAR_API_KEY;
  process.env.SPOONACULAR_API_KEY = "test-key";
  global.fetch = async (url) => {
    assert.match(String(url), /\/recipes\/12345\/information\?/);
    return {
      ok: true,
      json: async () => ({
        title: "Spoonacular Chili",
        image: "https://spoonacular.com/recipeImages/12345.jpg",
        extendedIngredients: [{ original: "1 lb ground beef" }, { original: "1 can beans" }],
        analyzedInstructions: [{ steps: [{ number: 1, step: "Brown the beef." }] }],
      }),
    };
  };

  try {
    const imported = await request("/api/recipes/import/12345", { method: "POST" });
    assert.equal(imported.status, 201);
    const recipeId = imported.body.id;

    const saved = await request(`/api/recipes/${recipeId}`);
    assert.equal(saved.body.image_url, "https://spoonacular.com/recipeImages/12345.jpg");

    const reimported = await request("/api/recipes/import/12345", { method: "POST" });
    assert.deepEqual(reimported.body, { id: recipeId, alreadySaved: true });
  } finally {
    global.fetch = originalFetch;
    process.env.SPOONACULAR_API_KEY = originalApiKey;
  }
});

test("importing a Spoonacular recipe without an image saves a null image URL", async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.SPOONACULAR_API_KEY;
  process.env.SPOONACULAR_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      title: "Spoonacular Soup",
      extendedIngredients: [{ original: "1 onion" }],
      analyzedInstructions: [{ steps: [{ number: 1, step: "Simmer." }] }],
    }),
  });

  try {
    const imported = await request("/api/recipes/import/67890", { method: "POST" });
    assert.equal(imported.status, 201);
    const saved = await request(`/api/recipes/${imported.body.id}`);
    assert.equal(saved.body.image_url, null);
  } finally {
    global.fetch = originalFetch;
    process.env.SPOONACULAR_API_KEY = originalApiKey;
  }
});

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("uploading a thumbnail attaches it to a recipe and replaces the previous file", async () => {
  const recipeId = await createRecipe({ title: "Salad", ingredients: "1 head lettuce" });

  const uploaded = await request(`/api/recipes/${recipeId}/thumbnail`, {
    method: "POST",
    file: { field: "thumbnail", filename: "salad.png", contentType: "image/png", data: TEST_PNG },
  });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.body.image_url, /^\/uploads\/.+\.png$/);

  const saved = await request(`/api/recipes/${recipeId}`);
  assert.equal(saved.body.image_url, uploaded.body.image_url);

  const uploadsDir = process.env.MEALMANAGER_UPLOADS_DIR;
  const firstFilename = uploaded.body.image_url.replace("/uploads/", "");
  assert.ok(existsSync(join(uploadsDir, firstFilename)));

  const secondUpload = await request(`/api/recipes/${recipeId}/thumbnail`, {
    method: "POST",
    file: { field: "thumbnail", filename: "salad2.png", contentType: "image/png", data: TEST_PNG },
  });
  assert.equal(secondUpload.status, 200);
  assert.notEqual(secondUpload.body.image_url, uploaded.body.image_url);
  assert.ok(!existsSync(join(uploadsDir, firstFilename)), "old thumbnail file should be deleted on replace");

  await request(`/api/recipes/${recipeId}`, { method: "DELETE" });
  const secondFilename = secondUpload.body.image_url.replace("/uploads/", "");
  assert.ok(!existsSync(join(uploadsDir, secondFilename)), "thumbnail file should be deleted when recipe is deleted");
});

test("thumbnail upload rejects non-image files and unknown recipes", async () => {
  const recipeId = await createRecipe({ title: "Toast", ingredients: "1 slice bread" });

  const rejectedType = await request(`/api/recipes/${recipeId}/thumbnail`, {
    method: "POST",
    file: { field: "thumbnail", filename: "notes.txt", contentType: "text/plain", data: Buffer.from("hi") },
  });
  assert.equal(rejectedType.status, 400);

  const missingRecipe = await request("/api/recipes/999999/thumbnail", {
    method: "POST",
    file: { field: "thumbnail", filename: "x.png", contentType: "image/png", data: TEST_PNG },
  });
  assert.equal(missingRecipe.status, 404);
});

test("API validation rejects incomplete recipes, unknown days, and missing recipe IDs", async () => {
  assert.equal(
    (await request("/api/recipes", {
      method: "POST",
      form: { title: "Incomplete" },
    })).status,
    400
  );
  assert.equal(
    (await request("/api/meal-plan/Funday", {
      method: "PUT",
      form: { recipeId: 1 },
    })).status,
    400
  );
  assert.equal(
    (await request("/api/meal-plan/Monday", {
      method: "PUT",
      form: { recipeId: 999999 },
    })).status,
    400
  );
});
