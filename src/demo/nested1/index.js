import { filename as file1 } from "./nested2/file1.js";
import { filename as file2 } from "./nested2/file2.js";
import { value } from "./nested2/invalidate.js";
import { prune } from "./nested2/prune.js";
import "../../index.css";

let dom = document.querySelector(".invalidate");
if (!dom) {
  dom = document.createElement("div");
  dom.className = "invalidate";
  dom.style = "font-size: 32px";
  dom.innerText = value;
  document.body.appendChild(dom);
} else {
  dom.innerText = value;
}

// 接收两个文件的变更，哪个文件更改，回调函数中的参数才会有值
import.meta.hot.accept(
  ["./nested2/file1.js", "./nested2/file2.js", "./nested2/invalidate.js"],
  (file1Module, file2Module, invalidateModule) => {
    console.log("accepted by nested1/index.js");
  }
);
