# CluedDev-Linux 上验证 Linux 升级工具的真实 statvfs、FS_IOC_GETVERSION 与逐条目挂载检查

对象：`R/linux/bin/clued-ci-upgrade-linux`（ee68029c 修复，本分支合并提交 af02e893）。`R = work/independent-ci-resident-v1`。

**状态：只写不跑。协调者同意后才跑。** 只在非生产发行版 `CluedDev-Linux` 里跑，不碰生产发行版，不碰 `/opt/clued-independent-ci`、`/etc/clued-independent-ci` 的真实目录；所有演练树都在 `$W`（发行版里的临时目录，ext4）下，用工具自己的 `paths(prefix)` 把 `/` 换成这个前缀。

## 工具里要验证的三处

| 位置 | 行为 |
|---|---|
| `fs_id(path)`（约 237 行） | `os.statvfs(path).f_fsid` 转十六进制；出错（非 Linux 等）返回 None。ext4 上由超级块 UUID 派生，不随 WSL2 虚拟机把同一个 ext4.vhdx 挂成另一个块设备号而变 |
| `inode_generation(path, kind)`（约 251 行） | `open(O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK[\|O_DIRECTORY])` 后 `fcntl.ioctl(fd, 0x80087601, 8 字节)`，取前 4 字节小端整数（ext4 的 `i_generation`）；不支持则 `OSError` 被吞掉，返回 None |
| `same_device(P)`（约 749 行） | 所有活条目的父目录、每个活条目自己、`P['opt']` 的 `st_dev` 必须只有一个值，否则拒绝 `CROSS_DEVICE_LAYOUT`；条目自己被挂载（tmpfs、bind）会被抓到。`stage`、`switch`、`rollback`、`verify` 都先调它 |

`ident()` 记录 `{kind, dev, ino, fsid, igen}`；`same()` 只比较 kind、ino，以及双方都有时的 fsid、igen，**不比较 dev**。

## 0. 前置：确认是非生产发行版

在 Windows（非提权 PowerShell）：

```powershell
wsl.exe -l -v
wsl.exe -d CluedDev-Linux -u root --exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/bash --noprofile --norc -c 'cat /etc/os-release | head -2; ls -d /opt/clued-independent-ci /etc/clued-independent-ci 2>&1; python3.12 -V'
```

- 做什么：列出发行版，确认目标就是 CluedDev-Linux，并确认里面没有生产布局，有 python3.12。
- 预期：列表里有 `CluedDev-Linux`；两个 `ls -d` 都输出 `No such file or directory`；`Python 3.12.x`。
- 通过：三项都满足。只要 `/opt/clued-independent-ci` 存在或名字不对，就停，不继续。

以下命令都在发行版里以 root 运行，写成 `wsl.exe -d CluedDev-Linux -u root --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C /usr/bin/bash --noprofile --norc -c '<命令>'`，或先进入发行版。

## 1. 准备：工具副本与临时目录

```bash
W=$(mktemp -d /root/cdv.XXXXXX) && echo "$W" && df -T "$W" | tail -1
mkdir -p "$W/tool" && cp /mnt/d/w/fleet-b1/work/independent-ci-resident-v1/linux/bin/clued-ci-upgrade-linux "$W/tool/" && sha256sum "$W/tool/clued-ci-upgrade-linux"
```

- 做什么：在发行版自己的磁盘上建临时目录，复制工具（路径按实际检出位置调整）。
- 预期：`df -T` 的类型列是 `ext4`；打印出工具的 sha256。
- 通过：类型是 ext4（不是 9p、overlay、tmpfs）；sha256 与 `sha256sum R/linux/bin/clued-ci-upgrade-linux`（Windows 侧或 git 里）一致。

之后每个 python 片段都先加载工具（等同测试里的加载方式）：

