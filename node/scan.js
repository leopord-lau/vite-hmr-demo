import { cleanUrl, idToModuleMap, moduleGraph, socketMap } from "./server.js";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import fs from "node:fs/promises";
import { init, parse as parseImports } from "es-module-lexer";
import MagicString from "magic-string";

export function getModuleNode(path) {
  if (!moduleGraph.get(path)) {
    moduleGraph.set(path, {
      id: "",
      url: "",
      importedModules: new Map(),
      content: null,
      importers: new Set(),
      acceptedHmrDeps: new Set(),
      isSelfAccepting: false,
      lastModifyTimestamp: null,
      modifyTimestamp: null,
    });
  }
  return moduleGraph.get(path);
}

export function scan() {
  return {
    name: "dep-scan",
    setup(build) {
      build.onResolve({ filter: /.js/ }, async ({ path, importer }) => {
        if (importer === "<stdin>") {
          const moduleNode = getModuleNode(path);
          moduleNode.id = fileURLToPath(
            new URL("../" + path, import.meta.url)
          ).replaceAll("\\", "/");
          idToModuleMap.set(moduleNode.id, moduleNode);
        }
      });
      // 提前扫描需要处理得文件
      build.onLoad({ filter: /.js/ }, async function (module) {
        module.path = module.path.replaceAll("\\", "/");
        scanTransform(module.path);
      });
    },
  };
}

function findStartIndex(start, file) {
  const matchDepsStart = /(\([\n\r\s]*\[)+/;
  const result = matchDepsStart.exec(file);
  if (result[1]) {
    return start + result[1].length;
  } else {
    return start;
  }
}

export async function scanTransform(path) {
  let file;
  try {
    file = await fs.readFile(path, "utf-8");
  } catch (e) {
    console.error(`read file ${path} fail`);
    process.exit(0);
  }
  let s = new MagicString(file);
  await init;
  let imports = [];
  let exports = [];
  try {
    [imports, exports] = parseImports(file);
  } catch (e) {
    console.error(`file ${path} parse error`);
    process.exit(0);
  }
  const moduleNode = idToModuleMap.get(path);
  if (!imports.length) {
    moduleNode && (() => (moduleNode.isSelfAccepting = false));
    return {
      contents: file,
      loader: "js",
    };
  }
  let importedUrls = [];
  await Promise.all(
    imports.map(async (importSpecifier, index) => {
      const { s: start, e: end, n: specifier } = importSpecifier;
      let rawUrl = file.slice(start, end);
      if (rawUrl === "import.meta") {
        const prop = file.slice(end, end + 4);
        if (prop === ".hot") {
          // 可能携带了 ?
          const endHot = end + 4 + (file[end + 4] === "?" ? 1 : 0);
          if (file.slice(endHot, endHot + 7) === ".accept") {
            let start = findStartIndex(endHot + 7, file);
            let end = file.indexOf("]", endHot + 7);
            let acceptedHmrDeps;
            if (start === end) {
              moduleNode.isSelfAccepting = true;
              // 接收模块为自身的路径
              moduleNode.acceptedHmrDeps.add(moduleNode);
            } else {
              acceptedHmrDeps = file
                .slice(start, end)
                .replace(/[\'|"|`]/g, "")
                .split(",")
                .map((item) => {
                  const absoluteDepPath = getAbsolutePath(
                    item.trim(),
                    moduleNode.id
                  );
                  let mod = idToModuleMap.get(absoluteDepPath);
                  if (!mod) {
                    mod = getModuleNode(item.trim());
                    mod.id = absoluteDepPath;
                    idToModuleMap.set(absoluteDepPath, mod);
                  }
                  moduleNode.acceptedHmrDeps.add(mod);
                  return getRelativePath(path, item.trim());
                });
              const acceptedHmrDepsString = formString(acceptedHmrDeps);
              s.overwrite(start, end, acceptedHmrDepsString);
              moduleNode.isSelfAccepting = false;
            }
          }
        }
      }
      if (specifier) {
        rawUrl = cleanUrl(file.slice(start, end));
        importedUrls.push(rawUrl);
        const absoluteDepPath = getAbsolutePath(rawUrl.trim(), moduleNode.id);
        let mod = idToModuleMap.get(absoluteDepPath);
        if (!mod) {
          mod = getModuleNode(rawUrl.trim());
          mod.id = absoluteDepPath;
          idToModuleMap.set(absoluteDepPath, mod);
        }
        s.overwrite(
          start,
          end,
          getRelativePath(
            path,
            specifier + (mod.modifyTimestamp ? `?t=${mod.modifyTimestamp}` : "")
          )
        );
      }
    })
  );
  const pruneImportedUrls = updateModuleInfo(moduleNode, importedUrls);
  if (pruneImportedUrls.size) {
    socketMap.forEach((socket) => {
      socket.send({
        type: "prune",
        paths: [...pruneImportedUrls],
      });
    });
  }

  const contents =
    "import { createHMRContext } from '/client/index.js';\n" +
    `const hot = createHMRContext('${moduleNode.url}');\n` +
    `import.meta.hot = hot;\n` +
    s.toString();
  moduleNode.content = contents;
  return {
    contents,
    loader: "js",
  };
}

function updateModuleInfo(moduleNode, importedModules) {
  let preImportedNodes = moduleNode.importedModules;
  let nextImportedNodes = new Map();
  let noLongerImported = new Set();
  for (const url of importedModules) {
    if (!preImportedNodes.has(url)) {
      const importedAbsolutePath = getAbsolutePath(url, moduleNode.id);
      let newDiscovery = idToModuleMap.get(importedAbsolutePath);
      if (!newDiscovery) {
        newDiscovery = getModuleNode(url);
        newDiscovery.id = importedAbsolutePath;
        idToModuleMap.set(importedAbsolutePath, newDiscovery);
      }
      newDiscovery.importers.add(moduleNode);
      nextImportedNodes.set(url, newDiscovery);
    } else {
      nextImportedNodes.set(url, preImportedNodes.get(url));
    }
  }
  Array.from(preImportedNodes.keys()).forEach((dep) => {
    if (!nextImportedNodes.has(dep)) {
      const mod = preImportedNodes.get(dep);
      mod.importers.delete(moduleNode);
      if (!mod.importers.size) {
        noLongerImported.add(mod.url);
      }
    }
  });
  moduleNode.importedModules = nextImportedNodes;

  return noLongerImported;
}

function getAbsolutePath(relative, refer) {
  const path = fileURLToPath(new URL(relative, `file://${refer}`)).replaceAll(
    "\\",
    "/"
  );
  return path;
}

export function getDoubleDot(url) {
  const singleDot = /(\.\/)/g;
  if (url.match(singleDot)?.length === 1) {
    url = url.replace(singleDot, "../");
  }
  return url;
}

export function getRelativePath(url, relativeUrl) {
  relativeUrl = getDoubleDot(relativeUrl);
  const path = nodePath
    .relative(process.cwd(), nodePath.resolve(url, relativeUrl))
    .replaceAll("\\", "/")
    .replace(/^src/, "");
  return path;
}

function formString(arr) {
  let result = "";
  for (let i = 0; i < arr.length; ) {
    result += "'" + arr[i] + "'";
    i++;
    if (i < arr.length) {
      result += ",";
    }
  }
  return result;
}
