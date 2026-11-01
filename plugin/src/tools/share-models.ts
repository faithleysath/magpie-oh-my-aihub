// share_models: choose which native models this node publishes, then re-sign the
// directory in memory. No `publish` step and no core restart: the Forward ACL
// already allows 3426 and 3425 for the life of the export.

import { writeConfig } from "../config.ts";
import { getRuntime } from "../runtime.ts";
import { CATALOG_MAX_MODEL_ID, type CatalogModel } from "../catalog-service.ts";
import { listNativeModels } from "./native-models.ts";
import { fail, jsonText, objectArgs, type ToolDef } from "./types.ts";

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) fail("E_INPUT", "models must be an array of model ids");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") fail("E_INPUT", "every entry of models must be a string");
    const id = item.trim();
    if (!id) fail("E_INPUT", "model ids must not be empty");
    if (id.length > CATALOG_MAX_MODEL_ID) fail("E_INPUT", `model id is longer than ${CATALOG_MAX_MODEL_ID} characters`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export const shareModelsTool: ToolDef = {
  description:
    "选择要对本网络共享的原生模型（空数组 = 不共享）。只接受 native_models 里 shareable 的模型；" +
    "写好选择后立刻重签目录，不重启 EasyTier。返回实际公布的模型、目录时间戳和目录服务是否在监听。",
  args: {
    type: "object",
    properties: {
      models: {
        type: "array",
        items: { type: "string" },
        description: "要共享的模型 id，必须是 native_models 里 shareable:true 的项；[] 表示不共享",
      },
    },
    required: ["models"],
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const ids = modelIds(args.models);

    // Magpie unavailability throws E_MAGPIE before anything is written.
    const native = await listNativeModels();
    const shareable = new Map(native.filter((model) => model.shareable).map((model) => [model.id, model]));
    for (const id of ids) {
      if (!shareable.has(id)) fail("E_INPUT", `${id} is not a native priced model`);
    }
    const selected: CatalogModel[] = ids.map((id) => ({
      id,
      price: shareable.get(id)!.price!,
    }));

    const runtime = await getRuntime();
    const next = { ...runtime.config, share: { models: ids } };
    try {
      writeConfig(next);
    } catch (error) {
      fail("E_PATH", `cannot write state.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    runtime.config = next;

    const doc = await runtime.catalog.update(selected);
    return jsonText({
      models: doc.models,
      catalogTs: doc.ts,
      published: runtime.server.listening,
    });
  },
};
