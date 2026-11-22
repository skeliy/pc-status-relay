// 起動したプログラムが「ゲーム」かどうかと、そのゲームの名前を決める。
//  - Steam のゲーム(steamapps のフォルダにあるもの)は、Steam が自分で知らせるので対象にしない
//  - よく遊ばれるゲームは一覧で名前を決め、それ以外はインストール先のフォルダの名前などから決める
//  - ランチャー・アンチチート・更新係など、ゲームそのものではないものは対象にしない
'use strict';

const STEAM = /[\\/]steamapps[\\/]/i;

// 実行ファイル名(小文字・.exe なし) -> ゲームの名前
const KNOWN = {
  'valorant-win64-shipping': 'VALORANT',
  'fortniteclient-win64-shipping': 'Fortnite',
  'fortniteclient-win64-shipping_eac_eos': 'Fortnite',
  'minecraft.windows': 'Minecraft',
  'minecraft': 'Minecraft',
  'r5apex': 'Apex Legends',
  'r5apex_dx12': 'Apex Legends',
  'league of legends': 'League of Legends',
  'cs2': 'Counter-Strike 2',
  'overwatch': 'Overwatch 2',
  'rocketleague': 'Rocket League',
  'robloxplayerbeta': 'Roblox',
  'genshinimpact': 'Genshin Impact',
  'yuanshen': 'Genshin Impact',
  'starrail': 'Honkai: Star Rail',
  'zenlesszonezero': 'Zenless Zone Zero',
  'eldenring': 'ELDEN RING',
  'osu!': 'osu!',
  'osulazer': 'osu!',
  'gta5': 'Grand Theft Auto V',
  'gta5_enhanced': 'Grand Theft Auto V',
  'rdr2': 'Red Dead Redemption 2',
  'destiny2': 'Destiny 2',
  'rainbowsix': 'Rainbow Six Siege',
  'rainbowsix_vulkan': 'Rainbow Six Siege',
  'marvel-win64-shipping': 'Marvel Rivals',
  'cod': 'Call of Duty',
  'cod24-cod': 'Call of Duty',
  'thefinals': 'THE FINALS',
  'palworld-win64-shipping': 'Palworld',
  'smalland-win64-shipping': 'Smalland',
  'wayofthehunter-win64-shipping': 'Way of the Hunter',
  'terraria': 'Terraria',
  'tmodloader': 'tModLoader',
  'among us': 'Among Us',
  'deadbydaylight-win64-shipping': 'Dead by Daylight',
  'pubg-win64-shipping': 'PUBG',
  'tslgame': 'PUBG',
  'escapefromtarkov': 'Escape from Tarkov',
  'helldivers2': 'HELLDIVERS 2',
  'fc25': 'EA SPORTS FC 25',
  'fc26': 'EA SPORTS FC 26',
  'forzahorizon5': 'Forza Horizon 5',
  'bf2042': 'Battlefield 2042',
  'bf6': 'Battlefield 6',
  'lethal company': 'Lethal Company',
  'phasmophobia': 'Phasmophobia',
  'repo': 'R.E.P.O.',
  'peak': 'PEAK',
};

// ゲームのフォルダにあっても、ゲームそのものではないもの
const NOT_GAME = /(launcher|crash|report|update|helper|service|anticheat|anti-cheat|easyanticheat|battleye|beservice|setup|install|uninst|cefprocess|cefsubprocess|webhelper|overlay|bootstrap|redist|vc_redist|dxsetup|unitycrashhandler|riotclient|vgc|vgtray|epicgames|epicweb|steam|socialclub|rockstar|eadesktop|origin|ubisoftconnect|uplay|battle\.net|agent)/i;

// ゲームが入っている場所(ランチャーごと)。この下のフォルダの名前をゲームの名前に使う
const STORE_DIRS = [
  /[\\/]Riot Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Epic Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]XboxGames[\\/]([^\\/]+)[\\/]/i,
  /[\\/]EA Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Electronic Arts[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Ubisoft Game Launcher[\\/]games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]HoYoPlay[\\/]games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Rockstar Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]GOG Galaxy[\\/]Games[\\/]([^\\/]+)[\\/]/i,
  /[\\/]Games[\\/]([^\\/]+)[\\/]/i,
];

