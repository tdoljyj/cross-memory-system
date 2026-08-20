# -*- coding: utf-8 -*-
"""R3-P0-1：directory-legacy → 新布局迁移事务（binding.json manifest + state.json 三轴）。

背景（2026-08-20 裁决 P0-1）：真实 Binding（codex-workbuddy-windows-primary）
当前为 legacy 目录布局 —— bindings/<id>/binding.json 承载三轴状态（无 schema）。
新布局固定为：
  - bindings/<id>/binding.json ：Clued manifest（clued.binding.v0.1 + Agent/scope）
  - bindings/<id>/state.json   ：三轴状态（lifecycle.state.v0.1）
两者以 binding_id + 各自 schema 版本关联，由安装事务原子创建。

本工具：directory-legacy → 新布局的**原子迁移事务**（与 R2M flat→directory
同风格：备份 → STAGE → COMMIT → VERIFY → DONE，失败完整回滚）。

约束（裁决）：
- **不执行真实迁移**：仅代码 + fixture 测试；真实 Binding 迁移须产品所有者
  另行裁决（通过后再执行，且执行前重跑 conformance 取证）；
- 前置：state.json 不存在、binding.json 为 legacy 三轴（非 manifest）、
  三轴合法；
- 原 binding.json **逐字节备份**（非删除），记录 SHA-256；
- manifest 由默认构造（lifecycle_ctl._default_manifest）产出；
- VERIFY：clued registry 校验 manifest + lifecycle 三轴一致 + 可枚举；
- 任一阶段失败 → 完整回滚（删除新文件 + 恢复备份 binding.json）。

用法（裁决后执行）：
  python tools/migrate_legacy_layout.py --state-root <root> --binding <id> \
      --backup-dir <dir> [--fault-inject <stage>]
"""

import argparse
import hashlib
import json
import os
import shutil
import time

STAGES = ("PRE", "BACKUP", "STAGE", "COMMIT", "VERIFY", "DONE")


class MigrateError(Exception):
    def __init__(self, stage, message):
        super(MigrateError, self).__init__("[%s] %s" % (stage, message))
        self.stage = stage
        self.message = message


