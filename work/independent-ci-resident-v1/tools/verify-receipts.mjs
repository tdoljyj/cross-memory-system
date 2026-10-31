// Read-only: verify a resident receipt chain and print its head. Exit 0 only for an intact chain.
//   node verify-receipts.mjs <receipts directory>
// The whole segmented chain (DESIGN §41.7, receipts.mjs#verifyAll): the seals, every archived month against its seal, and the
// open segment; nothing is moved or repaired. segments: how many sealed months it read.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ReceiptChain } from '../src/receipts.mjs';

export async function verifyReceipts(dir) {
  try {
    const chain = new ReceiptChain(dir, Date.now);
    const head = await chain.verifyAll();
    return { ok: true, report: { status: 'RECEIPT_CHAIN_INTACT', ...head, segments: (chain.sealsKnown ?? []).length } };
  } catch (error) {
    return { ok: false, report: { status: 'RECEIPT_CHAIN_BROKEN', code: error.code ?? 'UNREADABLE' } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { ok, report } = await verifyReceipts(process.argv[2]);
  console.log(JSON.stringify(report));
  if (!ok) process.exitCode = 1;
}
