import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("HTML内のidは重複せず、ローカル資産だけを参照する", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /src="\.\/js\/app\.js"/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.doesNotMatch(html, /https?:\/\//i);
});
test("主要画面とダイアログがHTMLに存在する", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const id of [
    "schedule-view", "timer-view", "history-view", "side-menu", "plan-dialog",
    "late-start-dialog", "manual-dialog", "expired-complete-dialog", "confirm-dialog", "toast-region",
    "settings-view", "update-banner", "network-status", "sound-enabled", "sound-volume",
    "enable-notification-button", "test-notification-button", "schedule-notification", "wake-lock-enabled",
    "export-backup-button", "backup-file-input", "backup-restore-dialog", "backup-replace-button"
  ]) assert.match(html, new RegExp(`id="${id}"`));
});
