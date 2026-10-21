// Read-only: verify a resident receipt chain and print its head. Exit 0 only for an intact chain.
//   node verify-receipts.mjs <receipts directory>
import { ReceiptChain } from '../src/receipts.mjs';

const dir = process.argv[2];
try {
  const chain = new ReceiptChain(dir, Date.now);
  const head = await chain.verify();
  console.log(JSON.stringify({ status: 'RECEIPT_CHAIN_INTACT', ...head }));
} catch (error) {
  console.log(JSON.stringify({ status: 'RECEIPT_CHAIN_BROKEN', code: error.code ?? 'UNREADABLE' }));
  process.exitCode = 1;
}