```bash
cat > "$W/load.py" <<'PY'
import importlib.machinery, importlib.util, os, sys
_l = importlib.machinery.SourceFileLoader('upgrade_linux', os.environ['W'] + '/tool/clued-ci-upgrade-linux')
tool = importlib.util.module_from_spec(importlib.util.spec_from_loader('upgrade_linux', _l)); _l.exec_module(tool)
PY
export W; PY="python3.12 -I"
$PY -c "import os, sys; sys.path.insert(0, os.environ['W']); from load import tool; print(tool.FS_IOC_GETVERSION == 0x80087601)"
```

- 预期：`True`。通过：输出 `True`（工具加载无异常）。`-I` 会忽略 PYTHONPATH 和当前目录，所以每个片段都用 `sys.path.insert(0, os.environ['W'])` 引入 `load.py`；后面所有命令都在这同一个 shell 里跑（`W` 与 `PY` 已设）。

## 2. 真实 statvfs（文件系统 ID）

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
for p in ('/', os.environ['W'], os.environ['W'] + '/tool/clued-ci-upgrade-linux', '/dev/shm', '/proc', '/mnt/c'):
    print(p, tool.fs_id(p), os.statvfs(p).f_fsid)
"
stat -f -c '%i %T' / /dev/shm /proc
```

- 做什么：对 ext4 根、临时目录、其中的文件和几个非 ext4 位置调用 `fs_id`，并与内核/coreutils 的值对照。
- 预期：前三行（`/`、`$W`、`$W/tool/...`）的 `fs_id` 是同一个非空十六进制串，且不是 `0`；`/dev/shm`（tmpfs）与 `/proc` 是与 ext4 不同的串（有的内核给 `0`，记录下来）；`/mnt/c`（9p/drvfs）有值或 `0`，不得抛异常；每一行第三列的整数转十六进制等于第二列。`stat -f` 的 `%i` 是同一个 fsid（高低 32 位的排列与 Python 的整数可能不同，只比“同一文件系统相同、不同文件系统不同”，不要求逐字相等）。
- 通过：ext4 上三路径 `fs_id` 相同且非 None、非 0；ext4 与 tmpfs 的 `fs_id` 不同；无任何路径抛异常；不存在的路径返回 None：

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
print(tool.fs_id('/nonexistent-x'))"
```

预期 `None`。

### 2b. 重新挂载后 fsid 不变（工具要解决的现场问题）

在 Windows（非提权）：

```powershell
wsl.exe -d CluedDev-Linux -u root --exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/bash --noprofile --norc -c "python3.12 -I -c \"import os;print(format(os.statvfs('/').f_fsid,'x'), os.stat('/').st_dev)\""
wsl.exe --terminate CluedDev-Linux
wsl.exe -d CluedDev-Linux -u root --exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/bash --noprofile --norc -c "python3.12 -I -c \"import os;print(format(os.statvfs('/').f_fsid,'x'), os.stat('/').st_dev)\""
```

- 做什么：终止并重启发行版（虚拟机重新挂载 ext4.vhdx），比较前后根文件系统的 fsid 与 st_dev。`--terminate` 只终止这一个发行版。
- 预期：两次第一列（fsid）相同；第二列（st_dev）可能相同也可能不同。
- 通过：fsid 相同。st_dev 若变了，正是 `same()` 不比较 dev 的原因，记为额外证据；st_dev 没变不算失败。

