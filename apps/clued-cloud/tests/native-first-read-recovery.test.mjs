import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function recovery(globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL("../app/native-read-recovery.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, AbortController, setInterval, clearInterval, setTimeout, clearTimeout, console, Date, ...globals });
  return exports;
}
const { runNativeRead, readNativeJson, NativeReadFailure } = recovery();
const options = diagnostic => ({ isCurrent: () => true, diagnostic: diagnostic ?? (() => {}) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const results = events => events.filter(event => event.outcome !== "start" && event.outcome !== "lifecycle");

test("first interrupted request and body recover automatically on the same explicit read", async () => {
  const events = [], delays = [], timers = new Set(), polls = new Set();
  const scheduled = [deferred(), deferred()]; let calls = 0, completed = false;
  const { runNativeRead, readNativeJson } = recovery({
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds }; timers.add(timer); delays.push(milliseconds);
      scheduled[delays.length - 1]?.resolve(timer); return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    setInterval(callback, milliseconds) {
      assert.equal(milliseconds, 50); const poll = { callback }; polls.add(poll); return poll;
    },
    clearInterval(poll) { polls.delete(poll); },
  });
  const work = runNativeRead("projects.list", async () => {
    if (++calls === 1) throw new TypeError("secret fixture bearer/body must not be retained");
    if (calls === 2) return readNativeJson(new Response(new ReadableStream({ start(stream) {
      stream.error(new DOMException("private fixture query must not be retained", "AbortError"));
    } }), { status: 200 }));
    return readNativeJson(Response.json({ projects: [{ id: "existing", name: "Fixture project" }] }));
  }, options(event => events.push(event)));
  void work.then(() => { completed = true; }, () => { completed = true; });
  for (const [index, milliseconds] of [250, 750].entries()) {
    const timer = await scheduled[index].promise;
    await Promise.resolve();
    assert.equal(timer.milliseconds, milliseconds);
    assert.equal(calls, index + 1, "the next read waits for its backoff callback");
    assert.equal(completed, false); assert.equal(timers.size, 1); assert.equal(polls.size, 1);
    assert.equal(timers.delete(timer), true); timer.callback();
  }
  const value = await work;
  assert.equal(calls, 3); assert.equal(value.projects.length, 1);
  assert.deepEqual(delays, [250, 750]);
  assert.equal(timers.size, 0); assert.equal(polls.size, 0, "all pending-read intervals are cleared");
  assert.deepEqual(results(events).map(event => [event.attempt, event.phase, event.outcome]), [[1, "request", "retry"], [2, "body", "retry"], [3, "complete", "success"]]);
  assert.equal(events.filter(event => event.outcome === "start").length, calls);
  assert.equal(new Set(events.map(event => event.readId)).size, 1);
  assert.equal(new Set(events.map(event => event.startedAt)).size, 1);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /secret|bearer|private|query|Fixture project|existing/);
});

test("persistent transport failure stops after three reads with a safe typed failure", async () => {
  let calls = 0; const events = [];
  await assert.rejects(runNativeRead("imprints.read", async () => {
    ++calls; throw new NativeReadFailure({ category: "transport", phase: "transport", status: 0, type: "TypeError" });
  }, options(event => events.push(event))), error => error instanceof NativeReadFailure && error.category === "transport" && error.status === 0);
  assert.equal(calls, 3); assert.deepEqual(results(events).map(event => event.outcome), ["retry", "retry", "failed"]);
  assert.equal(events.filter(event => event.outcome === "start").length, calls);
});

test("HTTP auth/other failures, malformed JSON, shape and semantic denials never retry", async () => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    await assert.rejects(runNativeRead("projects.list", async () => {
      ++calls; return readNativeJson(Response.json({ error: "fixture refusal" }, { status }));
    }, options()), error => error.category === "http" && error.status === status);
    assert.equal(calls, 1);
  }
  for (const read of [
    () => readNativeJson(new Response("not JSON", { status: 200 })),
    async () => { const used = Response.json({ projects: [] }); await used.json(); return readNativeJson(used); },
    () => { throw new NativeReadFailure({ category: "payload", phase: "payload", status: 200, type: "PayloadError" }); },
    () => { throw new NativeReadFailure({ category: "semantic", phase: "semantic", status: 200, type: "SemanticError" }); },
  ]) {
    let calls = 0;
    await assert.rejects(runNativeRead("imprints.read", () => { ++calls; return read(); }, options()), error => ["payload", "semantic"].includes(error.category));
    assert.equal(calls, 1);
  }
});

test("mutation label is rejected before the callback, including untyped JS callers", async () => {
  let calls = 0; const events = [];
  await assert.rejects(runNativeRead("imprints.mutate", () => { calls++; return Promise.resolve("committed"); }, options(event => events.push(event))), error => error.category === "semantic");
  assert.equal(calls, 0); assert.equal(events[0].operation, "invalid-operation");
});

