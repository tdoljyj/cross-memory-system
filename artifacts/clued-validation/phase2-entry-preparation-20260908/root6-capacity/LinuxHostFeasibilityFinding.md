# 这台 Linux 会话容器能不能当宿主 —— 实测，两次推翻我自己

**状态：`FEASIBILITY_NO_WRITE_PERFORMED`。** 未写库、未注册代际、未消耗预算。

我先后两次断言这台容器当不了宿主，**两次都是错的**。记在这里，连同实测过程。

## 一、Docker：能跑。我错在只跑了一条命令就下结论

第一次结论「Docker 守护进程连不上」——【实测】依据只有 `docker info` 失败一条。

再查：`/var/run/docker.sock` 在、`/usr/bin/dockerd` 在、当前用户是 `root`。**守护进程只是没启动。**
启动后：`Server Version 29.3.1`、`Storage Driver: overlayfs`。**能跑。**

## 二、镜像：拿得到。我错在只试了一个仓库

控制器要 `docker.io/library/python@sha256:285a71327884a4d50efbea30104473b0fa43ecefa499458899670ca30dae76e5`。

【实测】从 `docker.io` 拉：manifest 取到，blob 从 `production.cloudfront.docker.com` 被网关 403 拒（代理状态里 `connect_rejected` / `policy denial`）。**我据此断言拿不到。**

再试其它仓库：`ghcr.io` 401、`public.ecr.aws` 401、`mirror.gcr.io` 401 —— **401 是「连上了，只是要认证」，说明这些主机代理放行。**

`mirror.gcr.io` 是 Docker Hub 镜像站。按**同一个 digest** 拉：

```
Digest: sha256:285a71327884a4d50efbea30104473b0fa43ecefa499458899670ca30dae76e5   ← 完全一致
```

digest 相同即内容逐字节相同，**安全性不降**。随后以官方名重拉一次（层已在本地内容库，无需再取 blob），再删掉镜像站那条引用，使 `RepoDigests` 恰为单元素。

## 三、用控制器自己的检查验，不是用我的复述

```
validation.py sha256 : 3ac10b11456ddc2de9155fb2b9f8f8c8c20ac0da51957e587d3081339767ac2e
parent600.py 钉的    : 3ac10b11456ddc2de9155fb2b9f8f8c8c20ac0da51957e587d3081339767ac2e   ← 一致

image_valid(docker image inspect 输出) -> True
```

逐项：`Id` ✅ `Architecture=amd64` ✅ `Os=linux` ✅ `Descriptor.digest` ✅
`RepoDigests == ['python@sha256:285a…']` ✅ `Cmd=['python3']` ✅ `WorkingDir='/'` ✅
`Env` 5 项 ✅ `Entrypoint/Healthcheck/User/Volumes` 全 null ✅ RootFS 4 层 ✅

## 四、其余依赖

| 依赖 | 实测 |
| --- | --- |
| Node | v22.22.2 ✅ |
| `gh` | 不在，但**下得到**（release tarball，HTTP 200，13,069,957 字节）。新控制器需改钉 Linux 版摘要，原钉的是 Windows `gh.exe`（`e2efa10a…`，41775416 字节） |
| 宿主 Python | 3.11.15（原钉 3.12）——新 manifest 改钉即可 |

## 五、仍然未解决的两条

1. **基线文件 `ActualTerminalFullObservation.json`** —— 见 `LostInputsRecoveryAnalysis.md` 第二节。替代方案存在但是一次明确的判定降级，须评估者出意见、Owner 裁定。**这一条不是技术问题。**
2. **容器的可复现性** —— 本会话容器会被回收。manifest 钉宿主本地文件，若下一个容器由**同一镜像**构建则这些文件逐字节相同，资格仍成立；**但这一点尚未验证**，需跨会话再测一次。注意这与原 Windows 宿主相反：那台机器上 `gh.exe`、`docker.exe` 会自动更新，容器镜像反而是不可变的。

## 六、教训

两次错误同一个形状：**用一条命令的失败去断言一整类能力不存在。**
`docker info` 失败不等于 Docker 不可用；一个仓库 403 不等于镜像拿不到。
**在说「做不到」之前，至少要把同类的其它入口试一遍。**

---
**边界**：未写库、未注册代际、未消耗预算、未改动控制器任何字节。本文件不签发受理、不构成授权。
