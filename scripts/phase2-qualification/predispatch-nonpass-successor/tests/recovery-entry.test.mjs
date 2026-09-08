import test from 'node:test';import assert from 'node:assert/strict';
import {prepareTrustedToolMaterial} from '../recovery-context.mjs';
test('recovery admission refuses CREATE/START before reading any material or network',async()=>{for(const operation of ['CREATE','START'])await assert.rejects(prepareTrustedToolMaterial({operation}),/RECOVERY_NONPASS_GRR_ONLY/);});
