#!/usr/bin/env node
/**
 * tools/start.js — ゲームサーバーのランチャー
 *
 * ============================================================
 * なぜ .bat から中身を移したか
 * ============================================================
 * 日本語を含む UTF-8 の .bat は `chcp 65001` と噛み合わない。
 * cmd.exe はバッチファイルの位置を **バイト単位** で追うので、
 * コードページが切り替わるとマルチバイト文字で同期を失い、
 * **行の途中から実行を始める**。症状はこうなる:
 *
 *     '...' is not recognized as an internal or external command
 *
 * echo が消えるだけならまだしも、`set /p` のような行が壊れると
 * 分岐そのものが狂う。実際に学習パネルの .bat で起きた。
 *
 * 対策として .bat は ASCII だけにし、日本語を出す仕事はこちらへ移した。
 * Node は自分で UTF-8 を書けるので、この問題が構造的に起きない。
 *
 * Windows 以外でも動く（サーバーを起動するだけになる）。
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const IS_WIN = process.platform === 'win32';
const FIREWALL_RULE = `Huge Number Poker (TCP ${PORT})`;

const say = (s = '') => process.stdout.write(`${s}\n`);
const step = (n, total, label) => say(`[${n}/${total}] ${label}`);
const done = () => say('      完了');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** PowerShell を1行実行して標準出力を返す。失敗したら null */
function powershell(command) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// ============================================================
// [1] ポートを使っている古いプロセスを止める
// ============================================================

function freePort() {
  step(1, 5, `ポート ${PORT} を使っているプロセスを確認しています...`);
  if (!IS_WIN) { done(); return; }

  let out = '';
  try {
    out = execSync(`netstat -aon | findstr ":${PORT} " | findstr "LISTENING"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    out = '';   // 該当なしのとき findstr は終了コード1を返す
  }

  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }

  for (const pid of pids) {
    say(`      PID ${pid} を終了します`);
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } catch (e) { /* もう居ない場合は無視 */ }
  }
  done();
}

// ============================================================
// [2] 依存パッケージ
// ============================================================

function installDeps() {
  step(2, 5, '依存パッケージを確認しています...');
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) { done(); return; }

  say('      node_modules がありません。npm install を実行します...');
  const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    say('      [エラー] npm install に失敗しました。');
    say('              Node.js が入っているか確認してください（https://nodejs.org/）。');
    process.exit(1);
  }
  done();
}

// ============================================================
// [3] ファイアウォール
// ============================================================
//
// Windows の受信規則は「実行ファイルのパス」単位なので、node の
// インストール先が変わると既存の許可が効かなくなる。
// ここではポート番号に対する規則があるかを確認する。

async function checkFirewall() {
  step(3, 5, 'ファイアウォールの設定を確認しています...');
  if (!IS_WIN) { done(); return; }

  const found = powershell(
    `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue) ` +
    `{ 'yes' } else { 'no' }`);

  if (found === 'yes') { done(); return; }

  say('');
  say(`      [注意] TCP ${PORT} の受信許可がまだありません。`);
  say('             この PC だけで遊ぶ分には問題ありません。');
  say('             同じ Wi-Fi / LAN の他の端末から参加するには許可が必要です。');
  say('');

  const answer = await ask('      今すぐ設定しますか？ 管理者の確認が出ます [Y/n]: ');
  if (answer.toLowerCase() === 'n') {
    say('      スキップしました。後から allow-firewall.ps1 を実行しても設定できます。');
    done();
    return;
  }

  const ps1 = path.join(ROOT, 'allow-firewall.ps1');
  powershell(
    `Start-Process powershell -Verb RunAs -ArgumentList ` +
    `'-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`);
  say('      別ウィンドウで設定しています。完了してから続けてください。');
  await new Promise((r) => setTimeout(r, 3000));
  done();
}

// ============================================================
// [4] サーバー起動
// ============================================================

function startServer() {
  step(4, 5, 'サーバーを起動しています...');
  const server = path.join(ROOT, 'server.js');

  if (IS_WIN) {
    // 別ウィンドウで動かす。閉じればサーバーも止まる。
    spawn('cmd', ['/c', 'start', '"巨大数ポーカー サーバー"', 'cmd', '/k',
      `node "${server}"`], { cwd: ROOT, detached: true, stdio: 'ignore', shell: false });
  } else {
    spawn(process.execPath, [server], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  }
  done();
}

// ============================================================
// [5] 接続先の案内
// ============================================================
//
// LAN アドレスは PowerShell に聞くより os.networkInterfaces() のほうが速くて確実。

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function showUrls() {
  step(5, 5, '接続先を調べています...');
  const lan = lanAddress();

  say('');
  say('--------------------------------------------------------');
  say('  この PC で遊ぶ');
  say(`    http://localhost:${PORT}`);
  say('');
  if (lan) {
    say('  同じ Wi-Fi / LAN の他の端末から参加する');
    say(`    http://${lan}:${PORT}/online`);
  } else {
    say('  LAN アドレスが見つかりませんでした。');
    say('  ネットワークに接続されているか確認してください。');
  }
  say('');
  say('  遠くの友達と対戦する');
  say('    share-internet.bat を実行してください。');
  say('    インターネット公開用の URL が発行されます。');
  say('');
  say('  AI のテスト場');
  say(`    http://localhost:${PORT}/lab`);
  say('');
  say('  ホストが「部屋を作る」で出た 4 文字のコードを');
  say('  参加者に伝えてください。');
  say('--------------------------------------------------------');
  say('');

  const url = `http://localhost:${PORT}`;
  if (IS_WIN) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
  }
}

// ============================================================

async function main() {
  say('========================================================');
  say('  巨大数ポーカー ランチャー');
  say('========================================================');
  say('');

  freePort();
  installDeps();
  await checkFirewall();
  startServer();
  await new Promise((r) => setTimeout(r, 2000));
  showUrls();

  say('このウィンドウは閉じて構いません。');
  if (IS_WIN) {
    say('サーバーを止めるときは「巨大数ポーカー サーバー」のウィンドウを閉じてください。');
  } else {
    say(`サーバーを止めるときは: kill $(lsof -t -i:${PORT})`);
  }
  say('');
}

main().catch((e) => {
  say('');
  say(`[エラー] ${e && e.message ? e.message : e}`);
  process.exit(1);
});
