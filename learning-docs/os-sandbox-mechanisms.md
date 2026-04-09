# 操作系统级进程沙箱机制

本文档对比 Windows、macOS、Linux 三大平台的进程沙箱实现原理，并说明 bot 如何通过 `@anthropic-ai/sandbox-runtime` 集成 macOS/Linux 沙箱。

---

## 一、核心思路对比

三个平台的沙箱目标一致：**限制不可信进程的能力**，但实现哲学截然不同。

| | Windows | macOS | Linux |
|---|---|---|---|
| **核心机制** | Token + ACL | sandbox-exec (Seatbelt) | Namespace + seccomp + bind mount |
| **隔离方式** | 换身份降权 | 同身份，叠加内核策略 | 同身份，隔离命名空间 |
| **文件控制** | NTFS ACL 拒绝访问 | 内核策略 deny 规则 | 不挂载 = 不存在 |
| **网络控制** | Windows Filtering Platform / 防火墙 | 代理 + 域名过滤 | 空网络命名空间 + socat 桥接 |
| **系统调用控制** | 有限（Job Object） | Seatbelt 策略 | seccomp-BPF 精确过滤 |
| **进程间通信** | Token 权限限制 | 策略 deny | PID namespace 隔离 + seccomp 阻止 |

---

## 二、Windows：Token + ACL

### 2.1 原理

Windows 的安全模型建立在**安全令牌（Token）** 和**访问控制列表（ACL）** 之上。

每个进程启动时继承一个安全令牌，标识其身份（用户 SID、组 SID、特权列表）。当进程访问文件、注册表、管道等内核对象时，系统用令牌中的 SID 与对象的 ACL（DACL）逐条匹配，决定允许或拒绝。

沙箱的核心做法是**给进程一个降权后的令牌**：

```
正常进程: Token = Administrator SID + SeDebugPrivilege + ...
沙箱进程: Token = 低完整性级别 + Deny-Only SID + 移除所有特权
```

### 2.2 关键技术

**受限令牌（Restricted Token）**

调用 `CreateRestrictedToken()` 创建一个降权令牌：
- 添加 Deny-Only SID：保留用户身份但只用于拒绝检查
- 添加 Restricting SID：双重检查，普通 ACL 和 Restricting SID 都必须允许
- 移除特权：删除 `SeDebugPrivilege`、`SeBackupPrivilege` 等危险特权

**完整性级别（Integrity Level）**

Windows Vista 引入的强制访问控制（MAC）层：
- System > High > Medium > Low > Untrusted
- 沙箱进程设为 Low 或 Untrusted
- 即使 ACL 允许，低完整性进程也不能写入高完整性对象

```
icacls "C:\secret.txt"  →  DACL 允许 Everyone 读
但 secret.txt 完整性 = Medium
沙箱进程完整性 = Low
→ 内核拒绝写入（No-Write-Up 规则）
```

**Job Object**

进程组约束：
- 限制 CPU / 内存使用
- 禁止创建子进程
- 禁止访问剪贴板
- 限制用户对象（窗口、桌面）的创建数量

**Desktop 隔离**

为沙箱进程创建独立的 Window Station 和 Desktop：
- 无法发送消息到其他窗口（防止 Shatter Attack）
- 无法截屏或读取剪贴板
- Chrome 的 GPU 和渲染进程用此方式隔离

### 2.3 实际应用

Chromium 沙箱（最经典的 Windows 沙箱实现）：

```
Broker 进程（完整权限）
├── 渲染进程（Restricted Token + Low Integrity + Job Object）
│   └── 不能读写文件系统（Deny-Only SID）
│   └── 不能创建子进程（Job Object）
│   └── 不能访问网络（Restricted Token 无网络权限）
│   └── 需要资源时通过 IPC 请求 Broker
├── GPU 进程（Desktop 隔离 + 部分限制）
└── 插件进程（中等限制）
```

### 2.4 优缺点

**优点**：
- 与 NTFS 权限模型深度集成，粒度细到单个文件/注册表键
- Job Object 提供资源用量限制（CPU、内存、进程数）
- 完整性级别提供额外的强制访问控制层

**缺点**：
- 概念多（Token、ACL、完整性、Job、Desktop），组合复杂
- 文件系统 ACL 配置繁琐，不像 Linux 的 bind mount 那样"看不见就不存在"
- 网络过滤需要额外的 WFP（Windows Filtering Platform）规则

---

## 三、macOS：sandbox-exec（Seatbelt）

### 3.1 原理

macOS 的 **Seatbelt** 是内核级的强制访问控制（MAC）框架，与 TrustedBSD MAC Framework 同源。

