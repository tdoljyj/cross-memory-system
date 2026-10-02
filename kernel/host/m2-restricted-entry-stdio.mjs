import { createM2RestrictedEntryCandidate } from "./m2-restricted-entry-candidate.mjs";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

// Reuse the existing listTools/callTool Host interface. Deliberately no VM
// adapter, SDK dependency, shell spawning or auto-registration in this pilot.
export function createM2RestrictedStdioCandidate() {
  const host = createM2RestrictedEntryCandidate();
  return Object.freeze({
    async request(message) {
      const id = typeof message?.id === "string" || Number.isSafeInteger(message?.id) ? message.id : null;
      const response = result => ({ jsonrpc: "2.0", id, result });
      if (!message || message.jsonrpc !== "2.0" || id === null) {
        return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
      }
      if (message.method === "initialize") return response({
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "m2-restricted-entry-candidate", version: "0.1.0" },
        instructions: "Transport NOT_CONFIGURED; qualification NOT_ISSUED.",
      });
      if (message.method === "tools/list") return response({ tools: host.listTools() });
      if (message.method === "tools/call") {
        const result = await host.callTool(message.params?.name, message.params?.arguments);
        return response({ content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status === "deny" });
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not configured" } };
    },
    close: host.revoke,
  });
}

export async function runM2CandidateStdio({ input = process.stdin, output = process.stdout } = {}) {
  const endpoint = createM2RestrictedStdioCandidate();
  let pending = Buffer.alloc(0);
  const send = async response => {
    if (!output.write(JSON.stringify(response) + "\n")) await once(output, "drain");
  };
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > 131072) throw new Error("FRAME_TOO_LARGE");
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch {
          await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue;
        }
        if (message?.jsonrpc === "2.0" && message.method === "notifications/initialized" && !Object.hasOwn(message, "id")) continue;
        await send(await endpoint.request(message));
      }
      if (pending.length > 131072) throw new Error("FRAME_TOO_LARGE");
    }
    if (pending.length) await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Incomplete frame" } });
  } catch {
    await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Stdio boundary failure" } });
  } finally { endpoint.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runM2CandidateStdio();
}
