import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createOneTimeReload, createPwaManager, isUpdateBlocked } from "../js/pwa.js";

const rootUrl = new URL("../", import.meta.url);
const readText = (path) => readFile(new URL(path, rootUrl), "utf8");

function readPngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("Manifestは相対パスと必要なPWA設定を持ち、参照アイコンが存在する", async () => {
  const manifest = JSON.parse(await readText("manifest.webmanifest"));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "ja");
  assert.ok(manifest.name && manifest.short_name && manifest.description);
  assert.ok(manifest.background_color && manifest.theme_color);
  assert.equal(manifest.icons.length, 2);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\.\/icons\//);
    assert.equal(icon.type, "image/png");
    assert.match(icon.purpose, /maskable/);
    await stat(new URL(icon.src, rootUrl));
    const expected = Number(icon.sizes.split("x")[0]);
    assert.deepEqual(readPngSize(await readFile(new URL(icon.src, rootUrl))), { width: expected, height: expected });
  }
  assert.deepEqual(readPngSize(await readFile(new URL("icons/apple-touch-icon.png", rootUrl))), { width: 180, height: 180 });
});

test("index.htmlはManifest、アイコン、バージョンを相対参照する", async () => {
  const html = await readText("index.html");
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\.\/icons\/apple-touch-icon\.png"/);
  assert.match(html, /src="\.\/app-version\.js"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /name="apple-mobile-web-app-capable"/);
  assert.doesNotMatch(html, /(?:href|src)="\//);
  assert.ok(html.indexOf("./app-version.js") < html.indexOf("./js/app.js"));
});

test("Service Workerの事前キャッシュ対象はすべて存在する", async () => {
  const source = await readText("sw.js");
  const match = /const APP_SHELL = Object\.freeze\((\[[\s\S]*?\])\);/.exec(source);
  assert.ok(match, "APP_SHELLを解析できません");
  const shell = JSON.parse(match[1]);
  assert.ok(shell.includes("./index.html"));
  assert.ok(shell.includes("./manifest.webmanifest"));
  assert.ok(shell.includes("./js/pwa.js"));
  assert.ok(shell.includes("./js/alerts.js"));
  assert.ok(shell.includes("./js/backup.js"));
  assert.ok(shell.includes("./js/settings.js"));
  assert.ok(shell.includes("./js/wake-lock.js"));
  for (const path of shell) {
    assert.match(path, /^\.\//);
    await stat(path === "./" ? new URL("index.html", rootUrl) : new URL(path, rootUrl));
  }
});

test("Service Workerは手動更新、同一オリジンGET、古いキャッシュ削除に限定される", async () => {
  const source = await readText("sw.js");
  const installStart = source.indexOf('addEventListener("install"');
  const activateStart = source.indexOf('addEventListener("activate"');
  assert.ok(installStart >= 0 && activateStart > installStart);
  assert.doesNotMatch(source.slice(installStart, activateStart), /skipWaiting/);
  assert.match(source, /SKIP_WAITING/);
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /requestUrl\.origin !== self\.location\.origin/);
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.doesNotMatch(source, /indexedDB|localStorage|Notification|PushManager|wakeLock/);
});

test("アプリバージョンは画面とキャッシュの共通参照元に一致する", async () => {
  const versionSource = await readText("app-version.js");
  const version = /TIMEBOX_APP_VERSION = "([^"]+)"/.exec(versionSource)?.[1];
  const packageJson = JSON.parse(await readText("package.json"));
  const swSource = await readText("sw.js");
  assert.equal(version, "1.3.0");
  assert.equal(packageJson.version, version);
  assert.match(swSource, /globalThis\.TIMEBOX_APP_VERSION/);
  assert.match(swSource, /CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{globalThis\.TIMEBOX_APP_VERSION\}`/);
});

test("更新適用はタイマー中に拒否され、idle後にSKIP_WAITINGを送る", async () => {
  const messages = [];
  const worker = { postMessage: (message) => messages.push(message) };
  const registration = {
    waiting: worker,
    active: {},
    addEventListener() {},
    update: async () => registration
  };
  const serviceWorkerListeners = {};
  const environmentListeners = {};
  const environment = {
    location: { reload() {} },
    navigator: {
      onLine: true,
      serviceWorker: {
        controller: {},
        ready: Promise.resolve(registration),
        register: async (url, options) => {
          assert.match(String(url), /\/sw\.js$/);
          assert.equal(options.updateViaCache, "none");
          return registration;
        },
        addEventListener: (type, handler) => { serviceWorkerListeners[type] = handler; }
      }
    },
    addEventListener: (type, handler) => { environmentListeners[type] = handler; }
  };
  let timerStatus = "running";
  const manager = createPwaManager({ getTimerStatus: () => timerStatus, environment });
  await manager.start();
  assert.equal(manager.getState().updateAvailable, true);
  assert.equal(manager.applyUpdate(), false);
  assert.deepEqual(messages, []);
  timerStatus = "idle";
  manager.notifyTimerStateChanged();
  assert.equal(manager.applyUpdate(), true);
  assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
  assert.ok(serviceWorkerListeners.controllerchange);
  assert.ok(environmentListeners.online && environmentListeners.offline);
});

test("controllerchange後の再読み込みは1回だけに制限される", () => {
  let reloadCount = 0;
  const reload = createOneTimeReload(() => { reloadCount += 1; });
  assert.equal(reload(), true);
  assert.equal(reload(), false);
  assert.equal(reloadCount, 1);
});

test("online／offlineイベントで接続表示状態が変わる", async () => {
  const handlers = {};
  const environment = {
    navigator: { onLine: true },
    addEventListener: (type, handler) => { handlers[type] = handler; }
  };
  const manager = createPwaManager({ environment });
  await manager.start();
  assert.equal(manager.getState().online, true);
  environment.navigator.onLine = false;
  handlers.offline();
  assert.equal(manager.getState().online, false);
  environment.navigator.onLine = true;
  handlers.online();
  assert.equal(manager.getState().online, true);
});

test("更新保留対象はrunning、paused、expiredだけ", () => {
  for (const status of ["running", "paused", "expired"]) assert.equal(isUpdateBlocked(status), true);
  for (const status of ["idle", "completed", "skipped", null]) assert.equal(isUpdateBlocked(status), false);
});

test("GitHub Pages用.nojekyllが空ファイルとして存在する", async () => {
  assert.equal((await stat(new URL(".nojekyll", rootUrl))).size, 0);
});
