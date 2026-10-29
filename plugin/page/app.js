/* Plugin page for @oh-my-aihub/magpie-plugin.
 *
 * Magpie serves a plugin page with `connect-src 'none'`, so this page never
 * fetches anything. Two channels are available and both are used here:
 *   - magpie.options.get() / set()  (the window's bridge) for settings
 *   - status.js, a snapshot the host writes into this folder, for status
 * Reloading the page reads a fresh snapshot.
 *
 * Phase 4: the status shows both capabilities, every remote provider (read-only)
 * and every consumer. Nothing here performs an action; the loopback API/CLI is
 * the operator interface, as before. */

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => (typeof n === "number" ? `$${n.toFixed(4)}` : "—");
const fmtPrice = (p) =>
  !p
    ? "no published price"
    : `$${p.input}/$${p.output} per 1M in/out` +
      (p.cacheRead || p.cacheWrite ? ` · cache ${p.cacheRead}/${p.cacheWrite}` : "") +
      (p.source ? ` (${p.source})` : "");

function catalogBadge(status) {
  if (status === "identity-changed") return "bad";
  if (status === "unverified" || status === "unreachable" || status === "conflict" || status === "offline") return "bad";
  return null;
}

function table(headers, rows, className) {
  const t = document.createElement("table");
  const head = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  t.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const v of row) {
      const td = document.createElement("td");
      td.textContent = String(v);
      if (className && className(v)) td.className = className(v);
      tr.append(td);
    }
    t.append(tr);
  }
  return t;
}

function renderStatus(s) {
  const body = $("status-body");
  if (!s) {
    body.textContent = "No snapshot yet. Start Magpie once with the plugin enabled, then reload.";
    return;
  }
  const et = s.easytier || {};
  const cfg = s.config || {};
  const rows = [];
  rows.push(["Plugin host pid", s.plugin?.pid ?? "—"]);
  rows.push(["Magpie", s.magpie?.version ?? "—"]);
  rows.push(["This node", cfg.hostname ?? "—"]);
  rows.push([
    "Sharing (published)",
    !cfg.sharingEnabled
      ? "off"
      : cfg.sharingActive === false
        ? `suspended — ${cfg.shareSuspended?.reason ?? "safety check pending"}`
        : "on",
  ]);
  rows.push(["Consuming (remote)", cfg.consumingEnabled ? "on" : "off"]);
  rows.push(["Overlay", et.networkName ?? cfg.networkName ?? "—"]);
  rows.push(["EasyTier", et.coreVersion ?? "—"]);
  rows.push(["Core", et.running ? `running, pid ${et.pid}` : `stopped${et.lastError ? `: ${et.lastError}` : ""}`]);
  rows.push(["Restarts", et.restarts ?? 0]);
  rows.push(["Virtual IP", et.virtualIpv4 ?? cfg.virtualIpv4 ?? "—"]);
  rows.push(["My export", et.proxyCidr ? `${et.proxyCidr} → ${et.mappedCidr}` : "—"]);
  rows.push(["Published ports", (cfg.publishedPorts ?? []).join(", ") || "—"]);
  rows.push(["Share allow list", (cfg.share?.models ?? []).join(", ") || "—"]);
  rows.push(["Own providers", (cfg.nativeProviders ?? []).join(", ") || "none"]);
  rows.push(["Remote providers", (cfg.remoteProviders ?? []).join(", ") || "none"]);
  rows.push(["Secure Mode", et.secureMode ? "on (persisted key)" : "off"]);
  rows.push(["ACL", et.aclOk ? "ok" : `FAILED: ${(et.aclProblems || []).join("; ")}`]);
  rows.push(["Peers", (et.peers || []).map((p) => `${p.hostname || p.ipv4} ${p.ipv4} ${p.cost} ${p.latencyMs}ms`).join("\n") || "none yet"]);

  const t = document.createElement("table");
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = String(v);
    if (k === "Peers") td.style.whiteSpace = "pre-line";
    if ((k === "ACL" || k === "Core") && (et.aclOk === false || (k === "Core" && !et.running))) td.className = "bad";
    tr.append(th, td);
    t.append(tr);
  }
  body.innerHTML = "";
  body.append(t);

  const providers = s.providers || [];
  if (providers.length) {
    const h = document.createElement("h2");
    h.textContent = "Remote Magpies";
    body.append(
      h,
      table(
        ["provider", "address", "loopback", "status", "overlay peer", "native limit"],
        providers.map((p) => [
          p.id,
          `${p.mappedCidr}:${p.providerPort}`,
          `127.0.0.1:${p.localPort}`,
          `${p.status}${p.detail ? ` — ${p.detail}` : ""}`,
          p.fingerprint ? `${p.fingerprint.hostname}${p.fingerprint.peerId ? ` (${p.fingerprint.peerId})` : ""}` : "—",
          p.limit
            ? `${fmtUsd(p.limit.cost ?? 0)} used / ${fmtUsd(p.limit.costLimit ?? 0)} cap` +
              ` · ${p.limit.calls ?? 0} calls${p.limit.spent ? " · spent" : ""}`
            : "—",
        ]),
        (v) => (String(v).startsWith("connected") ? "" : /degraded|mismatch|disabled/.test(String(v)) ? "bad" : null),
      ),
    );
  }

  renderCatalog(s.catalog);
  renderDirectory(s.catalog?.peers || []);

  if ((s.consumers || []).length) {
    const h = document.createElement("h2");
    h.textContent = "Consumers";
    body.append(
      h,
      table(
        ["consumer", "models", "cap", "used", "left", "calls", "state"],
        s.consumers.map((c) => [
          c.consumerId,
          c.models.join(", "),
          fmtUsd(c.capUsd),
          fmtUsd(c.usedUsd ?? 0),
          fmtUsd(c.leftUsd ?? 0),
          c.calls ?? 0,
          c.revokedAt ? "revoked" : c.spent ? "spent" : "open",
        ]),
      ),
    );
  }

  const gen = document.createElement("p");
  gen.className = "muted";
  gen.textContent = `snapshot ${s.generatedAt || ""} · state version ${s.plugin?.stateVersion ?? "?"}`;
  body.append(gen);
}

