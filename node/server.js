import sirv from "sirv";
import connect from "connect";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import esbuild from "esbuild";
import { scan, scanTransform } from "./scan.js";

export const moduleGraph = new Map();
export const idToModuleMap = new Map();
export const urlToModuleMap = new Map();
const postfixRE = /[?#].*$/s;
export function cleanUrl(url) {
  return url.replace(postfixRE, "");
}

function getUrlTimestamp(url) {
  return url.match(/\bt=(\d{13})\b/)?.[1];
}

function handleHMRUpdate(filePath) {
  const moduleNode = idToModuleMap.get(filePath);
  if (!moduleNode) {
    return;
  }
  updateModules([moduleNode], Date.now());
}

function invalidateModule(mod, processed, timestamp) {
  mod.lastModifyTimestamp = mod.modifyTimestamp;
  mod.modifyTimestamp = timestamp;
  mod.content = "";
  if (processed.has(mod)) {
    return;
  }
  processed.add(mod);
  mod.importers.forEach((importer) => {
    if (!importer.acceptedHmrDeps.has(mod)) {
      invalidateModule(importer, processed, timestamp);
    } else {
      importer.lastModifyTimestamp = importer.modifyTimestamp;
      importer.modifyTimestamp = timestamp;
      importer.content = "";
      processed.add(importer);
    }
  });
}
function propagateUpdate(
  module,
  traversedModules,
  boundaries,
  moduleChain = [module]
) {
  if (traversedModules.has(module)) {
    return false;
  }
  traversedModules.add(module);

  if (module.isSelfAccepting) {
    boundaries.push({ boundary: module, acceptedVia: module });
    return false;
  }
  if (!module.importers.size) {
    return true;
  }

  for (const parentModule of module.importers) {
    const subChain = moduleChain.concat(parentModule);
    if (parentModule.acceptedHmrDeps.has(module)) {
      boundaries.push({ boundary: parentModule, acceptedVia: module });
      continue;
    }

    if (
      !moduleChain.includes(parentModule) &&
      propagateUpdate(parentModule, traversedModules, boundaries, subChain)
    ) {
      return true;
    }
  }
  return false;
}

function updateModules(modules, timestamp) {
  const updates = [];
  const traversedModules = new Set();
  const processed = new Set();
  for (const mod of modules) {
    invalidateModule(mod, processed, timestamp);
    const boundaries = [];
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries);

    if (hasDeadEnd) {
      socketMap.forEach((socket) => {
        socket.send({
          type: "full-reload",
        });
      });
      return;
    }
    updates.push(
      ...boundaries.map(({ boundary, acceptedVia }) => ({
        type: "js-update",
        path: boundary.url,
        acceptedPath: acceptedVia.url,
        timestamp: timestamp,
      }))
    );
  }

  if (updates.length === 0) {
    return;
  }
  socketMap.forEach((socket) => {
    socket.send({
      type: "hmr",
      updates,
    });
  });
}

export async function transform(path, url) {
  const moduleNode = idToModuleMap.get(path);
  const timestamp = getUrlTimestamp(url);
  // 从内存中获取
  if (timestamp === moduleNode.lastModifyTimestamp && moduleNode.content) {
    return moduleNode.content;
  }
  moduleNode.url = cleanUrl(url);
  urlToModuleMap.set(url, moduleNode);
  const result = await scanTransform(path);
  return result?.contents;
}

const middleware = connect();
const server = createServer(middleware);
const ws = new WebSocketServer({ noServer: true });
export const socketMap = new Map();

async function scanDependence() {
  const result = await esbuild.context({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `import './src/index.js'`,
      loader: "js",
      resolveDir: "./",
    },
    write: false,
    bundle: true,
    format: "esm",
    plugins: [scan()],
    outdir: "bundle",
  });
  return new Promise((resolve) => {
    result.rebuild().then(resolve);
  });
}
function getSocketClient(socket) {
  if (!socketMap.get(socket)) {
    socketMap.set(socket, {
      send: (...args) => {
        let payload;
        if (typeof args[0] === "string") {
          payload = {
            type: "custom",
            event: args[0],
            data: args[1],
          };
        } else {
          payload = args[0];
        }
        socket.send(JSON.stringify(payload));
      },
      socket,
    });
  }
  return socketMap.get(socket);
}

server.on("upgrade", (req, socket, head) => {
  ws.handleUpgrade(req, socket, head, (client) => {
    ws.emit("connection", client, req);
  });
});

ws.on("connection", (socket) => {
  getSocketClient(socket);
  socket.on("message", (rawData) => {
    const message = JSON.parse(rawData);
    if (message.type === "invalidate") {
      const moduleNode = urlToModuleMap.get(message.data.path);
      updateModules([...moduleNode.importers], moduleNode.modifyTimestamp);
    }
  });
  socket.on("error", (err) => {
    console.error(`websocket connect err \n ${err.stack}`);
  });
  socket.on("close", (err) => {
    socketMap.delete(socket);
  });

  socket.send(JSON.stringify({ type: "connected" }));
});
ws.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(`websocket server error: Post is already in use`);
  } else {
    console.error(`websocket socket error: \n ${e.stack} `);
  }
});

middleware.use(async (req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }
  if (req.url === "/" || req.url === "/index.html") {
    req.url = "/src/index.html";
  }
  next();
});

middleware.use(async (req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }
  req.url = cleanUrl(req.url);

  if (req.url.endsWith(".html")) {
    const filePath = fileURLToPath(
      new URL(".." + req.url.slice(0), import.meta.url)
    );
    const code = await fs.readFile(filePath, "utf-8");
    return res.end(code);
  } else if (req.url.endsWith(".js") || req.url.endsWith(".css")) {
    if (req.url === "/client/index.js") {
      req.url = "/index.js";
      return next();
    }

    const filePath = fileURLToPath(
      new URL(
        "." + (req.url.indexOf("src") > -1 ? "" : "./src") + req.url.slice(0),
        import.meta.url
      )
    ).replaceAll("\\", "/");
    const code = await transform(filePath, req.url);
    if (code) {
      res.setHeader("Content-Type", "application/javascript");
      return res.end(code);
    }
    return next();
  }
  return next();
});

middleware.use(sirv("./client"));
middleware.use(sirv("./src"));
middleware.use(sirv());

// 只监听src目录
const watcher = chokidar.watch("./src/");
watcher.on("change", (file) => {
  setTimeout(() => {
    if (file === "src\\index.html") {
      socketMap.forEach((socket) => {
        socket.send({ type: "full-reload" });
      });
    } else {
      const filePath = fileURLToPath(
        new URL("../" + file, import.meta.url)
      ).replaceAll("\\", "/");
      handleHMRUpdate(filePath);
    }
  }, 1000);
});

const onFileAddUnlink = async (file, isUnlink) => {
  const absolutePath = fileURLToPath(
    new URL("../" + file, import.meta.url)
  ).replaceAll("\\", "/");
  let mod = idToModuleMap.get(absolutePath);
  if (isUnlink) {
    if (mod) {
      for (let importedModules of mod.importedModules) {
        importedModules.importers.delete(mod);
      }
      updateModules([mod], Date.now());
    }
  }
};

server.listen(3000, async () => {
  await scanDependence();
  console.log("server start at localhost:3000");
  watcher.on("add", async (file) => {
    onFileAddUnlink(file, false);
  });
  watcher.on("unlink", async (file) => {
    onFileAddUnlink(file, true);
  });
});
