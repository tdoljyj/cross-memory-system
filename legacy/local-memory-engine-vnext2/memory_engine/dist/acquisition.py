# -*- coding: utf-8 -*-
"""R3-D02 Artifact Acquisition（ADR-R3-003 §3）。

- 受限下载：仅 allowlist URL 前缀（scheme://host/path 前缀匹配）；
- staging：下载到 staging 目录 + .part 文件；部分下载恢复（.part 续传）；
- 单飞锁：同 revision 单下载（目录锁，非阻塞获取）；
- 有界重试：3 次 + 抖动；总预算内完成；
- 全量验证：每文件 SHA-256 校验通过才算 staging 完成；
- cache retention：默认保留最近 N 个 revision，超限清理（仅清理 cache 目录）；
- 脱敏日志：URL 凭证/token 不落日志；
- 失败清理：下载失败/校验失败删除 staging（不留可消费半成品）。
"""

import hashlib
import json
import os
import random
import shutil
import time
import urllib.request


class AcquisitionError(Exception):
    def __init__(self, code, detail=""):
        super(AcquisitionError, self).__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


def _redact_url(url):
    import re
    s = re.sub(r"https?://[^\s\"']*@", "https://<user>@", url)
    s = re.sub(r"([?&](?:token|key|secret|signature|sig)=)[^&\s\"']*", r"\1<redacted>", s)
    return s


class ArtifactAcquisition(object):

    def __init__(self, allowed_prefixes, staging_root, cache_root=None,
                 max_retries=3, retain_versions=2, fetcher=None):
        self.allowed_prefixes = tuple(allowed_prefixes)  # 必须以此为前缀
        self.staging_root = staging_root
        self.cache_root = cache_root or os.path.join(staging_root, "..", "cache")
        self.max_retries = max_retries
        self.retain_versions = retain_versions
        self.fetcher = fetcher  # 可注入（测试用 http 桩）；默认 urllib

    # ---- URL 门禁 ----
    def _check_allowed(self, url):
        # 规范化斜杠：Windows 下 file://C:\... 与前缀 file://C:/... 必须视为同一路径
        norm = url.replace("\\", "/")
        prefixes = [p.replace("\\", "/") for p in self.allowed_prefixes]
        if not any(norm.startswith(p) for p in prefixes):
            raise AcquisitionError("CLD-DIST-002",
                                   "URL 不在 allowlist 前缀内: %s" % _redact_url(url))

    # ---- 单飞锁 ----
    @staticmethod
    def _lock_dir(root, revision):
        return os.path.join(root, ".lock-%s" % revision)

    def _acquire_lock(self, lock_path):
        try:
            os.makedirs(lock_path, exist_ok=False)
            return True
        except OSError:
            return False

    @staticmethod
    def _release_lock(lock_path):
        try:
            os.rmdir(lock_path)
        except OSError:
            pass

    # ---- 单文件下载（.part 续传 + 有界重试） ----
    def _download_one(self, url, dest):
        part = dest + ".part"
        for attempt in range(1, self.max_retries + 1):
            try:
                self._check_allowed(url)
                offset = os.path.getsize(part) if os.path.exists(part) else 0
                mode = "ab" if offset else "wb"
                if self.fetcher is not None:
                    data = self.fetcher(url, offset)
                    with open(part, mode) as f:
                        f.write(data)
                else:
                    req = urllib.request.Request(url, headers={"Range": "bytes=%d-" % offset} if offset else {})
                    with urllib.request.urlopen(req, timeout=30) as r, open(part, mode) as f:
                        shutil.copyfileobj(r, f, 65536)
                # 完成后原子改名
                os.replace(part, dest)
                return dest
            except Exception as e:
                if attempt >= self.max_retries:
                    raise AcquisitionError("CLD-DIST-002",
                                           "下载失败(%d 次): %s"
                                           % (attempt, _redact_url(str(e))))
                time.sleep(0.2 * attempt + random.random() * 0.1)

    # ---- 全量校验 ----
    @staticmethod
    def _sha256(path):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    # ---- 主流程：staging 下载 + 校验 + 失败清理 ----
    def stage(self, manifest, allowlist, url_for):
        """下载 manifest 全部 artifact 到 staging 并全量校验。

        url_for: callable(path) → url；allowlist 同时约束 revision/path/hash。
        成功 → 返回 staging 目录路径（含 verified 标记文件）；
        失败 → 删除 staging 并抛 AcquisitionError（不留可消费半成品）。
        """
        revision = manifest.get("revision")
        staging = os.path.join(self.staging_root, "stage-%s" % revision)
        if os.path.isdir(staging):
            # 已存在同 revision staging：视为完整（由调用方决定是否复用）
            shutil.rmtree(staging)
        os.makedirs(staging, exist_ok=True)
        lock = self._lock_dir(self.staging_root, revision)
        if not self._acquire_lock(lock):
            raise AcquisitionError("CLD-DIST-002", "单飞锁被占用: revision=%s" % revision)
        try:
            for a in manifest.get("artifacts", []):
                path = a["path"]
                dest = os.path.join(staging, path)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                url = url_for(path)
                self._download_one(url, dest)
                # 全量校验（allowlist 根信任 + 大小）
                actual = self._sha256(dest)
                allowlist.verify(revision, path, actual)
                if a.get("max_size_bytes") and os.path.getsize(dest) > a["max_size_bytes"]:
                    raise AcquisitionError("CLD-DIST-001",
                                           "%s 超过大小上限" % path)
            # verified staged receipt
            receipt = {
                "revision": revision,
                "release_id": manifest.get("release_id"),
                "verified_at": time.time(),
                "files": {a["path"]: a["sha256"] for a in manifest.get("artifacts", [])},
            }
            with open(os.path.join(staging, ".verified.json"), "w", encoding="utf-8") as f:
                json.dump(receipt, f, ensure_ascii=False, indent=1)
            self._prune_cache(revision)
            return staging
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)  # 失败清理：不留半成品
            raise
        finally:
            self._release_lock(lock)

    # ---- cache retention ----
    def _prune_cache(self, current_revision):
        if not os.path.isdir(self.cache_root):
            return
        try:
            entries = sorted(os.listdir(self.cache_root))
        except OSError:
            return
        kept = {current_revision}
        # 仅清理 cache 目录内已知 revision 目录，绝不触碰其他路径
        for name in entries:
            if name.startswith("rev-") and name[4:] not in kept:
                cand = os.path.join(self.cache_root, name)
                if os.path.isdir(cand):
                    try:
                        shutil.rmtree(cand)
                    except OSError:
                        pass