## 3. 真实 FS_IOC_GETVERSION（inode 代号）

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
W = os.environ['W']; f = W + '/g.txt'; open(f, 'w').write('x'); os.mkdir(W + '/gd')
print('file', tool.inode_generation(f, 'file'), 'dir', tool.inode_generation(W + '/gd', 'dir'))
print('shm', tool.inode_generation('/dev/shm', 'dir'), 'proc', tool.inode_generation('/proc/self/status', 'file'), 'missing', tool.inode_generation(W + '/none', 'file'))
"
lsattr -v "$W/g.txt"; lsattr -d -v "$W/gd"
```

- 做什么：对 ext4 的文件和目录读 inode 代号，并与 `lsattr -v`（同一个 ioctl，`EXT2_IOC_GETVERSION`）对照；再对非 ext4 与不存在的路径调用。
- 预期：`file`、`dir` 是 `0` 到 4294967295 之间的整数（非 None）；它们等于 `lsattr -v` 每行前面的版本号；`shm`、`proc`、`missing` 都是 `None`（不支持的文件系统/不存在，被吞掉而不是抛异常）。
- 通过：整数与 `lsattr -v` 逐个相等，且不支持的位置都返回 None。若 ext4 上也是 None，说明 ioctl 在这个内核上没有实现或被拒，判不通过并记录 `uname -r`；工具此时降级为只比较 kind 与 ino（见 `same()` 注释），这是已设计的降级，但要如实报告。

### 3b. 重命名保持代号；删后重建得到新代号

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
W = os.environ['W']; a = W + '/r1'; b = W + '/r2'
open(a, 'w').write('x'); i0 = tool.ident(a); os.rename(a, b); i1 = tool.ident(b)
print('rename keeps', (i0['kind'], i0['ino'], i0['fsid'], i0['igen']) == (i1['kind'], i1['ino'], i1['fsid'], i1['igen']), tool.same(i1, i0))
hits = 0
for n in range(400):
    old = tool.ident(b); os.unlink(b); open(b, 'w').write('y'); new = tool.ident(b)
    if new['ino'] == old['ino']:
        hits += 1
        assert new['igen'] != old['igen'], ('igen did not change', old, new)
        assert not tool.same(new, old), 'same() accepted a re-allocated inode number'
print('inode number reused', hits, 'times; every reuse had another igen and same() was False')
"
```

- 做什么：重命名后身份不变；循环删除重建，ext4 常把同一个 inode 号再发一次，此时代号必须变，`same()` 必须判为不同。
- 预期：第一行 `rename keeps True True`；第二行次数 `hits` 大于 0 且没有 AssertionError。
- 通过：第一行两个 True，且无断言失败。`hits` 为 0 时本项只算“未能触发复用”，换一个目录（同目录建删更多次）重试，仍为 0 则记录为未覆盖，不算失败。

### 3c. `same()` 不比较 dev，比较 fsid 与 igen

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
f = os.environ['W'] + '/s.txt'; open(f, 'w').write('x'); r = tool.ident(f)
o = lambda **k: {**r, **k}
print(tool.same(o(dev=r['dev'] + 7), r), tool.same(o(fsid='deadbeef'), r), tool.same(o(igen=(r['igen'] or 0) + 1), r), tool.same(o(ino=r['ino'] + 1), r), tool.same(o(fsid=None, igen=None), r))
"
```

- 预期：`True False False False True`（只改 dev 仍相同；另一个 fsid、另一个 igen、另一个 inode 号都不同；一侧没有 fsid/igen 时按剩余字段判相同）。
- 通过：恰好这五个值（在 igen 为 None 的内核上第三个会是 `False` 也可能变成 `True`，按第 3 步记录的结果判断）。

## 4. 逐条目挂载检查（`same_device`）

先在临时目录里按工具的布局建一棵演练树（`paths(prefix)` 把 `/opt`、`/etc` 等换到 `$W/root` 下）：

```bash
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
P = tool.paths(os.environ['W'] + '/root')
os.makedirs(P['opt']); os.makedirs(P['etc']); os.makedirs(P['units'])
for name, key, kind in tool.ITEMS:
    p = tool.live_item(P, name)
    os.makedirs(p) if kind == 'dir' else open(p, 'w').write('x')
