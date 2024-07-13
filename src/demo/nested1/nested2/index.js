export { filename as file1 } from "./file1.js";
export { filename as file2 } from "./file2.js";
export const nested2 = "nested2/index.js";

// 虽然导入了两个文件，但是只接收 file1.js 的更改，file2.js 文件的更改不处理
import.meta.hot.accept(["./file1.js"], (file1Module) => {
  console.log("accepted by /nested1/nested2/index.js");
  console.log(newFile1);
});
