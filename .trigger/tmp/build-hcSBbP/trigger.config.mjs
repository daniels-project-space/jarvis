import {
  defineConfig
} from "./chunk-UWUGKQYD.mjs";
import "./chunk-35EY4FVJ.mjs";
import "./chunk-63QJXTJT.mjs";
import "./chunk-KCQUMA6A.mjs";
import "./chunk-NIYKPRZ7.mjs";
import "./chunk-5F2UBCFF.mjs";
import {
  init_esm
} from "./chunk-J4P35T43.mjs";

// trigger.config.ts
init_esm();
var trigger_config_default = defineConfig({
  project: process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_wjwbdgeipgpddvrazxnp",
  runtime: "node",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  build: {}
});
var resolveEnvVars = void 0;
export {
  trigger_config_default as default,
  resolveEnvVars
};
//# sourceMappingURL=trigger.config.mjs.map
