import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// These are presentation-boundary tests, not real Binding authentication evidence.
// Authentication callbacks below are fixtures; delegated-oauth-transport.test.mjs
// covers the actual provider and transport boundary separately.
// Import the actual source with the existing Node runtime, without installing dependencies.
const source = await readFile(new URL("../worker/mcp-profile.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source, { mode: "transform" });
const {
  McpProfileError, mcpProfileTool, mcpProfileInput, mcpProfileIdentity,
  mcpProfileResult, handleMcpProfile, mcpProfileEmailSnapshot,
} = await import("data:text/javascript;base64," + Buffer.from(javascript).toString("base64"));

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const unavailable = error => error instanceof McpProfileError &&
  error.code === "mcp_profile_unavailable" && error.message === "mcp_profile_unavailable";
const invalidInput = error => error instanceof McpProfileError &&
  error.code === "mcp_profile_input_invalid";

test("profile descriptor has empty input, the official marker and exclusive identity output", () => {
  assert.equal(mcpProfileTool.name, "clued_account_profile");
  assert.deepEqual(mcpProfileTool.inputSchema, {
    type: "object", properties: {}, additionalProperties: false,
  });
  assert.deepEqual(mcpProfileTool.securitySchemes, [{ type: "oauth2", scopes: [] }]);
  assert.equal(mcpProfileTool.securitySchemes.some(scheme => scheme.type === "noauth"), false);
  assert.equal(mcpProfileTool._meta["openai/profile"], true);
  assert.deepEqual(mcpProfileTool._meta["clued/requiredScopes"], []);
  assert.equal(mcpProfileTool._meta["clued/scopeEnforcement"], "server-side");
  assert.deepEqual(mcpProfileTool.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.equal(mcpProfileTool.outputSchema.type, "object");
  assert.equal(mcpProfileTool.outputSchema.properties.id.minLength, 1);
  assert.equal(new RegExp(mcpProfileTool.outputSchema.properties.id.pattern).test(" "), false);
  assert.equal(new RegExp(mcpProfileTool.outputSchema.properties.id.pattern).test(userId), true);
  assert.equal(mcpProfileTool.outputSchema.additionalProperties, false);
  assert.deepEqual(mcpProfileTool.outputSchema.required, ["id"]);
  assert.deepEqual(Object.keys(mcpProfileTool.outputSchema.properties), ["id", "name", "email", "nickname"]);
  for (const field of Object.values(mcpProfileTool.outputSchema.properties)) {
    assert.equal(field.type, "string");
  }
});

test("empty input accepts omitted arguments and an object without a prototype", () => {
  for (const input of [undefined, {}, Object.create(null)]) {
    assert.doesNotThrow(() => mcpProfileInput(input));
  }
});

test("selectors, metadata, null and non-object arguments are rejected before authentication", async () => {
  const hiddenSelector = Object.defineProperty({}, "id", { value: otherUserId });
  const symbolSelector = { [Symbol("id")]: otherUserId };
  const inheritedSelector = Object.create({ user_id: otherUserId });
  let calls = 0;
  for (const input of [
    null, [], "", 0, false, new Date(), { id: otherUserId }, { user_id: otherUserId },
    { binding_id: "different-binding" }, { token: "different-token" }, { _meta: {} },
    hiddenSelector, symbolSelector, inheritedSelector,
  ]) {
    await assert.rejects(handleMcpProfile(input, async () => {
      calls++;
      return { id: userId };
    }), invalidInput);
  }
  assert.equal(calls, 0);
});

test("a validated identity is projected without leaking transport or account internals", () => {
  const identity = {
    id: userId, name: "林 Example", email: "person@example.invalid", nickname: "小林",
    binding_id: "internal-binding", session_token: "private-token", scopes: ["context:write"],
    user_metadata: { secret: "not-for-display" },
  };
  Object.defineProperty(identity, "credentials", { get() { throw new Error("must not read extras"); } });
  const result = mcpProfileResult(identity);
  const expected = { id: userId, name: "林 Example", email: "person@example.invalid", nickname: "小林" };
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected) }]);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result), /internal-binding|private-token|context:write|user_metadata|not-for-display/);
});

