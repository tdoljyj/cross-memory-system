# -*- coding: utf-8 -*-
"""R2M：扁平 → 目录 Binding 布局原子迁移事务（产品所有者裁决）。

原则（裁决）：
- 前置：flat 存在、directory 不存在、三轴 ACTIVE/ONLINE/ADVISORY；
- 原扁平文件**逐字节备份**并记录 SHA-256；
- 目录构件临时写入 → 校验 → 原子切换；
- 最终只保留正式目录真值，**不保留活动态双格式**；
- **不删除原文件**：移入本次备份证据区（非 purge）；
- 任一阶段故障 → 恢复为**完整扁平 ADVISORY 或完整目录 ADVISORY**（不允许半迁移）；
- 其他 Binding / canonical memory / 共享 Core / 冻结区零修改。

状态机（原子边界）：
  PRE → BACKUP → STAGE → COMMIT → VERIFY → FINALIZE → DONE
        └─────────── 任意边界失败 → ROLLBACK ───────────┘

回滚规则（逐字节一致）：
- FINALIZE 前失败：删除目录临时构件 → 完整扁平（原样）；
- FINALIZE 后失败：从备份恢复扁平（逐字节）+ 删除目录 → 完整扁平；
- 迁移成功：仅目录布局（flat 已移入备份区，非删除）。

fault_inject（测试专用）：在指定边界抛错，验证回滚完整性。
"""

import hashlib
import json
import os
import shutil
import time


class MigrateError(Exception):
    def __init__(self, stage, message):
        super(MigrateError, self).__init__("[%s] %s" % (stage, message))
        self.stage = stage
        self.message = message


STAGES = ("PRE", "BACKUP", "STAGE", "COMMIT", "VERIFY", "FINALIZE")


