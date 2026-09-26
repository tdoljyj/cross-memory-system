import fs from "node:fs/promises";
import path from "node:path";

/** Pre-existing, durably provisioned Host journal outside Agent-writable roots.
 * Runtime never creates directory entries. Bootstrap must qualify ownership,
 * fixed identity, a single process writer and the volume's flush guarantees. */
export function createResourceCenterRecoveryStore(journalPath) {
  if (typeof journalPath !== "string" || !path.isAbsolute(journalPath)) {
    throw new TypeError("An absolute, pre-provisioned Host recovery journal is required.");
  }
  const validKey = (key) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key ?? "");
  async function openJournal() {
    const before = await fs.lstat(journalPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("RECOVERY_JOURNAL_UNSAFE");
    const file = await fs.open(journalPath, "r+");
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1) {
      await file.close(); throw new Error("RECOVERY_JOURNAL_CHANGED");
    }
    return file;
  }
  const parse = (text) => {
    if (text && !text.endsWith("\n")) throw new Error("RECOVERY_JOURNAL_PARTIAL_RECORD");
    const keys = new Set();
    return text.split("\n").filter(Boolean).map((line) => {
      const value = JSON.parse(line);
      if (value.contract !== "clued.resource-center-recovery/1" || !validKey(value.request_key) || keys.has(value.request_key)) {
        throw new Error("RESOURCE_CENTER_RECOVERY_TICKET_INVALID");
      }
      keys.add(value.request_key);
      return value;
    });
  };
  let pending = Promise.resolve();
  return Object.freeze({
    persist_recovery(ticket) {
      const copy = structuredClone(ticket);
      const save = pending.then(async () => {
        if (copy?.contract !== "clued.resource-center-recovery/1" || !validKey(copy.request_key)) {
          throw new TypeError("Invalid recovery ticket.");
        }
        const file = await openJournal();
        try {
          const current = await file.readFile("utf8");
          if (parse(current).some((value) => value.request_key === copy.request_key)) {
            throw new Error("RECOVERY_KEY_ALREADY_EXISTS");
          }
          // This sole writer is now at EOF. A torn prior append fails closed
          // above: never discard it or join the next valid ticket to its tail.
          await file.writeFile(JSON.stringify(copy) + "\n", "utf8");
          await file.sync();
        } finally { await file.close(); }
      });
      pending = save.catch(() => {});
      return save;
    },
    async read_recovery(key) {
      if (!validKey(key)) throw new TypeError("Invalid recovery key.");
      await pending;
      const file = await openJournal();
      try {
        const ticket = parse(await file.readFile("utf8")).find((value) => value.request_key === key);
        if (!ticket) throw new Error("RESOURCE_CENTER_RECOVERY_TICKET_NOT_FOUND");
        return Object.freeze(ticket);
      } finally { await file.close(); }
    },
  });
}
