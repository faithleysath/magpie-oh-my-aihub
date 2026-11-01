// The address book tool: name an address once, use the name everywhere after.
//
// The value of this tool is that the other 8 tools that take a counterparty
// address accept these aliases (see `resolve.ts`), so an agent never has to ask
// for a 0x string twice. It stores nothing on the wire and nothing signed: the
// aliases live only in this node's ledger.

import {
  deleteContactByAlias,
  deleteContactsByAddress,
  listContacts,
  saveContact,
} from "../contacts.ts";
import { getRuntime } from "../runtime.ts";
import {
  fail,
  isAddress,
  jsonText,
  objectArgs,
  optionalString,
  requiredAddress,
  requiredString,
  type ToolDef,
} from "./types.ts";

export const contactsTool: ToolDef = {
  description:
    "本机地址簿：给钱包地址起名字。之后 send_payment 的 to、request_access / connect_provider / " +
    "disconnect_provider 的 provider、approve_request / reject_request / revoke_consumer 的 address、" +
    "history 的 address，都可以直接用名字代替 0x。action=list（默认）列出全部；add 需要 alias 和 address，" +
    "可选 note，同名重写会改指向并返回 previousAddress（省略 note 则保留原备注）；remove 接受 alias，或直接给地址删掉它的全部别名。" +
    "名字只是本机便利：不进签名、不进目录、不参与授权、不是转账白名单。",
  args: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove"], description: "默认 list" },
      alias: { type: "string", description: "名字，不区分大小写，例如 张三" },
      address: { type: "string", description: "0x… 钱包地址：add 必填，remove 可以用它代替 alias" },
      note: { type: "string", description: "可选备注，例如“提供方 · Base”" },
    },
    additionalProperties: false,
  },
  async execute(rawArgs) {
    const args = objectArgs(rawArgs);
    const action = (optionalString(args, "action", 16) ?? "list").toLowerCase();
    const runtime = await getRuntime();

    if (action === "list") {
      return jsonText({ contacts: listContacts(runtime.db) });
    }

    if (action === "add") {
      const alias = requiredString(args, "alias", 64);
      const address = requiredAddress(args, "address");
      const note = optionalString(args, "note", 200);
      const saved = saveContact(runtime.db, { alias, address, ...(note ? { note } : {}) });
      return jsonText({
        state: saved.previousAddress ? "repointed" : "saved",
        ...saved.contact,
        previousAddress: saved.previousAddress,
      });
    }

    if (action === "remove") {
      const rawAlias = args.alias;
      const rawAddress = args.address;
      const target =
        typeof rawAlias === "string" && rawAlias.trim()
          ? rawAlias
          : typeof rawAddress === "string" && rawAddress.trim()
            ? rawAddress
            : null;
      if (!target) fail("E_INPUT", "remove needs alias or address");
      if (isAddress(target)) {
        const removed = deleteContactsByAddress(runtime.db, target);
        if (removed.length === 0) fail("E_INPUT", `no contact has the address ${target.trim().toLowerCase()}`);
        return jsonText({ state: "removed", removed });
      }
      const removed = deleteContactByAlias(runtime.db, target);
      if (!removed) fail("E_INPUT", `no contact is named ${target.trim()}`);
      return jsonText({ state: "removed", removed: [removed] });
    }

    fail("E_INPUT", `action must be "list", "add" or "remove", got "${action}"`);
  },
};
