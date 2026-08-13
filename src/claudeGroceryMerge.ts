import Anthropic from "@anthropic-ai/sdk";

export class ClaudeUnavailableError extends Error {}

const MODEL = "claude-haiku-4-5";

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "string" } },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are helping build a household grocery shopping list from a week's worth of recipe ingredient lines. The lines are free-text and may repeat the same ingredient across multiple recipes with different phrasing, units, or descriptors (e.g. "2 cups shredded cheddar cheese" and "1/2 cup cheese, for topping").

Combine ingredient lines that refer to the same underlying grocery item into a single line per item. When quantities are in compatible units, add them together and phrase the combined amount naturally and concisely (e.g. "2.5 cups cheddar cheese"). When quantities are vague, non-numeric, or use incompatible units you cannot safely add (e.g. "a pinch of salt" plus "1 tsp salt"), combine them into one line anyway and describe the total the way a person writing a shopping list would -- prefer a natural phrase like "salt (a pinch, plus 1 tsp)" over silently dropping information, and use "at least X" phrasing only when you are rounding down a true numeric lower bound, not as a generic hedge.

Do not include recipe names, day labels, or instructions -- only the merged ingredient list. Do not add ingredients that were not present in the input. Do not invent quantities that were not stated or clearly summable from the input.`;

/**
 * Deliberate deviation from the Spoonacular integration's raw-fetch style: this repo's
 * Claude API tooling policy requires using the official SDK (@anthropic-ai/sdk) rather than
 * raw HTTP whenever an official SDK is available for the language in use.
 */
export async function mergeGroceryLinesWithClaude(lines: string[]): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeUnavailableError("ANTHROPIC_API_KEY is not configured");
  }
  if (lines.length === 0) return [];

  const client = new Anthropic({ apiKey });

  const requestPayload = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user" as const, content: `Ingredient lines:\n${lines.map((l) => `- ${l}`).join("\n")}` },
    ],
    output_config: { format: { type: "json_schema" as const, schema: MERGE_SCHEMA } },
  };
  console.log("[claudeGroceryMerge] request:", JSON.stringify(requestPayload, null, 2));

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(requestPayload);
  } catch (err) {
    console.error("[claudeGroceryMerge] error calling Claude:", err);
    throw err;
  }

  console.log("[claudeGroceryMerge] response:", JSON.stringify(response, null, 2));

  if (response.stop_reason === "refusal") {
    throw new ClaudeUnavailableError("Claude declined to process this grocery list");
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) {
    throw new ClaudeUnavailableError("Claude returned no text content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new ClaudeUnavailableError("Claude returned malformed JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as any).items) ||
    !(parsed as any).items.every((x: unknown) => typeof x === "string")
  ) {
    throw new ClaudeUnavailableError("Claude response did not match the expected shape");
  }

  const items = (parsed as { items: string[] }).items.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new ClaudeUnavailableError("Claude returned an empty merged list");
  }
  return items;
}