test("identity parsing creates a fresh projection and does not mutate the server identity", () => {
  const identity = Object.freeze({ id: userId, name: "Example", transport: "internal" });
  const parsed = mcpProfileIdentity(identity);
  assert.notStrictEqual(parsed, identity);
  parsed.name = "Changed output";
  assert.equal(identity.name, "Example");
  assert.deepEqual(Object.keys(parsed), ["id", "name"]);
});

test("id-only authenticated accounts are supported without fabricating display fields", () => {
  assert.deepEqual(mcpProfileIdentity({ id: userId }), { id: userId });
  assert.deepEqual(mcpProfileIdentity(Object.assign(Object.create(null), { id: userId })), { id: userId });
});

test("missing or malformed stable IDs fail closed without any fallback", () => {
  for (const identity of [
    undefined, null, [], new Date(), {}, { id: undefined }, { id: null }, { id: 1 }, { id: "" },
    { id: "person@example.invalid" }, { id: "clued_bnd_" + "a".repeat(64) },
    { id: "binding-123" }, { id: "00000000-0000-0000-0000-000000000000" },
    { id: "10000000-0000-4000-0000-000000000001" }, { id: " " + userId },
    { userId }, { user_id: userId }, Object.create({ id: userId }),
  ]) {
    assert.throws(() => mcpProfileResult(identity), unavailable);
  }
});

test("every malformed present optional field rejects the whole profile", () => {
  const invalidFields = [
    ["name", undefined], ["name", null], ["name", 1], ["name", {}], ["name", ""],
    ["name", " "], ["name", " Example"], ["name", "Example "], ["name", "a".repeat(257)],
    ["name", "Example\nOther"], ["nickname", ["Example"]], ["nickname", ""],
    ["nickname", "a".repeat(257)], ["nickname", "Example\u007f"],
    ["email", undefined], ["email", null], ["email", ""], ["email", "not-an-email"],
    ["email", "@example.invalid"], ["email", "person@"], ["email", "a@@example.invalid"],
    ["email", "person @example.invalid"], ["email", "person@example.invalid\n"],
    ["email", "a".repeat(310) + "@example.invalid"],
  ];
  for (const [field, value] of invalidFields) {
    assert.throws(() => mcpProfileResult({ id: userId, [field]: value }), unavailable, field);
  }
});

test("identity fields cannot be executable getters", () => {
  for (const field of ["id", "name", "email", "nickname"]) {
    let reads = 0;
    const identity = { id: userId };
    Object.defineProperty(identity, field, {
      enumerable: true, get() { reads++; throw new Error("provider-secret"); },
    });
    assert.throws(() => mcpProfileResult(identity), unavailable);
    assert.equal(reads, 0);
  }
});

test("authentication failures preserve their transport auth error and return no identity", async () => {
  let calls = 0;
  const failures = [
    Object.assign(new Error("Authentication required"), { status: 401, code: "expired" }),
    Object.assign(new Error("Authorization revoked"), { status: 403, code: "revoked" }),
    new Error("unknown-provider-diagnostic"),
  ];
  for (const failure of failures) {
    let result;
    await assert.rejects(async () => {
      result = await handleMcpProfile({}, async () => { calls++; throw failure; });
    }, error => error === failure);
    assert.equal(result, undefined);
  }
  assert.equal(calls, failures.length);
});

test("an authentication callback that supplies malformed identity returns no partial profile", async () => {
  await assert.rejects(handleMcpProfile({}, async () => ({
    id: userId, email: { private: "provider-secret" }, name: "Would otherwise display",
  })), unavailable);
  await assert.rejects(handleMcpProfile({}, async () => undefined), unavailable);
});

test("one callback is awaited for each call and the result uses that current self-identity", async () => {
  let calls = 0;
  const authenticateSelf = async () => {
    calls++;
    await Promise.resolve();
    return { id: calls === 1 ? userId : otherUserId, email: "account" + calls + "@example.invalid" };
  };
  assert.equal((await handleMcpProfile({}, authenticateSelf)).structuredContent.id, userId);
  assert.equal((await handleMcpProfile({}, authenticateSelf)).structuredContent.id, otherUserId);
  assert.equal(calls, 2);
});