class MigrateTransaction(object):

    def __init__(self, state_root, binding_id, backup_dir, fault_inject=None):
        self.state_root = state_root
        self.binding_id = binding_id
        self.backup_dir = backup_dir
        self.fault_inject = fault_inject  # stage 名（测试故障注入）
        self.flat_path = os.path.join(state_root, "%s.json" % binding_id)
        self.dir_path = os.path.join(state_root, binding_id)
        # P0-1（2026-08-20）：目录布局 = binding.json（Clued manifest）
        # + state.json（三轴）；三轴状态不再写入 binding.json。
        self.canonical = os.path.join(self.dir_path, "state.json")
        self.manifest_path = os.path.join(self.dir_path, "binding.json")
        self.stage = "PRE"
        self.flat_bytes = None
        self.flat_sha256 = None
        self.backup_flat = None
        self.committed = False
        self.finalized = False

    # ---- 工具 ----
    def _fault(self, stage):
        if self.fault_inject == stage:
            raise MigrateError(stage, "故障注入（%s 边界）" % stage)

    def _read_flat(self):
        with open(self.flat_path, "rb") as f:
            return f.read()

    # ---- 前置 ----
    def preflight(self):
        if not os.path.isfile(self.flat_path):
            raise MigrateError("PRE", "前置失败：flat 不存在")
        if os.path.exists(self.dir_path):
            raise MigrateError("PRE", "前置失败：directory 已存在")
        # 路径越界阻断：备份目录不得位于 state_root 内（否则污染枚举/白名单）
        try:
            common = os.path.commonpath([os.path.abspath(self.backup_dir),
                                         os.path.abspath(self.state_root)])
            if common == os.path.abspath(self.state_root):
                raise MigrateError("PRE", "路径越界：备份目录位于 state_root 内")
        except ValueError:
            pass  # 不同盘符：安全
        from memory_engine.lifecycle_ctl import LifecycleController
        ctl = LifecycleController(state_root=self.state_root)
        st = ctl.load(self.binding_id)
        if not st or st.get("_layout") != "flat-migration":
            raise MigrateError("PRE", "前置失败：非扁平布局（%s）"
                               % (st.get("_layout") if st else None))
        if not (st["binding"] == "ACTIVE" and st["session"] == "ONLINE"
                and st["truth"] == "ADVISORY"):
            raise MigrateError(
                "PRE", "前置失败：三轴必须 ACTIVE/ONLINE/ADVISORY（当前 %s/%s/%s）"
                % (st["binding"], st["session"], st["truth"]))
        self._fault("PRE")

    # ---- 主流程 ----
    def run(self):
        self.preflight()

        # BACKUP：逐字节备份 + SHA-256
        self.stage = "BACKUP"
        os.makedirs(self.backup_dir, exist_ok=True)
        self.flat_bytes = self._read_flat()
        self.flat_sha256 = hashlib.sha256(self.flat_bytes).hexdigest()
        self.backup_flat = os.path.join(self.backup_dir, "binding.flat.bin")
        with open(self.backup_flat, "wb") as f:
            f.write(self.flat_bytes)
        with open(os.path.join(self.backup_dir, "binding.flat.json"), "wb") as f:
            f.write(self.flat_bytes)  # 同时保留 .json 命名副本（证据）
        with open(os.path.join(self.backup_dir, "migrate-meta.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"binding_id": self.binding_id, "stage": "BACKUP",
                       "flat_sha256": self.flat_sha256,
                       "backup_flat": os.path.basename(self.backup_flat),
                       "ts": time.time()}, f, ensure_ascii=False, indent=1)
        self._fault("BACKUP")

        # STAGE：目录构件临时写入（P0-1：manifest + state.json 双构件）
        self.stage = "STAGE"
        os.makedirs(self.dir_path, exist_ok=True)
        st = json.loads(self.flat_bytes.decode("utf-8"))
        st["_migrated"] = True
        st["schema_version"] = "lifecycle.state.v0.1"
        from memory_engine.lifecycle_ctl.controller import LifecycleController
        ctl = LifecycleController(state_root=self.state_root)
        manifest = ctl._default_manifest(self.binding_id)
        manifest["_migrated"] = True
        s_tmp = self.canonical + ".tmp"
        m_tmp = self.manifest_path + ".tmp"
        with open(s_tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.flush()
        with open(m_tmp, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
            f.flush()
        self._fault("STAGE")

        # COMMIT：原子切换（此时双格式并存，迁移窗口；先 manifest 后 state，
        # state 失败回滚 manifest → 不留下半创建）
        self.stage = "COMMIT"
        os.replace(m_tmp, self.manifest_path)
        try:
            os.replace(s_tmp, self.canonical)
        except BaseException:
            if os.path.isfile(self.manifest_path):
                os.remove(self.manifest_path)
            raise
        self.committed = True
        self._fault("COMMIT")

        # VERIFY：目录可读 + 三轴一致 + manifest 合法 + 可枚举
        self.stage = "VERIFY"
        with open(self.canonical, "r", encoding="utf-8") as f:
            dir_st = json.load(f)
        flat_st = json.loads(self.flat_bytes.decode("utf-8"))
        for k in ("binding", "session", "truth"):
            if dir_st.get(k) != flat_st.get(k):
                raise MigrateError("VERIFY", "三轴不一致：%s" % k)
        from memory_engine.lifecycle_ctl import LifecycleController
        ctl = LifecycleController(state_root=self.state_root)
        if ctl.find_by_agent(self.binding_id) is None:
            raise MigrateError("VERIFY", "迁移后 find_by_agent 无法定位")
        # P0-1：迁移产物 binding.json 必须为合法 Clued manifest（doctor 兼容）
        with open(self.manifest_path, "r", encoding="utf-8") as f:
            man = json.load(f)
        from clued.manifests import validate_binding_manifest
        ok, err = validate_binding_manifest(man)
        if not ok:
            raise MigrateError("VERIFY", "迁移产物 manifest 校验失败: %s" % err)
        if man.get("binding_id") != self.binding_id \
                or dir_st.get("binding_id") != self.binding_id:
            raise MigrateError("VERIFY", "manifest/state 与 binding_id 关联不一致")
        self._fault("VERIFY")

        # FINALIZE：扁平移入备份区（非删除）
        self.stage = "FINALIZE"
        moved = os.path.join(self.backup_dir, "binding.flat.moved.json")
        os.replace(self.flat_path, moved)
        self.finalized = True
        self._fault("FINALIZE")

        # DONE：终态 = 仅目录布局（bindings/ 下无扁平）
        self.stage = "DONE"
        if os.path.exists(self.flat_path):
            raise MigrateError("DONE", "终态失败：扁平仍存在（活动态双格式）")
        with open(os.path.join(self.backup_dir, "migrate-meta.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"binding_id": self.binding_id, "stage": "DONE",
                       "flat_sha256": self.flat_sha256,
                       "moved_to": os.path.basename(moved),
                       "canonical": self.canonical,
                       "ts": time.time()}, f, ensure_ascii=False, indent=1)
        return {"status": "DONE", "flat_sha256": self.flat_sha256,
                "moved_to": moved, "canonical": self.canonical}

    # ---- 回滚（逐字节一致；完整扁平或完整目录） ----
    def rollback(self):
        """失败回滚：恢复完整扁平 ADVISORY（逐字节），删除目录构件。"""
        # 1) 恢复扁平（若已移走）
        if self.finalized and self.backup_flat:
            shutil.copyfile(self.backup_flat, self.flat_path)
        # 2) 删除目录构件（临时 + 正式）
        if os.path.isfile(self.canonical + ".tmp"):
            os.remove(self.canonical + ".tmp")
        if os.path.isdir(self.dir_path):
            shutil.rmtree(self.dir_path, ignore_errors=True)
        # 3) 校验：扁平逐字节一致 + 三轴 ADVISORY
        if not os.path.isfile(self.flat_path):
            raise MigrateError("ROLLBACK", "回滚失败：扁平缺失")
        restored = self._read_flat()
        if self.flat_bytes is not None and restored != self.flat_bytes:
            raise MigrateError("ROLLBACK", "回滚失败：扁平字节不一致")
        from memory_engine.lifecycle_ctl import LifecycleController
        st = LifecycleController(state_root=self.state_root).load(self.binding_id)
        if not st or st["truth"] != "ADVISORY":
            raise MigrateError("ROLLBACK", "回滚失败：非 ADVISORY")
        return {"status": "ROLLED_BACK", "flat_sha256": self.flat_sha256}