class LegacyLayoutMigrate(object):

    def __init__(self, state_root, binding_id, backup_dir, fault_inject=None):
        self.state_root = state_root
        self.binding_id = binding_id
        self.backup_dir = backup_dir
        self.fault_inject = fault_inject
        self.dir_path = os.path.join(state_root, binding_id)
        self.mpath = os.path.join(self.dir_path, "binding.json")   # legacy 三轴
        self.spath = os.path.join(self.dir_path, "state.json")     # 目标三轴
        self.stage = "PRE"
        self.legacy_bytes = None
        self.legacy_sha256 = None
        self.backup_legacy = None
        self.committed = False

    def _fault(self, stage):
        if self.fault_inject == stage:
            raise MigrateError(stage, "故障注入（%s 边界）" % stage)

    # ---- 前置 ----
    def preflight(self):
        if os.path.isfile(self.spath):
            raise MigrateError("PRE", "前置失败：state.json 已存在（新布局？）")
        if not os.path.isfile(self.mpath):
            raise MigrateError("PRE", "前置失败：legacy binding.json 不存在")
        with open(self.mpath, "r", encoding="utf-8") as f:
            man = json.load(f)
        if man.get("schema_version") == "clued.binding.v0.1":
            raise MigrateError(
                "PRE", "前置失败：binding.json 已是 manifest（非 legacy），无需迁移")
        for k in ("binding", "session", "truth"):
            if k not in man:
                raise MigrateError("PRE", "前置失败：非三轴 legacy（缺 %s）" % k)
        # 备份目录不得位于 state_root 内（防止污染枚举）
        try:
            common = os.path.commonpath([os.path.abspath(self.backup_dir),
                                         os.path.abspath(self.state_root)])
            if common == os.path.abspath(self.state_root):
                raise MigrateError("PRE", "路径越界：备份目录位于 state_root 内")
        except ValueError:
            pass
        self._fault("PRE")

    # ---- 主流程 ----
    def run(self):
        self.preflight()

        # BACKUP：逐字节备份 + SHA-256
        self.stage = "BACKUP"
        os.makedirs(self.backup_dir, exist_ok=True)
        with open(self.mpath, "rb") as f:
            self.legacy_bytes = f.read()
        self.legacy_sha256 = hashlib.sha256(self.legacy_bytes).hexdigest()
        self.backup_legacy = os.path.join(self.backup_dir, "binding.legacy.bin")
        with open(self.backup_legacy, "wb") as f:
            f.write(self.legacy_bytes)
        with open(os.path.join(self.backup_dir, "binding.legacy.json"), "wb") as f:
            f.write(self.legacy_bytes)
        with open(os.path.join(self.backup_dir, "migrate-meta.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"binding_id": self.binding_id, "stage": "BACKUP",
                       "legacy_sha256": self.legacy_sha256,
                       "ts": time.time()}, f, ensure_ascii=False, indent=1)
        self._fault("BACKUP")

        # STAGE：写 state.json.tmp（三轴 + schema）+ binding.json.tmp（manifest）
        self.stage = "STAGE"
        from memory_engine.lifecycle_ctl.controller import (
            LifecycleController, STATE_SCHEMA)
        ctl = LifecycleController(state_root=self.state_root)
        legacy = json.loads(self.legacy_bytes.decode("utf-8"))
        st = {k: legacy[k] for k in ("binding", "session", "truth")}
        st["binding_id"] = self.binding_id
        st["schema_version"] = STATE_SCHEMA
        st["updated_at"] = time.time()
        st["_migrated"] = True
        manifest = ctl._default_manifest(self.binding_id)
        manifest["_migrated"] = True
        s_tmp = self.spath + ".tmp"
        m_tmp = self.mpath + ".tmp"
        with open(s_tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.flush()
        with open(m_tmp, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
            f.flush()
        self._fault("STAGE")

        # COMMIT：原子切换（先 state 后 manifest；manifest 失败回滚 state）
        self.stage = "COMMIT"
        os.replace(s_tmp, self.spath)
        try:
            os.replace(m_tmp, self.mpath)
        except BaseException:
            if os.path.isfile(self.spath):
                os.remove(self.spath)
            raise
        self.committed = True
        self._fault("COMMIT")

        # VERIFY：三轴一致 + manifest 合法 + lifecycle 可读可枚举
        self.stage = "VERIFY"
        with open(self.spath, "r", encoding="utf-8") as f:
            new_st = json.load(f)
        for k in ("binding", "session", "truth"):
            if new_st.get(k) != legacy.get(k):
                raise MigrateError("VERIFY", "三轴不一致：%s" % k)
        with open(self.mpath, "r", encoding="utf-8") as f:
            man = json.load(f)
        from clued.manifests import validate_binding_manifest
        ok, err = validate_binding_manifest(man)
        if not ok:
            raise MigrateError("VERIFY", "manifest 校验失败: %s" % err)
        if man.get("binding_id") != self.binding_id \
                or new_st.get("binding_id") != self.binding_id:
            raise MigrateError("VERIFY", "binding_id 关联不一致")
        from memory_engine.lifecycle_ctl import LifecycleController
        ctl = LifecycleController(state_root=self.state_root)
        loaded = ctl.find_by_agent(self.binding_id)
        if loaded is None or loaded.get("_layout") != "directory":
            raise MigrateError("VERIFY", "迁移后 lifecycle 无法以新布局定位")
        self._fault("VERIFY")

        # DONE：收尾 meta
        self.stage = "DONE"
        with open(os.path.join(self.backup_dir, "migrate-meta.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"binding_id": self.binding_id, "stage": "DONE",
                       "legacy_sha256": self.legacy_sha256,
                       "backup": os.path.basename(self.backup_legacy),
                       "ts": time.time()}, f, ensure_ascii=False, indent=1)
        return {"status": "DONE", "legacy_sha256": self.legacy_sha256,
                "backup": self.backup_legacy}

    # ---- 回滚（完整 legacy 或完整新布局；不允许半迁移） ----
    def rollback(self):
        if os.path.isfile(self.spath):
            os.remove(self.spath)
        if os.path.isfile(self.mpath + ".tmp"):
            os.remove(self.mpath + ".tmp")
        if os.path.isfile(self.spath + ".tmp"):
            os.remove(self.spath + ".tmp")
        if self.backup_legacy and os.path.isfile(self.backup_legacy):
            shutil.copyfile(self.backup_legacy, self.mpath)
        if not os.path.isfile(self.mpath):
            raise MigrateError("ROLLBACK", "回滚失败：binding.json 缺失")
        with open(self.mpath, "rb") as f:
            if self.legacy_bytes is not None and f.read() != self.legacy_bytes:
                raise MigrateError("ROLLBACK", "回滚失败：legacy 字节不一致")
        return {"status": "ROLLED_BACK"}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-root", required=True)
    ap.add_argument("--binding", required=True)
    ap.add_argument("--backup-dir", required=True)
    ap.add_argument("--fault-inject", default=None)
    args = ap.parse_args(argv)
    tx = LegacyLayoutMigrate(args.state_root, args.binding, args.backup_dir,
                             fault_inject=args.fault_inject)
    try:
        result = tx.run()
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0
    except MigrateError as e:
        rb = tx.rollback()
        print(json.dumps({"status": "FAILED", "stage": e.stage,
                          "error": e.message, "rollback": rb},
                         ensure_ascii=False, indent=1))
        return 4


if __name__ == "__main__":
    import sys
    sys.exit(main())
