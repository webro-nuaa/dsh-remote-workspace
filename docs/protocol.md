# DSH Remote Daemon 协议 v1

## 传输

- daemon 以 `ssh <host> node ~/.dsh-remote/daemon.js` 方式启动，**stdin/stdout 是唯一协议通道**
- 帧格式：NDJSON —— 每行一个 JSON 对象，UTF-8，`\n` 结尾
- stdout **只允许**出现协议帧；daemon 自身日志走 stderr；所有子进程输出一律经管道捕获，禁止 inherit
- 通道随 ssh 会话存在，ssh 断开 = daemon 收到 stdin EOF → 优雅退出（先终止其管理的子进程）

## 请求 / 响应

```json
{"id": 7, "method": "fs.read", "params": {"path": "/home/a.txt"}}
```
```json
{"id": 7, "ok": true,  "result": {"contentB64": "..."}}
{"id": 7, "ok": false, "error": {"code": "ENOENT", "message": "no such file"}}
```

- `id` 由客户端分配，daemon 原样回填；解析失败的帧回 `id:null`
- 处理顺序不保证（`exec.wait` 这类长等待不阻塞其他请求）

## 方法

### 握手

| method | params | result |
|---|---|---|
| `ping` | — | `{protocol, version, platform, arch, nodeVersion, uptimeSec, home}` |

`node daemon.js --version` 直接打印版本号退出，供引导阶段校验。

### fs（路径均为远端绝对路径）

| method | params | result |
|---|---|---|
| `fs.stat` | `{path}` | `{isDir, isFile, isSymlink, size, mtimeMs, mode}` |
| `fs.list` | `{path}` | `{entries: [{name, isDir, isFile, isSymlink, size, mtimeMs}]}` |
| `fs.read` | `{path, offset?, length?}`（缺省从头，默认上限 2 MiB） | `{contentB64, size, truncated}` |
| `fs.write` | `{path, contentB64, mkdirs?}` | `{size}` |
| `fs.mkdir` | `{path, recursive?}` | `{}` |
| `fs.remove` | `{path, recursive?}` | `{}` |
| `fs.rename` | `{from, to}` | `{}` |

### exec（远端进程）

| method | params | result |
|---|---|---|
| `exec.start` | `{argv: string[], cwd?, env?}` | `{jobId, pid}` |
| `exec.read` | `{jobId, fromStdout?, fromStderr?}` | `{stdout, stderr, nextStdout, nextStderr, lossy, running, exitCode?, signal?}` |
| `exec.kill` | `{jobId, signal?}`（POSIX 杀整个进程组） | `{}` |
| `exec.wait` | `{jobId, timeoutMs?}` | `{running, exitCode?, signal?, timedOut?}` |
| `exec.list` | — | `{jobs: [{jobId, argv, pid, running}]}` |

- 输出捕获：每 job 有界缓冲（默认 1 MiB tail，丢头部置 `lossy:true`），`exec.read` 按
  整流字节坐标增量读取（`fromByte` 传上次返回的 `next*`）
- `exec.start` 在 POSIX 上 `detached:true` 建独立进程组，`exec.kill` 用 `kill(-pid)`

## 安全模型

- 协议通道 = ssh 会话的 stdio，天然只有该 ssh 用户可达，daemon 不再做二次鉴权
- daemon 以 ssh 登录用户身份运行，无提权路径
- 后续（P2）：按 DSH approval 策略在客户端侧拦截敏感操作，daemon 不做策略判断

## v1 明确不做

`fs.watch`（P1，inotify → 事件帧）、PTY（P1，`exec.startPty`）、文件上传分块续传、多版本协议协商（先靠版本检查兜底）