function renderCatalog(c) {
  const body = $("catalog-body");
  if (!c) {
    body.textContent = "No catalogue snapshot yet.";
    return;
  }
  body.innerHTML = "";
  const rows = [];
  rows.push(["Publishing", c.publishing ? `on — ${c.server?.address ?? ""}${c.server?.port ? ` (port ${c.server.port})` : ""}` : "off"]);
  if (c.quote) {
    rows.push(["Quote", `version ${c.quote.version} · ${c.quote.modelCount} model(s) · updated ${c.quote.updatedAt}`]);
    rows.push(["Identity", `Ed25519 ${c.quote.identity?.fingerprint ?? "—"} (self-signed, not a real-world identity)`]);
    rows.push(["Top-up", `${fmtUsd(c.config?.minTopUpUsd ?? 0)} minimum, simulated only — no wallet or payment is connected`]);
    rows.push(["Billing", "display only — the quote itself never charges; real charging needs a manually issued key and the later price lock"]);
  } else {
    rows.push(["Quote", c.publishing ? "no signed quote yet" : "not published"]);
  }
  rows.push(["Last refresh", c.lastRefreshAt ?? "—"]);
  if (c.server?.error || c.error) rows.push(["Error", c.server?.error || c.error]);
  const t = document.createElement("table");
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = String(v);
    if (k === "Error") td.className = "bad";
    tr.append(th, td);
    t.append(tr);
  }
  body.append(t);

  const quote = c.quote;
  if (quote) {
    const h = document.createElement("h2");
    h.textContent = "Published models and quotes";
    body.append(
      h,
      table(
        ["model", "APIs", "capabilities", "price"],
        (quote.models || []).map((m) => [
          m.id,
          `${(m.gatewayApis || []).join("/")}${m.nativeApis ? ` · native ${m.nativeApis.join("/")}` : ""}`,
          `${m.contextWindow ? `${m.contextWindow} ctx` : "ctx unknown"}${m.maxOutputTokens ? ` · ${m.maxOutputTokens} out` : ""}` +
            `${m.images ? " · images" : ""}${m.reasoningLevels ? ` · reasoning ${m.reasoningLevels.join("/") || "none"}` : ""}`,
          fmtPrice(m.pricing),
        ]),
      ),
    );
  }
}