核心理念：**不改变进程身份，而是给进程附加一组规则**。进程仍以你的用户身份运行（UID 不变），但内核在每次系统调用时额外检查沙箱规则，deny 规则优先于文件权限。

```
传统 Unix 权限检查：
  进程 UID/GID → 文件 mode bits → 允许/拒绝

Seatbelt 叠加检查：
  进程 UID/GID → 文件 mode bits → Seatbelt 策略 → 允许/拒绝
```

即使文件权限是 777，Seatbelt 说 deny 就是 deny。

### 3.2 sandbox-exec 命令

`sandbox-exec` 是 Seatbelt 的用户态入口：

```bash
sandbox-exec -p '(version 1) (deny default) (allow file-read*)' bash -c 'ls /'
```

沙箱配置文件使用 **Scheme 语法**（TinyScheme 方言），称为 Sandbox Profile：

```scheme
(version 1)
(deny default)                              ; 默认拒绝所有操作

;; 文件系统
(allow file-read*
  (subpath "/usr")                          ; 允许读 /usr 及子目录
  (subpath "/System")
  (literal "/etc/resolv.conf"))             ; 允许读单个文件
(deny file-read*
  (subpath (param "HOME_DIR/.ssh")))        ; 禁止读 .ssh

;; 写入
(allow file-write*
  (subpath (param "WORK_DIR"))              ; 允许写工作目录
  (subpath "/tmp"))
(deny file-write*
  (regex #"\.env(\..+)?$")                  ; 禁止写 .env 文件
  (regex #"\.(pem|key)$"))

;; 网络
(deny network-outbound)                     ; 禁止所有出站网络
(allow network-outbound                     ; 除了代理端口
  (remote tcp "localhost:8080"))

;; 进程
(allow process-exec)                        ; 允许执行程序
(deny process-fork)                         ; 可以禁止 fork（可选）
```

### 3.3 网络域名过滤

sandbox-exec 的网络控制只到 IP/端口粒度，不识别域名。因此 `sandbox-runtime` 采用**代理方案**：

```
                    沙箱内进程
                         |
                  HTTP_PROXY=localhost:8080
                  HTTPS_PROXY=localhost:8080
                         |
                         v
              ┌─────────────────────┐
              │  HTTP/SOCKS Proxy   │  ← sandbox-runtime 启动的代理
              │  (宿主机进程)        │
              │                     │
              │  域名检查:           │
              │  github.com → 放行   │
              │  evil.com → 拒绝    │
              └─────────────────────┘
                         |
                         v
                      互联网
```

1. sandbox-exec 禁止所有直接出站网络，只允许连接本地代理端口
2. 设置 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量
3. 代理进程在域名级别做 allow/deny 过滤
4. `curl`、`npm`、`pip` 等工具自动走代理

### 3.4 sandbox-runtime 的包装流程

`SandboxManager.wrapWithSandbox(command)` 做了什么：

```
输入: "npm install express"

1. 生成 sandbox profile:
   - 合并默认规则 + 用户配置
   - 路径 glob 转 Seatbelt regex（globToRegex()）
   - 添加代理端口放行规则
   - 添加环境变量注入

2. 输出:
   sandbox-exec -p '(version 1) (deny default) ...' \
     bash -c 'export HTTP_PROXY=http://localhost:8080; npm install express'
```

### 3.5 特殊之处

**App Sandbox（App Store 沙箱）vs sandbox-exec**：

macOS 实际上有两套沙箱：
- **App Sandbox**：面向 App Store 应用，通过 entitlements 声明权限（如"允许访问相机"），由 Xcode 签名时嵌入
- **sandbox-exec**：面向命令行进程，通过 profile 文件指定规则，运行时动态附加

Bot 用的是后者。sandbox-exec 在 macOS 上标记为 deprecated（Apple 推荐用 App Sandbox），但实际上内核层的 Seatbelt 框架仍然活跃且被广泛使用。

### 3.6 优缺点

**优点**：
- macOS 原生内核支持，零额外依赖
- 进程保持原用户身份，文件所有权不出问题
- Profile 语法表达力强，支持路径 glob、regex、参数化
- 内核级强制执行，进程无法绕过（除非有 root + SIP 关闭）

**缺点**：
- 官方标记 deprecated（但内核机制仍在）
- 网络只能控制到 IP/端口，域名过滤需要外部代理
- Scheme 语法不直观
- 没有资源用量限制（不像 Linux cgroup）

---

## 四、Linux：Namespace + seccomp-BPF + bind mount

### 4.1 原理

Linux 沙箱是多种内核机制的组合，每种解决一个维度的隔离：

