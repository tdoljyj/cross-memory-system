import test from 'node:test';
import assert from 'node:assert/strict';
import {inside} from './build-controller-manifest.mjs';
test('Windows fixed root normalizes separators/case but rejects siblings, traversal and other drives',()=>{
 const root='C:/Users/Windows/AppData/Local/Programs/Python/Python312';
 assert.equal(inside('C:\\Users\\Windows\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\json\\__init__.py',root),true);
 assert.equal(inside(root.toLowerCase()+'/Lib/os.py',root),true);
 assert.equal(inside(root,root),true);
 for(const p of [root+'-outside/Lib/os.py',root+'/../Python311/Lib/os.py','D:/Users/Windows/AppData/Local/Programs/Python/Python312/os.py'])assert.equal(inside(p,root),false);
});