tool.same_device(P); print('one file system: ok')
for name, _, _ in tool.ITEMS: print(name, os.lstat(tool.live_item(P, name)).st_dev)
"
```

- 做什么：建演练树，所有条目都在同一个 ext4 上，调用 `same_device`。
- 预期：`one file system: ok`，所有条目的 st_dev 相同。
- 通过：无异常，st_dev 列全相同。

### 4b. 一个目录条目被另一个文件系统盖住

```bash
mount -t tmpfs tmpfs "$W/root/opt/clued-independent-ci/source-v2"
stat -c '%n %d' "$W/root/opt/clued-independent-ci/source-v2" "$W/root/opt/clued-independent-ci"
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
P = tool.paths(os.environ['W'] + '/root')
try: tool.same_device(P); print('NOT REFUSED')
except tool.Refused as e: print('refused', e.code)
"
umount "$W/root/opt/clued-independent-ci/source-v2"
```

- 预期：`stat` 显示 source-v2 与其父目录的设备号不同；python 输出 `refused CROSS_DEVICE_LAYOUT`。
- 通过：输出 `refused CROSS_DEVICE_LAYOUT`；`NOT REFUSED` 为失败（修复前的代码只查父目录，会漏过）。

### 4c. 一个文件条目被 bind 挂载（manifest 与一个 unit）

```bash
echo y > /dev/shm/cdv-manifest && mount --bind /dev/shm/cdv-manifest "$W/root/etc/clued-independent-ci/formal-source-manifest-v2.json"
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
P = tool.paths(os.environ['W'] + '/root')
try: tool.same_device(P); print('NOT REFUSED')
except tool.Refused as e: print('refused', e.code)
"
umount "$W/root/etc/clued-independent-ci/formal-source-manifest-v2.json"
echo y > /dev/shm/cdv-unit && mount --bind /dev/shm/cdv-unit "$W/root/etc/systemd/system/clued-ci-worker@.service"
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
P = tool.paths(os.environ['W'] + '/root')
try: tool.same_device(P); print('NOT REFUSED')
except tool.Refused as e: print('refused', e.code)
"
umount "$W/root/etc/systemd/system/clued-ci-worker@.service"; rm -f /dev/shm/cdv-manifest /dev/shm/cdv-unit
```

- 预期：两次都输出 `refused CROSS_DEVICE_LAYOUT`。
- 通过：两次都被拒绝。

### 4d. 卸载后恢复

```bash
findmnt -R "$W/root" ; echo "findmnt exit $?"
$PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
tool.same_device(tool.paths(os.environ['W'] + '/root')); print('ok again')"
```

- 预期：`findmnt` 无输出（退出码 1），之后输出 `ok again`。
- 通过：没有残留挂载，检查恢复通过。残留挂载必须先 `umount` 再继续。

### 4e. 条目缺失不报错

```bash
rmdir "$W/root/opt/clued-independent-ci/resident-v1" && $PY -c "
import os, sys; sys.path.insert(0, os.environ['W']); from load import tool
tool.same_device(tool.paths(os.environ['W'] + '/root')); print('missing item ignored')"
```

- 预期：`missing item ignored`（`os.path.lexists` 守卫：缺失的条目不参与，由别的检查负责）。通过：输出该行。

## 5. 现有单元测试在真实 Linux 上整体跑一遍

```bash
mkdir -p "$W/suite/linux/bin" "$W/suite/test" && cp -r /mnt/d/w/fleet-b1/work/independent-ci-resident-v1/linux/. "$W/suite/linux/" && cp /mnt/d/w/fleet-b1/work/independent-ci-resident-v1/test/test_upgrade_linux.py "$W/suite/test/"
cd "$W/suite" && python3.12 -I test/test_upgrade_linux.py 2>&1 | tail -5
```

- 做什么：这个测试在 Windows 上 `fs_id` 与 `inode_generation` 返回 None（没有 statvfs/ioctl），所以真实调用只有在 Linux 上才被走到。
- 预期：`Ran 31 tests`，`OK`（个别依赖 node/git 的用例在缺工具时会被跳过，输出里会写明原因）。
- 通过：`OK`，无 FAIL/ERROR。

## 6. 清理

```bash
findmnt -R "$W" || true
rm -rf "$W"
```

- 通过：`findmnt` 无输出后才能 `rm -rf`（有挂载时先 `umount`，不要 `rm -rf` 穿过挂载点）。

## 结果记录格式

每一步记：命令、实际输出、通过/不通过；`uname -r`、`wsl.exe --version`、`df -T $W` 一并记入。任何一步不通过就停，不修改工具，交协调者。