```
┌─────────────────────────────────────────────────┐
│              Linux 沙箱 = 多层防御                │
│                                                  │
│  Layer 1: Namespace   → 资源视图隔离              │
│  Layer 2: bind mount  → 文件系统白名单            │
│  Layer 3: seccomp-BPF → 系统调用过滤              │
│  Layer 4: cgroup      → 资源用量限制（可选）       │
│                                                  │
│  bubblewrap (bwrap) = Layer 1 + 2 的一站式工具     │
└─────────────────────────────────────────────────┘
```

### 4.2 Namespace（命名空间）

Linux namespace 是容器技术（Docker、LXC）的底层基础。每种 namespace 隔离一类系统资源：

| Namespace | 隔离内容 | bwrap 参数 |
|---|---|---|
| Mount (mnt) | 文件系统挂载点 | 默认创建 |
| PID | 进程 ID 空间 | `--unshare-pid` |
| Network (net) | 网络栈（网卡、路由、端口） | `--unshare-net` |
| UTS | 主机名 | `--unshare-uts` |
| IPC | System V IPC、POSIX 消息队列 | `--unshare-ipc` |
| User | 用户/组 ID 映射 | `--unshare-user` |

关键的是 **Network Namespace**：

```
宿主机网络命名空间:
  eth0: 192.168.1.100
  lo: 127.0.0.1
  路由表、iptables 规则...

--unshare-net 创建的新网络命名空间:
  (空)
  → 没有任何网卡
  → 没有路由
  → 连 localhost 都不存在
  → 所有网络系统调用返回 ENETUNREACH
```

进程被关进一个**没有网络的世界**。

### 4.3 bubblewrap（bwrap）

bwrap 是一个用户态工具（非 root 可用），一次命令创建多种 namespace 并配置 bind mount：

```bash
bwrap \
  --unshare-net \                    # 隔离网络
  --unshare-pid \                    # 隔离 PID
  --ro-bind /usr /usr \              # 只读挂载 /usr
  --ro-bind /lib /lib \              # 只读挂载 /lib
  --ro-bind /bin /bin \              # 只读挂载 /bin
  --bind /home/user/project /workspace \  # 可写挂载工作目录
  --tmpfs /tmp \                     # 临时文件系统
  --proc /proc \                     # /proc 文件系统
  --dev /dev \                       # 设备节点
  --                                 # 分隔符
  bash -c 'user command'
```

**文件系统白名单**的精髓：不是"拒绝读 `~/.ssh`"，而是**根本不挂载它**。在沙箱进程看来，`~/.ssh` 这个目录不存在——`ls` 看不到，`stat` 返回 ENOENT。比 ACL 更彻底。

### 4.4 网络恢复：socat 桥接

完全隔离网络后，需要把代理端口"桥接"进去：

```
宿主机                              沙箱 (net namespace)
┌───────────────┐                  ┌──────────────────┐
│ HTTP Proxy    │                  │                  │
│ :8080         │                  │  进程看到:        │
│               │                  │  /tmp/http.sock   │
│ SOCKS Proxy   │    socat         │  /tmp/socks.sock  │
│ :1080         │ ──────────────── │                  │
│               │  Unix socket     │  HTTP_PROXY=      │
│               │  bridge          │  socks5h://...    │
└───────────────┘                  └──────────────────┘
```

1. 宿主机启动 HTTP 和 SOCKS 代理
2. `socat` 在宿主机和沙箱之间建立 Unix socket 桥接
3. 沙箱内进程通过 Unix socket 连接代理
4. 代理进行域名级过滤

### 4.5 seccomp-BPF：系统调用过滤

即使网络被 namespace 隔离了，Unix socket 仍然可以在同一台机器上通信（不需要网络栈）。所以需要 seccomp 来封堵这个漏洞：

```c
// 用 BPF 伪代码表示的 seccomp 过滤器:
if (syscall == SYS_socket) {
    if (arg0 == AF_UNIX) {
        return SECCOMP_RET_KILL;   // 阻止创建 Unix socket
    }
}
return SECCOMP_RET_ALLOW;          // 其他系统调用放行
```

sandbox-runtime 编译了一个名为 `apply-seccomp` 的二进制，在 bwrap 内部 exec 目标命令之前注入 seccomp 过滤器：

```bash
bwrap ... -- apply-seccomp bash -c 'user command'
#            ↑ 先注入 BPF 过滤器
#                        ↑ 再执行用户命令
```

seccomp-BPF 的威力在于它工作在系统调用层面——进程做任何事都需要系统调用，而 BPF 程序在内核中执行，开销极小且不可绕过。

### 4.6 完整调用链

