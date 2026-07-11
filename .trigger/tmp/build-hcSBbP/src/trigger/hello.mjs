import {
  task
} from "../../chunk-UWUGKQYD.mjs";
import "../../chunk-35EY4FVJ.mjs";
import "../../chunk-63QJXTJT.mjs";
import "../../chunk-KCQUMA6A.mjs";
import "../../chunk-NIYKPRZ7.mjs";
import "../../chunk-5F2UBCFF.mjs";
import {
  __name,
  init_esm
} from "../../chunk-J4P35T43.mjs";

// src/trigger/hello.ts
init_esm();
var hello = task({
  id: "hello",
  run: /* @__PURE__ */ __name(async (payload) => {
    return { greeting: `JARVIS online, ${payload?.name ?? "sir"}.`, at: (/* @__PURE__ */ new Date()).toISOString() };
  }, "run")
});
export {
  hello
};
//# sourceMappingURL=hello.mjs.map
