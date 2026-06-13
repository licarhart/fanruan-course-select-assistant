# 选课助手 demo · 运行说明

四页 SPA（**点评 / 课程 / 我的选课 / 课程详情**）+ 四个 AI 触点。
纯前端，数据内联在 `data.js`，**双击 `index.html`（file://）即可打开**，无需服务器。
线上则由 GitHub Pages 直接托管（见仓库根目录 `DEPLOY.md`）。

## 文件
- `index.html` — 入口
- `app.js` — SPA 逻辑 + 匹配引擎 + AI 触点
- `data.js` — 课程/评价数据内联（演示用 mock，运行期不 fetch）
- `styles.css` — 样式
- `server.js` — **可选**，仅"实时 AI 结构化（F1）"用的本地代理；不开它页面也能演示，F1 走预存回放
- `prompt_v2.md` — 评价结构化的生产级 prompt（`server.js` 载入作系统提示词）

## 四个 AI 触点
1. **F1 实时结构化**：写点评弹窗输入散评 →「AI 结构化」→ 13 字段逐项亮起。
2. **证据高亮**：AI 概览 / "对我是否合适"旁「引用自 N 条点评 / M 个客观字段」→ 可回溯原评价与客观字段。
3. **矛盾提醒**：口碑说给分好但客观分布不支持时，出 AI 风险提示条。
4. **ChatBI**：右下角 / 顶栏「问 AI」→ 输入框 + 预设问题 →「识别条件 → 命中」。

## 接真实 AI（可选，仅本地）
key 只走环境变量，**不进仓库、不进页面、不进日志**。在终端开好代理：

```bash
DEEPSEEK_API_KEY=sk-你的key node server.js
```

- 代理从 `process.env.DEEPSEEK_API_KEY` 读 key，载入同目录 `prompt_v2.md` 作系统提示词，转发 OpenAI 兼容接口，只对浏览器开 `http://localhost:8788/api/structure`（带 CORS，file:// 也能调）。
- **不设 key / 代理没开 / 调用失败 → 前端自动回放预存真实结构化结果**，并提示"当前演示使用预存真实结构化结果回放"。回放只用于兜底演示，不代表新输入文本真的被 LLM 解析。
- GitHub Pages 等静态托管无后端，线上一律走回放，这是预期行为。

## 本地起静态服务（等价于双击）
```bash
python3 -m http.server 8011    # 然后访问 http://localhost:8011
```

---
*demo 中的课程/评价/给分数据均为演示用 mock，不代表任何真实院校或教师。*
