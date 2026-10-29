#!/usr/bin/env bun
// Boots the plugin host exactly the way Magpie does: import the entry, call its
// default export. Used by the phase-4 lab so the lab exercises the shipped code
// path (lock, API, supervisor, provisioner), not a test double.
//
//   OH_MY_AIHUB_MAGPIE=/path/to/magpie MAGPIE_ADDR=192.0.2.1:34001 \
//     bun host.ts            # cwd must be the instance's Magpie config dir
import { boot } from "../../../../plugin/src/index.ts";

const running = await boot({}, {});
void running;
