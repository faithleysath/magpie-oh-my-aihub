// The provider side: who asked, who is approved, who was revoked
// (DESIGN-V2 §7.2).
//
// Approving does not hand out a budget: the grant is a model list, and the money
// is the consumer's deposit at this address. Stage 3 has no chain observer, so a
// fresh approval is always `waiting-deposit` and no key leaves the node — that is
// the expected behaviour, not a failure.
//
// A key secret is never part of any answer here. The only place it appears is the
// provider→consumer poll response (`GET /request`), which is where it belongs.

import { cleanModelList } from "../grants.ts";
import { logger } from "../log.ts";
import { getRuntime } from "../runtime.ts";
import { jsonText, objectArgs, optionalString, requiredAddress, type ToolDef } from "./types.ts";

export const consumersTool: ToolDef = {
  description:
    "列出本节点的消费者：地址、已批准/申请的模型、余额、已用、剩余和状态（pending / waiting-deposit / active / revoked）。" +
    "unclaimed 是有入账但还没申请访问的地址。不返回任何 Key。",
  args: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const runtime = await getRuntime();
    return jsonText(await runtime.grants.listing({ usage: true }));
  },
};

export const approveRequestTool: ToolDef = {
  description:
    "批准一个申请（或改模型）：只保留当前已共享且有价格的模型，空结果报 E_INPUT。" +
    "余额 ≥ $0.0001 时同时签发/更新 Gateway Key（cap = 余额）；余额为 0 时只记录批准，状态 waiting-deposit。" +
    "省略 models 时用申请里的模型。",
  args: {
    type: "object",
    properties: {
      address: { type: "string", description: "申请方的钱包地址（0x…）" },
      models: {
        type: "array",
        items: { type: "string" },
        description: "要批准的模型子集；省略时用申请里的列表",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const address = requiredAddress(args, "address");
    const models = args.models === undefined || args.models === null ? undefined : cleanModelList(args.models);
    const runtime = await getRuntime();
    const result = await runtime.grants.approve(address, models);
    return jsonText({
      address: result.address,
      grantedModels: result.grantedModels,
      state: result.state,
      keyIssued: result.keyIssued,
    });
  },
};

export const rejectRequestTool: ToolDef = {
  description:
    "拒绝一个还没批准的申请（状态变 revoked）。已经批准过的地址要用 revoke_consumer，它会同时删除 Gateway Key。" +
    "note 只写日志，不进入状态。",
  args: {
    type: "object",
    properties: {
      address: { type: "string", description: "申请方的钱包地址（0x…）" },
      note: { type: "string", description: "可选的备注，只写进本地日志" },
    },
    required: ["address"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const address = requiredAddress(args, "address");
    const note = optionalString(args, "note", 200, "note");
    const runtime = await getRuntime();
    const result = await runtime.grants.reject(address);
    if (note) logger.info(`reject ${address}: ${note}`);
    return jsonText(result);
  },
};

export const revokeConsumerTool: ToolDef = {
  description:
    "撤销一个消费者：删掉 Magpie 里的 Gateway Key（失败时用 rotate 兜底），保留账目。" +
    "返回 keyRemoved / rotated 说明真实结果；重新批准会签发新 Key，对方向 connect_provider 再取一次即可。",
  args: {
    type: "object",
    properties: {
      address: { type: "string", description: "消费者的钱包地址（0x…）" },
    },
    required: ["address"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const address = requiredAddress(args, "address");
    const runtime = await getRuntime();
    const result = await runtime.grants.revoke(address);
    if (!result.keyRemoved && !result.rotated) {
      logger.warn(`revoke ${address}: ${result.detail ?? "the key could not be removed"}`);
    }
    return jsonText(result);
  },
};