test("caller abort during a pending request returns immediately and never retries", async () => {
  const controller = new AbortController(), pending = deferred(), dispatched = deferred(); let calls = 0, requestSignal;
  const work = runNativeRead("projects.list", ({ signal }) => { calls++; requestSignal = signal; dispatched.resolve(); return pending.promise; }, { ...options(), signal: controller.signal });
  await dispatched.promise; controller.abort("fixture private reason is not retained");
  await assert.rejects(work, error => error.category === "cancelled" && !error.message.includes("private"));
  assert.equal(calls, 1); assert.equal(requestSignal.aborted, true);
  pending.resolve({ projects: ["old"] });
});

test("account/selection change stops a pending read and rejects its late success", async () => {
  const pending = deferred(), dispatched = deferred(); let current = true, oldCalls = 0, oldSignal;
  const old = runNativeRead("imprints.read", ({ signal }) => { oldCalls++; oldSignal = signal; dispatched.resolve(); return pending.promise; }, { ...options(), isCurrent: () => current });
  await dispatched.promise; current = false;
  const fresh = await runNativeRead("imprints.read", async () => ({ records: ["new"] }), options());
  await assert.rejects(old, error => error.category === "stale");
  pending.resolve({ records: ["old"] });
  assert.deepEqual(fresh.records, ["new"]); assert.equal(oldCalls, 1); assert.equal(oldSignal.aborted, true);
});

test("abort and stale selection during backoff stop before any second request", async () => {
  for (const kind of ["abort", "stale"]) {
    const controller = new AbortController(), first = deferred(); let calls = 0, current = true;
    const work = runNativeRead("projects.list", async () => { calls++; throw new TypeError("fixture transport failure"); }, {
      signal: controller.signal, isCurrent: () => current, diagnostic(event) { if (event.outcome === "retry") first.resolve(); },
    });
    await first.promise;
    if (kind === "abort") controller.abort(); else current = false;
    await assert.rejects(work, error => error.category === (kind === "abort" ? "cancelled" : "stale"));
    assert.equal(calls, 1);
  }
});

test("an already inactive caller never sends a read; diagnostic failures never retry a success", async () => {
  let calls = 0;
  await assert.rejects(runNativeRead("projects.list", () => { calls++; return Promise.resolve([]); }, { ...options(), isCurrent: () => false }), error => error.category === "stale");
  assert.equal(calls, 0);
  const value = await runNativeRead("projects.list", async () => { calls++; return "success"; }, options(() => { throw Error("collector failed"); }));
  assert.equal(value, "success"); assert.equal(calls, 1);
});

