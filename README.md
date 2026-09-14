# dsh-remote-workspace

为 DSH（DeepSeek Harness）提供 ZCode 风格的**远程工作区**能力：Agent 的执行世界（文件读写、命令、终端、后台任务）可以落在 SSH 远程主机上，而 agent 循环、模型调用、会话、GUI 全部留在本地 DSH Host，一个窗口内本地与远程工作区并存。

## 设计决策（已定）

### 路线：Host 留本地，执行后端伸到远端

不做"远程跑一个完整 DSH"，而是给现有 DSH Host 换上**复合执行后端**：

```
工具层（bash / write / read / jobs / terminal …）
        ↓
fs / subprocess / shell / terminals 能力服务（每进程单实现坑位）
        ↓
复合实现（本仓库提供，架构预留的实现替换点）
  ├── 本地工作区 → 复用 @deepseek-ai/dsh-*-local（零修改）
  └── 远程工作区 → SSH 传输 → 远端 daemon
```

- 同一 Profile / 同一窗口内，本地与多个远程工作区并存
- "连接远程工作区"是运行时注册（登记表加一条），断开即注销，**不需要重启**
- 依据：DSH 的 `dsh-fs` / `dsh-subprocess` 等均为"抽象契约 + `-local` 实现"结构，
  官方文档明示 *Subclass, implement, load as a plugin*；`dsh-subprocess-local`
  内部本就按平台（linux-scope / windows-job / fallback）分流，复合路由是同一模式

### 远端 daemon

- 单文件 Node 脚本，零第三方依赖，经 `ssh host node daemon.js` 以 stdio NDJSON 运行
- 首连引导：SFTP 上传至 `~/.dsh-remote/`，版本不匹配自动重传（复刻 ZCode `~/.zcode/server` 模式）
- 职责仅限"手"：fs 原语 / 进程 spawn+PTY / 输出流回传 / 文件 watch
- agent 循环、LLM 调用、凭据**不出本机**

### 权限模型（对齐 ZCode）

| 模式 | 行为 |
|---|---|
| 变更前确认（远端默认） | 改文件、跑命令先确认 |
| 自动编辑 | 文件编辑放行，命令确认 |
| 计划模式 | 先出计划再实施 |
| 完全访问 | 尽量自动执行 |

映射到 DSH 既有 `approval` 服务（`setPolicy`），按工作区维度设置；远端不假装本地
Windows ACL 沙箱存在，以 approval 策略为安全边界。

### 打包与分发

- 本仓库本身即一个 DSH Profile Bundle 包（`dsh.bundle.patch: ./cordis.patch.yml`）
- Host 插件：`lib/index.js`（ESM，`name`/`inject`/`apply` 约定），工具经 `tools.register(defineTool(...))` 注册
- 远端 daemon 随包分发（`daemon/dsh-remote-daemon.js`），插件用 `import.meta.url` 定位自己包内的 daemon
- 安装（Profile 级）：`dsh plugin --profile <name> add dsh-remote-workspace`（npm 或本地路径）；
  桌面版暂无该子命令时可手动把包加入 Profile 的 `package.json` 依赖与 `dsh.profile.bundles` 列表
- 本地开发：`node_modules/@deepseek-ai` junction 指向 DSH 运行时包目录；`pnpm verify:exports` 自检

## 路线图

- [x] P0 原型（动态 Cordis 插件）：SSH 传输 + 认证（系统 ssh，支持 key / SSH_ASKPASS 密码）
- [x] P0 远端 daemon：NDJSON 协议（ping / fs.* / exec.start / exec.read / exec.kill），15/15 冒烟测试
- [x] P0 Host 插件端到端（direct 调试通道）：连接引导 / RPC / remote_exec / remote_fs 全链路
- [x] P0 Bundle 化：`lib/index.js` + `cordis.patch.yml` + 随包 daemon，导出契约自检通过
- [ ] P1 SSH 传输真机验证（探测→node 检查→版本比对→上传引导→建通道，代码就绪待靶子）
- [ ] P1 复合 fs / subprocess 实现 + 远程工作区注册表（同 Profile 本地/远程并存）
- [ ] P1 终端（PTY over ssh）与 jobs 贯通、fs.watch 事件流
- [ ] P2 权限模式按工作区接入 approval 服务（对齐 ZCode 四档）
- [ ] P2 Profile 实装验证（文件树/diff 端到端）+ 发 npm

## 目标环境

- 本机：Windows（OpenSSH 客户端 9.5+，WSL/Docker 后续可加）
- 远端：POSIX 主机，需有 `node`（≥18）
