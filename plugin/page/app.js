/* Plugin page for @oh-my-aihub/magpie-plugin.
 *
 * Magpie serves a plugin page with `connect-src 'none'`, so this page never
 * fetches anything. Two channels are available and both are used here:
 *   - magpie.options.get() / set()  (the window's bridge) for settings
 *   - status.js, a snapshot the host writes into this folder, for status
 * Reloading the page reads a fresh snapshot. */

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => (typeof n === "number" ? `$${n.toFixed(4)}` : "—");

function renderStatus(s) {
  const body = $("status-body");
  if (!s) {
    body.textContent = "No snapshot yet. Start Magpie once with the plugin enabled, then reload.";
    return;
  }
  const et = s.easytier || {};
  const rows = [];
  rows.push(["Plugin host pid", s.plugin?.pid ?? "—"]);
  rows.push(["Magpie", s.magpie?.version ?? "—"]);
  rows.push(["Role", s.config?.role ?? "—"]);
  rows.push(["Overlay", et.networkName ?? s.config?.networkName ?? "—"]);
  rows.push(["EasyTier", et.coreVersion ?? "—"]);
  rows.push(["Core", et.running ? `running, pid ${et.pid}` : `stopped${et.lastError ? `: ${et.lastError}` : ""}`]);
  rows.push(["Restarts", et.restarts ?? 0]);
  rows.push(["Virtual IP", et.virtualIpv4 ?? s.config?.virtualIpv4 ?? "—"]);
  rows.push(["Provider export", et.proxyCidr ? `${et.proxyCidr} → ${et.mappedCidr}` : "—"]);
  rows.push(["Published ports", (s.config?.publishedPorts ?? []).join(", ") || "—"]);
  rows.push(["Secure Mode", et.secureMode ? "on (persisted key)" : "off"]);
  rows.push(["ACL", et.aclOk ? "ok" : `FAILED: ${(et.aclProblems || []).join("; ")}`]);
  rows.push(["Peers", (et.peers || []).map((p) => `${p.hostname || p.ipv4} ${p.ipv4} ${p.cost} ${p.latencyMs}ms`).join("\n") || "none yet"]);
  if (s.wiring) rows.push(["Remote Magpie", `${s.wiring.id} at ${s.wiring.url}`]);

  const table = document.createElement("table");
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = String(v);
    if (k === "Peers") td.style.whiteSpace = "pre-line";
    if (k === "ACL" && !et.aclOk) td.className = "bad";
    tr.append(th, td);
    table.append(tr);
  }
  body.innerHTML = "";
  body.append(table);

  if ((s.consumers || []).length) {
    const h = document.createElement("h2");
    h.textContent = "Consumers";
    const t = document.createElement("table");
    t.innerHTML =
      "<tr><th>consumer</th><th>models</th><th>cap</th><th>used</th><th>left</th><th>calls</th><th>state</th></tr>";
    for (const c of s.consumers) {
      const tr = document.createElement("tr");
      for (const v of [
        c.consumerId,
        c.models.join(", "),
        fmtUsd(c.capUsd),
        fmtUsd(c.usedUsd ?? 0),
        fmtUsd(c.leftUsd ?? 0),
        c.calls ?? 0,
        c.revokedAt ? "revoked" : c.spent ? "spent" : "open",
      ]) {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.append(td);
      }
      t.append(tr);
    }
    body.append(h, t);
  }

  const gen = document.createElement("p");
  gen.className = "muted";
  gen.textContent = `snapshot ${s.generatedAt || ""}`;
  body.append(gen);
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
    if (options.role) form.elements.role.value = String(options.role);
    for (const k of ["networkName", "networkSecret", "listenAddr"]) {
      if (options[k]) form.elements[k].value = String(options[k]);
    }
    if (options.peers) form.elements.peers.value = Array.isArray(options.peers) ? options.peers.join(", ") : String(options.peers);
    if (options.publishedPorts) {
      form.elements.publishedPorts.value = Array.isArray(options.publishedPorts)
        ? options.publishedPorts.join(", ")
        : String(options.publishedPorts);
    }
    if (typeof options.secureMode === "boolean") form.elements.secureMode.checked = options.secureMode;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const next = {
        role: f.role.value,
        networkName: f.networkName.value.trim(),
        networkSecret: f.networkSecret.value,
        peers: f.peers.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        listenAddr: f.listenAddr.value.trim(),
        publishedPorts: f.publishedPorts.value.split(/[\s,]+/).map((s) => Number(s.trim())).filter(Boolean),
        secureMode: f.secureMode.checked,
      };
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
