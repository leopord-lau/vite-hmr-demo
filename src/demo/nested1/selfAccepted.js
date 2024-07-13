export { filename } from "./nested2/file1.js";

console.log("self11");

// 这是一个自我接收模块，只会接收到自身文件的更改。
import.meta.hot.accept([], (module) => {
  console.log("accepted by demo/nested1/selfAccepted.js");
  console.log(module);
});