test("the supplied stable ID survives fixture credential changes and display-name changes", async () => {
  // These contexts simulate transport results only; they do not authenticate real credentials.
  const contexts = [
    { binding: "old-binding", token: "old-token", name: "Old display" },
    { binding: "new-binding", token: "rotated-token", name: "New display" },
  ];
  const results = [];
  for (const context of contexts) {
    results.push(await handleMcpProfile({}, async () => ({
      id: userId, name: context.name, email: "person@example.invalid",
      binding_id: context.binding, token: context.token,
    })));
  }
  assert.equal(results[0].structuredContent.id, userId);
  assert.equal(results[1].structuredContent.id, userId);
  assert.notEqual(results[0].structuredContent.name, results[1].structuredContent.name);
  assert.doesNotMatch(JSON.stringify(results), /old-binding|new-binding|old-token|rotated-token/);
});

test("email snapshots retain the same stable account ID and only a valid own email", () => {
  const identity = Object.freeze({
    id: userId, email: "person@example.invalid", name: "Example", nickname: "Personal",
    binding_id: "internal-binding", user_metadata: { private: "account-internal" },
  });
  const expected = { id: userId, email: "person@example.invalid" };
  assert.deepEqual(mcpProfileEmailSnapshot(identity), expected);
  const snapshot = mcpProfileEmailSnapshot(identity, userId);
  assert.deepEqual(snapshot, expected);
  assert.notStrictEqual(snapshot, identity);
  assert.doesNotMatch(JSON.stringify(snapshot), /Example|Personal|internal-binding|account-internal/);
  assert.deepEqual(mcpProfileEmailSnapshot(Object.assign(Object.create(null), expected), userId), expected);
});

test("email snapshots omit unavailable or invalid email without losing the stable ID", () => {
  assert.deepEqual(mcpProfileEmailSnapshot({ id: userId }, userId), { id: userId });
  for (const email of [
    undefined, null, 42, {}, [], "", " ", "person@example.invalid ", " person@example.invalid",
    "not-an-email", "@example.invalid", "person@", "a@@example.invalid", "person @example.invalid",
    "person@example.invalid\n", "person\u007f@example.invalid", "a".repeat(319) + "@b",
  ]) {
    assert.deepEqual(mcpProfileEmailSnapshot({ id: userId, email }, userId), { id: userId });
  }
  const maximumLengthEmail = "a".repeat(318) + "@b";
  assert.equal(maximumLengthEmail.length, 320);
  assert.deepEqual(mcpProfileEmailSnapshot({ id: userId, email: maximumLengthEmail }, userId), {
    id: userId, email: maximumLengthEmail,
  });
});

test("email snapshots reject a missing, invalid or different account ID", () => {
  for (const value of [
    undefined, null, [], {}, { id: undefined }, { id: null }, { id: 1 }, { id: "" },
    { id: "person@example.invalid" }, { id: "binding-123" },
    { id: "00000000-0000-0000-0000-000000000000" }, { id: " " + userId },
    Object.create({ id: userId }),
  ]) {
    assert.throws(() => mcpProfileEmailSnapshot(value), unavailable);
  }
  for (const expectedId of [otherUserId, "", " " + userId]) {
    assert.throws(() => mcpProfileEmailSnapshot({ id: userId, email: "person@example.invalid" }, expectedId), unavailable);
  }
});

test("email snapshots never execute getters or copy unrelated account fields", () => {
  let reads = 0;
  const identity = { id: userId };
  for (const field of ["email", "name", "nickname", "user_metadata", "credentials"]) {
    Object.defineProperty(identity, field, {
      enumerable: true, get() { reads++; throw new Error("private-provider-diagnostic"); },
    });
  }
  assert.deepEqual(mcpProfileEmailSnapshot(identity, userId), { id: userId });
  const getterId = Object.defineProperty({}, "id", {
    enumerable: true, get() { reads++; throw new Error("private-provider-diagnostic"); },
  });
  assert.throws(() => mcpProfileEmailSnapshot(getterId, userId), unavailable);
  assert.equal(reads, 0);
});