function fakeLifecycle() {
  class Surface extends EventTarget {
    active = new Map();
    visibilityState = "visible";
    addEventListener(type, listener, options) {
      if (!this.active.has(type)) this.active.set(type, new Set());
      this.active.get(type).add(listener); super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      this.active.get(type)?.delete(listener); super.removeEventListener(type, listener, options);
    }
    count() { return [...this.active.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
    fire(type) {
      const event = new Event(type);
      event.privateBody = "PRIVATE_BODY_SENTINEL"; event.url = "https://private.invalid/?token=TOKEN_SENTINEL";
      this.dispatchEvent(event);
    }
  }
  const document = new Surface(), window = new Surface();
  for (const surface of [document, window]) {
    for (const key of ["location", "cookie", "localStorage", "sessionStorage", "user", "selection"]) {
      Object.defineProperty(surface, key, { get() { throw Error("Private browser property must not be read: " + key); } });
    }
  }
  return { document, window };
}

test("fixed lifecycle events only observe a pending read, exclude private payloads, and detach on success", async () => {
  const surfaces = fakeLifecycle(), { runNativeRead } = recovery(surfaces), pending = deferred(), events = [];
  let calls = 0, signal;
  const work = runNativeRead("projects.list", attempt => { calls++; signal = attempt.signal; return pending.promise; }, options(event => events.push(event)));
  assert.equal(surfaces.document.count(), 1); assert.equal(surfaces.window.count(), 3);
  surfaces.document.visibilityState = "hidden"; surfaces.document.fire("visibilitychange");
  for (const lifecycle of ["pagehide", "offline", "online"]) surfaces.window.fire(lifecycle);
  surfaces.document.visibilityState = "PRIVATE_VISIBILITY_SENTINEL"; surfaces.document.fire("visibilitychange");
  surfaces.window.fire("unload");
  assert.equal(signal.aborted, false, "observations must not cancel the read"); assert.equal(calls, 1);
  pending.resolve({ projects: ["PRIVATE_RESULT_SENTINEL"] }); await work;
  assert.equal(surfaces.document.count(), 0); assert.equal(surfaces.window.count(), 0);
  const count = events.length; surfaces.window.fire("pagehide"); surfaces.document.fire("visibilitychange"); assert.equal(events.length, count);
  assert.deepEqual(events.filter(event => event.outcome === "lifecycle").map(event => event.lifecycle), ["visibilitychange", "pagehide", "offline", "online", "visibilitychange"]);
  assert.equal(events.filter(event => event.outcome === "lifecycle").at(-1).visibility, "unknown");
  assert.equal(events.filter(event => event.outcome === "start").length, calls);
  assert.deepEqual(results(events).map(event => event.outcome), ["success"]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|TOKEN_SENTINEL|private\.invalid|cookie|selection|user|stack/);
});

test("lifecycle observations during backoff do not add reads or alter the fixed retry schedule", async () => {
  const surfaces = fakeLifecycle(), { runNativeRead } = recovery(surfaces), firstRetry = deferred(), events = []; let calls = 0;
  const work = runNativeRead("imprints.read", async () => { if (++calls === 1) throw new TypeError("fixture interrupted"); return "ready"; }, options(event => {
    events.push(event); if (event.outcome === "retry") firstRetry.resolve();
  }));
  await firstRetry.promise;
  assert.equal(surfaces.document.count(), 1); assert.equal(surfaces.window.count(), 3);
  surfaces.window.fire("offline"); surfaces.window.fire("pagehide");
  assert.equal(await work, "ready"); assert.equal(calls, 2);
  assert.equal(events.filter(event => event.outcome === "start").length, calls);
  assert.ok(events.filter(event => event.outcome === "lifecycle").every(event => event.phase === "backoff"));
  assert.deepEqual(results(events).map(event => event.outcome), ["retry", "success"]);
  assert.equal(surfaces.document.count(), 0); assert.equal(surfaces.window.count(), 0);
});

test("pending lifecycle listeners detach on caller cancellation and stale selection", async () => {
  for (const kind of ["abort", "stale"]) {
    const surfaces = fakeLifecycle(), { runNativeRead } = recovery(surfaces), pending = deferred(), events = [], controller = new AbortController(); let current = true, calls = 0;
    const work = runNativeRead("imprints.source", () => { calls++; return pending.promise; }, {
      signal: controller.signal, isCurrent: () => current, diagnostic: event => events.push(event),
    });
    assert.equal(surfaces.document.count(), 1); assert.equal(surfaces.window.count(), 3);
    if (kind === "abort") controller.abort("PRIVATE_ABORT_REASON"); else current = false;
    await assert.rejects(work, error => error.category === (kind === "abort" ? "cancelled" : "stale"));
    assert.equal(surfaces.document.count(), 0); assert.equal(surfaces.window.count(), 0);
    const count = events.length; surfaces.window.fire("offline"); assert.equal(events.length, count); assert.equal(calls, 1);
    pending.resolve("old private body"); assert.doesNotMatch(JSON.stringify(events), /PRIVATE_ABORT_REASON|old private body/);
  }
});

test("persistent failure removes all observers and retry transitions never duplicate listeners", async () => {
  const surfaces = fakeLifecycle(), { runNativeRead } = recovery(surfaces), events = []; let calls = 0;
  await assert.rejects(runNativeRead("projects.list", async () => {
    calls++; assert.equal(surfaces.document.count(), 1); assert.equal(surfaces.window.count(), 3);
    surfaces.window.fire("offline"); throw new TypeError("PRIVATE_FAILURE_SENTINEL");
  }, options(event => events.push(event))), error => error.category === "transport");
  assert.equal(calls, 3); assert.equal(events.filter(event => event.outcome === "start").length, calls);
  assert.equal(events.filter(event => event.outcome === "lifecycle").length, calls);
  assert.deepEqual(results(events).map(event => event.outcome), ["retry", "retry", "failed"]);
  assert.equal(surfaces.document.count(), 0); assert.equal(surfaces.window.count(), 0);
  const count = events.length; surfaces.window.fire("online"); assert.equal(events.length, count);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_FAILURE_SENTINEL/);
});

test("default diagnostics are one-line JSON with ephemeral increasing read IDs", async () => {
  const lines = [], { runNativeRead } = recovery({ console: { info(...args) { lines.push(args); } } });
  for (let i = 0; i < 2; i++) await runNativeRead("projects.list", async () => ({ secret: "PRIVATE_RESULT_SENTINEL" }), { isCurrent: () => true });
  assert.equal(lines.length, 4);
  const events = lines.map(args => { assert.equal(args.length, 1); assert.equal(typeof args[0], "string"); assert.doesNotMatch(args[0], /\n|PRIVATE_RESULT_SENTINEL|stack|subject|token/); return JSON.parse(args[0]); });
  assert.deepEqual(events.map(event => event.outcome), ["start", "success", "start", "success"]);
  assert.equal(events[0].readId, events[1].readId); assert.equal(events[2].readId, events[0].readId + 1); assert.equal(events[2].readId, events[3].readId);
  assert.equal(events[0].startedAt, events[1].startedAt); assert.ok(events[2].startedAt >= events[0].startedAt);
});
