// The provider side: who asked, who is approved, who was revoked.
//
// Approving does not hand out a budget: the grant is a model list, and the money
// is the consumer's deposit at this address. A fresh approval with no deposit is
// `waiting-deposit`; the chain observer issues the key when the first deposit is
// confirmed.
//
// A key secret is never part of any answer here. The only place it appears is the
// provider→consumer poll response (`GET /request`), which is where it belongs.

import { cleanModelList } from "../grants.ts";
import { logger } from "../log.ts";
import { getRuntime } from "../runtime.ts";
import { jsonText, objectArgs, optionalString, requiredString, type ToolDef } from "./types.ts";
import { resolveTarget } from "./resolve.ts";

export const consumersTool: ToolDef = {
  description:
    "列出本节点的消费者：地址、已批准/申请的模型、余额、已用、剩余和状态（pending / waiting-deposit / active / revoked）。" +
    "payersWithoutGrant 是有入账但没有可用授权的付款方（没申请过 / 待批准 / 被拒 / 被撤销后又打了钱），" +
    "带地址簿里的名字（name，可能为 null）。不返回任何 Key。",
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
    "省略 models 时用申请里的模型。批准是整份替换、不是追加：这次列表里没有的模型会被撤掉，返回在 droppedModels 里。",
  args: {
    type: "object",
    properties: {
      address: { type: "string", description: "申请方地址：0x…，或地址簿里的名字" },
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
    const address = await resolveTarget(requiredString(args, "address", 64), "address");
    const models = args.models === undefined || args.models === null ? undefined : cleanModelList(args.models);
    const runtime = await getRuntime();
    const result = await runtime.grants.approve(address, models);
    return jsonText({
      address: result.address,
      grantedModels: result.grantedModels,
      // An approval replaces the grant: a model left out of the list is taken
      // away, and this field is the only place that says so.
      droppedModels: result.droppedModels,
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
      address: { type: "string", description: "申请方地址：0x…，或地址簿里的名字" },
      note: { type: "string", description: "可选的备注，只写进本地日志" },
    },
    required: ["address"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const address = await resolveTarget(requiredString(args, "address", 64), "address");
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
      address: { type: "string", description: "消费者地址：0x…，或地址簿里的名字" },
    },
    required: ["address"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const address = await resolveTarget(requiredString(args, "address", 64), "address");
    const runtime = await getRuntime();
    const result = await runtime.grants.revoke(address);
    if (!result.keyRemoved && !result.rotated) {
      logger.warn(`revoke ${address}: ${result.detail ?? "the key could not be removed"}`);
    }
    return jsonText(result);
  },
};