```
sandbox-runtime: wrapCommandWithSandboxLinux()
│
├── 启动 socat 桥接 (initializeLinuxNetworkBridge)
│   ├── socat UNIX-LISTEN:/tmp/http.sock TCP:localhost:8080
│   └── socat UNIX-LISTEN:/tmp/socks.sock TCP:localhost:1080
│
└── 生成 bwrap 命令:
    bwrap \
      --unshare-net --unshare-pid \
      --ro-bind /usr /usr \
      --ro-bind /lib /lib \
      --bind ./project ./project \
      --bind /tmp/http.sock /tmp/http.sock \
      --bind /tmp/socks.sock /tmp/socks.sock \
      -- \
      apply-seccomp \         # 注入 seccomp BPF 过滤器
      bash -c \
        'export HTTP_PROXY=socks5h://localhost/tmp/socks.sock;
         npm install express'
```

### 4.7 与 Docker 的关系

Docker 本质上也是 namespace + cgroup + seccomp + overlay fs 的组合：

| 特性 | bwrap 沙箱 | Docker 容器 |
|---|---|---|
| 底层机制 | namespace + bind mount + seccomp | namespace + cgroup + seccomp + overlay |
| 文件系统 | 基于宿主 bind mount | 独立镜像层 + overlay |
| 进程模型 | 单次命令 | 长运行容器 |
| 网络 | 空 namespace + socat | veth pair + bridge |
| 启动开销 | ~5ms | ~500ms |
| 依赖 | bwrap 二进制 | Docker daemon (root) |
| 适用场景 | 单命令沙箱化 | 完整环境隔离 |

bwrap 是"轻量 Docker"——用相同的内核机制，但没有镜像、daemon、网络桥接等重量级基础设施。

### 4.8 优缺点

**优点**：
- 最彻底的隔离：文件系统白名单（不挂载 = 不存在）、网络完全隔离
- seccomp-BPF 提供系统调用级精确控制
- bwrap 无需 root 权限（用 user namespace）
- 启动极快（~5ms），适合每条命令单独沙箱化
- 可叠加 cgroup 做资源限制

**缺点**：
- 需要安装 bwrap（`apt install bubblewrap`）和 socat
- bind mount 配置复杂，遗漏一个路径会导致命令找不到依赖
- seccomp 过滤器编写/调试困难
- 不同发行版对 user namespace 支持不同（Ubuntu 曾限制非 root 创建）

---

## 五、Bot 的沙箱集成

### 5.1 架构

Bot 通过 `Executor` 接口抽象命令执行，沙箱对工具层完全透明：

```
Agent LLM
  │
  ├── bash tool ──→ executor.exec("npm test")
  ├── read tool ──→ executor.exec("cat file.ts")
  ├── write tool ─→ executor.exec("printf ... > file")
  └── edit tool ──→ executor.exec("cat file") + executor.exec("printf ...")
                         │
                  ┌──────┴──────┐
                  │             │
            HostExecutor   SandboxExecutor
            sh -c 'cmd'    SandboxManager.wrapWithSandbox('cmd')
                           → sandbox-exec -p '...' bash -c 'cmd'  (macOS)
                           → bwrap --unshare-net ... bash -c 'cmd' (Linux)
```

### 5.2 配置

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["npmjs.org", "github.com", "pypi.org"],
      "deniedDomains": []
    },
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
      "allowWrite": [".", "/tmp"],
      "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
    }
  }
}
```

或 CLI：`bot --cli --sandbox`（使用默认配置）。

### 5.3 关键代码路径

| 文件 | 职责 |
|---|---|
| `packages/bot/src/sandbox.ts` | `Executor` 接口、`HostExecutor`、`SandboxExecutor`、`initializeSandbox()`、`resetSandbox()` |
| `packages/bot/src/config.ts` | `SandboxConfig` 类型定义 |
| `packages/bot/src/main.ts` | CLI 参数解析、沙箱初始化/清理 |
| `packages/bot/src/agent-runner.ts` | 根据 `sandboxEnabled` 选择 Executor |
| `node_modules/@anthropic-ai/sandbox-runtime` | `SandboxManager.wrapWithSandbox()` 底层实现 |

### 5.4 生命周期

```
启动:
  main.ts → initializeSandbox(config)
          → SandboxManager.initialize(runtimeConfig)
          → macOS: 准备 sandbox profile 模板
          → Linux: 启动 socat 桥接进程
          → AgentRunner(sandboxEnabled=true) → SandboxExecutor

运行:
  每条命令 → SandboxExecutor.exec(cmd)
           → SandboxManager.wrapWithSandbox(cmd) → 包装后命令
           → spawn("bash", ["-c", wrappedCmd])
           → 内核级沙箱执行
           → annotateStderrWithSandboxFailures() → 标注违规信息

关闭:
  shutdown() → resetSandbox()
             → SandboxManager.reset()
             → Linux: 停止 socat 桥接、清理 Unix socket
             → macOS: 最小清理（sandbox-exec 是无状态的）
```
