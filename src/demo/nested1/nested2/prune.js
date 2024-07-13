export const prune = "prune.js";

let num = 0;
let interval = setInterval(() => {
  console.log(num++);
}, 5000);

globalThis.message = "global message from invalidate.js";

import.meta.hot.prune(() => {
  clearInterval(interval);
  delete globalThis.message;
  console.log("prune");
});
