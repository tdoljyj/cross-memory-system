# -*- coding: utf-8 -*-
"""跨进程锁（协议 §6.3 Acquire Lock / §8.3 单飞 / §10.1）。

沿用 sync-memory.py 的既有模式：O_CREAT|O_EXCL + PID 文件 + Windows 安全探活
（OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetExitCodeProcess；
os.kill(pid,0) 在 Windows 上会 TerminateProcess，禁止使用）。
"""

import os

from .audit import AuditLog

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259


def _pid_alive(pid):
    """Windows 安全探活；打开失败=进程不存在；ACCESS_DENIED(5)=按存活保守处理。"""
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return ctypes.get_last_error() == 5
            try:
                code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True
                return code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class CrossProcessLock(object):
    """进程级互斥锁（可重入同进程）。到期不会自动释放——持有者崩溃后由
    下一次 acquire 按 PID 探活回收（与同步层 .sync.lock 语义一致）。"""

    def __init__(self, path, audit=None, purpose="lifecycle"):
        self.path = path
        self.audit = audit
        self.purpose = purpose
        self.acquired = False

    def acquire(self):
        if self.acquired:
            return True
        d = os.path.dirname(self.path)
        if not os.path.isdir(d):
            os.makedirs(d)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, str(os.getpid()).encode("ascii"))
                finally:
                    os.close(fd)
                self.acquired = True
                if self.audit is not None:
                    self.audit.append(
                        "lock_acquired", result_code="OK",
                        metadata={"purpose": self.purpose, "pid": os.getpid()})
                return True
            except FileExistsError:
                holder = None
                try:
                    with open(self.path, "r", encoding="ascii") as fh:
                        holder = int(fh.read().strip() or 0)
                except Exception:
                    holder = None
                if _pid_alive(holder):
                    return False
                try:
                    os.remove(self.path)
                except OSError:
                    return False
        return False

    def release(self):
        if not self.acquired:
            return
        try:
            if os.path.exists(self.path):
                os.remove(self.path)
        except OSError:
            pass
        self.acquired = False
        if self.audit is not None:
            self.audit.append("lock_released", result_code="OK",
                              metadata={"purpose": self.purpose})

    def __enter__(self):
        if not self.acquire():
            raise LockBusy("cross-process lock busy: %s" % self.purpose)
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()
        return False


class LockBusy(Exception):
    pass
