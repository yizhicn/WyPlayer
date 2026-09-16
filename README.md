# WyPlayer

个人用的 **网易云 Web 播放器**，部署在 Cloudflare Pages。

改自 [CPlayer](https://github.com/ChKSz/CPlayer)（MIT）。

- 搜索、播放、歌词（支持 VIP 音质）
- 「我的歌单」：分成 **我创建的** / **收藏歌单**
- Cookie 存在 Cloudflare **KV**（可扫码更新）
- 管理密码和 edgetunnel 一样：KV 里的 `ADMIN`

> 仅供个人学习自用，请自行保管账号 Cookie。

---

## 你需要准备

1. [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. 电脑已安装 [Node.js](https://nodejs.org/)（用来跑部署命令）
3. 一个网易云账号（有 VIP 更好）

**注意：不要用网页「拖拽上传」部署。**  
本项目有 `functions/` 后端，必须用命令行（或 Git）部署。

---

## 一、部署（约 3 分钟）

在项目根目录打开终端（能看到 `index.html` 和 `functions`）：

```bash
npx wrangler login
npx wrangler pages deploy . --project-name=wyplayer
```

- 第一次会提示创建项目，选 **Create a new project**，回车即可
- 成功后会得到类似地址：`https://wyplayer-xxxxx.pages.dev`
- 若已有旧项目名（如 `cplayer`），把命令里的名字改成你的即可

---

## 二、绑定 KV（必做）

和 [edgetunnel](https://fastly.blog.cmliussss.com/p/edt2/) 一样：光建 KV 不够，还要绑到 Pages 上。

### 1）创建命名空间

Cloudflare → **存储和数据库** → **KV** → 创建  
名字随意，例如 `WYPLAYER_KV`

### 2）绑到 Pages 项目

打开你的 Pages 项目 → **设置** → **绑定** → **添加**

| 项 | 填什么 |
|---|---|
| 类型 | KV 命名空间 |
| **变量名称** | **`KV`**（必须大写） |
| 命名空间 | 选刚建的 `WYPLAYER_KV` |

保存后，**再部署一次**：

```bash
npx wrangler pages deploy . --project-name=wyplayer
```

### 3）在 KV 里写什么

| 键 | 要不要手填 | 说明 |
|---|---|---|
| `ADMIN` | 可不填 | 网页点账号按钮可**首次设置** |
| `NETEASE_COOKIE` | 可不填 | 管理页里**扫码**自动写入 |

绑定好 `KV` 并重新部署后：

- **盾牌图标（账号管理）**：设 `ADMIN` → 扫码写入站点 KV Cookie  
- **二维码图标（访客登录）**：扫码登录自己的号，Cookie 只存在本浏览器；清缓存后回到 KV 默认账号

站点 Cookie **只读 KV**，不再使用 Secret 回退。

---

## 三、登录网易云（推荐扫码）

### 站点默认账号（写入 KV）

1. 点右上角 **盾牌图标**
2. 输入 / 首次设置 `ADMIN` 密码
3. 点 **生成 / 刷新二维码**，用网易云 App 扫码
4. Cookie 写入 KV 的 `NETEASE_COOKIE`

### 访客临时登录（本机缓存）

1. 点右上角 **二维码图标**
2. 扫码登录自己的账号
3. Cookie 存在 `localStorage`，请求时通过请求头带给后端
4. 点「恢复站点默认」、换浏览器或清缓存 → 回到 KV 账号

### 也可手动贴 Cookie

浏览器登录 [music.163.com](https://music.163.com) → F12 → Cookie → 复制 `MUSIC_U`  
KV 键 `NETEASE_COOKIE` 的值写成：

```text
MUSIC_U=这里粘贴; __csrf=可选
```

---

## 四、日常使用

打开站点后：

| 功能 | 说明 |
|---|---|
| 搜索添加 | 搜歌并加入当前播放 |
| 我的歌单 | 自动分成「我创建的」「收藏歌单」 |
| 音质 | 设置里可选，VIP 可用更高音质 |
| 账号按钮 | 改 Cookie / 看是否失效 |

Cookie 过期：**不用重新部署**，扫码或改 KV 即可。

---

## 五、改完代码怎么更新

```bash
cd 你的项目目录
npx wrangler pages deploy . --project-name=wyplayer
```

只改 KV 里的 `ADMIN` / `NETEASE_COOKIE` → **不用重新部署**。  
改了绑定（比如刚绑上 KV）→ **要再部署一次**。

---

## 六、检查是否正常

| 地址 | 正常结果 |
|---|---|
| `https://你的域名/` | 能打开播放器 |
| `https://你的域名/api/health` | `{"ok":true,...}` |
| `https://你的域名/api/me` | 能看到你的昵称 / userId |

常见问题：

- `/api/me` 说未配置 Cookie → KV 没绑，或键名不是 `NETEASE_COOKIE`，或绑完没重新部署  
- 账号密码不对 → 检查 KV 里 `ADMIN` 的值  
- 扫码失败 → 确认绑定变量名是 **`KV`**

---

## 项目结构（了解即可）

```text
├── index.html          播放器页面
├── functions/          后端 API（部署时会编译成 Worker）
│   ├── api/
│   └── _lib/
├── css / js / fonts    静态资源
└── README.md
```

和 edgetunnel 的单个 `_worker.js` 不同：本项目用 `functions/` 文件夹，所以要用命令行部署。

---

## 声明

- 不提供、不内置任何受版权保护的音频
- Cookie / VIP 属于你的网易云账号，请勿泄露
