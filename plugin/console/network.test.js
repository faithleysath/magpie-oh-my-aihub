// The network page's read-only labels are pure, so the "never present stale
// facts as live" rule is tested without a DOM, a fetch mock or a browser.

import { describe, expect, test } from "bun:test";
import { neighborStatus, networkFacts } from "./network.js";

const network = (over = {}) => ({
  state: "failed",
  evidence: { readAt: "2026-10-31T00:00:00.000Z", stale: true, live: false, staleMs: 600_000 },
  core: { running: false, version: "2.6.4", state: "failed", lastError: "refusing to serve: unproven core" },
  thisNode: { hostname: "node-1", virtualIpv4: "10.126.126.1", networkName: "studio-ai", stale: true, observedAt: "2026-10-31T00:00:00.000Z" },
  ...over,
});

const values = (facts) => Object.fromEntries(facts.rows);

describe("network facts never claim a stopped core is live", () => {
  test("a stopped core labels identity, version and evidence as last known", () => {
    const facts = networkFacts(network(), { running: false }, { networkName: "studio-ai" }, (iso) => `at ${iso}`);
    const row = values(facts);
    expect(facts.stale).toBe(true);
    expect(row["虚拟地址"]).toBe("10.126.126.1（最后已知）");
    expect(row["网络引擎"]).toBe("EasyTier 2.6.4 · 已停止（最后已知版本）");
    expect(row["本机节点名"]).toBe("node-1（最后已知）");
    expect(row["状态证据"]).toContain("最后已知，非实时");
    expect(row["状态证据"]).toContain("600 秒前");
  });

  test("a configured but never-read address is not presented as assigned", () => {
    const facts = networkFacts(
      network({ thisNode: { hostname: null, virtualIpv4: null, networkName: "studio-ai", stale: false }, evidence: { readAt: null, stale: false }, core: { running: false, version: null } }),
      {},
      { networkName: "studio-ai", virtualIpv4: "10.77.0.9/24" },
      () => "",
    );
    const row = values(facts);
    expect(row["虚拟地址"]).toBe("10.77.0.9/24（配置值，未在线确认）");
    expect(row["网络引擎"]).toBe("未运行");
    expect(row["状态证据"]).toBe("尚未读取");
  });

  test("a fresh read is not labelled last-known", () => {
    const facts = networkFacts(
      network({ evidence: { readAt: "2026-10-31T00:00:00.000Z", stale: false, live: true, staleMs: 2_000 }, thisNode: { hostname: "node-1", virtualIpv4: "10.126.126.1", networkName: "studio-ai", stale: false }, core: { running: true, version: "2.6.4" } }),
      { running: true },
      {},
      () => "at now",
    );
    const row = values(facts);
    expect(row["虚拟地址"]).toBe("10.126.126.1");
    expect(row["网络引擎"]).toBe("EasyTier 2.6.4 · no-TUN");
    expect(row["状态证据"]).not.toContain("最后已知");
  });
});

describe("neighbour markers never upgrade a stale row to online", () => {
  test("stale wins over online, unknown has no marker", () => {
    expect(neighborStatus({ stale: true, online: true })).toEqual({ text: "最后已知", tone: "warn" });
    expect(neighborStatus({ stale: false, online: true })).toEqual({ text: "在线", tone: "good" });
    expect(neighborStatus({ stale: false, online: false })).toEqual({ text: "离线", tone: "warn" });
    expect(neighborStatus({ stale: false, online: null })).toBeNull();
    expect(neighborStatus({})).toBeNull();
  });
});
