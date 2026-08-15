const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGroceryList,
  normalizeIngredientName,
  parseIngredientLine,
} = require("../dist/groceryList");

test("parseIngredientLine handles mixed fractions, units, and approximation words", () => {
  assert.deepEqual(parseIngredientLine("1 1/2 cups chopped carrots"), {
    quantity: 1.5,
    unit: "cups",
    name: "chopped carrots",
    approximate: false,
  });

  assert.deepEqual(parseIngredientLine("about 2 tbsp olive oil"), {
    quantity: 2,
    unit: "tbsp",
    name: "olive oil",
    approximate: true,
  });
});

test("normalizeIngredientName removes preparation details and singularizes names", () => {
  assert.equal(normalizeIngredientName("Fresh tomatoes, diced, for serving"), "tomato");
  assert.equal(normalizeIngredientName("finely chopped onions"), "onion");
});

test("buildGroceryList combines compatible volume and weight quantities", () => {
  assert.deepEqual(
    buildGroceryList([
      "2 cups shredded cheddar cheese",
      "1/2 cup cheddar cheese",
      "1 kg potatoes",
      "500 g diced potatoes",
    ]),
    [
      { text: "1.5kg potatoes", count: 2 },
      { text: "600ml cheddar cheese", count: 2 },
    ]
  );
});

test("buildGroceryList marks estimated count-to-weight conversions as approximate", () => {
  assert.deepEqual(buildGroceryList(["2 slices cheese", "100 g cheese"]), [
    { text: "at least 150g cheese", count: 2 },
  ]);
});

test("buildGroceryList preserves distinct unquantified ingredient lines", () => {
  assert.deepEqual(buildGroceryList(["salt to taste", "Salt, as needed"]), [
    { text: "salt to taste; Salt, as needed", count: 2 },
  ]);
});
