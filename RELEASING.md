# 发版流程（RELEASING）

> 面向要发新版的人（包括未来的我自己）。每一步都标了**为什么**，因为这里踩过的坑都不便宜。

---

## 0. 前置

- npm 账号（当前发布者：`k423charotte`）
- **命令行也必须登录**：`npm whoami --registry=https://registry.npmjs.org/` 能看到用户名才算数
  - ⚠️ **网页登录 ≠ 命令行登录**。网页有 session，`npm publish` 要的是 token。
  - 登录命令：`npm login --auth-type=web --registry=https://registry.npmjs.org/`
    - 它会打印一个 `https://www.npmjs.com/login?next=/login/cli/<uuid>` 授权链接
    - **链接约 5 分钟有效**，必须在浏览器里打开、填邮箱 OTP、见到「Authentication Successful」
    - ⚠️ **别在等待期间重启/终止那个 `npm login` 进程** —— token 是它在轮询取回的，进程没了这次授权就白做
    - ⚠️ 也**别同时跑多个** `npm login`：会产生多个 CLI 会话，很容易在过期的那个页面上填码
  - 账号若没开 2FA：每次登录用邮箱 OTP；开了 2FA：用验证器

---

## 1. 改版本

- `package.json` 的 `version`（本包版本与 git tag 保持一致：`v0.1.3` ↔ `0.1.3`）
- `CHANGELOG.md` 加一段：**只写使用者能感知的变化**，别贴 commit log

---

## 2. 发布前必跑（全离线，不碰真实数据）

```bash
npm test                 # Host 半
npm run test:client      # Client 半
npm run test:qr          # 二维码编码器
npm run check:new-user   # 新用户旅程（首次启动的默认值 / 隐私边界 / 失败提示）
```

四套都得 **0 失败**。

---

## 3. 隐私与内容核对（**这一步别省**）

```bash
npm pack --dry-run
```

逐项看清单：

- **不能出现**：`bili_credential.json`、本机绝对路径（`C:\Users\...`）、`_backup/`、会话记录、任何 `.env` / token
- **必须出现**：`lib/`、`prompts/duty.md`、`cordis.patch.yml`、`package.json`、`README.md`、`LICENSE`、`CHANGELOG.md`、`icon.svg`、`locale/*.json`

> 本仓库的结构决定了第二类风险很低：**git 仓库根就是包目录**，含会话记录的 `_backup/` 在父目录，物理上打不进来。
> 但**第一类仍要人工看一眼**（人会犯错，工具不会替你判断）。

---

## 4. 提交与打 tag

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "bili-duty X.Y.Z"
git push origin main && git push origin vX.Y.Z
```

---

## 5. 发布

```bash
npm publish
```

- `package.json` 里已配 `publishConfig.registry = https://registry.npmjs.org/`，
  所以**即使本机 `.npmrc` 指向 npmmirror 镜像也会发到官方源**。
  万一仍然走错源，显式指定：`npm publish --registry=https://registry.npmjs.org/`
- 网络不稳时的典型报错是 `ECONNRESET` / `Failed to connect` —— **重试**通常就好（本项目实测多次）。
- 若发布过程中要求 OTP，输入邮箱里最新那封邮件的码。

---

## 6. 发布后验证（**别只看命令退出码**）

```bash
npm view bili-duty version --registry=https://registry.npmjs.org/
npm view bili-duty dist.tarball --registry=https://registry.npmjs.org/
```

再打开 https://www.npmjs.com/package/bili-duty 看：

- README 渲染正常、`icon` 显示、`repository` 链接指向 GitHub
- 版本号与 tag 一致
- 包内容里没有隐私文件（页面的 "Code" 标签可以浏览文件列表）

---

## 7. GitHub Release

在 https://github.com/k423Charotte/bili-duty/releases/new 选 tag `vX.Y.Z`，
标题写版本号，正文贴 `CHANGELOG.md` 里那一段。这样 tag 才有可读的说明页。

---

## 8. 回滚（有限）

- `npm unpublish bili-duty@X.Y.Z`：**仅 72 小时内**可用，且会导致该版本号永久不可复用
- 超过 72 小时：只能 `npm deprecate bili-duty@X.Y.Z "原因"`，然后发一个修复版本
- ⇒ 结论：**发布前那一步 `npm pack --dry-run` 的核对，比事后回滚便宜得多**

---

## 附：本项目的发布史

| 版本 | 时间 | 备注 |
| --- | --- | --- |
| 0.1.3 | 2026-10-16 | 首次开源发布（GitHub）；npm 待发 |
