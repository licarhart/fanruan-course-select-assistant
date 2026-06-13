# 部署指引 · GitHub Pages（纯前端，免费）

demo 是零依赖纯前端站点，可直接托管到 GitHub Pages，任何人打开链接即可访问。
实时 AI（F1）在公网无后端时会自动回落到**预存的真实结构化结果回放**，其余功能全部可交互。

---

## 一、把仓库推到 GitHub

```bash
cd Github            # 本文件夹就是要上传的仓库根目录
git init
git add .
git commit -m "选课助手：产品方案 + 可运行 demo"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> `.gitignore` 已配置：`.DS_Store`、`__pycache__`、`.env`、`.claude/`、任何 `api_config.md` 都不会被提交。
> 推送前可再跑一次自检（见第三节）确认无密钥。

---

## 二、开启 GitHub Pages

1. 打开仓库 → **Settings** → 左侧 **Pages**。
2. **Source** 选 **Deploy from a branch**。
3. **Branch** 选 `main`，目录选 `/ (root)`，点 **Save**。
4. 等 1–2 分钟，页面顶部会出现站点地址，形如：
   `https://<你的用户名>.github.io/<仓库名>/`
5. **demo 的访问地址**＝在上面地址后加 `demo/`：
   `https://<你的用户名>.github.io/<仓库名>/demo/`

把这个 demo 地址填回 `README.md` 的「在线 Demo」一节即可。

---

## 三、推送前自检（确认无密钥泄露）

在 `Github/` 目录下执行，应无任何输出（无输出 = 干净）：

```bash
grep -rn "sk-[A-Za-z0-9]\{20,\}\|tp-[A-Za-z0-9]\{10,\}" . --exclude-dir=.git
```

---

## 四、（可选）本地体验实时 AI

GitHub Pages 是纯静态托管，**不**能跑 `server.js`。实时 AI 仅在本地可选体验：

```bash
cd demo
DEEPSEEK_API_KEY=sk-你的key node server.js   # 另开一个终端
# 然后双击 index.html 或 python3 -m http.server 8011
```

- key 只从环境变量读，不进仓库、不进页面、不进日志。
- 不开代理也不影响演示：F1 会自动回放预存的真实结构化结果，并在界面注明"回放不代表新输入被实时解析"。

---

## 备选托管（同样纯静态、免费）

Vercel / Netlify / Cloudflare Pages 均可一键导入此仓库；构建命令留空、输出目录设为根目录即可，demo 路径同样是 `/demo/`。