function prettyBase(base) {
  let s = String(base || '')
    .replace(/[-_ ]?(Win64|WinGDK|Win32)?[-_ ]?Shipping$/i, '')
    .replace(/[-_ ](x64|x86|DX11|DX12|BE|EAC|EOS)$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
  if (!s || /^(client|game|launcher|app|main|start|bin|win64|win32|x64)$/i.test(s)) return '';
  if (/^[A-Z0-9 ]+$/.test(s) && /[A-Z]{4,}/.test(s)) s = s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  else if (!/\s/.test(s) && /[a-z][A-Z]/.test(s)) s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return s;
}

/**
 * @param {string} name 実行ファイル名(例: VALORANT-Win64-Shipping.exe)
 * @param {string} exePath 実行ファイルの場所(分からなければ空)
 * @returns {string|null} ゲームの名前。ゲームではない・Steam のゲームなら null
 */
function gameOf(name, exePath) {
  const file = String(name || '').replace(/\.exe$/i, '');
  const key = file.toLowerCase();
  const p = String(exePath || '');
  if (!key) return null;
  if (STEAM.test(p)) return null; // Steam のゲームは Steam が知らせる
  if (/^[a-z]:[\\/]windows[\\/]/i.test(p)) return null;
  if (key === 'javaw' || key === 'java') {
    return /minecraft|prismlauncher|multimc|modrinth|curseforge|atlauncher|gdlauncher|feather|lunar|badlion/i.test(p) ? 'Minecraft' : null;
  }
  if (key === 'client-win64-shipping') {
    if (/wuthering|鳴潮/i.test(p)) return 'Wuthering Waves';
    const store = STORE_DIRS.map((re) => p.match(re)).find(Boolean);
    return store ? store[1].trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(KNOWN, key)) return KNOWN[key];
  if (NOT_GAME.test(key)) return null;
  const shipping = /-(win64|wingdk)-shipping$/i.test(file);
  const store = STORE_DIRS.map((re) => p.match(re)).find(Boolean);
  if (!shipping && !store) return null; // どこのゲームか分からないものは知らせない(普通のアプリを間違えないため)
  return prettyBase(file) || (store ? store[1].trim() : null);
}

/**
 * プロセスの一覧の変化から、「今起動したゲーム」を見つける。
 * タブを切り替えて戻ってきただけでは知らせない(プロセスが新しく始まった時だけ)。
 */
class GameWatcher {
  constructor({ onStart, now = () => Date.now(), repeatMs = 2 * 60 * 1000 } = {}) {
    this.onStart = onStart;
    this.now = now;
    this.repeatMs = repeatMs;
    this.running = new Map(); // pid -> ゲームの名前
    this.recent = new Map(); // ゲームの名前 -> 最後に終わった時刻(起動し直しをまとめるため)
    this.first = true;
  }

  get playing() {
    return new Set(this.running.values());
  }

  update(procs) {
    const next = new Map();
    for (const [pid, name, exePath] of procs || []) {
      const g = gameOf(name, exePath);
      if (g) next.set(Number(pid), g);
    }
    const before = new Set(this.running.values());
    const now = this.now();
    for (const [pid, g] of this.running) if (!next.has(pid) && ![...next.values()].includes(g)) this.recent.set(g, now);
    const started = [];
    for (const [pid, g] of next) {
      if (this.running.has(pid) || before.has(g) || started.includes(g)) continue;
      if (this.first) continue; // アプリを起動した時に、もう動いていたゲームは知らせない
      if (this.recent.has(g) && now - this.recent.get(g) < this.repeatMs) continue; // すぐに起動し直しただけ
      started.push(g);
    }
    this.running = next;
    this.first = false;
    for (const g of started) this.onStart && this.onStart(g);
    return started;
  }
}

module.exports = { gameOf, GameWatcher, prettyBase };
