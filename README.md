# cfyouxuan

Cloudflare Worker 聚合三个纯文本 IPv4 来源，按运营商分类后写入 Cloudflare KV，并提供五个 TXT 订阅端点。

## 来源与规则

- UOUIN：`https://bestcf.tools12345.com/uouin/all.txt`（电信、联通、移动、多线）
- WeTest：`https://bestcf.tools12345.com/wetest/ipv4.txt`（电信、联通、移动）
- CFYes：`https://bestcf.tools12345.com/cfyes/ipv4.txt`（电信、联通、移动）
- 每个来源、每个分类最多收录 5 个不同 IPv4。
- 电信、联通、移动：合并去重后至少 8 个才更新 KV。
- 多线：至少 1 个即可更新（此分类仅由 UOUIN 提供，最多 5 个）。
- 任一来源请求失败、没有可识别数据或数量校验未通过，整次刷新失败并保留旧 KV 快照。
- 内容无变化时不写入 KV。
- Cron 每天 UTC 03:17（北京时间 11:17）执行。

## 五个订阅地址

将 `SUB_PATH_TOKEN` 替换为自己的随机字符串后：

- `https://你的-worker-域名/<SUB_PATH_TOKEN>/a.txt` — 电信
- `https://你的-worker-域名/<SUB_PATH_TOKEN>/b.txt` — 联通
- `https://你的-worker-域名/<SUB_PATH_TOKEN>/c.txt` — 移动
- `https://你的-worker-域名/<SUB_PATH_TOKEN>/d.txt` — 多线
- `https://你的-worker-域名/<SUB_PATH_TOKEN>/e.txt` — 全部分类按 IPv4 去重合并

源行会原样保留，以保留端口及备注；去重按 IPv4 地址进行，同一 IP 不同端口仍视为重复。

## 1. 创建 KV

在 Cloudflare Dashboard 的 Workers & Pages / Storage & databases / KV（界面名称可能略有不同）创建 namespace，例如 `cfyouxuan-data`，复制 Namespace ID。

## 2. 配置仓库

1. 将项目文件提交到 GitHub 仓库的 `main` 分支。
2. 编辑 `wrangler.toml`：将 `SUB_PATH_TOKEN` 换成至少 24 字符的随机值；将 KV `id` 换成真实 Namespace ID。
3. 不要把 Cloudflare API Token、`UPDATE_SECRET` 或其他凭据写进仓库。

## 3. 配置 Cloudflare 自动部署

在 Cloudflare Dashboard 中打开 Workers & Pages / Workers Builds，连接 GitHub，选择此仓库和 `main` 分支。若页面要求构建配置：

- Root directory：仓库根目录
- Build command：留空（本项目不需要编译）
- Deploy command：`npx wrangler deploy`
- 若界面只提供一个命令栏，则填写 `npx wrangler deploy`
- Node.js：22（若可选）

如果 Cloudflare 界面自动识别 Wrangler 配置，优先采用界面推荐值，并确认部署日志中执行了 Wrangler 部署。首次连接时按 Cloudflare 页面提示授权 GitHub。

## 4. 配置手动更新密钥

在本地项目目录运行：

```bash
npm install
npx wrangler secret put UPDATE_SECRET
```

输入高强度随机密钥。也可以在 Cloudflare Worker 的 Settings / Variables and Secrets 中新增加密 Secret `UPDATE_SECRET`。不要将密钥提交到 GitHub。

## 5. 首次更新与手动更新

Cron 会在下一次触发时自动拉取数据。想立即初始化，可调用：

```bash
curl -X POST \
  'https://你的-worker-域名/<SUB_PATH_TOKEN>/r' \
  -H 'Authorization: Bearer 你的_UPDATE_SECRET'
```

成功响应会返回是否更新及各分类数量。更新失败时，旧 KV 数据不会被覆盖。首次成功写入 KV 前，TXT 端点返回 HTTP 503。

## 6. 本地测试/手动部署（可选）

```bash
npm install
npx wrangler login
npx wrangler deploy
```

手动部署和 Cloudflare Git 自动部署二选一即可；后续代码推送由 Cloudflare 自动部署时，不需要 GitHub Actions。

## 安全说明

- `SUB_PATH_TOKEN` 是不公开的订阅路径令牌，不应发布到公开页面。
- `UPDATE_SECRET` 必须作为 Worker Secret 保存。
- 不要把 Cloudflare API Token 提交到仓库。
- 如果订阅路径泄露，修改 `SUB_PATH_TOKEN` 并重新部署。
