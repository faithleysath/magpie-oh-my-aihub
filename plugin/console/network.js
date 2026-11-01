// Pure projections for the read-only network page.
//
// The service already separates a live read from last-known facts (a stopped
// core or an old peer read). This module only turns that into labels, so the
// "never present stale facts as live" rule is unit-testable without a DOM,
// a fetch mock or a browser.

export function networkFacts(network = {}, et = {}, config = {}, time = () => "") {
  const node = network.thisNode || {};
  const evidence = network.evidence || {};
  const core = network.core || {};
  const factsStale = evidence.stale === true || node.stale === true;
  const lastKnown = factsStale ? "（最后已知）" : "";
  const coreRunning = core.running === true || et.running === true;
  const coreVersion = core.version || et.coreVersion || null;
  const networkName = node.networkName || config.networkName || "未配置";
  const hostname = node.hostname || config.hostname || "等待生成";
  const virtualIpv4 = node.virtualIpv4
    ? `${node.virtualIpv4}${lastKnown}`
    : (config.virtualIpv4 ? `${config.virtualIpv4}（配置值，未在线确认）` : "未分配");
  const engine = coreRunning
    ? (coreVersion ? `EasyTier ${coreVersion} · no-TUN` : "运行中")
    : (coreVersion ? `EasyTier ${coreVersion} · 已停止（最后已知版本）` : "未运行");
  const catalog = network.catalog || {};
  const publishing = typeof catalog.publishing === "boolean"
    ? (catalog.publishing ? `已发布 · ${catalog.modelCount ?? "未知"} 个模型` : "未发布")
    : ((config.catalog || {}).enabled ? "已发布" : "未发布");
  const evidenceText = evidence.readAt
    ? `${time(evidence.readAt)}${evidence.staleMs ? ` · ${Math.round(evidence.staleMs / 1000)} 秒前` : ""}${factsStale ? " · 最后已知，非实时" : ""}`
    : "尚未读取";
  return {
    stale: factsStale,
    rows: [
      ["网络名称", `${networkName}${lastKnown}`],
      ["本机节点名", `${hostname}${lastKnown}`],
      ["虚拟地址", virtualIpv4],
      ["网络引擎", engine],
      ["目录发布", publishing],
      ["状态证据", evidenceText],
    ],
  };
}

/** One neighbour row's reachability marker: last-known is never "online". */
export function neighborStatus(peer = {}) {
  if (peer.stale === true) return { text: "最后已知", tone: "warn" };
  if (peer.online === true) return { text: "在线", tone: "good" };
  if (peer.online === false) return { text: "离线", tone: "warn" };
  return null;
}
