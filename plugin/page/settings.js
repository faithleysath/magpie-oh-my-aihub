/* The plugin page's settings maths, kept out of app.js so it can be tested.
 *
 * Magpie's bridge replaces this plugin's whole options object
 * (`magpie.options.set` → `plugin.SetOptions`, internal/plugin/store.go), and that
 * call restarts the plugin host. So the page must never send "the form": it sends
 * what it read plus the fields the operator actually changed, and it never sends
 * the network secret unless a new one was typed. Everything untouched — the
 * secret, `rpcPort`, `apiPort`, keys another version of this plugin wrote — is
 * carried over unchanged.
 *
 * Loaded as a plain <script> (CSP forbids inline scripts), and evaluated by
 * plugin/test/page-settings.test.ts.
 */
(function (root) {
  "use strict";

  /** The keys the first-run wizard may write. Everything else is CLI-owned. */
  var SEED_FIELDS = [
    "networkName",
    "networkSecret",
    "peers",
    "listenAddr",
    "secureMode",
    "sharingEnabled",
    "consumingEnabled",
  ];

  /** The overlay listen-address option, spelled once for the page and the host. */
  var LISTEN_KEY = "listenAddr";

  /** The page's own preferences: stored in plugins.json, applied by this page. */
  var PREF_FIELDS = ["pagePrefs"];

  function canonical(value) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    var keys = Object.keys(value)
      .filter(function (k) {
        return value[k] !== undefined;
      })
      .sort();
    return (
      "{" +
      keys
        .map(function (k) {
          return JSON.stringify(k) + ":" + canonical(value[k]);
        })
        .join(",") +
      "}"
    );
  }

  function same(a, b) {
    return canonical(a) === canonical(b);
  }

  function text(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  function list(text_) {
    var s = text(text_);
    if (!s) return [];
    var out = [];
    s.split(/[\s,]+/).forEach(function (part) {
      var p = part.trim();
      if (p && out.indexOf(p) < 0) out.push(p);
    });
    return out;
  }

  function portList(text_) {
    var out = [];
    list(text_).forEach(function (p) {
      var n = Number(p);
      if (n % 1 === 0 && n > 0 && n < 65536 && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  /** What the operator typed, as options values. Empty strings mean "no value". */
  function draftToOptions(draft) {
    var out = {};
    if (!draft || typeof draft !== "object") return out;
    if (draft.networkName !== undefined) out.networkName = text(draft.networkName);
    if (draft.networkSecret !== undefined) out.networkSecret = typeof draft.networkSecret === "string" ? draft.networkSecret : "";
    if (draft.peers !== undefined) out.peers = Array.isArray(draft.peers) ? draft.peers : list(draft.peers);
    if (draft[LISTEN_KEY] !== undefined) out[LISTEN_KEY] = text(draft[LISTEN_KEY]) || null;
    if (draft.secureMode !== undefined) out.secureMode = Boolean(draft.secureMode);
    if (draft.sharingEnabled !== undefined) out.sharingEnabled = Boolean(draft.sharingEnabled);
    if (draft.consumingEnabled !== undefined) out.consumingEnabled = Boolean(draft.consumingEnabled);
    if (draft.publishedPorts !== undefined) {
      out.publishedPorts = Array.isArray(draft.publishedPorts) ? draft.publishedPorts : portList(draft.publishedPorts);
    }
    if (draft.shareModels !== undefined) {
      out.shareModels = Array.isArray(draft.shareModels) ? draft.shareModels : list(draft.shareModels);
    }
    if (draft.pagePrefs !== undefined && draft.pagePrefs && typeof draft.pagePrefs === "object") {
      var prefs = {};
      if (typeof draft.pagePrefs.showAdvanced === "boolean") prefs.showAdvanced = draft.pagePrefs.showAdvanced;
      out.pagePrefs = prefs;
    }
    return out;
  }

  /**
   * The options object to send, and the keys that actually changed.
   *
   * - `base` is exactly what `magpie.options.get()` answered (unknown keys and
   *   all), so every key this page does not own survives untouched.
   * - an empty network secret means "keep the stored one": it is never sent as
   *   "", which is what used to erase a saved secret on a later save.
   * - a field whose value is unchanged is not sent at all.
   */
  function mergeSaved(base, draft) {
    var from = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    var merged = {};
    Object.keys(from).forEach(function (k) {
      merged[k] = from[k];
    });
    var wanted = draftToOptions(draft);
    var changed = [];
    Object.keys(wanted).forEach(function (k) {
      var value = wanted[k];
      if (k === "networkSecret") {
        var secret = typeof value === "string" ? value : "";
        if (!secret) return; // untouched: keep whatever is stored
        if (!same(secret, from.networkSecret)) {
          merged.networkSecret = secret;
          changed.push(k);
        }
        return;
      }
      if (k === "networkName" && !value) return; // blank is not a rename
      if (k === "pagePrefs") {
        var next = {};
        var prevPrefs = from.pagePrefs && typeof from.pagePrefs === "object" ? from.pagePrefs : {};
        Object.keys(prevPrefs).forEach(function (p) {
          next[p] = prevPrefs[p];
        });
        Object.keys(value).forEach(function (p) {
          next[p] = value[p];
        });
        if (!same(next, prevPrefs)) {
          merged.pagePrefs = next;
          changed.push(k);
        }
        return;
      }
      if (!same(value, from[k])) {
        merged[k] = value;
        changed.push(k);
      }
    });
    changed.sort();
    return { merged: merged, changed: changed };
  }

  /**
   * The keys that differ between two merged options objects. The page compares the
   * form as it is now with the form as it was filled, so a fresh form is not
   * "dirty" just because the host's defaults are not in plugins.json yet.
   */
  function changedBetween(previous, next) {
    var a = previous && typeof previous === "object" ? previous : {};
    var b = next && typeof next === "object" ? next : {};
    var keys = Object.keys(a).concat(
      Object.keys(b).filter(function (k) {
        return Object.keys(a).indexOf(k) < 0;
      }),
    );
    var changed = [];
    keys.forEach(function (k) {
      if (!same(a[k], b[k])) changed.push(k);
    });
    return changed.sort();
  }

  /** true when these options could seed a brand-new node. */
  function seedReady(options) {
    var o = options || {};
    return text(o.networkName).length >= 2 && String(o.networkSecret || "").trim().length >= 8;
  }

  var api = {
    SEED_FIELDS: SEED_FIELDS,
    LISTEN_KEY: LISTEN_KEY,
    PREF_FIELDS: PREF_FIELDS,
    canonical: canonical,
    same: same,
    list: list,
    portList: portList,
    draftToOptions: draftToOptions,
    mergeSaved: mergeSaved,
    changedBetween: changedBetween,
    seedReady: seedReady,
  };

  root.OHMYAIHUB_SETTINGS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
