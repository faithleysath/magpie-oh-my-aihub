/* Oh My AIHub — the plugin page.
 *
 * Magpie serves this page with `connect-src 'none'` and `sandbox allow-scripts`
 * (internal/gui/pluginpage.go), so it cannot fetch, cannot reach the loopback
 * operator API, cannot use storage, and cannot ask the host to do anything. It
 * has exactly two channels:
 *
 *   - `magpie.options.get()` / `set()` (the official bridge) for this plugin's
 *     own options — the only write this page may make;
 *   - two generated files beside it: `status.js` (the host's snapshot) and
 *     `options.js` (what the host did with the options, written by
 *     src/plugin-options.ts).
 *
 * Therefore every state-changing operation is a copyable CLI line, and the page
 * never claims to have measured something it has not. This file is plain
 * browser JavaScript: no modules, no build step, no inline scripts.
 */
(function () {
  "use strict";

  var settings = window.OHMYAIHUB_SETTINGS;
  // The listen-address option key, defined once in settings.js so the page, the
  // form and the host cannot drift apart on its spelling.
  var LISTEN_KEY = settings.LISTEN_KEY;
  var LOCAL = { cls: "local", text: "本地" };
  var REMOTE = { cls: "remote", text: "远端实测" };
  var UNMEASURED = { cls: "unknown", text: "未测" };
  var MISSING = { cls: "missing", text: "未提供" };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function status() {
    return window.__OH_MY_AIHUB_STATUS__ || null;
  }

  function optionsView() {
    return window.__OH_MY_AIHUB_OPTIONS__ || null;
  }

  function fmtUsd(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return "$" + n.toFixed(4);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      "-" +
      p(d.getMonth() + 1) +
      "-" +
      p(d.getDate()) +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes()) +
      ":" +
      p(d.getSeconds())
    );
  }

  function tag(evidence) {
    var span = el("span", "tag " + evidence.cls, evidence.text);
    return span;
  }

  function cell(value, evidence, at) {
    var wrap = el("span");
    wrap.append(document.createTextNode(value === undefined || value === null || value === "" ? "—" : String(value)));
    if (evidence) wrap.append(document.createTextNode(" "), tag(evidence));
    if (at) wrap.append(el("span", "at", " · " + fmtTime(at)));
    return wrap;
  }

  /** rows: [label, node-or-string, note?] */
  function kvTable(node, rows) {
    clear(node);
    var t = el("table");
    rows.forEach(function (row) {
      if (!row) return;
      var tr = el("tr");
      tr.append(el("th", null, row[0]));
      var td = el("td");
      if (row[1] instanceof Node) td.append(row[1]);
      else td.textContent = row[1] === undefined || row[1] === null || row[1] === "" ? "—" : String(row[1]);
      if (row[2]) td.append(el("div", "note", row[2]));
      tr.append(td);
      t.append(tr);
    });
    node.append(t);
  }

  /** rows: array of arrays; a cell may be a string, a number or a Node. */
  function table(headers, rows, opts) {
    var t = el("table");
    var head = el("tr");
    headers.forEach(function (h) {
      head.append(el("th", null, h));
    });
    t.append(head);
    rows.forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (value) {
        var td = el("td");
        if (value instanceof Node) td.append(value);
        else td.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
        tr.append(td);
      });
      if (opts && opts.rowClass) {
        var cls = opts.rowClass(row);
        if (cls) tr.className = cls;
      }
      t.append(tr);
    });
    return t;
  }

  function empty(node, text) {
    clear(node);
    node.append(el("p", "muted", text));
  }

  // --- copyable commands ------------------------------------------------------

  function dataDir() {
    // The snapshot carries no local path, and it must not: the command is a
    // template the operator fills in with their own Magpie data directory.
    return "<magpie data>";
  }

  function cli(command) {
    return "bun plugin/bin/ohmyaihub.ts --data " + dataDir() + " " + command;
  }

  function command(text) {
    var pre = el("pre", "cmd");
    pre.tabIndex = 0;
    pre.textContent = text;
    pre.title = "点击选中，然后按 ⌘C / Ctrl-C 复制";
    pre.addEventListener("click", function () {
      var copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () {
              pre.classList.add("copied");
              pre.dataset.note = "已复制";
            },
            function () {
              /* the selection below is the fallback */
            },
          );
          copied = true;
        }
      } catch (e) {
        copied = false;
      }
      try {
        var range = document.createRange();
        range.selectNodeContents(pre);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (!copied) pre.dataset.note = "已选中，按 ⌘C 复制";
      } catch (e) {
        /* selecting is a convenience, not a promise */
      }
    });
    return pre;
  }

  function commands(node, list) {
    clear(node);
    var box = el("div", "cmds");
    list.forEach(function (item) {
      if (typeof item === "string") box.append(command(item));
      else if (item && item.note) box.append(el("p", "muted", item.note));
    });
    node.append(box);
  }

  // --- 1. first use and diagnostics -------------------------------------------

  function checkByName(s, name) {
    var list = (s && s.checks) || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return list[i];
    return null;
  }

  function evidenceOf(check) {
    if (!check) return null;
    if (check.kind === "remote") return REMOTE;
    if (check.kind === "local") return LOCAL;
    return UNMEASURED;
  }

  function usableKeys(s) {
    if (s && s.consumersSummary) {
      var sm = s.consumersSummary;
      return { total: sm.total, open: sm.open, paused: sm.paused, spent: sm.spent, revoked: sm.revoked };
    }
    var list = (s && s.consumers) || [];
    var open = 0;
    var paused = 0;
    var spent = 0;
    list.forEach(function (c) {
      if (!c) return;
      if (c.revokedAt) return;
      if (c.paused) paused++;
      else if (c.spent) spent++;
      else open++;
    });
    return { total: list.length, open: open, paused: paused, spent: spent };
  }

  /** The operator's own words, first: what is true now and what to type next. */
  function renderStep(s) {
    var node = $("step");
    var next = $("next");
    clear(node);
    clear(next);
    if (!s) {
      node.append(el("p", "big", "还没有收到宿主的状态。"));
      node.append(el("p", "muted", "点下面「Reload 快照」；如果一直没有，说明插件宿主没起来（看 Magpie 的 Plugins 页）。"));
      return;
    }
    var cfg = s.config || {};
    var et = s.easytier || {};
    var providers = s.providers || [];
    var connected = providers.filter(function (p) {
      return p && p.status === "connected";
    }).length;
    var keys = usableKeys(s);

    if (!cfg.networkName) {
      node.append(el("p", "big", "这台机器还没有接入覆盖网。"));
      node.append(
        el("p", "muted", "在终端运行一条命令就能完成接入；本页不需要填任何东西，网络密钥只在终端里出现。"),
      );
      var box = el("div");
      box.append(el("p", "label", "共享自己的 Magpie（会显示这台机器的地址）："));
      box.append(command(cli("share setup")));
      box.append(el("p", "label", "或使用别人的 Magpie（需要对方给你的 Key 文件）："));
      box.append(command(cli("connect --fingerprint <64hex> --quote <64hex> --key-file ./peer-b.key")));
      box.append(el("p", "muted", "在终端直接运行 connect 会列出目录里的 peer 让你选，并让你核对指纹与报价。"));
      next.append(box);
      return;
    }

    var serving = Boolean(cfg.sharingActive || cfg.consumingEnabled);
    if (!cfg.sharingEnabled && !cfg.consumingEnabled) {
      node.append(el("p", "big", "已接入 " + cfg.networkName + "，但还没有共享、也没有使用别人的。"));
      node.append(el("p", "muted", "覆盖网已经建立（EasyTier " + (et.running ? "在跑" : "没在跑") + "），现在选一个方向："));
      var pick = el("div");
      pick.append(el("p", "label", "把这台 Magpie 共享出去："));
      pick.append(command(cli("share on")));
      pick.append(el("p", "label", "使用别人的：先在对方机器上拿到 Key 文件，再："));
      pick.append(command(cli("connect --fingerprint <64hex> --quote <64hex> --key-file ./peer-b.key")));
      pick.append(el("p", "muted", "在终端直接运行 connect 会提示选择 peer、核对指纹与报价。"));
      next.append(pick);
      return;
    }

    var parts = [];
    if (cfg.sharingEnabled) parts.push(cfg.sharingActive ? "正在共享这台 Magpie" : "共享已打开但当前没有在服务");
    if (cfg.consumingEnabled) parts.push("正在使用 " + providers.length + " 台远端 Magpie（" + connected + " 台最近一次远端实测可用）");
    node.append(el("p", "big", "已接入 " + cfg.networkName + "：" + parts.join("，") + "。"));
    if (cfg.shareSuspended) {
      node.append(el("p", "warn", "共享已被安全规则撤下：" + cfg.shareSuspended.reason));
    }
    node.append(el("p", "muted", "下面按需要继续；每一步都是终端里的一条命令。"));

    var todo = el("div");
    if (cfg.sharingEnabled && keys.total === 0) {
      todo.append(el("p", "label", "还没有给任何人发 Key：每个消费者一把（白名单 + 额度），交付时不打印 Key："));
      todo.append(command(cli("share handover alice --key-file ./alice.key")));
    }
    if (cfg.sharingEnabled && keys.total > 0) {
      todo.append(el("p", "label", "给已有消费者加额度，或换价后重签："));
      todo.append(command(cli("share approve ./alice-request.json --cap 5")));
    }
    if (!(s.catalog && s.catalog.publishing)) {
      todo.append(el("p", "label", "想让别人发现你：发布只读目录："));
      todo.append(command(cli("catalog publish on")));
    }
    if (cfg.consumingEnabled && providers.length === 0) {
      todo.append(el("p", "label", "还没有远端记录："));
      todo.append(command(cli("connect --fingerprint <64hex> --quote <64hex> --key-file ./peer-b.key")));
    }
    if (s.readiness && s.readiness.reasons && s.readiness.reasons.length) {
      todo.append(el("p", "label", "宿主报告："));
      todo.append(el("p", "muted", s.readiness.reasons.join("; ")));
    }
    if (todo.childNodes.length) next.append(todo);
  }

  /** The technical detail: for the advanced view and for a bug report. */
  function renderDiagnostics(s) {
    var node = $("versions");
    if (!s) return empty(node, "还没有快照。");
    var cfg = s.config || {};
    var et = s.easytier || {};
    var keys = usableKeys(s);
    var providers = s.providers || [];
    var remoteOk = providers.filter(function (p) {
      return p && p.status === "connected";
    });
    var lastRemote = null;
    remoteOk.forEach(function (p) {
      if (p.lastConnectedAt && (!lastRemote || p.lastConnectedAt > lastRemote)) lastRemote = p.lastConnectedAt;
    });
    var networks = (s.wallet && s.wallet.networks) || [];
    var enabledNetworks = networks.filter(function (n) {
      return n && n.enabled;
    });
    var gatewayCheck = checkByName(s, "gateway-key-required");
    var rows = [];
    if (s.readiness) {
      var ready = s.readiness;
      var reasonList = Array.isArray(ready.reasons) ? ready.reasons : [];
      rows.push([
        "宿主判断",
        cell(
          (ready.state || "—") + (ready.ageMs !== undefined ? " · " + Math.round(ready.ageMs / 1000) + " 秒前的测量" : ""),
          ready.source === "remote" ? REMOTE : ready.source === "local" ? LOCAL : UNMEASURED,
          ready.checkedAt,
        ),
        reasonList.length ? reasonList.join("; ") : null,
      ]);
      (Array.isArray(ready.providers) ? ready.providers : []).forEach(function (r) {
        rows.push(["提供者 " + r.id + " 可达性", cell(r.reachability || "—", UNMEASURED), null]);
      });
    }
    rows.push(["宿主与快照", cell("pid " + (s.plugin && s.plugin.pid ? s.plugin.pid : "?") + " · 启动于 " + fmtTime(s.plugin && s.plugin.startedAt), LOCAL, s.generatedAt), null]);
    rows.push(["网络配置", cfg.networkName ? cell(cfg.networkName + " · 节点 ID " + (cfg.nodeId || "—"), LOCAL) : cell("未配置", UNMEASURED), null]);
    rows.push([
      "EasyTier 核心",
      et.running
        ? cell("运行中 pid " + et.pid + " · " + (et.coreVersion || "版本未知") + " · 重启 " + (et.restarts || 0) + " 次", LOCAL, et.lastCheckAt)
        : cell("未运行" + (et.lastError ? "：" + et.lastError : ""), LOCAL, et.lastCheckAt),
      null,
    ]);
    rows.push(["覆盖网（ACL）", et.aclOk ? cell("入站 Drop 无规则，转发只开已发布端口", LOCAL) : cell((et.aclProblems || []).join("; ") || "尚未生效", LOCAL), null]);
    rows.push([
      "网关要求 Key（本机自测）",
      gatewayCheck ? cell(gatewayCheck.ok ? "本机绕道自身导出地址取到 401" : gatewayCheck.detail, LOCAL, gatewayCheck.at) : cell("未测", UNMEASURED),
      gatewayCheck
        ? "这是本机探针：证明网关要求 Key，不证明别人连得上"
        : "本节点无法从远端测自己：能证明的是 peer 会话与 Magpie 用量记录",
    ]);
    rows.push(["Gateway Key", keys.total === 0 ? cell("还没有消费者 Key", LOCAL) : cell(keys.total + " 把：可用 " + keys.open + "、暂停 " + keys.paused + "、用完 " + keys.spent, LOCAL), null]);
    rows.push(["目录发布", s.catalog && s.catalog.publishing ? cell("已发布 · 版本 " + ((s.catalog.quote && s.catalog.quote.version) || "?") + " · " + ((s.catalog.quote && s.catalog.quote.modelCount) || 0) + " 个模型", LOCAL, s.catalog.lastRefreshAt) : cell("未发布", LOCAL), null]);
    rows.push(["远程提供者", providers.length === 0 ? cell("还没有远程 Magpie 记录", LOCAL) : cell(remoteOk.length + "/" + providers.length + " 最近一次远端实测可用", remoteOk.length ? REMOTE : UNMEASURED, lastRemote), null]);
    rows.push(["测试网钱包", !s.wallet ? cell("宿主这次启动还没写出钱包状态", MISSING) : s.wallet.disabled ? cell("所有测试网已关闭", LOCAL) : cell(enabledNetworks.length + " 个测试网已启用", LOCAL), null]);

    var view = optionsView();
    if (view) {
      var sourceText = { seed: "首次写入（种子）", patch: "作为补丁应用", migrated: "首次迁移：保留已有状态", none: "没有记录" }[view.source] || view.source;
      rows.push(["插件选项", sourceText + (view.applied ? " · 本次启动已应用" : " · 本次启动未应用")]);
      rows.push(["选项摘要", view.digest ? view.digest.slice(0, 16) + "…" : "—"]);
      if (view.reason) rows.push(["宿主判断（原始）", view.reason]);
      if (view.drift) rows.push(["选项漂移", "插件选项与已应用的不一致（未应用，配置优先）"]);
    }
    kvTable(node, rows);

    var more = el("div");
    more.append(
      table(
        ["项", "值"],
        [
          ["快照 schema", s.schema || "旧版（无 schema 字段）"],
          ["插件版本", (s.plugin && s.plugin.version) || "—"],
          ["Magpie", (s.magpie && s.magpie.version) || "—"],
          ["Magpie 网关", (s.magpie && s.magpie.gateway) || "—"],
          ["宿主 pid", (s.plugin && s.plugin.pid) || "—"],
          ["宿主启动于", fmtTime(s.plugin && s.plugin.startedAt)],
          ["状态版本", (s.plugin && s.plugin.stateVersion) || "—"],
          ["快照时间", fmtTime(s.generatedAt)],
          ["设置文件", view ? (view.hostPid ? "pid " + view.hostPid : "—") : "—"],
        ],
      ),
    );
    node.append(more);
  }

  function renderChecks(s) {
    var node = $("checks");
    var list = (s && s.checks) || [];
    if (!list.length) return empty(node, "宿主未提供检查结果（或还没有）。");
    clear(node);
    node.append(
      table(
        ["检查", "结果", "证据", "时间", "细节"],
        list.map(function (c) {
          return [
            c.name,
            c.ok ? el("span", "ok", "PASS") : el("span", "bad", "FAIL"),
            evidenceOf(c) ? tag(evidenceOf(c)) : el("span", "tag missing", "未提供"),
            fmtTime(c.at),
            c.detail || "—",
          ];
        }),
        {
          rowClass: function (row) {
            return row[1] && row[1].className === "bad" ? "bad-row" : null;
          },
        },
      ),
    );
  }

  function renderVersions(s) {
    var node = $("versions");
    if (!s) return empty(node, "还没有快照。");
    var rows = [
      ["快照 schema", s.schema || "旧版（无 schema 字段）"],
      ["插件版本", (s.plugin && s.plugin.version) || "—"],
      ["Magpie", (s.magpie && s.magpie.version) || "—"],
      ["Magpie 网关", (s.magpie && s.magpie.gateway) || "—"],
      ["宿主 pid", (s.plugin && s.plugin.pid) || "—"],
      ["宿主启动于", fmtTime(s.plugin && s.plugin.startedAt)],
      ["数据目录", (s.plugin && s.plugin.dataDir) || "—"],
      ["状态版本", (s.plugin && s.plugin.stateVersion) || "—"],
      ["快照时间", fmtTime(s.generatedAt)],
    ];
    var view = optionsView();
    if (view) {
      var sourceText =
        { seed: "首次写入（种子）", patch: "作为补丁应用", migrated: "首次迁移：保留已有状态", none: "没有记录" }[view.source] || view.source;
      rows.push(["插件选项", sourceText + (view.applied ? " · 本次启动已应用" : " · 本次启动未应用")]);
      rows.push(["选项摘要", view.digest ? view.digest.slice(0, 16) + "…" : "—"]);
      if (view.reason) rows.push(["宿主判断", view.reason]);
      if (view.drift) rows.push(["选项漂移", "插件选项与已应用的不一致（未应用，配置优先）"]);
    } else {
      rows.push(["插件选项", cell("宿主没有写 options.js", MISSING)]);
    }
    kvTable(node, rows);
  }

  // --- 2. the node ------------------------------------------------------------

  function renderNode(s) {
    var node = $("node");
    if (!s) return empty(node, "还没有快照。");
    var cfg = s.config || {};
    var et = s.easytier || {};
    kvTable(node, [
      ["网络", cfg.networkName || "—"],
      ["节点 ID", cfg.nodeId || "—"],
      ["EasyTier 主机名", et.hostname || cfg.hostname || "—"],
      ["虚拟 IP", et.virtualIpv4 || cfg.virtualIpv4 || "—"],
      ["我的导出", et.proxyCidr ? et.proxyCidr + " → " + (et.mappedCidr || "?") : "—"],
      ["已发布端口", (cfg.publishedPorts || []).join(", ") || "—"],
      ["监听地址", cfg.listenAddr || "只拨号"],
      ["Secure Mode", et.secureMode ? "开（持久化身份）" : "关"],
      ["RPC 端口", cfg.rpcPort || "—"],
      ["ACL", et.aclOk ? cell("符合预期", LOCAL) : cell((et.aclProblems || []).join("; ") || "未生效", LOCAL)],
    ]);

    var peers = et.peers || [];
    node.append(el("h3", null, "覆盖网 peer"));
    node.append(
      peers.length
        ? table(
            ["主机名", "虚拟 IP", "路径", "延迟", "代价"],
            peers.map(function (p) {
              return [p.hostname || "—", p.ipv4 || "—", p.route || p.tunnel || "—", p.latencyMs !== undefined ? p.latencyMs + " ms" : "—", p.cost || "—"];
            }),
          )
        : el("p", "muted", "还没有 peer。"),
    );

    var box = el("div");
    box.append(el("h3", null, "命令"));
    commands(box, [
      cli("status"),
      { note: "首次接入（引导式，密钥用隐藏输入或 --secret-file，不留在 shell 历史里）：" },
      cli("setup"),
      cli("setup --reconfigure"),
      cli("start"),
      cli("stop"),
    ]);
    node.append(box);
  }

  // --- 3. sharing and keys ----------------------------------------------------

  function renderSharing(s) {
    var node = $("sharing");
    if (!s) return empty(node, "还没有快照。");
    var cfg = s.config || {};
    var et = s.easytier || {};
    var gw = (s.magpie && s.magpie.gateway) || "";
    var port = "";
    try {
      port = String(new URL(gw).port || "");
    } catch (e) {
      port = "";
    }
    var published = (cfg.publishedPorts || []).indexOf(Number(port)) >= 0;
    var gatewayCheck = checkByName(s, "gateway-key-required");

    kvTable(node, [
      ["开关（意图）", cfg.sharingEnabled ? "开" : "关"],
      ["实际在服务", cfg.sharingActive ? cell("是", LOCAL) : cell("否", LOCAL)],
      [
        "安全撤下",
        cfg.shareSuspended
          ? cell("已撤下：" + cfg.shareSuspended.reason, LOCAL, cfg.shareSuspended.at)
          : cell("没有撤下", LOCAL),
      ],
      ["共享模型白名单", (cfg.share && cfg.share.models && cfg.share.models.join(", ")) || "—"],
      ["网关端口", port || "—"],
      ["端口已发布", published ? cell("是（ACL 允许该端口）", LOCAL) : cell("否：覆盖网上到不了", LOCAL)],
      [
        "网关要求 Key",
        gatewayCheck
          ? cell(gatewayCheck.detail, LOCAL, gatewayCheck.at)
          : cell("未测：等宿主的检查项", UNMEASURED),
      ],
      ["自有 provider", (cfg.nativeProviders || []).join(", ") || "—"],
      [
        "远端实测（别人能否连上我）",
        cell("本节点测不到自己：能证明的是 peer 会话存在，以及 Magpie 用量记录里有没有请求", UNMEASURED),
      ],
    ]);

    var consumers = s.consumers || [];
    var box = $("consumers");
    if (!consumers.length) {
      empty(box, "还没有消费者 Key。");
    } else {
      clear(box);
      box.append(
        table(
          ["消费者", "模型", "状态", "说明"],
          consumers.map(function (c) {
            var state;
            var why = "—";
            if (c.revokedAt) state = "已撤销";
            else if (c.paused) {
              state = "暂停";
              why = c.paused.reason + " [" + c.paused.enforcement + (c.paused.enforced === false ? "，未真正停住" : "") + "]";
            } else if (c.spent) state = "用完";
            else state = "可用";
            if (c.revokedAt) why = "撤销于 " + fmtTime(c.revokedAt);
            return [c.consumerId, (c.models || []).join(", "), state, why];
          }),
          {
            rowClass: function (row) {
              return /暂停|撤销|用完/.test(String(row[2])) ? "warn-row" : null;
            },
          },
        ),
      );
    }

    if (s.consumersSummary) {
      var sum = s.consumersSummary;
      box.append(
        el(
          "p",
          "muted",
          "共 " + sum.total + " 把：可用 " + sum.open + "、暂停 " + sum.paused + "、用完 " + sum.spent + "、撤销 " + sum.revoked,
        ),
      );
    }
    box.append(
      el(
        "p",
        "muted",
        "额度、已用、账本余额与结算只在带 token 的 API/CLI 里（快照文件只放状态，不放账务）：consumers add / topup / accounting。",
      ),
    );

    var cmds = el("div");
    cmds.append(el("h3", null, "命令"));
    commands(cmds, [
      { note: "共享开关（改的是配置，不是插件选项）：" },
      cli("share on"),
      cli("share off"),
      cli("share models deepseek/deepseek-chat, deepseek/*"),
      { note: "每个消费者一把 Key（白名单 + 正额度）。交付时 Key 写进 0600 文件，终端不打印：" },
      cli("consumers add alice deepseek/deepseek-chat 5"),
      cli("share handover alice --key-file ./alice.key"),
      { note: "充值、换价重签、撤销：" },
      cli("topup alice 2"),
      cli("consumers reissue alice --accept-price-version <sha256>"),
      cli("revoke alice"),
    ]);
    node.append(cmds);
  }

  // --- 4. catalogue and directory --------------------------------------------

  function fullFingerprint(identity) {
    if (!identity || !identity.fingerprint) return "—";
    return identity.fingerprint;
  }

  function identityCell(identity, pending) {
    if (!identity) return cell("还没有身份", MISSING);
    var wrap = el("span");
    wrap.append(el("code", "fp", fullFingerprint(identity)));
    wrap.append(el("div", "note", "自签 Ed25519（TOFU）：同一把私钥签的，不代表真实身份 · keyId " + (identity.keyId || "—")));
    if (pending) wrap.append(el("div", "note bad", "新指纹待本地接受：" + pending));
    return wrap;
  }

  // The projected quote nests its metadata under `publication`; an older host
  // wrote it flat. Read both, and never invent a field that is not there.
  function quoteVersion(quote) {
    var publication = quote.publication || {};
    var v = publication.version !== undefined ? publication.version : quote.version;
    return v === undefined || v === null ? "?" : v;
  }

  function quoteModels(quote) {
    if (Array.isArray(quote.models)) return quote.models.length;
    return quote.modelCount === undefined ? "?" : quote.modelCount;
  }

  function quotePublishedAt(quote) {
    var p = quote.publication || {};
    return p.updatedAt || p.publishedAt || quote.updatedAt || null;
  }

  function quoteContentHash(quote) {
    return quote.contentHash || (quote.publication && quote.publication.contentHash) || null;
  }

  function priceCell(pricing) {
    if (!pricing) return "没有公布价格";
    var text =
      "$" + pricing.input + " / $" + pricing.output + " 每 1M 输入/输出" +
      (pricing.cacheRead || pricing.cacheWrite ? " · 缓存 " + (pricing.cacheRead || 0) + "/" + (pricing.cacheWrite || 0) : "") +
      (pricing.source ? "（" + pricing.source + "）" : "");
    return text;
  }

  function renderCatalog(s) {
    var node = $("catalog");
    if (!s) return empty(node, "还没有快照。");
    var cat = s.catalog || null;
    if (!cat) return empty(node, "宿主未提供目录状态。");
    var quote = cat.quote || null;
    var server = cat.server || {};
    kvTable(node, [
      ["发布开关", cat.config && cat.config.enabled ? "开" : "关"],
      ["实际在服务", cat.publishing ? cell("是", LOCAL) : cell("否", LOCAL)],
      ["监听", server.running ? cell((server.address || "") + (server.port ? ":" + server.port : ""), LOCAL) : cell("没有监听", LOCAL)],
      ["错误", server.error || cat.error || "—"],
      ["发现开关", cat.config && cat.config.discoveryEnabled ? "开" : "关"],
      ["SOCKS5", (s.easytier && s.easytier.socks5Port ? "127.0.0.1:" + s.easytier.socks5Port : "—")],
      ["最后刷新", fmtTime(cat.lastRefreshAt)],
      ["引用版本", quote ? "v" + quoteVersion(quote) + " · " + quoteModels(quote) + " 个模型" : "—"],
      ["报价时间", quote ? "发布 " + fmtTime(quotePublishedAt(quote)) : "—"],
      ["内容摘要", quote && quoteContentHash(quote) ? quoteContentHash(quote) : cell("快照未提供", MISSING)],
      ["报价到期", cell("签名报价里没有 expiresAt/ttl：过期状态 UNKNOWN，连接前重读当前报价", UNMEASURED)],
      ["我的身份", identityCell(quote && quote.identity, null)],
    ]);

    if (quote && quote.models && quote.models.length) {
      node.append(el("h3", null, "公布出去的模型与价格"));
      node.append(
        table(
          ["模型", "API", "上下文", "价格", "价格版本", "价格锁定"],
          quote.models.map(function (m) {
            return [
              m.id,
              (m.gatewayApis || []).join("/") + (m.nativeApis ? " · 原生 " + m.nativeApis.join("/") : ""),
              (m.contextWindow ? m.contextWindow + " ctx" : "未知") + (m.maxOutputTokens ? " · 输出 " + m.maxOutputTokens : ""),
              priceCell(m.pricing),
              (m.pricing && m.pricing.priceVersion) ||
                (quote.billing && quote.billing.priceVersion) ||
                cell("报价未提供", MISSING),
              "priceLocked: false",
            ];
          }),
        ),
      );
    }

    var peers = cat.peers || [];
    var box = $("directory");
    if (!peers.length) {
      empty(box, "目录里还没有 peer（打开发现，或等一次刷新）。");
    } else {
      clear(box);
      box.append(
        table(
          ["peer", "虚拟 IP", "地址", "路径", "状态", "身份（完整指纹）", "报价（含读取时间）"],
          peers.map(function (p) {
            var quoteText = "—";
            if (p.quote) {
              var billing = p.quote.billing || {};
              var pub = p.quote.publication || {};
              var publishedAt = quotePublishedAt(p.quote);
              quoteText =
                "v" + quoteVersion(p.quote) +
                " · " + ((p.quote.models || []).length) + " 个模型" +
                " · " + (billing.priceVersion || (p.quote.models && p.quote.models[0] && p.quote.models[0].pricing && p.quote.models[0].pricing.priceVersion) || "无价格版本") +
                " · priceLocked: false" +
                " · 发布 " + fmtTime(publishedAt) +
                " · 读取 " + fmtTime(p.fetchedAt) +
                " · 无到期时间（UNKNOWN）";
            }
            return [
              p.hostname || "—",
              p.virtualIpv4 || "—",
              p.mappedCidr ? p.mappedCidr + ":" + (p.catalogPort || "?") : "—",
              (p.route || "—") + (p.latencyMs ? " " + p.latencyMs + "ms" : "") + (p.tunnel ? " " + p.tunnel : ""),
              (p.status || "—") + (p.detail ? "：" + p.detail : ""),
              identityCell(p.identity, p.pendingFingerprint),
              quoteText,
            ];
          }),
          {
            rowClass: function (row) {
              var state = String(row[4]);
              // "stale" here means a replayed or rolled-back version, not an expired
              // quote: the catalogue carries no expiry to compare against.
              if (/stale/.test(state)) return "warn-row";
              return /identity-changed|unverified|conflict|offline|unreachable/.test(state) ? "warn-row" : null;
            },
          },
        ),
      );
    }

    var cmds = el("div");
    cmds.append(el("h3", null, "命令"));
    commands(cmds, [
      cli("catalog publish on"),
      cli("catalog publish off"),
      cli("catalog discover on"),
      cli("catalog config --display-name \"My Magpie\" --port 3426"),
      cli("catalog peers"),
      { note: "第一次看到的身份是未验证的；只在核对过指纹之后本地接受（指纹变了要重新接受）：" },
      cli("catalog trust <node-id> --fingerprint <64hex>"),
      { note: "读一次某个 peer 的当前报价（必须给核对过的指纹与报价摘要）：" },
      cli("catalog request <node-id> --fingerprint <64hex> --quote <64hex>"),
      { note: "或者直接用引导式连接（会列出 peer、让你核对指纹与报价）：" },
      cli("connect"),
    ]);
    node.append(cmds);
  }

  // --- 5. remote providers ----------------------------------------------------

  function renderProviders(s) {
    var node = $("providers");
    if (!s) return empty(node, "还没有快照。");
    var providers = s.providers || [];
    if (!providers.length) {
      empty(node, (s.config && s.config.consumingEnabled) ? "使用别人的 Magpie 已打开，但还没有记录。" : "还没有远程 Magpie 记录。");
    } else {
      clear(node);
      node.append(
        table(
          ["提供者", "地址", "本地端口", "状态（远端实测）", "最后连通", "转发（本地）", "注册（本地）", "远端 Key（远端实测）", "peer"],
          providers.map(function (p) {
            // The remote limit's money is this node's private spending: the snapshot
            // carries only whether the key is spent. The numbers are `providers` on
            // the token-protected API/CLI.
            var limit = p.limit ? (p.limit.spent === null || p.limit.spent === undefined ? "—" : p.limit.spent ? "已用完" : "还有额度") : "—";
            var forward = checkByName(s, "provider:" + p.id + ":forward");
            var registered = checkByName(s, "provider:" + p.id + ":registered");
            return [
              p.id,
              p.mappedCidr + ":" + p.providerPort,
              "127.0.0.1:" + p.localPort,
              cell(p.status + (p.detail ? "：" + p.detail : ""), REMOTE, p.lastConnectedAt),
              fmtTime(p.lastConnectedAt),
              forward ? cell(forward.ok ? "在" : forward.detail, LOCAL, forward.at) : cell("未提供", MISSING),
              registered ? cell(registered.ok ? "是" : registered.detail, LOCAL, registered.at) : cell("未提供", MISSING),
              cell(limit, REMOTE, p.updatedAt),
              p.fingerprint ? p.fingerprint.hostname + (p.fingerprint.peerId ? " (" + p.fingerprint.peerId + ")" : "") : "—",
            ];
          }),
          {
            rowClass: function (row) {
              return /degraded|mismatch|disabled/.test(String(row[3].textContent || row[3])) ? "warn-row" : null;
            },
          },
        ),
      );
    }

    if (s.providersSummary) {
      var ps = s.providersSummary;
      node.append(
        el(
          "p",
          "muted",
          "共 " + ps.total + " 台：connected " + ps.connected + "、degraded " + ps.degraded + "、已用完 " + ps.spent + "。",
        ),
      );
    }
    node.append(el("p", "muted", "远端金额与调用次数不在本页（快照不放账务）：终端用 providers 看。"));

    var cmds = el("div");
    cmds.append(el("h3", null, "命令"));
    commands(cmds, [
      { note: "每台远端 Magpie 单独一条记录，各有自己的 Key 与端口；删一个不碰其他：" },
      cli("remote add peer-b --cidr 10.66.1.2/32 --key-file ./peer-b.key --port 3425"),
      cli("remote update-key peer-b --key-file ./peer-b.key"),
      cli("remote remove peer-b"),
      cli("providers"),
      cli("provider reconcile"),
      cli("consume on"),
      cli("consume off"),
    ]);
    node.append(cmds);
  }

  // --- 6. testnet wallet ------------------------------------------------------

  function renderWallet(s) {
    var node = $("wallet");
    if (!s) return empty(node, "还没有快照。");
    var w = s.wallet;
    if (!w) {
      return empty(node, "宿主这次启动还没有写出钱包状态（这不代表测试网已关闭；用 wallet 命令查询）。");
    }
    if (w.disabled) {
      return empty(node, "这个节点上所有测试网都已关闭：不会请求也不会记入任何存款。");
    }
    clear(node);
    var networks = (w.networks || []).slice();
    var assets = (w.assets || []).slice();
    var totals = w.totals || {};

    if (networks.length) {
      node.append(
        table(
          ["网络", "chainId", "类型", "启用", "最终性", "扫描游标", "最近扫描"],
          networks.map(function (n) {
            return [
              n.displayName,
              n.chainId,
              n.networkType,
              n.enabled ? "是" : "否",
              n.finality ? n.finality.mode + (n.finality.confirmations ? "（" + n.finality.confirmations + "）" : "") : "—",
              n.cursor === undefined || n.cursor === null ? "—" : n.cursor,
              n.lastScanAt ? fmtTime(n.lastScanAt) + (n.lastError ? " · " + n.lastError : "") : n.lastError || "—",
            ];
          }),
        ),
      );
    } else {
      node.append(el("p", "muted", "没有已登记的网络。"));
    }

    if (assets.length) {
      node.append(el("h3", null, "测试代币"));
      node.append(
        table(
          ["币", "chainId", "合约", "小数", "链上读数", "费率", "启用"],
          assets.map(function (a) {
            var onchain = a.onchainDecimals === undefined || a.onchainDecimals === null
              ? "—"
              : a.onchainDecimals === a.decimals
                ? String(a.onchainDecimals) + " ✓"
                : String(a.onchainDecimals) + " 不一致";
            return [
              a.symbol + " — " + a.name,
              a.chainId,
              a.contractAddress,
              a.decimals,
              onchain,
              a.nanosPerToken + " nanos/整币（" + a.priceVersion + "）",
              a.enabled ? "是" : "否",
            ];
          }),
        ),
      );
    }

    node.append(el("h3", null, "汇总"));
    node.append(
      table(
        ["已入账", "已最终确认未入账", "待确认", "未认领", "不确定", "已回滚"],
        [[
          totals.credited || 0,
          totals.finalized || 0,
          totals.pending || 0,
          totals.unclaimed || 0,
          totals.uncertain || 0,
          totals.reverted || 0,
        ]],
      ),
    );
    node.append(
      el(
        "p",
        "muted",
        "本页只放汇总：存款请求的付款地址、每笔交易与「谁付了哪笔」的对应关系不进入本快照，在终端用 wallet intents / wallet events 查。",
      ),
    );

    var cmds = el("div");
    cmds.append(el("h3", null, "命令"));
    commands(cmds, [
      cli("wallet status"),
      cli("wallet wizard"),
      cli("wallet networks"),
      cli("wallet network 97 --enable"),
      cli("wallet receiving provider-a 97 0x…"),
      cli("wallet intent provider-a alice 97 eip155:97:0x… 2500000"),
      cli("wallet events --tx 0x…"),
      cli("wallet statement alice --out ./statements"),
      cli("wallet credit alice"),
    ]);
    node.append(cmds);
  }

  // --- settings ---------------------------------------------------------------

  var formState = { base: {}, canSeed: false, dirty: false, changed: [], busy: false };

  function readDraft(form) {
    var f = form.elements;
    var draft = {};
    if (formState.canSeed) {
      draft.networkName = f.networkName.value;
      draft.networkSecret = f.networkSecret.value;
      draft.peers = f.peers.value;
      draft[LISTEN_KEY] = $("listen-addr").value;
      draft.secureMode = f.secureMode.checked;
      draft.sharingEnabled = f.sharingEnabled.checked;
      draft.consumingEnabled = f.consumingEnabled.checked;
    }
    draft.pagePrefs = { showAdvanced: f.showAdvanced.checked };
    return draft;
  }

  function refreshDirty() {
    var form = $("form");
    var result = settings.mergeSaved(formState.base, readDraft(form));
    // What the operator changed is the difference from the form as it was filled,
    // not from plugins.json: a fresh form already differs from an empty options
    // object and must not look like an edit.
    var changed = formState.baseline ? settings.changedBetween(formState.baseline, result.merged) : result.changed;
    formState.dirty = changed.length > 0;
    formState.changed = changed;
    var save = $("save");
    if (!formState.busy) {
      save.disabled = !formState.dirty;
      save.textContent = formState.dirty ? "保存（" + changed.join(", ") + "）" : "保存";
    }
    return { merged: result.merged, changed: changed };
  }

  function banner(kind, text, detail) {
    var node = $("save-banner");
    if (!text) {
      node.hidden = true;
      node.textContent = "";
      node.className = "banner";
      return;
    }
    node.hidden = false;
    node.className = "banner " + (kind || "");
    clear(node);
    node.append(el("strong", null, text));
    if (detail) node.append(el("div", "note", detail));
  }

  function applyPrefs(prefs) {
    var advanced = Boolean(prefs && prefs.showAdvanced);
    document.body.classList.toggle("advanced", advanced);
  }

  function fillForm(view, magpieOptions) {
    var form = $("form");
    var f = form.elements;
    formState.base = magpieOptions || {};
    var snap = status();
    var cfg = (snap && snap.config) || {};
    // Without a snapshot this page cannot tell whether the node is configured,
    // and a wizard that guesses would write options nobody asked for.
    var canSeed = Boolean(snap) && !cfg.networkName;
    formState.canSeed = canSeed;
    $("wizard").hidden = !canSeed;
    if (!snap) {
      $("settings-note").textContent = "还没有宿主快照：无法判断这个节点是否已配置，所以不显示首次配置。先点 Reload。";
    } else if (!canSeed) {
      $("settings-note").textContent =
        "这个节点已经有网络配置（" + (cfg.networkName || "?") + "）。网络设置本页不再写入——它属于配置，用 CLI 改，免得把命令行改过的结果覆盖掉。这里只剩本页偏好可写。";
    } else {
      $("settings-note").textContent =
        "这个节点还没有网络配置：下面的字段会作为启动种子写入 Magpie 的插件选项，宿主下次启动时用它建立覆盖网。";
    }
    if (canSeed) {
      if (formState.base.networkName) f.networkName.value = String(formState.base.networkName);
      if (formState.base.peers) f.peers.value = Array.isArray(formState.base.peers) ? formState.base.peers.join(", ") : String(formState.base.peers);
      if (formState.base[LISTEN_KEY]) $("listen-addr").value = String(formState.base[LISTEN_KEY]);
      if (typeof formState.base.secureMode === "boolean") f.secureMode.checked = formState.base.secureMode;
      if (typeof formState.base.sharingEnabled === "boolean") f.sharingEnabled.checked = formState.base.sharingEnabled;
      if (typeof formState.base.consumingEnabled === "boolean") f.consumingEnabled.checked = formState.base.consumingEnabled;
      var stored = typeof formState.base.networkSecret === "string" ? formState.base.networkSecret.length : 0;
      $("secret-state").textContent = stored
        ? "已保存密钥（" + stored + " 个字符）：留空就保持它不变"
        : "还没有保存过密钥";
    }

    var prefs = (formState.base.pagePrefs || {}) || {};
    f.showAdvanced.checked = Boolean(prefs.showAdvanced);
    applyPrefs(prefs);
    formState.baseline = settings.mergeSaved(formState.base, readDraft(form)).merged;
    refreshDirty();
  }

  function expectToken(s) {
    if (!s || !s.plugin) return "";
    // pid, startedAt, and the moment of the save: after a reload the page can tell
    // "the host restarted" from "the host is still starting and has not written a
    // new snapshot yet" (a first start may download EasyTier and take minutes).
    return (
      String(s.plugin.pid || "?") +
      "~" +
      encodeURIComponent(String(s.plugin.startedAt || "?")) +
      "~" +
      String(Date.now())
    );
  }

  /**
   * After a reload the page compares the pid it saved with the one in the fresh
   * snapshot. That is the only proof available: the page cannot ask the host.
   */
  function verifyAfterReload(s) {
    var params = new URLSearchParams(window.location.search);
    var expect = params.get("expect");
    if (!expect) return;
    var tries = Number(params.get("try") || "0");
    var parts = expect.split("~");
    var pid = parts[0];
    var started = decodeURIComponent(parts[1] || "");
    var savedAt = Number(parts[2] || "0");
    var current = s && s.plugin ? s.plugin : null;
    var clean = function () {
      try {
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
      } catch (e) {
        /* the query staying in the address bar is harmless */
      }
    };
    if (!current) {
      banner("warn", "已提交，但还没有新快照", "宿主重启后才会写出快照。稍等再 Reload。");
      return;
    }
    if (String(current.pid) !== pid || String(current.startedAt) !== started) {
      banner(
        "ok",
        "宿主已重启，保存的选项已重读",
        "保存前 pid " + pid + "，现在 " + current.pid + "（启动于 " + fmtTime(current.startedAt) + "）。" +
          (optionsView() && optionsView().reason ? " 宿主对这次保存的判断：" + optionsView().reason : ""),
      );
      clean();
      return;
    }
    var snapshotAt = Date.parse(s.generatedAt || "") || 0;
    var stillStarting = savedAt > 0 && snapshotAt > 0 && snapshotAt < savedAt;
    if (tries < 6) {
      banner(
        "warn",
        stillStarting
          ? "宿主还没写出新快照（第 " + (tries + 1) + " 次检查）"
          : "宿主还没有重启（第 " + (tries + 1) + " 次检查）",
        (stillStarting
          ? "它可能仍在启动：第一次启动要下载并校验 EasyTier，可能要一分钟以上。"
          : "写入已经发出；Magpie 重启宿主后 pid 才会变。") + " 3 秒后自动再看一次，页面不能主动问宿主。",
      );
      setTimeout(function () {
        try {
          window.location.replace(
            window.location.pathname + "?expect=" + encodeURIComponent(expect) + "&try=" + (tries + 1) + window.location.hash,
          );
        } catch (e) {
          window.location.reload();
        }
      }, 3000);
      return;
    }
    banner(
      "warn",
      "无法在本页确认（还没有写出新快照）",
      "写入已经发出，但宿主可能仍在启动，或重启后还没写出快照。这不等于失败：点 Reload 再看 pid，或在终端执行 magpie plugin options <插件名> 对照。",
    );
    clean();
  }

  function wireSettings(magpie) {
    var form = $("form");
    var save = $("save");
    form.addEventListener("input", refreshDirty);
    form.addEventListener("change", refreshDirty);

    $("reload").addEventListener("click", function () {
      window.location.reload();
    });

    // A sandboxed page without `allow-forms` never fires a submit event at all:
    // Magpie's policy is `sandbox allow-scripts`, so a <form> submit is not just
    // blocked, it is silent. The Save button is therefore a plain button, and the
    // submit listener stays only as a belt-and-braces path for other hosts.
    save.addEventListener("click", function (event) {
      event.preventDefault();
      doSave();
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      doSave();
    });

    async function doSave() {
      if (formState.busy) return; // no duplicate saves while one is in flight
      var result = refreshDirty();
      if (!result.changed.length) {
        $("saved").textContent = "没有改动，未提交（不会重启宿主）。";
        return;
      }
      var before = status();
      var token = expectToken(before);
      formState.busy = true;
      var save = $("save");
      save.disabled = true;
      save.textContent = "提交中…";
      $("saved").textContent = "正在写入选项；Magpie 随后会重启插件宿主。";
      banner("", "正在提交…", "写入后 Magpie 会重启插件宿主，overlay 与本地 API 会消失几秒。");
      try {
        await magpie.options.set(result.merged);
      } catch (e) {
        formState.busy = false;
        save.disabled = false;
        save.textContent = "保存";
        $("saved").textContent = "";
        banner("bad", "提交失败（这是桥接真的报错，不是超时）", String((e && e.message) || e));
        return;
      }
      // The write is in. The host restart is out of this page's sight: say so,
      // and go and look at the pid instead of guessing.
      $("saved").textContent = "已提交，未验证。等待宿主重启后对照 pid。";
      save.textContent = "已提交（未验证）";
      banner(
        "warn",
        "已提交，尚未验证",
        "写入成功，但页面无法询问宿主。Magpie 重启插件宿主后 pid 会变；2 秒后自动 Reload，用 pid 与 startedAt 对照。",
      );
      applyPrefs(result.merged.pagePrefs);
      setTimeout(function () {
        try {
          window.location.replace(window.location.pathname + "?expect=" + encodeURIComponent(token) + "&try=0");
        } catch (e) {
          window.location.reload();
        }
      }, 2000);
    }
  }

  // --- boot -------------------------------------------------------------------

  function main() {
    var s = status();
    var view = optionsView();
    // status.js and options.js live in the same installed package. If two Magpie
    // profiles share that package, one node's snapshot can be read by the other's
    // page; the host pid is the cheapest proof that both files are this host's.
    if (s && view && s.plugin && view.hostPid && Number(s.plugin.pid) !== Number(view.hostPid)) {
      banner(
        "bad",
        "快照和设置来自不同的宿主，本页不敢把它们当同一个节点",
        "status.js 的 pid " + s.plugin.pid + "，options.js 的 pid " + view.hostPid +
          "。两个 Magpie 配置可能共用同一个插件目录；请各自安装一份插件，或先 Reload 再看。",
      );
      document.body.classList.add("conflict");
    }
    var problems = (view && view.problems) || [];
    if (problems.length) {
      banner("bad", "保存的选项里有不能用的值，宿主没有应用它们", problems.join("; "));
    }
    renderStep(s);
    renderDiagnostics(s);
    renderChecks(s);
    renderVersions(s);
    renderNode(s);
    renderSharing(s);
    renderCatalog(s);
    renderProviders(s);
    renderWallet(s);

    if (s && s.config && !s.config.networkName) document.body.classList.add("unconfigured");
    else document.body.classList.remove("unconfigured");

    verifyAfterReload(s);

    var magpie = window.magpie;
    if (!magpie) {
      $("saved").textContent = "Magpie 的桥接脚本没加载：本页只能看，不能保存选项。";
      $("save").disabled = true;
      $("wizard").hidden = true;
      return;
    }
    magpie.ready.then(
      function () {
        return magpie.options.get();
      },
      function () {
        return null;
      },
    ).then(function (options) {
      var opts = options && typeof options === "object" ? options : {};
      if (view) applyPrefs(opts.pagePrefs || view.pagePrefs);
      fillForm(view, opts);
      wireSettings(magpie);
      if (view && view.drift) {
        banner(
          "warn",
          "插件选项与已应用的不一致，本次没有应用",
          "插件选项摘要与宿主记录的不一样，但已有配置优先，宿主没有据此改覆盖网。用 CLI 改配置，或清掉选项：" +
            " magpie plugin options <插件名> off",
        );
      }
      if (view && view.error) {
        banner("bad", "上一次保存没有生效", view.error);
      }
    });
  }

  main();
})();
