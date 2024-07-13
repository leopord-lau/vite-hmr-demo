// 此文件是自我接受模块，在更新了 value 之后，只会重新加载当前的文件
// 但是由于 value 是被导出去的，存在副作用，如果更改的是 value 值，文件本身是无法处理的。
// 需要调用 invalidate，强行让导入者处理
export const value = "immutable";

import.meta.hot.accept([], function (module) {
  if (module.value !== "immutable") {
    import.meta.hot.invalidate();
  }
});