function renderDirectory(peers) {
  const body = $("directory-body");
  if (!peers.length) {
    body.textContent = "No peers in the directory yet (enable discovery, or wait for a refresh).";
    return;
  }
  body.innerHTML = "";
  body.append(
    table(
      ["peer", "virtual IP", "mapped address", "route", "status", "identity", "quote"],
      peers.map((p) => [
        p.hostname,
        p.virtualIpv4,
        p.mappedCidr ? `${p.mappedCidr}:${p.catalogPort ?? "?"}` : "—",
        `${p.route}${p.latencyMs ? ` ${p.latencyMs}ms` : ""}${p.tunnel ? ` ${p.tunnel}` : ""}`,
        `${p.status}${p.detail ? ` — ${p.detail}` : ""}`,
        p.identity ? `${p.identity.keyId} · ${p.identity.fingerprint.slice(0, 16)}…${p.pendingFingerprint ? ` · PENDING ${p.pendingFingerprint.slice(0, 16)}…` : ""}` : "—",
        p.quote
          ? `v${p.quote.publication.version} · ${p.quote.models.map((m) => `${m.id} (${fmtPrice(m.pricing)})`).join("; ")}`
          : "—",
      ]),
      (v) => catalogBadge(String(v).split(" ")[0]),
    ),
  );
}

async function main() {
  renderStatus(globalThis.__OH_MY_AIHUB_STATUS__ || null);

  $("reload").addEventListener("click", () => location.reload());

  const magpie = globalThis.magpie;
  if (!magpie) {
    $("saved").textContent = "Magpie's bridge did not load; settings cannot be read.";
    return;
  }
  try {
    await magpie.ready;
    const options = (await magpie.options.get()) || {};
    const form = $("form");
    const sharing = typeof options.sharingEnabled === "boolean" ? options.sharingEnabled : options.role === "provider";
    const consuming = typeof options.consumingEnabled === "boolean" ? options.consumingEnabled : options.role === "consumer";
    form.elements.sharingEnabled.checked = Boolean(sharing);
    form.elements.consumingEnabled.checked = Boolean(consuming);
    form.elements.catalogEnabled.checked = Boolean(options.catalogEnabled);
    form.elements.catalogDiscovery.checked = Boolean(options.catalogDiscovery);
    for (const k of ["networkName", "networkSecret", "listenAddr"]) {
      if (options[k]) form.elements[k].value = String(options[k]);
    }
    if (options.peers) form.elements.peers.value = Array.isArray(options.peers) ? options.peers.join(", ") : String(options.peers);
    if (options.publishedPorts) {
      form.elements.publishedPorts.value = Array.isArray(options.publishedPorts)
        ? options.publishedPorts.join(", ")
        : String(options.publishedPorts);
    }
    if (options.shareModels) {
      form.elements.shareModels.value = Array.isArray(options.shareModels) ? options.shareModels.join(", ") : String(options.shareModels);
    }
    for (const k of ["catalogDisplayName", "catalogContact"]) {
      if (options[k]) form.elements[k].value = String(options[k]);
    }
    if (options.catalogPort) form.elements.catalogPort.value = String(options.catalogPort);
    if (typeof options.secureMode === "boolean") form.elements.secureMode.checked = options.secureMode;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const next = {
        sharingEnabled: f.sharingEnabled.checked,
        consumingEnabled: f.consumingEnabled.checked,
        networkName: f.networkName.value.trim(),
        networkSecret: f.networkSecret.value,
        peers: f.peers.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        listenAddr: f.listenAddr.value.trim(),
        publishedPorts: f.publishedPorts.value.split(/[\s,]+/).map((s) => Number(s.trim())).filter(Boolean),
        shareModels: f.shareModels.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        catalogEnabled: f.catalogEnabled.checked,
        catalogDiscovery: f.catalogDiscovery.checked,
        catalogDisplayName: f.catalogDisplayName.value.trim(),
        catalogContact: f.catalogContact.value.trim(),
        catalogPort: f.catalogPort.value ? Number(f.catalogPort.value) : undefined,
        secureMode: f.secureMode.checked,
      };
      if (!next.sharingEnabled && !next.consumingEnabled) {
        $("saved").textContent = "Nothing to do: turn on sharing, consuming, or both.";
        return;
      }
      try {
        await magpie.options.set(next);
        $("saved").textContent = "Saved. Restart magpie (or reopen this page) so the host reads them.";
      } catch (err) {
        $("saved").textContent = `Save failed: ${err?.message || err}`;
      }
    });
  } catch (err) {
    $("saved").textContent = `Bridge error: ${err?.message || err}`;
  }
}

main();
