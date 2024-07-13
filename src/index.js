export * from "./demo/nested1/index.js";
export * from "./demo/nested1/selfAccepted.js";

import.meta.hot.accept(
  ["./demo/nested1/index.js", "./demo/nested1/selfAccepted.js"],
  (index1Module, selfAcceptedModule, index2Module) => {
    console.log("accepted by index.js");
  }
);
