/* 选课助手 demo v2 · 应用逻辑（阶段一：静态数据 + 轻交互）
 *
 * 阶段一范围：顶部导航四页可点 / 未登录↔登录态可切 / 点评·课程进入详情可点。
 * 阶段二范围：F1 实时结构化、证据高亮、矛盾提醒、ChatBI 输入框与轻量评价整理。
 *
 * 口径护栏：
 *  #1 个性化只在决策层（我的选课 / 详情"对我是否合适" / ChatBI），公共课程页只做统一排序。
 *  #2 F4 解释=AI 讲人话但锚定结构化字段、可追溯（理由里用 <em> 标出引用的字段/数据）。
 *  #3 schema 13 字段；评价者画像自填标签不参与匹配/排序。
 *  #4 教务=模拟绑定。#5 99% 只能说"v2 prompt 18 条对抗集 spot-check 99%"。
 *  #7 五维颜色按风险语义。#8 旧学期评价折叠标灰。
 */
(function () {
  "use strict";

  // ---------- 数据 ----------
  var COURSES = window.DEMO_COURSES;
  var REVIEWS_RAW = window.DEMO_REVIEWS;
  var ALL_REVIEWS = REVIEWS_RAW.reviews;
  var WEIGHTS = COURSES["画像权重模板_v1"];

  // teacher_id -> {course, teacher}
  var TMAP = {};
  COURSES.courses.forEach(function (c) {
    c.teachers.forEach(function (t) { TMAP[t.teacher_id] = { course: c, teacher: t }; });
  });

  // ---------- 应用状态 ----------
  var state = {
    page: "reviews",          // reviews | courses | mycourses | detail
    loggedIn: false,
    user: { name: "林晓", profile: "保研冲给分" },  // 决策层默认画像
    detailTeacherId: "civ_proc_wang",
    courseCategory: "全部",
    courseSort: "评分最高",
    reviewFilter: "最新点评",
    modal: null,              // 'login' | 'prefs' | 'write' | 'evidence' | null
    chatOpen: false,
    // F1 实时结构化（阶段二）
    f1: { status: "idle", text: "", result: null, source: null, scores: null },
    writeTeacherId: "civ_proc_wang",
    publishedReviews: [],
    prefs: ["给分友好", "不点人 / 不点名", "作业少", "收获高"],
    dragPrefIndex: null,
    // 证据高亮（阶段二·触点2）
    evidence: { teacherId: null, kind: "summary" },
    // ChatBI（阶段二·触点4）
    chat: { query: "", conditions: null, results: null, note: "" }
  };

  var PROXY_BASE = "http://localhost:8788";  // F1 本地代理；不可达时回落预存结果

  var COURSE_CATEGORIES = ["全部", "数学", "英语", "公共必修", "专业必修", "专业选修", "通识", "体育", "实验/实践", "研讨课"];
  var MY_COURSE_CATEGORIES = ["数学必修", "英语必修", "公共必修", "专业必修", "专业选修", "通识", "体育", "实验/实践课", "研讨课"];
  var FACULTIES = ["数学学院", "外语学院", "马克思主义学院", "法学院", "体育学院", "通识教育中心", "计算机学院", "经济管理学院", "人文学院"];
  var REVIEW_SCORE_KEYS = ["给分", "难度", "作业量", "收获", "点名"];
  var PREF_TAGS = ["时间不冲突", "考试简单", "老师讲得清楚", "平时分稳定", "不早八", "小组作业少", "期末占比低"];

  // ---------- 维度语义/颜色映射（护栏#7） ----------
  // sem: good=绿 mid=黄 bad=红
  var DIM_SEM = {
    "给分":   { "慷慨": "good", "正常": "mid", "压分": "bad", "未提及": "flat" },
    "难度":   { "低": "good", "中": "mid", "高": "bad", "未提及": "flat" },
    "作业量": { "轻": "good", "中": "mid", "重": "bad", "未提及": "flat" },
    "收获":   { "高": "good", "中": "mid", "低": "bad", "未提及": "flat" },
    "点名":   { "无": "good", "偶尔": "mid", "严": "bad", "未提及": "flat" }
  };
  // 匹配引擎用：枚举/客观分 -> 0-1 维度分（来自 courses.json 口径）
  var DIM_SCORE = COURSES["维度分映射"];
  function gradeFromAvg(avg) {
    if (avg >= 85) return 1.0;
    if (avg >= 82) return 0.7;
    if (avg >= 79) return 0.55;
    if (avg >= 76) return 0.35;
    if (avg >= 73) return 0.2;
    return 0.1;
  }

  // ---------- 匹配引擎 ----------
  // 关键：给分维度取客观分布(平均分)；其余取口碑聚合。情境开关：必修/高学分→给分权重×1.25。
  function matchScore(course, teacher, profile, fears) {
    fears = fears || [];
    var w = {};
    Object.keys(WEIGHTS[profile]).forEach(function (k) { w[k] = WEIGHTS[profile][k]; });
    var isRequired = course["类型"].indexOf("必修") >= 0;
    var highCredit = course["学分"] >= 3;
    if (isRequired || highCredit) { w["给分"] *= 1.25; }
    else { w["点名"] *= 1.25; w["作业量"] *= 1.25; }
    var sum = 0; Object.keys(w).forEach(function (k) { sum += w[k]; });
    Object.keys(w).forEach(function (k) { w[k] /= sum; });

    var agg = teacher["聚合维度"];
    var ds = {
      "给分": gradeFromAvg(teacher["客观给分分布"]["平均分"]),
      "难度": DIM_SCORE["难度"][agg["难度"]],
      "作业量": DIM_SCORE["作业量"][agg["作业量"]],
      "收获": DIM_SCORE["收获"][agg["收获"]],
      "点名": DIM_SCORE["点名"][agg["点名"]]
    };
    var score = 0; Object.keys(w).forEach(function (k) { score += w[k] * ds[k]; });
    var penalized = false;
    if (fears.indexOf("课堂点人") >= 0 && agg["课堂点人"] === "会点人") { score *= 0.5; penalized = true; }
    return { score: score, pct: Math.round(score * 100), penalized: penalized };
  }

  // ---------- 派生：总评分（口碑口径，护栏#1 课程页按口碑展示给分）/ 评价数 ----------
  function teacherScore10(teacher) {
    var agg = teacher["聚合维度"];
    var g = DIM_SCORE["给分"][agg["给分"]];
    var h = DIM_SCORE["收获"][agg["收获"]];
    var wl = DIM_SCORE["作业量"][agg["作业量"]];
    var at = DIM_SCORE["点名"][agg["点名"]];
    var sat = 0.5 * g + 0.25 * h + 0.15 * wl + 0.10 * at;
    return Math.round((5.5 + 4 * sat) * 10) / 10;
  }
  function allReviews() { return (state.publishedReviews || []).concat(ALL_REVIEWS); }
  function reviewsOf(teacherId) { return allReviews().filter(function (r) { return r.teacher_id === teacherId; }); }
  function reviewCount(teacherId) { return reviewsOf(teacherId).length; }

  // ---------- 开课单位（数据无院系字段，按课程派生展示用） ----------
  function faculty(course) {
    if (course.course_id === "pe_badminton") return "体育学院";
    if (course.course_id === "legal_eng") return "外语学院";
    if (course.course_id === "econ_law") return "经济管理学院";
    if (course["类型"].indexOf("通识") >= 0) return "通识教育中心";
    return "法学院";
  }
  function courseClass(course) {
    if (course.course_id === "pe_badminton") return "体育";
    if (course.course_id === "legal_eng") return "英语必修";
    if (course["类型"].indexOf("研讨") >= 0) return "研讨课";
    if (course["类型"].indexOf("实验") >= 0 || course["类型"].indexOf("实践") >= 0) return "实验/实践课";
    if (course["类型"].indexOf("通识") >= 0) return "通识";
    if (course["类型"].indexOf("公共") >= 0) return "公共必修";
    if (course["类型"].indexOf("专业必修") >= 0) return "专业必修";
    if (course["类型"].indexOf("专业选修") >= 0) return "专业选修";
    return course["类型"];
  }
  function category(course) {
    var cls = courseClass(course);
    if (cls.indexOf("数学") >= 0) return "数学";
    if (cls.indexOf("英语") >= 0) return "英语";
    if (cls.indexOf("通识") >= 0) return "通识";
    if (cls.indexOf("体育") >= 0) return "体育";
    if (cls.indexOf("实验") >= 0) return "实验/实践";
    if (cls.indexOf("研讨") >= 0) return "研讨课";
    return cls;
  }
  function matchesCourseCategory(row, selected) {
    if (selected === "全部") return true;
    if (selected === "数学") return row.cls.indexOf("数学") >= 0;
    if (selected === "英语") return row.cls.indexOf("英语") >= 0;
    if (selected === "实验/实践") return row.cls.indexOf("实验/实践") >= 0;
    return row.cat === selected || row.cls === selected;
  }
  function dimScore5(key, value) {
    var scoreMap = {
      "给分": { "慷慨": 4.5, "正常": 3.5, "压分": 2.0, "未提及": 0 },
      "难度": { "低": 4.5, "中": 3.0, "高": 1.8, "未提及": 0 },
      "作业量": { "轻": 4.5, "中": 3.0, "重": 1.8, "未提及": 0 },
      "收获": { "高": 4.5, "中": 3.3, "低": 2.0, "未提及": 0 },
      "点名": { "无": 4.5, "偶尔": 3.2, "严": 1.8, "未提及": 0 }
    };
    return (scoreMap[key] && scoreMap[key][value]) || 0;
  }

  // ---------- AI 课程概览（F10：根据历史点评摘要生成；data-grounded） ----------
  function aiSummary(teacherId) {
    var rs = reviewsOf(teacherId).filter(function (r) { return r.structured && r.structured["有效评价"]; });
    var ctx = TMAP[teacherId];
    var course = ctx.course;
    var teacher = ctx.teacher;
    var agg = teacher["聚合维度"];
    var dist = teacher["客观给分分布"];
    var styles = {};
    rs.forEach(function (r) { var s = r.structured["老师风格"]; if (s && s !== "未提及") styles[s] = 1; });
    var styleStr = Object.keys(styles).slice(0, 2).join("、");
    var staleCount = reviewsOf(teacherId).filter(function (r) { return r["过期"]; }).length;
    var modules = [
      {
        title: "教学质量",
        body: (styleStr ? "历史点评提到老师风格多为" + styleStr + "。" : "历史点评主要围绕授课节奏、讲解方式和课堂表达展开。") +
          "口碑聚合显示收获为" + agg["收获"] + "、课程难度为" + agg["难度"] + "。"
      },
      {
        title: "作业与习题",
        body: "作业量整体为" + agg["作业量"] + "。点评中相关信息主要用于判断课后投入、平时负担和是否需要持续跟进练习。"
      },
      {
        title: "考试与给分",
        body: "给分口碑为" + agg["给分"] + "；往届客观均分 " + dist["平均分"] + "，90+ 占比 " + dist["A_90+"] + "%。这部分建议和上方给分分布一起看。"
      },
      {
        title: "课程内容",
        body: "点评围绕《" + course["课程名"] + "》的课堂内容、案例/知识点组织和课程节奏展开。当前样本更适合帮助用户快速了解这门课被讨论最多的学习体验。"
      },
      {
        title: "课堂氛围和助教",
        body: "考勤情况为" + agg["点名"] + "，课堂点人为" + agg["课堂点人"] + "。这部分主要反映课堂互动压力、出勤要求和现场参与感。"
      },
      {
        title: "总体评价",
        body: "整体来看，评价信息集中在给分、作业负担、课堂互动和收获感几个方面。AI 总结只整理散落点评，不替用户直接下选课结论。"
      }
    ];
    var uncertain = "AI 总结为根据点评内容自动生成，仅供参考。基于 " + rs.length + " 条历史点评" + (staleCount ? "（其中 " + staleCount + " 条旧学期已折叠）" : "") + "，样本有限，建议结合最新评价和客观分布判断。";
    return { modules: modules, uncertain: uncertain, count: rs.length };
  }

  // ---------- F4：对我是否合适（AI 讲人话 + 锚定字段） ----------
  function fitExplain(course, teacher, profile) {
    var fears = []; // 阶段一默认不开雷点；阶段二接雷点开关
    var m = matchScore(course, teacher, profile, fears);
    var agg = teacher["聚合维度"];
    var dist = teacher["客观给分分布"];
    var parts = [];
    // 正面锚定
    if (dist["平均分"] >= 83) parts.push("给分友好（往届客观均分 <em>" + dist["平均分"] + "</em>、A 率 <em>" + dist["A_90+"] + "%</em>），适合冲绩点");
    else if (dist["平均分"] < 76) parts.push("给分偏紧（往届客观均分仅 <em>" + dist["平均分"] + "</em>），冲绩点需谨慎");
    if (agg["收获"] === "高") parts.push("收获高（多条点评提到<em>" + (agg["难度"] === "高" ? "硬核但学得到" : "讲得透") + "</em>）");
    // 风险锚定
    var risks = [];
    if (agg["课堂点人"] === "会点人") risks.push("这门课多条点评提到<em>会课堂点人</em>，若你怕被点名存在风险");
    if (agg["点名"] === "严") risks.push("<em>考勤严</em>，翘课会直接影响平时分");
    if (agg["难度"] === "高") risks.push("<em>难度高</em>、挂科风险偏大");
    var body = "匹配你的「" + profile + "」偏好：" + parts.join("；") + "。";
    if (risks.length) body += "但要注意：" + risks.join("；") + "。";
    return { pct: m.pct, body: body };
  }

  // ---------- 工具 ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  function dimChips(agg, keys) {
    keys = keys || ["给分", "难度", "作业量", "收获", "点名"];
    var labelMap = { "作业量": "作业", "点名": "考勤" };
    return '<div class="dims">' + keys.map(function (k) {
      var v = agg[k]; var sem = (DIM_SEM[k] && DIM_SEM[k][v]) || "flat";
      return '<span class="dim ' + sem + '"><span class="k">' + (labelMap[k] || k) + '</span>' + esc(v) + "</span>";
    }).join("") + "</div>";
  }

  function defaultReviewScores() {
    return { "给分": 4, "难度": 3, "作业量": 3, "收获": 4, "点名": 3 };
  }

  function labelFromScore(key, score) {
    score = Number(score);
    if (key === "给分") return score >= 4 ? "慷慨" : (score >= 3 ? "正常" : "压分");
    if (key === "难度") return score >= 4 ? "低" : (score >= 3 ? "中" : "高");
    if (key === "作业量") return score >= 4 ? "轻" : (score >= 3 ? "中" : "重");
    if (key === "收获") return score >= 4 ? "高" : (score >= 3 ? "中" : "低");
    if (key === "点名") return score >= 4 ? "无" : (score >= 3 ? "偶尔" : "严");
    return "未提及";
  }

  function reviewScoreValue(r, key) {
    if (r.scores && r.scores[key] != null) return Number(r.scores[key]);
    var s = r.structured || {};
    var v = s[key];
    var mapped = dimScore5(key, v);
    return mapped || null;
  }

  function reviewScoreChips(r) {
    var labelMap = { "作业量": "作业", "点名": "考勤" };
    return '<div class="review-score-chips">' + REVIEW_SCORE_KEYS.map(function (k) {
      var v = reviewScoreValue(r, k);
      var label = labelMap[k] || k;
      return '<span class="score-chip ' + (v ? "" : "empty") + '"><b>' + label + '</b>' + (v ? v.toFixed(1) + "/5" : "未打分") + "</span>";
    }).join("") + "</div>";
  }

  function reviewScoreTotal(r) {
    var vals = REVIEW_SCORE_KEYS.map(function (k) { return reviewScoreValue(r, k); }).filter(Boolean);
    if (!vals.length) return null;
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length * 10) / 10;
  }

  function renderReviewScoreControls(scores) {
    scores = scores || defaultReviewScores();
    var labelMap = { "作业量": "作业", "点名": "考勤" };
    function opts(v) {
      return [5, 4, 3, 2, 1].map(function (n) {
        return '<option value="' + n + '"' + (Number(v) === n ? " selected" : "") + ">" + n + " 分</option>";
      }).join("");
    }
    return '<div class="review-score-panel">' +
      '<div class="section-label">本次五维评分 <span class="hint">随评价一起发布</span></div>' +
      '<div class="review-score-grid">' + REVIEW_SCORE_KEYS.map(function (k) {
        return '<label><span>' + (labelMap[k] || k) + '</span><select class="score-select" data-score-key="' + k + '">' + opts(scores[k]) + "</select></label>";
      }).join("") + "</div></div>";
  }

  function readDraftScores() {
    var base = state.f1.scores || defaultReviewScores();
    var scores = {};
    REVIEW_SCORE_KEYS.forEach(function (k) {
      var input = document.querySelector('[data-score-key="' + k + '"]');
      scores[k] = input ? Number(input.value) : Number(base[k]);
    });
    return scores;
  }

  function timeAgo(i) {
    var times = ["3 分钟前", "12 分钟前", "27 分钟前", "41 分钟前", "58 分钟前", "1 小时前", "2 小时前", "昨天 18:30", "2 天前", "5 天前"];
    return times[i % times.length];
  }

  // ====================================================================
  //  阶段二 · F1 实时结构化（写点评）
  // ====================================================================
  var F1_KEYS = ["有效评价", "给分", "难度", "作业量", "收获", "点名", "老师风格", "考核形式", "课堂点人", "评价者口碑", "适合人群", "不适合人群", "提醒标签"];

  // 预置一句真实散评（来自 reviews 语料）；其 structured 作为无 key/失败时的回放底
  function f1Sample() {
    return ALL_REVIEWS.filter(function (r) { return r.id === "r004"; })[0] ||
      ALL_REVIEWS.filter(function (r) { return r.teacher_id === "civ_proc_wang" && r.structured && r.structured["有效评价"]; })[0];
  }

  function renderStructured(s) {
    return '<div class="f1-grid">' + F1_KEYS.map(function (k, i) {
      var v = s[k], disp, cls;
      if (k === "有效评价") { disp = v ? "✓ 是" : "✗ 否"; cls = v ? "good" : "bad"; }
      else if (Array.isArray(v)) { disp = v.length ? v.join("、") : "—"; cls = v.length ? "flat" : "empty"; }
      else { disp = (v == null || v === "未提及") ? "未提及" : v; cls = (DIM_SEM[k] && DIM_SEM[k][v]) || ((v == null || v === "未提及") ? "empty" : "flat"); }
      return '<div class="f1-field ' + cls + '" style="animation-delay:' + (i * 0.09).toFixed(2) + 's"><span class="fk">' + k + '</span><span class="fv">' + esc(disp) + "</span></div>";
    }).join("") + "</div>";
  }

  function structuredForPublish(text, scores) {
    var base = {};
    F1_KEYS.forEach(function (k) { base[k] = Array.isArray((state.f1.result || {})[k]) ? [] : "未提及"; });
    base["有效评价"] = text.trim().length > 0;
    base["考核形式"] = [];
    base["适合人群"] = [];
    base["不适合人群"] = [];
    base["提醒标签"] = [];
    if (state.f1.result) {
      Object.keys(state.f1.result).forEach(function (k) { base[k] = state.f1.result[k]; });
    }
    REVIEW_SCORE_KEYS.forEach(function (k) { base[k] = labelFromScore(k, scores[k]); });
    return base;
  }

  function publishDraftReview() {
    var inp = document.getElementById("f1-input");
    var text = (inp ? inp.value : state.f1.text || "").trim();
    if (!text) { toast("先写一句真实评价，再发布。"); return; }
    var scores = readDraftScores();
    var teacherId = state.writeTeacherId || state.detailTeacherId || "civ_proc_wang";
    var review = {
      id: "user_" + Date.now(),
      teacher_id: teacherId,
      "学期": "2025秋",
      "文本": text,
      "过期": false,
      structured: structuredForPublish(text, scores),
      scores: scores,
      userPublished: true
    };
    state.publishedReviews.unshift(review);
    state.f1.text = "";
    state.f1.result = null;
    state.f1.status = "idle";
    state.f1.scores = null;
    state.modal = null;
    state.page = "reviews";
    state.reviewFilter = "最新点评";
    render();
    toast("✓ 已发布到最新点评流，也会出现在对应课程详情页。");
  }

  function writeModal() {
    var sample = f1Sample();
    var prefill = state.f1.text || (sample ? sample["文本"] : "");
    var f = state.f1;
    var scoreControls = renderReviewScoreControls(f.scores || defaultReviewScores());
    var status = "";
    if (f.status === "loading") {
      status = '<div class="f1-status loading">⏳ 正在结构化…（调用 DeepSeek 实时抽取 13 字段）</div>';
    } else if (f.status === "done" || f.status === "fallback") {
      var src = f.source === "deepseek"
        ? '<div class="f1-src ok">✓ 来自 DeepSeek 实时结构化</div>'
        : '<div class="f1-src replay">↺ 当前演示使用预存真实结构化结果回放（未连 key 或调用失败时自动兜底；字段不代表这次新输入）</div>';
      status = src + renderStructured(f.result);
    } else {
      status = '<div class="f1-status idle">点击「AI 结构化」后，13 个字段会逐项亮起；散评可自由改写。</div>';
    }
    return '<div class="modal-mask" data-act="close-modal-bg"><div class="modal write-modal">' +
      '<h3>写点评 · AI 实时结构化 <span class="ai-badge">F1 · 唯一实时 LLM</span></h3>' +
      '<p>把一句口语化评价交给 AI，实时抽成 13 个可比较字段（schema v2）。真实调用 DeepSeek；无 key 或失败自动回放预存真实结果。</p>' +
      '<textarea id="f1-input" class="f1-input" rows="3">' + esc(prefill) + "</textarea>" +
      scoreControls +
      '<div class="modal-actions" style="margin:12px 0">' +
        '<button class="cta" style="margin-top:0;width:auto;padding:0 18px" data-act="f1-structure">✦ AI 结构化</button>' +
        '<button class="btn-ghost primary-soft" data-act="publish-review">发布评价</button>' +
        '<button class="btn-ghost" data-act="close-modal">关闭</button>' +
      "</div>" + status +
    "</div></div>";
  }

  function doStructure() {
    var text = state.f1.text;
    function finish(structured, source) {
      state.f1.status = source === "deepseek" ? "done" : "fallback";
      state.f1.result = structured; state.f1.source = source;
      render();
    }
    function fallback() {
      var s = f1Sample();
      finish(s ? s.structured : {}, "fallback");
    }
    try {
      fetch(PROXY_BASE + "/api/structure", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text })
      }).then(function (r) {
        if (!r.ok) throw new Error("bad");
        return r.json();
      }).then(function (d) {
        if (d && d.structured) finish(d.structured, "deepseek");
        else throw new Error("no_structured");
      }).catch(function () { setTimeout(fallback, 600); });
    } catch (e) { setTimeout(fallback, 600); }
  }

  // ====================================================================
  //  阶段二 · 证据高亮（触点2，data-grounded）
  // ====================================================================
  function evidenceFor(teacherId) {
    var ctx = TMAP[teacherId];
    var teacher = ctx.teacher, agg = teacher["聚合维度"], dist = teacher["客观给分分布"];
    var rs = reviewsOf(teacherId).filter(function (r) { return r.structured && r.structured["有效评价"]; });
    function pick(field, val, max) {
      return rs.filter(function (r) { return r.structured[field] === val; }).slice(0, max || 3)
        .map(function (r) { return { 学期: r["学期"], snippet: r["文本"] }; });
    }
    var reviewClaims = [], objClaims = [];
    if (agg["给分"] !== "未提及") { var s1 = pick("给分", agg["给分"]); if (s1.length) reviewClaims.push({ label: "给分『" + agg["给分"] + "』（口碑聚合）", sources: s1 }); }
    if (agg["课堂点人"] === "会点人") { var s2 = pick("课堂点人", "会点人"); if (s2.length) reviewClaims.push({ label: "会课堂点人", sources: s2 }); }
    if (agg["点名"] === "严") { var s3 = pick("点名", "严"); if (s3.length) reviewClaims.push({ label: "考勤严", sources: s3 }); }
    if (agg["收获"] === "高") { var s4 = pick("收获", "高"); if (s4.length) reviewClaims.push({ label: "收获高", sources: s4 }); }
    objClaims.push({ label: "往届给分分布", value: "平均分 " + dist["平均分"] + " / A 率 " + dist["A_90+"] + "%" });
    objClaims.push({ label: "近 3 学期选满率", value: teacher["选满率近3学期"].join(" · ") });
    var seen = {}; reviewClaims.forEach(function (c) { c.sources.forEach(function (s) { seen[s.snippet] = 1; }); });
    return { reviewClaims: reviewClaims, objClaims: objClaims, N: Object.keys(seen).length, M: objClaims.length };
  }

  function evidenceButton(teacherId) {
    var ev = evidenceFor(teacherId);
    return '<button class="evidence-toggle" data-act="open-evidence" data-tid="' + teacherId + '">🔎 引用自 ' + ev.N + " 条点评 / " + ev.M + " 个客观字段</button>";
  }

  function evidenceModal() {
    var teacherId = state.evidence.teacherId;
    if (!teacherId || !TMAP[teacherId]) return "";
    var ctx = TMAP[teacherId];
    var ev = evidenceFor(teacherId);
    var rc = ev.reviewClaims.map(function (c) {
      return '<div class="ev-claim"><div class="ev-claim-head"><span class="ev-tag">点评依据</span>' + esc(c.label) + "</div>" +
        c.sources.map(function (s) { return '<div class="ev-src">「' + esc(s.snippet) + '」<span class="ev-term">— ' + esc(s.学期) + "</span></div>"; }).join("") + "</div>";
    }).join("");
    var oc = ev.objClaims.map(function (c) {
      return '<div class="ev-claim"><div class="ev-claim-head"><span class="ev-tag obj">客观字段</span>' + esc(c.label) + '</div><div class="ev-src">' + esc(c.value) + "</div></div>";
    }).join("");
    return '<div class="modal-mask" data-act="close-modal-bg"><div class="modal evidence-modal">' +
      '<h3>AI 依据（可追溯） <span class="ai-badge">证据</span></h3>' +
      '<p>《' + esc(ctx.course["课程名"]) + "》" + esc(ctx.teacher["老师"]) + ' · AI 总结与推荐的每条结论都能回溯到原始点评或客观字段，不是凭空生成。</p>' +
      rc + oc +
      '<div class="modal-actions" style="margin-top:16px"><button class="btn-ghost" data-act="close-modal">关闭</button></div>' +
    "</div></div>";
  }

  // ====================================================================
  //  阶段二 · 矛盾提醒（触点3）：口碑说给分好、客观分布不支持
  // ====================================================================
  function contradictionBar(teacher) {
    var agg = teacher["聚合维度"], dist = teacher["客观给分分布"];
    if (agg["给分"] === "慷慨" && dist["平均分"] < 80) {
      return '<div class="ai-risk-bar"><span class="ai-risk-badge">⚠ AI 提示</span>' +
        '<div>AI 发现：口碑评价偏乐观（多条点评说"给分好/给分大方"），但往届 <b>均分 ' + dist["平均分"] + " / A 率 " + dist["A_90+"] + '%</b> 并不支持"给分好"的说法，建议优先参考下方给分分布。</div></div>';
    }
    return "";
  }

  // ====================================================================
  //  阶段二 · ChatBI（触点4）：自然语言 → 数据查询条件 → 命中
  // ====================================================================
  function parseQuery(q) {
    var conditions = { display: [] };
    function has(re) { return re.test(q); }
    if (has(/给分(好|高|友好|大方|慷慨)|分(高|好)|不压分|gpa|绩点|刷分|冲分/i)) { conditions.gradeGood = true; conditions.display.push("给分 = 好（取客观往届均分 ≥ 82，避免口碑虚高）"); }
    if (has(/不点名|考勤(松|宽|不严|友好)|不卡考勤|不签到|可翘课|翘课/)) { conditions.attend = ["无", "偶尔"]; conditions.display.push("点名 = 无 / 偶尔（放宽：不必严格零考勤）"); }
    if (has(/不点人|不cue|不抽|社恐|不被?点|不喊人/)) { conditions.callout = ["不会"]; conditions.display.push('课堂点人 = 不会（页面可表达"不会/较少"，当前数据按"不会"查询）'); }
    if (has(/作业(少|轻|不多|不重)|workload(少|低|小)/i)) { conditions.workload = ["轻"]; conditions.display.push("作业量 = 轻"); }
    if (has(/收获|学(到|得到|点)东西|有料|有用|硬核|学得到/)) { conditions.harvest = ["高", "中"]; conditions.display.push("收获 = 高 / 中"); }
    if (has(/简单|容易|不难|好过|轻松/)) { conditions.difficulty = ["低", "中"]; conditions.display.push("难度 = 低 / 中"); }
    if (has(/民(事诉讼|诉)/)) { conditions.courseId = "civ_proc"; conditions.display.push("限定课程 = 民事诉讼法"); }
    return conditions;
  }

  function runQuery(conditions) {
    var rows = [];
    COURSES.courses.forEach(function (c) { c.teachers.forEach(function (t) { rows.push({ course: c, teacher: t }); }); });
    var res = rows.filter(function (r) {
      var agg = r.teacher["聚合维度"], dist = r.teacher["客观给分分布"];
      if (conditions.courseId && r.course.course_id !== conditions.courseId) return false;
      if (conditions.gradeGood && dist["平均分"] < 82) return false;
      if (conditions.attend && conditions.attend.indexOf(agg["点名"]) < 0) return false;
      if (conditions.callout && conditions.callout.indexOf(agg["课堂点人"]) < 0) return false;
      if (conditions.workload && conditions.workload.indexOf(agg["作业量"]) < 0) return false;
      if (conditions.harvest && conditions.harvest.indexOf(agg["收获"]) < 0) return false;
      if (conditions.difficulty && conditions.difficulty.indexOf(agg["难度"]) < 0) return false;
      return true;
    });
    res.sort(function (a, b) { return b.teacher["客观给分分布"]["平均分"] - a.teacher["客观给分分布"]["平均分"]; });
    return res.slice(0, 3);
  }

  function askChat(q) {
    state.chat.query = q;
    state.chat.conditions = parseQuery(q);
    state.chat.results = runQuery(state.chat.conditions);
    render();
  }

  // ====================================================================
  //  顶部导航
  // ====================================================================
  function topbar() {
    var login = state.loggedIn
      ? '<button class="login is-logged"><span class="avatar">' + esc(state.user.name[0]) + "</span>" + esc(state.user.name) + "</button>"
      : '<button class="login" data-act="open-login">登录</button>';
    function item(id, label, locked) {
      var cls = "nav-item" + (state.page === id ? " active" : "") + (locked ? " locked" : "");
      return '<button class="' + cls + '" data-nav="' + id + '">' + label + "</button>";
    }
    return '' +
      '<div class="topbar">' +
        '<div class="brand"><i class="mark"></i>XX学校评课社群</div>' +
        '<nav class="nav">' +
          item("reviews", "点评", false) +
          item("courses", "课程", false) +
          item("mycourses", "我的选课", !state.loggedIn) +
        "</nav>" +
        '<div class="top-ai-wrap"><button class="top-ai" data-act="open-chat"><span class="ai-dot"></span>问 AI</button></div>' +
        '<div class="search">搜课程 / 老师</div>' +
        '<div class="login-area">' + login + "</div>" +
      "</div>";
  }

  // ====================================================================
  //  1. 点评页（社区层）
  // ====================================================================
  function pageReviews() {
    // 点评流：跨老师轮转交织，营造"不同课都有人在评"的活跃感（最新优先）
    var valid = allReviews().filter(function (r) { return r.structured && r.structured["有效评价"] && !r["过期"]; });
    var byTeacher = {};
    valid.forEach(function (r) { (byTeacher[r.teacher_id] = byTeacher[r.teacher_id] || []).push(r); });
    var buckets = Object.keys(byTeacher).map(function (k) { return byTeacher[k]; });
    var stream = [];
    for (var round = 0; round < 4; round++) {
      buckets.forEach(function (b) { if (b[round]) stream.push(b[round]); });
    }
    if (state.reviewFilter === "点赞最多") {
      stream = stream.sort(function (a, b) {
        return reviewCount(b.teacher_id) + teacherScore10(TMAP[b.teacher_id].teacher) - reviewCount(a.teacher_id) - teacherScore10(TMAP[a.teacher_id].teacher);
      });
    }
    stream = stream.slice(0, 8);

    var cards = stream.map(function (r, i) {
      var ctx = TMAP[r.teacher_id];
      var sc = teacherScore10(ctx.teacher);
      var help = [12, 8, 23, 5, 17, 31, 9, 14][i % 8];
      return '' +
        '<article class="card review-card">' +
          "<div>" +
            '<div class="review-meta">' + (r.userPublished ? "我刚刚" : "匿名同学") + ' 点评了 <b>《' + esc(ctx.course["课程名"]) + "》" + esc(ctx.teacher["老师"]) + "</b> · " + (r.userPublished ? "刚刚" : timeAgo(i)) + "</div>" +
            '<p class="review-text">' + esc(r["文本"]) + "</p>" +
            '<div class="card-actions">' +
              '<button class="chip solid" data-detail="' + r.teacher_id + '">进入课程详情</button>' +
              '<button class="chip">👍 有帮助 ' + help + "</button>" +
            "</div>" +
          "</div>" +
          '<div class="score-box"><div class="s">' + sc.toFixed(1) + '</div><div class="l">总评分</div></div>' +
        "</article>";
    }).join("");

    var todo = [
      { id: "civ_proc_wang", name: "民事诉讼法", t: "王明哲" },
      { id: "legal_history_wu", name: "中国法制史", t: "吴桐" },
      { id: "pe_badminton_gao", name: "大学体育（羽毛球）", t: "高强" }
    ];
    var hot = [
      { id: "civ_proc_wang", name: "民事诉讼法 · 王明哲" },
      { id: "ip_law_zhou", name: "知识产权法 · 周岚" },
      { id: "const_deng", name: "宪法学 · 邓琳" }
    ];

    var right = '' +
      '<div class="right-card primary">' +
        '<p class="section-label">邀请你评价已修课 <span class="hint">冷启动</span></p>' +
        todo.map(function (t) {
          return '<div class="todo-course"><span>《' + esc(t.name) + "》" + esc(t.t) + '</span><span class="mini-link" data-act="open-write" data-tid="' + t.id + '">去评价</span></div>';
        }).join("") +
        '<button class="cta" data-act="open-write" data-tid="civ_proc_wang">写第一条评价</button>' +
      "</div>" +
      '<div class="right-card"><p class="section-label">热门点评</p>' +
        hot.map(function (h) { return '<div class="todo-course"><span data-detail="' + h.id + '" class="mini-link" style="color:#3a4a63;font-weight:600">' + esc(h.name) + "</span></div>"; }).join("") +
      "</div>";

    var main = '' +
      '<div class="toolbar"><div class="chips">' +
        ["最新点评", "点赞最多"].map(function (f) {
          return '<button class="chip ' + (state.reviewFilter === f ? "active" : "") + '" data-rfilter="' + f + '">' + f + "</button>";
        }).join("") +
      '</div><span class="count">持续更新 · 社区共 ' + allReviews().length + ' 条点评 · 共 9 页，当前第 1 页</span></div>' +
      (cards || '<p class="count">该筛选下暂无点评。</p>') +
      '<div class="pagination"><button class="page-btn disabled">上一页</button><span>第 1 / 9 页</span><button class="page-btn active">1</button><button class="page-btn">2</button><button class="page-btn">3</button><button class="page-btn">下一页</button></div>';

    return '<div class="layout review"><section class="main">' + main + '</section><aside class="right">' + right + "</aside></div>";
  }

  // ====================================================================
  //  2. 课程页（社区层，统一排序，无个性化、无右侧区）
  // ====================================================================
  function pageCourses() {
    var cats = COURSE_CATEGORIES;
    var sorts = ["评分最高", "点评最多", "最新点评"];

    // 课程×老师扁平化
    var rows = [];
    COURSES.courses.forEach(function (c) {
      c.teachers.forEach(function (t) {
        rows.push({ course: c, teacher: t, cat: category(c), cls: courseClass(c), score: teacherScore10(t), n: reviewCount(t.teacher_id) });
      });
    });
    if (state.courseCategory !== "全部") rows = rows.filter(function (r) { return matchesCourseCategory(r, state.courseCategory); });
    if (state.courseSort === "评分最高") rows.sort(function (a, b) { return b.score - a.score; });
    else if (state.courseSort === "点评最多") rows.sort(function (a, b) { return b.n - a.n; });
    else rows.sort(function (a, b) { return b.n - a.n; }); // 最新点评：mock 退化为活跃度

    var list = rows.map(function (r) {
      var flag = r.teacher["flag_打架"] ? '<span class="warn-flag">⚠ 口碑与给分分布不一致</span>' : "";
      return '' +
        '<article class="card course-card" data-detail="' + r.teacher.teacher_id + '">' +
          "<div>" +
            '<div class="course-title">《' + esc(r.course["课程名"]) + '》<span class="teacher">' + esc(r.teacher["老师"]) + "</span>" + flag + "</div>" +
            '<div class="course-sub">' + esc(faculty(r.course)) + " · " + esc(r.course["类型"]) + " · " + r.course["学分"] + " 学分</div>" +
            dimChips(r.teacher["聚合维度"]) +
          "</div>" +
          '<div class="count" style="white-space:nowrap">' + r.n + " 人评价</div>" +
          '<div class="score-box"><div class="s">' + r.score.toFixed(1) + '</div><div class="l">总评分</div></div>' +
        "</article>";
    }).join("");

    var side = '' +
      '<div class="side-group"><p class="section-label">课程分类</p><ul class="menu">' +
        cats.map(function (c) { return '<li class="' + (state.courseCategory === c ? "active" : "") + '" data-ccat="' + c + '">' + c + "</li>"; }).join("") +
      "</ul></div>" +
      '<div class="side-group"><p class="section-label">开课单位</p><ul class="menu">' +
        FACULTIES.map(function (f) { return "<li>" + f + "</li>"; }).join("") +
      "</ul></div>";

    var main = '' +
      '<div class="toolbar">' +
        '<span class="count">公共课程库按统一口径排序（个性化匹配在「我的选课」）</span>' +
        '<div class="chips">' + sorts.map(function (s) { return '<button class="chip ' + (state.courseSort === s ? "active" : "") + '" data-csort="' + s + '">' + s + "</button>"; }).join("") + "</div>" +
      "</div>" +
      '<p class="count" style="margin-bottom:14px">共 ' + rows.length + " 门课×老师</p>" +
      (list || '<p class="count">该分类下暂无课程；演示数据集中主要覆盖法学、英语、通识与体育样例。</p>');

    return '<div class="layout two"><aside class="side">' + side + '</aside><section class="main">' + main + "</section></div>";
  }

  // ====================================================================
  //  3. 我的选课页（决策层，需登录）
  // ====================================================================
  function pageMyCourses() {
    if (!state.loggedIn) {
      return '<div class="gate"><div class="gate-card">' +
        "<h2>🔒 登录并绑定教务后解锁</h2>" +
        "<p>「我的选课」是选课决策工作台：同步你的课表、成绩、已修学分与本学期可选课程，再结合你的偏好给出可解释的老师推荐。</p>" +
        '<button class="cta" style="width:auto;padding:0 22px" data-act="open-login">登录并绑定教务</button>' +
      "</div></div>";
    }

    var course = TMAP["civ_proc_wang"].course; // 锚点课：民诉 4 老师可选
    var profile = state.user.profile;
    var ranked = course.teachers.map(function (t) {
      return { t: t, m: matchScore(course, t, profile, []) };
    }).sort(function (a, b) { return b.m.pct - a.m.pct; });

    var cards = ranked.map(function (r, i) {
      var t = r.t; var agg = t["聚合维度"];
      var fit = fitExplain(course, t, profile);
      var hl = i === 0 ? " highlight" : "";
      var deg = Math.round(r.m.pct / 100 * 360);
      return '' +
        '<article class="card teacher-card' + hl + '">' +
          '<div class="tc-head"><div class="teacher-main">' +
            '<div class="tc-title-row"><div class="tc-name">' + esc(t["老师"]) + '</div><span class="rank-pill">#' + (i + 1) + (i === 0 ? " 推荐" : "") + "</span></div>" +
            '<div class="tc-sub">' + esc(t["上课时间"]) + " · 近3学期选满率 " + t["选满率近3学期"][2] + "</div></div>" +
            '<div class="match"><div class="ring" style="background:conic-gradient(var(--blue) 0 ' + deg + 'deg,#e4eef9 ' + deg + 'deg 360deg)"></div><span class="val" style="background:#fff;width:42px;height:42px;border-radius:50%;display:grid;place-items:center">' + r.m.pct + '</span><span class="cap">匹配度</span></div>' +
          "</div>" +
          '<div style="margin:14px 0 4px">' + dimChips(agg) + "</div>" +
          '<div class="ai-reason"><span class="tag">✦ AI 解释（锚定字段·可追溯）</span>' + fit.body + "</div>" +
          '<div class="card-actions"><button class="chip solid">加入待选</button><button class="chip" data-detail="' + t.teacher_id + '">查看课程详情</button></div>' +
        "</article>";
    }).join("");

    // 课表（含冲突：王明哲民诉 周二3-4 × 法律英语 周二3-4）
    var calendar = buildCalendar();

    var side = '' +
      '<div class="side-group"><p class="section-label">本学期可选课程</p><ul class="menu">' +
        MY_COURSE_CATEGORIES.map(function (c) {
          return '<li class="' + (c === "专业必修" ? "active" : "") + '">' + c + (c === "专业必修" ? '<span class="badge">4</span>' : "") + "</li>";
        }).join("") +
      "</ul></div>" +
      '<div class="side-group"><p class="section-label">我的课程状态</p><ul class="menu">' +
        '<li class="active">待处理课程</li><li>已修课程<span class="badge">28</span></li></ul></div>';

    var creditRows = [
      ["总学分", 86, 120],
      ["专业必修", 42, 48],
      ["专业选修", 14, 24],
      ["通识、体育", 12, 16],
      ["公共必修", 10, 16],
      ["英语学分", 8, 8]
    ];
    var right = '' +
      '<div class="right-card primary"><p class="section-label">我的偏好 <span class="hint">拖拽排序</span></p><ul class="pref-list">' +
        state.prefs.map(function (p, i) { return '<li><span class="rank">' + (i + 1) + "</span>" + esc(p) + '<span class="grip">⋮⋮</span></li>'; }).join("") +
      '</ul><div class="mini-hint">本轮可维护偏好；推荐排序保持固定演示样例。</div><button class="cta" data-act="open-prefs">修改偏好</button></div>' +
      '<div class="right-card"><p class="section-label">学分进度</p><div class="progress-list">' +
        creditRows.map(function (r) {
          var pct = Math.min(100, Math.round(r[1] / r[2] * 100));
          return '<div class="progress-row"><div class="progress-head"><span>' + r[0] + '</span><b>' + r[1] + " / " + r[2] + '</b></div><div class="progress"><span style="width:' + pct + '%"></span></div></div>';
        }).join("") +
      "</div></div>" +
      '<div class="right-card"><p class="section-label">时间冲突</p><div class="conflict-note">⚠ <b>周二 3-4 节</b>：《民事诉讼法》王明哲 与《法律英语》周敏 撞课，二选一。</div></div>';

    var main = '' +
      '<div class="unlock-banner">✓ 教务数据已同步：课表 / 已修课程 / 成绩 / 学分（模拟绑定）</div>' +
      '<p class="section-label" style="font-size:14px">当前 / 待选课表</p>' + calendar +
      '<div class="spacer"></div>' +
      '<p class="section-label" style="font-size:14px">《' + esc(course["课程名"]) + "》" + course.teachers.length + "位老师可选 · 周二3-4 / 周四5-6 等</p>" +
      '<div class="workbench-grid">' + cards + "</div>";

    return '<div class="layout three"><aside class="side">' + side + '</aside><section class="main">' + main + '</section><aside class="right">' + right + "</aside></div>";
  }

  function buildCalendar() {
    // 简化周一~周五 × 5 节段
    var days = ["周一", "周二", "周三", "周四", "周五"];
    var slots = ["1-2", "3-4", "5-6", "7-8", "9-10"];
    // events[slotIndex][dayIndex] = {label, cls}
    var ev = {};
    function put(slot, day, label, cls) { ev[slot + "_" + day] = { label: label, cls: cls }; }
    put(0, 0, "民法总论 · 专业必修", "fixed");        // 周一1-2 已选(示意)
    put(2, 0, "宪法学 · 专业必修", "fixed");          // 周一5-6
    put(1, 1, "民诉 · 专业必修", "conflict");         // 周二3-4 冲突
    put(2, 4, "知产法 · 专业选修", "pending");        // 周五1-2 待选(放5-6示意)
    put(1, 3, "民诉 李静 · 专业必修", "pending");     // 周四…（示意）
    // 冲突另一门叠加文字
    var conflictNote = { "1_1": "民诉/法律英语 撞课" };

    var grid = '<div class="calendar"><div class="cal-cell head"></div>' + days.map(function (d) { return '<div class="cal-cell head">' + d + "</div>"; }).join("");
    slots.forEach(function (s, si) {
      grid += '<div class="cal-cell time">' + s + "</div>";
      days.forEach(function (d, di) {
        var e = ev[si + "_" + di];
        if (e) {
          var note = conflictNote[si + "_" + di] ? '<div class="event conflict" style="margin-top:3px">⚠ 与法律英语撞</div>' : "";
          grid += '<div class="cal-cell"><div class="event ' + e.cls + '">' + esc(e.label) + "</div>" + note + "</div>";
        } else grid += '<div class="cal-cell"></div>';
      });
    });
    grid += "</div>";
    grid += '<div class="cal-legend"><span><i style="background:var(--blue-soft);border:1px solid rgba(45,127,249,.25)"></i>已选课程</span><span><i style="background:#f4f8fe;border:1px dashed var(--blue)"></i>待选课程</span><span><i style="background:#fff4f5;border:1px solid rgba(217,93,97,.5)"></i>时间冲突</span></div>';
    return grid;
  }

  function distributionTotal(teacherId) {
    var totals = {
      "civ_proc_wang": 118,
      "civ_proc_li": 104,
      "civ_proc_chen": 89,
      "civ_proc_zhang": 92,
      "ip_law_zhou": 67,
      "legal_eng_zhou2": 54,
      "pe_badminton_gao": 76
    };
    return totals[teacherId] || Math.max(42, reviewCount(teacherId) * 9 + 28);
  }

  function detailTags(course, teacher, nrev) {
    var agg = teacher["聚合维度"];
    var dist = teacher["客观给分分布"];
    var tags = [courseClass(course), nrev + " 人评价"];
    if (dist["平均分"] >= 83) tags.push("给分偏友好");
    else if (dist["平均分"] < 76) tags.push("给分偏紧");
    if (agg["课堂点人"] === "不会") tags.push("不课堂点人");
    else if (agg["课堂点人"] === "会点人") tags.push("会课堂点人");
    else if (agg["点名"] === "严") tags.push("考勤严格");
    return tags;
  }

  // ====================================================================
  //  4. 课程详情页（跨层）
  // ====================================================================
  function pageDetail() {
    var ctx = TMAP[state.detailTeacherId];
    var course = ctx.course, teacher = ctx.teacher;
    var agg = teacher["聚合维度"];
    var dist = teacher["客观给分分布"];
    var score = teacherScore10(teacher);
    var nrev = reviewCount(teacher.teacher_id);
    var summ = aiSummary(teacher.teacher_id);

    // 五维大格
    var dimKeys = ["给分", "难度", "作业量", "收获", "点名"];
    var labelMap = { "作业量": "作业", "点名": "考勤" };
    var metrics = dimKeys.map(function (k) {
      var v = agg[k]; var sem = (DIM_SEM[k] && DIM_SEM[k][v]) || "flat";
      return '<div class="metric ' + sem + '"><div class="mk">' + (labelMap[k] || k) + '</div><div class="mv">' + esc(v) + '</div><div class="mscore">' + dimScore5(k, v).toFixed(1) + "/5</div></div>";
    }).join("");

    // 往届给分分布
    var distTotal = distributionTotal(teacher.teacher_id);
    var remaining = distTotal;
    var distRows = [
      { lab: "90+", key: "A_90+", cls: "" },
      { lab: "80-89", key: "B_80-89", cls: "" },
      { lab: "70-79", key: "C_70-79", cls: "low" },
      { lab: "60-69", key: "D_60-69", cls: "bad" },
      { lab: "<60", key: "F_<60", cls: "bad" }
    ].map(function (d, i, arr) {
      var p = dist[d.key];
      var people = i === arr.length - 1 ? remaining : Math.round(distTotal * p / 100);
      remaining -= people;
      return '<div class="dist-row"><span class="lab">' + d.lab + '</span><div class="dist-bar ' + d.cls + '"><span style="width:' + Math.min(100, p * 2) + '%"></span></div><span class="people">' + people + ' 人</span><span class="pct">' + p + "%</span></div>";
    }).join("");

    // 同课多老师（F11）
    var switcher = "";
    if (course.teachers.length > 1) {
      switcher = '<div class="teacher-switch">' + course.teachers.map(function (t) {
        return '<button class="chip ' + (t.teacher_id === teacher.teacher_id ? "active" : "") + '" data-detail="' + t.teacher_id + '">' + esc(t["老师"]) + "</button>";
      }).join("") + "</div>";
    }

    // 对我是否合适（F3/F4，护栏#1：登录后才有个性化）
    var fitBlock;
    if (!state.loggedIn) {
      fitBlock = '<div class="fit-locked"><p>登录并绑定教务后，查看课表冲突、学分要求和针对你的个性化推荐。</p><button class="chip solid" data-act="open-login">登录查看</button></div>';
    } else {
      var fit = fitExplain(course, teacher, state.user.profile);
      fitBlock = '<div class="fit-open"><div class="fit-score"><span class="pct">' + fit.pct + '</span><span class="count">匹配你的「' + esc(state.user.profile) + '」偏好</span></div><div class="ai-reason"><span class="tag">✦ AI 解释（锚定字段·可追溯）</span>' + fit.body + '</div><div style="margin-top:10px">' + evidenceButton(teacher.teacher_id) + "</div></div>";
    }

    // 点评列表（F5：旧学期折叠标灰）
    var rs = reviewsOf(teacher.teacher_id);
    var fresh = rs.filter(function (r) { return !r["过期"]; });
    var stale = rs.filter(function (r) { return r["过期"]; });
    function rvItem(r, isStale) {
      var s = r.structured || {};
      var tags = [];
      ["给分", "难度", "作业量", "课堂点人", "收获", "点名"].forEach(function (k) {
        var v = s[k]; if (v && v !== "未提及") tags.push('<span class="dim flat">' + esc(k === "课堂点人" ? v : k + "·" + v) + "</span>");
      });
      return '<div class="rv-item' + (isStale ? " stale" : "") + '">' +
        '<div class="rv-head">' + (r.userPublished ? "我刚刚" : "匿名同学") + ' · ' + esc(r["学期"]) + " · " + esc(teacher["老师"]) + ' · <span class="sem">口碑：' + esc(s["评价者口碑"] || "中立") + "</span>" + (isStale ? ' <span class="stale-badge">旧学期</span>' : "") + "</div>" +
        '<div class="rv-tags">' + tags.join("") + "</div>" +
        reviewScoreChips(r) +
        '<div class="rv-body">' + esc(r["文本"]) + "</div>" +
        '<div class="rv-foot"><span>👍 有帮助</span><span>回复</span></div>' +
      "</div>";
    }
    var rvHtml = fresh.map(function (r) { return rvItem(r, false); }).join("");
    var staleHtml = stale.length ? '<div class="stale-toggle"><button data-act="toggle-stale">展开 ' + stale.length + ' 条旧学期评价（已标灰）▾</button></div><div id="stale-list" style="display:none">' + stale.map(function (r) { return rvItem(r, true); }).join("") + "</div>" : "";

    var mainBlocks = '' +
      '<article class="card hero-card">' +
        '<h1 class="hero-title">《' + esc(course["课程名"]) + "》" + esc(teacher["老师"]) + "</h1>" +
        '<p class="hero-sub">' + esc(faculty(course)) + " · " + esc(course["类型"]) + " · " + course["学分"] + " 学分 · 最近开课 2025秋</p>" +
        '<div class="hero-tags">' + detailTags(course, teacher, nrev).map(function (t) { return '<span class="tag-pill">' + esc(t) + "</span>"; }).join("") + "</div>" +
        switcher +
      "</article>" +

      '<article class="card section-block"><h3>评分总览 <span class="src">总评分 ' + score.toFixed(1) + ' · 共 ' + nrev + ' 人评价（口碑口径）</span></h3><div class="metric-grid">' + metrics + "</div></article>" +

      contradictionBar(teacher) +

      '<article class="card section-block"><div class="dist-head"><h3>往届给分分布 <span class="src">基于往届公开/教务样例数据</span></h3><select class="term-select"><option>全部学期</option><option>2025秋</option><option>2024秋</option><option>2023秋</option></select></div>' +
        '<div class="dist-meta"><span class="avg">' + dist["平均分"] + '</span><span class="count">往届平均分 · 样本 ' + distTotal + ' 人 · 高 stakes 用户最关心的"给分到底怎么样"</span></div>' +
        distRows +
      "</article>" +

      '<article class="card section-block ai-summary"><h3>AI 课程概览 <span class="ai-badge">AI 摘要</span> <span class="src">根据 ' + summ.count + ' 条历史点评分模块整理</span>' + evidenceButton(teacher.teacher_id) + "</h3>" +
        '<div class="summary-modules">' + summ.modules.map(function (m) {
          return '<section class="summary-module"><h4>' + esc(m.title) + '</h4><p>' + esc(m.body) + "</p></section>";
        }).join("") + "</div>" +
        '<p class="lead">' + esc(summ.uncertain) + "</p>" +
      "</article>" +

      '<article class="card section-block"><h3>对我是否合适？ <span class="src">个性化决策层</span></h3>' + fitBlock + "</article>" +

      '<article class="card section-block"><h3>课程点评 <span class="src">共 ' + rs.length + ' 条 · 默认显示当前老师·当前学期（F5 时效性）</span></h3>' +
        rvHtml + staleHtml +
      "</article>";

    // 左侧锚点
    var anchors = ["课程概览", "评分总览", "往届给分", "AI 总结", "对我是否合适", "学生点评"];
    var side = '<div class="side-group"><p class="section-label">页面锚点</p><ul class="menu">' +
      anchors.map(function (a, i) { return '<li class="' + (i === 0 ? "active" : "") + '">' + a + "</li>"; }).join("") + "</ul></div>";

    // 右侧信息
    var others = course.teachers.filter(function (t) { return t.teacher_id !== teacher.teacher_id; });
    var related = relatedCourses(course);
    var right = '' +
      '<div class="right-card primary"><p class="section-label">课程操作</p><div class="action-stack">' +
        '<button class="icon-action primary" data-act="open-write" data-tid="' + teacher.teacher_id + '">✎ 写点评</button>' +
        '<button class="icon-action">★ 收藏</button>' +
        '<button class="icon-action">↗ 分享</button>' +
        (others.length ? '<button class="icon-action">⇄ 同课老师</button>' : "") +
      "</div></div>" +
      '<div class="right-card"><p class="section-label">教师信息</p>' +
        '<div class="info-line"><span class="k">姓名</span><span class="v">' + esc(teacher["老师"]) + "</span></div>" +
        '<div class="info-line"><span class="k">开课单位</span><span class="v">' + esc(faculty(course)) + "</span></div>" +
        '<div class="info-line"><span class="k">上课时间</span><span class="v">' + esc(teacher["上课时间"]) + "</span></div>" +
        '<div class="info-line"><span class="k">同课老师</span><span class="v">' + course.teachers.length + " 位</span></div>" +
      "</div>" +
      '<div class="right-card"><p class="section-label">课程信息</p>' +
        '<div class="info-line"><span class="k">课程名</span><span class="v">' + esc(course["课程名"]) + "</span></div>" +
        '<div class="info-line"><span class="k">学分</span><span class="v">' + course["学分"] + "</span></div>" +
        '<div class="info-line"><span class="k">类别</span><span class="v">' + esc(course["类型"]) + "</span></div>" +
        '<div class="info-line"><span class="k">全英文</span><span class="v">' + (course["是否全英文"] ? "是" : "否") + "</span></div>" +
        '<div class="info-line"><span class="k">开课学期</span><span class="v">2025秋 / 2024秋</span></div>' +
      "</div>" +
      '<div class="right-card"><p class="section-label">相关课程</p>' + related.map(function (r) { return '<div class="rel-course" data-detail="' + r.id + '">《' + esc(r.name) + "》" + esc(r.t) + "</div>"; }).join("") + "</div>";

    return '<div class="layout three"><aside class="side">' + side + '</aside><section class="main"><div class="detail-grid">' + mainBlocks + '</div></section><aside class="right">' + right + "</aside></div>";
  }

  function relatedCourses(course) {
    var pool = [];
    COURSES.courses.forEach(function (c) {
      if (c.course_id === course.course_id) return;
      if (faculty(c) === faculty(course)) pool.push({ id: c.teachers[0].teacher_id, name: c["课程名"], t: c.teachers[0]["老师"] });
    });
    return pool.slice(0, 3);
  }

  // ====================================================================
  //  Modal / Chat / Toast
  // ====================================================================
  function loginModal() {
    return '<div class="modal-mask" data-act="close-modal-bg"><div class="modal">' +
      "<h3>登录并绑定教务</h3>" +
      "<p>演示用模拟绑定：不真连教务系统、不抓取实时余量。绑定后同步课表 / 成绩 / 已修学分 / 本学期可选课程。</p>" +
      '<div class="field"><label>学号</label><input value="2022xxxxx" /></div>' +
      '<div class="field"><label>教务密码</label><input type="password" value="••••••" /></div>' +
      '<div class="sync-note">绑定后解锁：我的选课工作台 · 个性化「对我是否合适」· ChatBI 问数</div>' +
      '<div class="modal-actions"><button class="cta" data-act="do-login">模拟绑定教务</button><button class="btn-ghost" data-act="close-modal">取消</button></div>' +
    "</div></div>";
  }

  function prefsModal() {
    return '<div class="modal-mask" data-act="close-modal-bg"><div class="modal prefs-modal">' +
      "<h3>修改我的选课偏好</h3>" +
      "<p>选择你关心的标签，并把更重要的偏好拖到前面。本轮先演示偏好维护，推荐排序仍保持固定样例。</p>" +
      '<p class="section-label">当前排序</p><ul class="pref-list modal-pref-list">' +
        state.prefs.map(function (p, i) {
          return '<li draggable="true" data-pref-index="' + i + '"><span class="rank">' + (i + 1) + "</span>" + esc(p) + '<button class="pref-remove" data-act="remove-pref" data-pref-index="' + i + '">×</button><span class="grip">⋮⋮</span></li>';
        }).join("") +
      "</ul>" +
      '<p class="section-label" style="margin-top:16px">可添加标签</p><div class="pref-tags">' +
        PREF_TAGS.map(function (t) {
          var added = state.prefs.indexOf(t) >= 0;
          return '<button class="chip ' + (added ? "disabled" : "") + '" data-act="add-pref" data-pref="' + esc(t) + '"' + (added ? " disabled" : "") + '>+ ' + esc(t) + "</button>";
        }).join("") +
      "</div>" +
      '<div class="field custom-pref-row" style="margin-top:14px"><label>自定义标签</label><div><input id="custom-pref-input" placeholder="例如：小组作业少 / 期末占比低" /><button class="btn-ghost" data-act="add-custom-pref">添加</button></div></div>' +
      '<div class="modal-actions"><button class="cta" data-act="close-modal">保存偏好</button><button class="btn-ghost" data-act="close-modal">取消</button></div>' +
    "</div></div>";
  }

  function chatPanel() {
    if (!state.chatOpen) return "";
    var presets = ["哪门课给分好又不点名？", "民事诉讼法哪个老师更适合冲绩点？", "有没有作业少、收获还不错的课？"];
    var c = state.chat;

    var condBlock = "";
    if (c.conditions) {
      if (c.conditions.display.length) {
        condBlock = '<div class="chat-cond"><div class="cond-head">✦ 已识别条件（自然语言 → 数据查询）</div>' +
          c.conditions.display.map(function (d) { return '<div class="cond-row"><span class="cond-dot"></span>' + esc(d) + "</div>"; }).join("") + "</div>";
      } else {
        condBlock = '<div class="chat-cond"><div class="cond-head">已识别条件</div><div class="muted-note">未识别到明确条件，试试"给分好 / 不点名 / 作业少 / 收获高"等说法。</div></div>';
      }
    }

    var resultBlock = "";
    if (c.results) {
      if (c.results.length) {
        resultBlock = '<div class="chat-result"><div class="cond-head">命中结果（按往届客观均分排序）</div>' +
          c.results.map(function (r, i) {
            var t = r.teacher, cc = r.course, agg = t["聚合维度"], dist = t["客观给分分布"];
            return '<div class="hit' + (i === 0 ? " top" : "") + '" data-detail="' + t.teacher_id + '">' +
              (i === 0 ? '<span class="hit-rank">最佳命中</span>' : "") +
              '<div class="hit-title">《' + esc(cc["课程名"]) + "》" + esc(t["老师"]) + "</div>" +
              '<div class="hit-meta">给分 <em>' + esc(agg["给分"]) + "</em>（均分 " + dist["平均分"] + "）· 点名 <em>" + esc(agg["点名"]) + "</em> · 课堂点人 <em>" + esc(agg["课堂点人"]) + "</em></div></div>";
          }).join("") + "</div>";
      } else {
        resultBlock = '<div class="chat-result"><div class="muted-note">没有完全满足条件的课；可放宽某个条件再问。</div></div>';
      }
    }

    return '<div class="modal-mask" data-act="close-chat-bg"><div class="modal chat-modal">' +
        '<h3>ChatBI · 自然语言问数 <span class="ai-badge">AI</span></h3>' +
        '<p>用一句话问，系统把它翻译成对结构化数据的查询条件，再给出命中课程。</p>' +
        '<div class="chat-input-row"><input id="chat-input" class="chat-input" placeholder="例如：哪门课给分好又不点名不点人？" value="' + esc(c.query) + '" /><button class="cta chat-send" data-act="chat-ask">问</button></div>' +
        '<div class="chat-presets">' + presets.map(function (p) { return '<button class="chip" data-act="chat-preset" data-q="' + esc(p) + '">' + esc(p) + "</button>"; }).join("") + "</div>" +
        condBlock + resultBlock +
        '<div class="modal-actions" style="margin-top:16px"><button class="btn-ghost" data-act="close-chat">关闭</button></div>' +
      "</div></div>";
  }

  function floatingAiButton() {
    if (state.chatOpen) return "";
    return '<button class="floating-ai-fallback" data-act="open-chat" aria-label="问 AI"><span class="ai-dot"></span><span>问 AI</span></button>';
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    if (t) t.remove();
    t = el('<div class="toast" id="toast">' + msg + "</div>");
    document.body.appendChild(t);
    setTimeout(function () { if (t) t.remove(); }, 3200);
  }

  function addPref(label) {
    label = String(label || "").trim();
    if (!label) { toast("先输入一个偏好标签。"); return; }
    if (state.prefs.indexOf(label) >= 0) { toast("这个偏好已经在列表里。"); return; }
    state.prefs.push(label);
    render();
  }

  // ====================================================================
  //  渲染 + 事件
  // ====================================================================
  function render() {
    var body;
    if (state.page === "reviews") body = pageReviews();
    else if (state.page === "courses") body = pageCourses();
    else if (state.page === "mycourses") body = pageMyCourses();
    else body = pageDetail();

    var screen = '<div class="screen">' + topbar() + body + chatPanel() + floatingAiButton() + "</div>";
    document.getElementById("app").innerHTML = '<div class="app-shell">' + screen + "</div>";
    syncFloatingAi();
    // 登录 modal 挂在 body（脱离 #app），重渲染时需手动清理，避免残留
    var old = document.getElementById("app-modal");
    if (old) old.remove();
    if (state.modal === "login") {
      var m = el(loginModal());
      m.id = "app-modal";
      document.body.appendChild(m);
    }
    if (state.modal === "prefs") {
      var pm = el(prefsModal());
      pm.id = "app-modal";
      document.body.appendChild(pm);
    }
    if (state.modal === "write") {
      var wm = el(writeModal());
      wm.id = "app-modal";
      document.body.appendChild(wm);
    }
    if (state.modal === "evidence") {
      var em = el(evidenceModal());
      em.id = "app-modal";
      document.body.appendChild(em);
    }
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-nav],[data-act],[data-detail],[data-rfilter],[data-ccat],[data-csort]");
    if (!t) return;

    if (t.dataset.nav) {
      if (t.dataset.nav === "mycourses" && !state.loggedIn) { state.page = "mycourses"; render(); return; }
      state.page = t.dataset.nav; render(); return;
    }
    if (t.dataset.detail) { state.detailTeacherId = t.dataset.detail; state.page = "detail"; state.chatOpen = false; state.modal = null; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.rfilter) { state.reviewFilter = t.dataset.rfilter; render(); return; }
    if (t.dataset.ccat) { state.courseCategory = t.dataset.ccat; render(); return; }
    if (t.dataset.csort) { state.courseSort = t.dataset.csort; render(); return; }

    var act = t.dataset.act;
    if (act === "open-login") { state.modal = "login"; render(); }
    else if (act === "open-prefs") { state.modal = "prefs"; render(); }
    else if (act === "open-write") {
      state.writeTeacherId = t.dataset.tid || state.detailTeacherId || "civ_proc_wang";
      state.f1 = { status: "idle", text: "", result: null, source: null, scores: defaultReviewScores() };
      state.modal = "write"; render();
    }
    else if (act === "f1-structure") {
      var inp = document.getElementById("f1-input");
      state.f1.text = inp ? inp.value : state.f1.text;
      state.f1.scores = readDraftScores();
      state.f1.status = "loading"; state.f1.result = null;
      render();
      doStructure();
    }
    else if (act === "publish-review") { publishDraftReview(); }
    else if (act === "add-pref") {
      addPref(t.dataset.pref);
    }
    else if (act === "add-custom-pref") {
      var ci2 = document.getElementById("custom-pref-input");
      addPref(ci2 ? ci2.value : "");
    }
    else if (act === "remove-pref") {
      var pi = Number(t.dataset.prefIndex);
      if (!Number.isNaN(pi)) {
        state.prefs.splice(pi, 1);
        render();
      }
    }
    else if (act === "open-evidence") { state.evidence.teacherId = t.dataset.tid; state.modal = "evidence"; render(); }
    else if (act === "chat-preset") { askChat(t.dataset.q); }
    else if (act === "chat-ask") {
      var ci = document.getElementById("chat-input");
      askChat(ci ? ci.value : "");
    }
    else if (act === "close-modal" || act === "close-modal-bg") {
      if (act === "close-modal-bg" && e.target !== t) return;
      state.modal = null; render();
    }
    else if (act === "do-login") {
      state.loggedIn = true; state.modal = null;
      render();
      toast('✓ 教务已同步：<b>课表 / 成绩 / 已修 86 学分 / 本学期可选课程</b>。已解锁「我的选课」决策层。');
    }
    else if (act === "open-chat") { state.chatOpen = true; render(); }
    else if (act === "close-chat" || act === "close-chat-bg") {
      if (act === "close-chat-bg" && e.target.closest(".modal")) return;
      state.chatOpen = false; render();
    }
    else if (act === "toggle-stale") {
      var list = document.getElementById("stale-list");
      if (list) { list.style.display = list.style.display === "none" ? "block" : "none"; t.textContent = list.style.display === "none" ? t.textContent.replace("收起", "展开").replace("▴", "▾") : t.textContent.replace("展开", "收起").replace("▾", "▴"); }
    }
  });

  document.addEventListener("change", function (e) {
    var score = e.target.closest("[data-score-key]");
    if (score) state.f1.scores = readDraftScores();
  });

  document.addEventListener("dragstart", function (e) {
    var item = e.target.closest(".modal-pref-list [data-pref-index]");
    if (!item) return;
    state.dragPrefIndex = Number(item.dataset.prefIndex);
    item.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.dataset.prefIndex);
    }
  });

  document.addEventListener("dragover", function (e) {
    if (e.target.closest(".modal-pref-list [data-pref-index]")) e.preventDefault();
  });

  document.addEventListener("drop", function (e) {
    var item = e.target.closest(".modal-pref-list [data-pref-index]");
    if (!item || state.dragPrefIndex == null) return;
    e.preventDefault();
    var from = Number(state.dragPrefIndex);
    var to = Number(item.dataset.prefIndex);
    if (!Number.isNaN(from) && !Number.isNaN(to) && from !== to) {
      var moved = state.prefs.splice(from, 1)[0];
      state.prefs.splice(to, 0, moved);
    }
    state.dragPrefIndex = null;
    render();
  });

  document.addEventListener("dragend", function () {
    state.dragPrefIndex = null;
    var dragging = document.querySelector(".modal-pref-list .dragging");
    if (dragging) dragging.classList.remove("dragging");
  });

  function syncFloatingAi() {
    var btn = document.querySelector(".floating-ai-fallback");
    if (!btn) return;
    var mains = document.querySelectorAll(".main");
    var internalScrolled = Array.prototype.some.call(mains, function (m) { return m.scrollTop > 80; });
    var visible = window.scrollY > 120 || internalScrolled;
    btn.classList.toggle("is-visible", visible);
  }

  window.addEventListener("scroll", syncFloatingAi, { passive: true });
  document.addEventListener("scroll", syncFloatingAi, true);

  // 关闭 modal 背景点击（mask 自身）
  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("modal-mask")) {
      var a = e.target.dataset.act;
      if (a === "close-modal-bg") { state.modal = null; render(); }
      if (a === "close-chat-bg") { state.chatOpen = false; render(); }
    }
  });

  render();
})();
