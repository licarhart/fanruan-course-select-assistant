/* F1 实时结构化 · 本地代理（零依赖，Node 内置模块）
 *
 * 作用：把浏览器的「一句话评价 → 13 字段结构化」请求转发给 DeepSeek。
 *   - key 只从环境变量 DEEPSEEK_API_KEY 读取，永不返回给前端、不写日志、不进仓库。
 *   - 系统提示词从同目录 prompt_v2.md 抽取（与产品口径同源）。
 *   - 加 CORS（Allow-Origin *），让 file:// 双击打开的页面也能调用。
 *   - 没 key / 调用失败时返回非 200，前端据此回落到预存真实 structured 回放。
 *
 * 跑法（可选，仅本地体验实时 AI；不开它页面也能跑，F1 自动走回放）：
 *   DEEPSEEK_API_KEY=sk-xxxx node server.js
 * key 只走环境变量，不进仓库、不进页面、不进日志。
 */
"use strict";

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");

var PORT = process.env.DEMO_PROXY_PORT || 8788;
var PROMPT_PATH = path.join(__dirname, "prompt_v2.md");

// 从 md 抽取「## System Prompt」后的第一个 ``` 代码块作为系统提示词
function loadSystemPrompt() {
  try {
    var md = fs.readFileSync(PROMPT_PATH, "utf8");
    var anchor = md.indexOf("System Prompt");
    var seg = anchor >= 0 ? md.slice(anchor) : md;
    var start = seg.indexOf("```");
    if (start < 0) return null;
    var rest = seg.slice(start + 3);
    var end = rest.indexOf("```");
    if (end < 0) return null;
    return rest.slice(0, end).trim();
  } catch (e) {
    return null;
  }
}
var SYSTEM_PROMPT = loadSystemPrompt();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function sendJson(res, code, obj) {
  cors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

// 调 DeepSeek chat completions，返回解析后的 structured
function callDeepSeek(text, cb) {
  var key = process.env.DEEPSEEK_API_KEY;
  if (!key) return cb({ status: "no_key" });
  if (!SYSTEM_PROMPT) return cb({ status: "no_prompt" });

  var payload = JSON.stringify({
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: String(text || "") }
    ]
  });

  var req = https.request({
    method: "POST",
    hostname: "api.deepseek.com",
    path: "/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
      "Content-Length": Buffer.byteLength(payload)
    }
  }, function (r) {
    var buf = "";
    r.on("data", function (d) { buf += d; });
    r.on("end", function () {
      if (r.statusCode < 200 || r.statusCode >= 300) {
        return cb({ status: "api_error", code: r.statusCode });
      }
      try {
        var data = JSON.parse(buf);
        var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) return cb({ status: "empty" });
        // 容错：去掉可能的 ```json fences
        var cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        var structured = JSON.parse(cleaned);
        cb(null, structured);
      } catch (e) {
        cb({ status: "parse_error" });
      }
    });
  });
  req.setTimeout(25000, function () { req.destroy(); cb({ status: "timeout" }); });
  req.on("error", function () { cb({ status: "network_error" }); });
  req.write(payload);
  req.end();
}

var HOST = process.env.DEMO_PROXY_HOST || "127.0.0.1";

var server = http.createServer(function (req, res) {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  if (req.url === "/health") {
    return sendJson(res, 200, { ok: true, hasKey: !!process.env.DEEPSEEK_API_KEY, hasPrompt: !!SYSTEM_PROMPT });
  }

  if (req.method === "POST" && req.url === "/api/structure") {
    var body = "";
    req.on("data", function (d) { body += d; if (body.length > 1e5) req.destroy(); });
    req.on("end", function () {
      var text = "";
      try { text = (JSON.parse(body || "{}")).text || ""; } catch (e) { text = ""; }
      console.log("[proxy] /api/structure 收到 " + text.length + " 字评价，转发 DeepSeek…");
      callDeepSeek(text, function (err, structured) {
        if (err) {
          console.log("[proxy] 调用未成功（" + err.status + "），前端将回落预存结果。");
          return sendJson(res, 502, { error: err.status });
        }
        console.log("[proxy] 结构化成功，返回 13 字段。");
        sendJson(res, 200, { source: "deepseek", structured: structured });
      });
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, function () {
  console.log("F1 结构化代理已启动：http://" + HOST + ":" + PORT);
  console.log("  DEEPSEEK_API_KEY：" + (process.env.DEEPSEEK_API_KEY ? "已读取（不打印）" : "未设置 → 前端将走预存回放"));
  console.log("  系统提示词：" + (SYSTEM_PROMPT ? "已从 prompt_评价结构化_v2.md 载入" : "未找到，/api/structure 将回错误"));
});
