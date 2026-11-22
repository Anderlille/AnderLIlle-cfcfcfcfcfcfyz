# Komari Glassmorphism · CF-Server-Monitor 移植版

把 [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism)（v3.4.4，MIT）移植到 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)。

**移植原则：界面代码一行不改。** 所有页面、组件、样式、动画、composable、service 均为原版源码；
只替换了最底层的数据传输（原来请求 Komari 的 RPC2 / REST），改由浏览器内的适配层把 CFSM 公开 API
翻译成 Komari 的数据结构。因此画面与交互与原版一致。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/cfsm/backend.ts` | **新增**。浏览器内的 "Komari 后端"：应答原主题用到的全部 RPC 方法，数据来自 `/api/config`、`/api/servers`、`/api/server`、`/api/history/all`、`/api/ws`，保存设置走 `POST /api/theme_options` |
| `src/cfsm/adapter.ts` | **新增**。CFSM 字段 → Komari 字段（单位 MB→字节、价格/周期/币种、标签分隔符、流量限制、GPU、三网线路） |
| `src/cfsm/http.ts` / `turnstile.ts` | **新增**。JWT（`localStorage.jwt_token`）、Turnstile 人机验证、跨域 WebSocket token |
| `src/cfsm/themeOptions.ts` / `themeSchema.ts` | **新增**。按 `komari-theme.json` 把 CFSM 的 `theme_options` 还原成带类型、带默认值的 `theme_settings` |
| `src/components/CfsmThemeSettingsDialog.vue` | **新增**。CFSM 后台只有原始 JSON 文本框，没有 Komari 那样按清单生成的设置表单；管理员登录后，主题右上角多一个「主题设置」按钮，内容与 `komari-theme.json` 01–08 节完全对应 |
| `src/utils/rpc.ts`、`src/utils/api.ts` | 保留全部类型和方法签名，只把传输层换成 `cfsmBackend` |
| `src/utils/init.ts` | 私有站点跳转改为 `/admin#/admin` |
| `src/router/index.ts` | 改为 hash 路由：首页 `/#/`，详情 `/#/server/:id`（CFSM 约定；旧 `/#/instance/:id` 自动跳转） |
| `src/components/Header.vue` | 后台入口改为 `/admin#/admin`；管理员多一个主题设置按钮 |
| `src/components/Footer.vue` | 页脚改为 `Powered by CF-Server-Monitor`（CFSM 要求），版本号放在 title |
| `public/images` → `public/assets/images` | CFSM 只反代 `index.html` 和 `assets/`，图片路径同步改为 `/assets/images/...` |
| `index.html`、`vite.config.ts` | 去掉 Komari 管理端路由和 zip 打包插件 |
| `.github/workflows/cfsm-build-branch.yml` | **新增**。push 到 main 后自动构建，把 `index.html` + `assets/` 推到 `build` 分支 |

## 部署

1. 把本目录推到你自己的 GitHub 仓库（`main` 分支）。
2. GitHub Actions 会自动构建并生成 `build` 分支（也可在 Actions 页手动运行 *Deploy CFSM Build Branch*）。
3. 在 CFSM 后台「外观设置」里把主题地址设为：
   `https://github.com/<你的用户名>/<仓库名>/tree/<build 分支最新 commit 的 SHA>`
   （或者提交到 CFSM-Theme-Store，`branch` 填 `build`。）
4. 可选：把 `cfsm-theme-options.example.json` 的内容粘贴到 CFSM 后台「主题自定义配置 JSON」，
   或者直接登录后在主题里点右上角「主题设置」修改。

本地构建：

```bash
bun install
bun run build        # 先类型检查再构建；输出在 dist/
# 本地联调：CFSM_API_TARGET=https://你的worker域名 bun run dev
```

## 需要在 CFSM 后台确认的设置

- **三网详情（show_three_net_details）**：首页卡片的延迟 / 丢包小图用 `/api/servers` 自带的 2 小时窗口（不额外消耗 D1）。关闭时首页三网显示为空，这是 CFSM 的设计。
- **显示价格（show_price）**：关闭时访客隐藏价格，相当于原主题的「未登录隐藏价格」。
- **CSP**：CFSM 默认已放行 iconify、ip.sb、ipwho.is、ipapi.co、frankfurter、er-api，原主题用到的图标、访客信息、汇率都能直接用。自定义背景图 / 视频的外部域名需加到 `csp_static`。

## 与 Komari 版仍然不同的地方（CFSM 后端不提供对应数据）

| 功能 | 表现 |
|---|---|
| 节点 IP / 城市级定位 / ASN | CFSM 公开接口不返回 IP，地球和国旗按后台填写的地区（国家）显示；拓扑里的 ASN、城市为空 |
| 审计日志 | 面板仍在，但会提示 CFSM 未提供该接口 |
| Ping 任务 | 固定为电信 / 联通 / 移动 / BGP（ID 1–4）及自定义节点 1–4（ID 5–8），名称取后台设置；按服务器选择线路仍可用 |
| 历史范围 | CFSM 最多 168 小时；访客最多 24 小时（更长的范围会按 24 小时返回） |
| 温度、GPU 显存 / 温度 | CFSM 不上报，相关数值为 0 或为空 |
| 历史流量累计曲线 | CFSM 历史表没有累计流量列，该曲线为 0 |
| 实时刷新 | 默认改为 WebSocket 推送（原主题默认 HTTP 每 3 秒轮询，在 Workers 上很费额度）；HTTP 模式最快 10 秒一次；页面切到后台自动断开；遵守 `frontend_ws_timeout_minutes` |

## 许可

原主题 MIT（© sanrokamlan / Tokinx 等原作者），`src/cfsm/` 中的计费解析与 Turnstile 逻辑参考
[Tokinx/cf-server-monitor-theme-emerald](https://github.com/Tokinx/cf-server-monitor-theme-emerald)（MIT）。
