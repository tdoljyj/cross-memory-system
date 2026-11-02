from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

import maintenance as m
from test_maintenance import Fixture, HERE


class ProducerTests(Fixture):
    def test_supervisor_waits_for_orphan_descendant(self):
        marker = self.root / "descendant-finished"
        grandchild = "import time,pathlib,sys;time.sleep(.35);pathlib.Path(sys.argv[1]).write_text('done')"
        child = "import subprocess,sys;subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]])"
        started = time.monotonic()
        result = self.child("from producer import run_tree;import os;sys.exit(run_tree(sys.argv[2:],os.environ.copy()))",
                            sys.executable, "-c", child, grandchild, marker)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(time.monotonic() - started, .3)
        self.assertEqual(marker.read_text(), "done")

    def test_timeout_contains_only_own_descendants(self):
        marker = self.root / "must-not-be-written"
        grandchild = "import time,pathlib,sys;time.sleep(3);pathlib.Path(sys.argv[1]).write_text('bad')"
        child = "import subprocess,sys;subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]])"
        result = self.child("from producer import run_tree;import os;sys.exit(run_tree(sys.argv[2:],os.environ.copy(),.15))",
                            sys.executable, "-c", child, grandchild, marker)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertFalse(marker.exists())

    def test_real_cli_writer_holds_cache_until_descendant_terminal(self):
        registry = self.root / "registry.json"
        binding = self.root / "binding.json"
        registry.write_text(json.dumps(self.registry))
        binding.write_text(json.dumps(self.binding))
        ready, done = self.root / "ready", self.root / "done"
        grandchild = ("import os,pathlib,sys,time; p=pathlib.Path(os.environ['CLUED_CACHE_DIR']);"
                      "(p/'payload.bin').write_bytes(b'cache');pathlib.Path(sys.argv[1]).write_text('ready');"
                      "time.sleep(.7);pathlib.Path(sys.argv[2]).write_text('done')")
        child = "import subprocess,sys;subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]])"
        process = subprocess.Popen([sys.executable, str(HERE / "maintenance.py"), "--registry", str(registry),
            "--registry-sha256", m.digest(self.registry), "--binding", str(binding), "run", "--cache-id", "packages", "--",
            sys.executable, "-c", child, grandchild, str(ready), str(done)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 8
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(ready.exists(), process.stderr.read() if process.poll() is not None else "producer did not start")
        self.assertFalse(done.exists())
        result = self.manager.cycle()
        self.assertEqual(result["code"], "LEASE_BUSY")
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr + stdout)
        self.assertTrue(done.exists())
        self.assertEqual(self.manager.cycle()["removed_bytes"], 5)

    def test_child_failure_is_terminal_and_does_not_pin_cache_forever(self):
        result = self.child("from producer import run_tree;import os;sys.exit(run_tree(sys.argv[2:],os.environ.copy()))",
                            sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7, result.stderr)

    @unittest.skipUnless(os.name == "nt", "Windows handle inheritance")
    def test_unrelated_inheritable_handle_not_visible_in_child(self):
        extra = self.root / "private-extra-handle.bin"
        extra.write_bytes(b"fixture-only")
        code = r'''
import os,msvcrt,ctypes
from producer import run_tree
fd=os.open(sys.argv[2],os.O_RDONLY)
try:
 os.set_inheritable(fd,True)
 handle=msvcrt.get_osfhandle(fd)
 child="import ctypes,sys;from ctypes import wintypes as w;k=ctypes.WinDLL('kernel32');k.GetFinalPathNameByHandleW.argtypes=[w.HANDLE,w.LPWSTR,w.DWORD,w.DWORD];b=ctypes.create_unicode_buffer(32768);n=k.GetFinalPathNameByHandleW(int(sys.argv[1]),b,len(b),0);sys.exit(41 if n and b.value.endswith('private-extra-handle.bin') else 0)"
 rc=run_tree([sys.executable,'-c',child,str(handle)],os.environ.copy())
 assert os.get_inheritable(fd), 'original handle flag changed'
 sys.exit(rc)
finally:os.close(fd)
'''
        result = self.child(code, extra)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(os.name == "nt", "Windows handle setup fault")
    def test_failed_stdio_setup_closes_private_copies_without_mutating_originals(self):
        code = r'''
import ctypes,os
from ctypes import wintypes as w
from unittest.mock import patch
import producer
from maintenance import Refused
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.GetCurrentProcess.restype=w.HANDLE
k.GetStdHandle.argtypes=[w.DWORD];k.GetStdHandle.restype=w.HANDLE
k.GetHandleInformation.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)]
k.GetProcessHandleCount.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)]
raw=k.DuplicateHandle
raw.argtypes=[w.HANDLE,w.HANDLE,w.HANDLE,ctypes.POINTER(w.HANDLE),w.DWORD,w.BOOL,w.DWORD]
def std_flags():
 out=[]
 for number in (-10,-11,-12):
  h=k.GetStdHandle(number & 0xffffffff);v=w.DWORD();assert k.GetHandleInformation(h,ctypes.byref(v));out.append(v.value)
 return out
def count():
 v=w.DWORD();assert k.GetProcessHandleCount(k.GetCurrentProcess(),ctypes.byref(v));return v.value
for failure_index in (2,3):
 calls=[0]
 def fault(*args):
  calls[0]+=1
  if calls[0]==failure_index:ctypes.set_last_error(5);return 0
  return raw(*args)
 k.DuplicateHandle=fault
 before_flags,before_count=std_flags(),count()
 with patch.object(producer.ctypes,'WinDLL',return_value=k):
  try:producer.run_tree([sys.executable,'-c','raise SystemExit(99)'],os.environ.copy())
  except Refused as e:assert str(e)=='STD_HANDLE_COPY_FAILED'
  else:raise AssertionError('setup unexpectedly succeeded')
 assert calls[0]==failure_index
 assert std_flags()==before_flags,'original stdio flags mutated'
 assert count()==before_count,'private handle leaked'
'''
        result = self.child(code)
        self.assertEqual(result.returncode, 0, result.stderr)
