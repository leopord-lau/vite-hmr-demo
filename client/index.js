let heartBeat;
const ws = new WebSocket("http://localhost:3000/");
ws.addEventListener("open", () => {
  heartBeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "heartBeat",
        })
      );
    } else {
      heartBeat && clearInterval(heartBeat);
      heartBeat = null;
    }
  }, 30000);
});
ws.addEventListener("message", function ({ data }) {
  data = JSON.parse(data);
  if (data.type === "full-reload") {
    setTimeout(() => {
      location.reload();
    }, 50);
  } else if (data.type === "hmr") {
    data.updates.forEach(async (update) => {
      hmrClient.fetchUpdate(update);
    });
  } else if (data.type === "prune") {
    hmrClient.prune(data.paths);
  }
});
ws.addEventListener("close", () => {
  if (heartBeat) {
    clearInterval(heartBeat);
    heartBeat = null;
  }
});

const hmrClient = {
  hotModulesMap: new Map(),
  pruneMap: new Map(),
  dataMap: new Map(),
  importUpdateModules: async (update) => {
    return await import(
      `${
        ".." +
        update.acceptedPath +
        (update.timestamp ? "?t=" + update.timestamp : "")
      }`
    );
  },
  async fetchUpdate(update) {
    try {
      const fetchModule = await hmrClient.importUpdateModules(update);
      const mod = hmrClient.hotModulesMap.get(update.path);
      if (!mod) {
        return;
      }
      const data = mod.deps.map((dep) => {
        if (ensureRelative(dep) === ensureRelative(update.acceptedPath)) {
          return fetchModule;
        } else {
          return undefined;
        }
      });
      mod.callback && mod.callback(...data);
    } catch (e) {
      console.error(e.message);
      console.error("hmr update fail.");
    }
  },
  prune(paths) {
    paths.forEach((path) => {
      const fn = hmrClient.pruneMap.get(path);
      if (fn) {
        fn();
      }
    });
  },
};

function ensureRelative(url) {
  if (url.indexOf(".") !== 0) {
    return "." + url;
  } else {
    return url;
  }
}

export function createHMRContext(src) {
  const mod = hmrClient.hotModulesMap.get(src);
  // 删除上一个文件内的监听
  if (mod) {
    mod.callback = null;
  }

  let context = {
    ownerPath: src,
    accept: function (deps, cb) {
      const mod = hmrClient.hotModulesMap.get(context.ownerPath) || {
        id: context.ownerPath,
        deps,
        callback: null,
      };
      mod.callback = cb;
      mod.deps = deps.length !== 0 ? deps : [context.ownerPath];
      hmrClient.hotModulesMap.set(context.ownerPath, mod);
    },
    invalidate() {
      ws.send(
        JSON.stringify({
          type: "invalidate",
          data: { path: context.ownerPath },
        })
      );
    },
    prune(cb) {
      hmrClient.pruneMap.set(context.ownerPath, cb);
    },
  };
  return context;
}

const sheetsMap = new Map();

let lastInsertedStyle;

export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-hmr-id", id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => {
        lastInsertedStyle = undefined;
      }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}

export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
