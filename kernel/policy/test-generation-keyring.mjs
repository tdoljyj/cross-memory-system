import { createHmac, timingSafeEqual } from "node:crypto";

export class TestGenerationKeyError extends Error {
  constructor(code) {
    super(code);
    this.name = "TestGenerationKeyError";
    this.code = code;
  }
}
function reject(code) { throw new TestGenerationKeyError(code); }
function payloadBytes(payload) { return typeof payload === "string" ? payload : JSON.stringify(payload); }

export class InMemoryTestGenerationKeyRing {
  #keys = new Map();
  #currentGeneration = null;
  #previousGeneration = null;
  #dualVerifyThrough = null;
  #destroyed = false;

  constructor({ audiencePrefix = "urn:clued:test:", profileId = "test_generation" } = {}) {
    if (profileId !== "test_generation" || audiencePrefix.length < 8) reject("TEST_PROFILE_REQUIRED");
    this.audiencePrefix = audiencePrefix;
    this.profileId = profileId;
  }
  #live() { if (this.#destroyed) reject("KEY_RING_DESTROYED"); }
  #audience(audience) {
    if (typeof audience !== "string" || !audience.startsWith(this.audiencePrefix)) {
      reject("PRODUCTION_AUDIENCE_FORBIDDEN");
    }
  }
  installInitial({ generation, keyMaterial }) {
    this.#live();
    if (this.#currentGeneration !== null || generation !== 1 ||
        !Buffer.isBuffer(keyMaterial) || keyMaterial.length < 32) reject("INITIAL_KEY_INVALID");
    this.#keys.set(generation, Buffer.from(keyMaterial));
    this.#currentGeneration = generation;
  }
  rotate({ generation, keyMaterial, dualVerifyThrough }) {
    this.#live();
    if (!Number.isSafeInteger(generation) || generation <= this.#currentGeneration ||
        !Buffer.isBuffer(keyMaterial) || keyMaterial.length < 32 ||
        !Number.isFinite(dualVerifyThrough)) reject("ROTATION_INVALID");
    this.#previousGeneration = this.#currentGeneration;
    this.#currentGeneration = generation;
    this.#dualVerifyThrough = dualVerifyThrough;
    this.#keys.set(generation, Buffer.from(keyMaterial));
  }
  sign(payload, { audience, generation = this.#currentGeneration } = {}) {
    this.#live();
    this.#audience(audience);
    if (generation !== this.#currentGeneration) reject("OLD_GENERATION_SIGNING_FORBIDDEN");
    const key = this.#keys.get(generation);
    if (!key) reject("KEY_GENERATION_UNAVAILABLE");
    return Object.freeze({
      profile_id: this.profileId,
      audience,
      generation,
      algorithm: "HMAC-SHA256-TEST-ONLY",
      signature: "sha256:" + createHmac("sha256", key).update(payloadBytes(payload)).digest("hex"),
    });
  }
  verify(payload, signature, { audience, now }) {
    this.#live();
    this.#audience(audience);
    if (!signature || signature.profile_id !== this.profileId || signature.audience !== audience) return false;
    const accepted = signature.generation === this.#currentGeneration ||
      (signature.generation === this.#previousGeneration &&
       Number.isFinite(this.#dualVerifyThrough) && now <= this.#dualVerifyThrough);
    if (!accepted) return false;
    const key = this.#keys.get(signature.generation);
    const supplied = String(signature.signature || "").replace(/^sha256:/, "");
    if (!key || !/^[0-9a-f]{64}$/.test(supplied)) return false;
    return timingSafeEqual(
      createHmac("sha256", key).update(payloadBytes(payload)).digest(),
      Buffer.from(supplied, "hex"),
    );
  }
  finalizeRotation({ now }) {
    this.#live();
    if (this.#previousGeneration === null || now < this.#dualVerifyThrough) reject("DUAL_VERIFY_WINDOW_ACTIVE");
    const previous = this.#keys.get(this.#previousGeneration);
    if (previous) previous.fill(0);
    this.#keys.delete(this.#previousGeneration);
    this.#previousGeneration = null;
    this.#dualVerifyThrough = null;
  }
  destroyAll() {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
    this.#currentGeneration = null;
    this.#previousGeneration = null;
    this.#dualVerifyThrough = null;
    this.#destroyed = true;
  }
  attestation() {
    return Object.freeze({
      profile_id: this.profileId,
      audience_prefix: this.audiencePrefix,
      current_generation: this.#currentGeneration,
      previous_generation: this.#previousGeneration,
      active_key_count: this.#keys.size,
      destroyed: this.#destroyed,
      private_material_exported: false,
      persisted: false,
    });
  }
}
