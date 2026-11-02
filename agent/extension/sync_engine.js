// 同期の判断(どのサービスでも共通)。
//
// 「みんなの共通の状態」(shared)を1つ覚えておき、
//   - 自分のプレイヤーがそれと違う動きをしたら(自分で曲を選んだ・止めた・シークした) → みんなに送る
//   - 誰かから状態が届いたら → 自分のプレイヤーをそれに合わせる指示(load / seek / play / pause)を出す
// サービスが違っても同じ曲を流せるよう、曲は「曲名・アーティスト・長さ・ISRC・各サービスの番号」の
// まとまり(desc)でやり取りし、自分のサービスでの番号は各サービスの部品(apple.js など)が探す。
//
// ブラウザ拡張機能(background.js)と、テスト(node)の両方から使う。
(function (root) {
  const PLAYING = 'playing';
  const PAUSED = 'paused';
  const TRANSIENT = new Set(['loading', 'ended', 'idle', 'ad']);
  const LATENCY_COMP_SEC = 0.3;
  const AUTO_END_SEC = 4; // 曲の残りがこれ以下で別の曲に変わったら「最後まで行って自動で次に進んだ」とみなす
  const AUTO_HOLD_SEC = 8; // 流していた人から次の曲が届くのを待つ時間

  function now() {
    return Date.now() / 1000;
  }

  class SyncEngine {
    constructor(opts) {
      opts = opts || {};
      this.clock = opts.clock || now;
      this.wallClock = opts.wallClock || (() => Date.now());
      this.send = opts.send || (() => {}); // send(stateData) … みんなに送る
      this.log = opts.log || (() => {});
      this.reset();
    }

    reset() {
      this.shared = null; // { desc, ownId, playing, position, at }
      this.target = null; // { desc, ownId, playing, position, at, deadline }
      this.lastCmd = {};
      this.cmdSeq = 0;
      this.pending = {}; // 指示の id -> 指示
      this.needsClick = false;
      this.notFound = null; // { localId, title } … 届いた曲が自分のサービスに無かった時
      this.notice = null; // { text, until }
      this.service = null;
      this.queueShown = []; // 画面に出す「次の曲」(自分が流している時は自分のキュー、届いた時は相手のキュー)
      this.remoteQueue = []; // 届いたキュー(先読みに使う)
      this.resolveCache = new Map(); // 曲 -> 自分のサービスでの番号(先読みの結果。見つからなければ null)
      this.prefetchAt = -1e9;
      this.sentQueueKey = '';
      this.lastQueueSend = -1e9;
      this.prevLocal = null; // 前回見た自分のプレイヤー { id, position, duration } (曲が最後まで行って次に変わったかを見分ける)
      this.autoHold = null; // { localId, until } 曲の終わりに勝手に始まった曲を、しばらく送らないでおく
    }

    // 次に流れる曲(最大3曲)。画面の表示用
    displayQueue() {
      return (this.queueShown || []).slice(0, 3).map((q) => ({ title: q.title, artist: q.artist }));
    }

    // みんなのキューにある次の曲を、前もって自分のサービスで探す指示(探してもページが動かないサービスだけ)
    nextPrefetch(state) {
      if (!state || !state.quietResolve || this.target) return null;
      const t = this.clock();
      if (t - this.prefetchAt < 4) return null;
      for (const item of (this.remoteQueue || []).slice(0, 3)) {
        if (item.ids && item.ids[this.service]) continue;
        const key = descKey(item);
        if (this.resolveCache.has(key)) continue;
        this.prefetchAt = t;
        this.resolveCache.set(key, undefined); // 探し中
        return this._cmd('resolve', { desc: item });
      }
      return null;
    }

    _expected(snap, t) {
      return snap.playing ? snap.position + (t - snap.at) : snap.position;
    }

    _cmd(action, extra) {
      this.cmdSeq += 1;
      this.lastCmd[action] = this.clock();
      const cmd = Object.assign({ id: this.cmdSeq, action, issuedAt: this.wallClock() }, extra || {});
      this.pending[cmd.id] = cmd;
      return cmd;
    }

    _setNotice(text, seconds) {
      this.notice = { text, until: this.clock() + (seconds || 8) };
    }

    currentNotice() {
      if (this.notice && this.clock() < this.notice.until) return this.notice.text;
      return null;
    }

    // 誰かから状態が届いた
    onRemote(data, ageSec, fromLabel) {
      const song = data && data.song;
      if (!song || !(song.title || (song.ids && Object.keys(song.ids).length))) return;
      const t = this.clock();
      const playing = !!data.isPlaying;
      let position = Number(data.position) || 0;
      if (playing) position += (ageSec || 0) + LATENCY_COMP_SEC;
      let ownId = this.service && song.ids ? song.ids[this.service] || null : null;
      if (!ownId && this.resolveCache.get(descKey(song))) ownId = this.resolveCache.get(descKey(song)); // 先読みで見つけてあった
      this.remoteQueue = Array.isArray(data.queue) ? data.queue.slice(0, 5) : [];
      this.queueShown = this.remoteQueue;
      const snap = { desc: song, ownId, playing, position, at: t, mine: false };
      // 同じ曲の情報なら、こちらで見つけた番号を引き継ぐ
      if (!snap.ownId && this.shared && sameDesc(this.shared.desc, song)) snap.ownId = this.shared.ownId;
      this.shared = snap;
      this.target = Object.assign({}, snap, { deadline: t + 25, from: fromLabel || null });
      this.lastCmd = {};
      this.notFound = null;
      this.autoHold = null;
      this.log(`届いた: ${song.title} / ${song.artist} (${playing ? '再生' : '一時停止'} ${position.toFixed(1)}秒) from ${fromLabel}`);
    }

    // 拡張機能の部品が指示を実行した結果
    onResult(result) {
      const cmd = this.pending[result.id];
      delete this.pending[result.id];
      if (!cmd) return;
      if (cmd.action === 'resolve') {
        this.resolveCache.set(descKey(cmd.desc), result.ok ? result.resolvedId || null : null);
        return;
      }
      if (result.ok) {
        if (cmd.action === 'load' && result.resolvedId) {
          if (this.target && sameDesc(this.target.desc, cmd.desc)) this.target.ownId = result.resolvedId;
          if (this.shared && sameDesc(this.shared.desc, cmd.desc)) {
            this.shared.ownId = result.resolvedId;
            this.shared.desc = withId(this.shared.desc, this.service, result.resolvedId);
          }
        }
        return;
      }
      if (result.error === 'autoplay') {
        this.needsClick = true;
        if (cmd.action === 'load' && result.resolvedId) {
          // 曲は入れられた(あとは再生ボタンを押すだけ)。同じ曲を何度も入れ直さないよう、番号を覚えておく
          if (this.target && sameDesc(this.target.desc, cmd.desc)) this.target.ownId = result.resolvedId;
          if (this.shared && sameDesc(this.shared.desc, cmd.desc)) this.shared.ownId = result.resolvedId;
        }
        return;
      }
      if (cmd.action === 'load' && result.error === 'notfound') {
        const title = (cmd.desc && cmd.desc.title) || null;
        this.log(`見つからなかった: ${title || '?'}`);
        this.notFound = { localId: result.localId || null, title };
        this.target = null;
        this._setNotice({ key: 'skipped', args: [title] }, 10); // 表示する時に今の言語で文にする
        return;
      }
      this.log(`指示が失敗: ${cmd.action} ${result.error}`);
      if (cmd.action === 'load') {
        // 何が起きたか分かるように、画面にも出す
        this._setNotice({ key: 'playFailed', args: [(cmd.desc && cmd.desc.title) || null, String(result.error || '')] }, 12);
      }
    }

    // 自分のプレイヤーの今の状態(0.5秒ごと)。返り値はプレイヤーへの指示の配列
    onLocal(state, opts) {
      opts = opts || {};
      if (!state || !state.available) return [];
      this.service = state.service || this.service;
      if (state.isPlaying) this.needsClick = false;
      const t = this.clock();
      let cmds = [];
      if (this.target) cmds = this._converge(state, t);
      else if (opts.broadcast !== false) cmds = this._detect(state, t, opts) || [];
      const song = state.song;
      this.prevLocal = song && song.id ? { id: song.id, position: Number(state.position) || 0, duration: Number(song.duration) || 0 } : this.prevLocal;
      return cmds;
    }

    _converge(st, t) {
      const tg = this.target;
      if (st.phase === 'ad') {
        // 無料版の広告中は待つ(広告が長くても時間切れにしない。終わったら位置を合わせる)
        tg.deadline = Math.max(tg.deadline, t + 10);
        return [];
      }
      if (t > tg.deadline) {
        this.log('相手の状態に合わせきれないまま時間切れ');
        this.target = null;
        return [];
      }
      if (!tg.ownId && this.service && tg.desc.ids && tg.desc.ids[this.service]) tg.ownId = tg.desc.ids[this.service];
      const expected = this._expected(tg, t);
      const since = (a) => t - (this.lastCmd[a] == null ? -1e9 : this.lastCmd[a]);
      const localId = st.song && st.song.id;

      if (!tg.ownId || localId !== tg.ownId) {
        // 曲を探して流す(探すのに時間がかかることがあるので、少し長めに待ってから出し直す)
        if (since('load') > 10) {
          return [this._cmd('load', { songId: tg.ownId, desc: tg.desc, position: expected, play: tg.playing })];
        }
        return [];
      }
      if (TRANSIENT.has(st.phase) && st.phase !== 'ended') return [];

      const cmds = [];
      const position = Number(st.position) || 0;
      const posOk = Math.abs(position - expected) <= 2.0;
      const playOk = !!st.isPlaying === tg.playing;
      if (!posOk && since('seek') > 2.5 && since('load') > 2.5) {
        cmds.push(this._cmd('seek', { position: expected, play: tg.playing }));
      }
      if (!playOk && since('play') > 2.5 && since('load') > 2.5) {
        cmds.push(this._cmd(tg.playing ? 'play' : 'pause'));
        this.lastCmd.play = this.clock();
      }
      if (posOk && playOk) {
        this.target = null;
        this.needsClick = false;
        this.shared = { desc: tg.desc, ownId: tg.ownId, playing: tg.playing, position: expected, at: t, mine: false };
      }
      return cmds;
    }

    // 前回まで共有の曲を最後近くまで流していて、今は別の曲の頭にいる = 曲が終わって自動で次に進んだ
    _autoAdvanced(sh, st) {
      const prev = this.prevLocal;
      if (!prev || prev.id !== sh.ownId || !prev.duration) return false;
      return prev.position >= prev.duration - AUTO_END_SEC && (Number(st.position) || 0) < 6;
    }

    _broadcast(st, t) {
      const song = st.song;
      const sameAsShared = this.shared && this.shared.ownId === song.id;
      const baseIds = sameAsShared && this.shared.desc.ids ? this.shared.desc.ids : {};
      const desc = {
        title: song.title || (sameAsShared ? this.shared.desc.title : null),
        artist: song.artist || (sameAsShared ? this.shared.desc.artist : null),
        album: song.album || null,
        duration: Number(song.duration) || (sameAsShared ? this.shared.desc.duration : null) || null,
        isrc: song.isrc || (sameAsShared ? this.shared.desc.isrc : null) || null,
        // localOnly: 自分のライブラリでしか通じない番号(相手には送らず、曲名などで探してもらう)
        ids: song.localOnly ? Object.assign({}, baseIds) : Object.assign({}, baseIds, { [st.service]: song.id }),
      };
      const position = Number(st.position) || 0;
      this.shared = { desc, ownId: song.id, playing: !!st.isPlaying, position, at: t, mine: true };
      this.autoHold = null;
      const queue = (Array.isArray(st.queue) ? st.queue : []).slice(0, 5).map((q) => ({
        title: q.title || null,
        artist: q.artist || null,
        duration: Number(q.duration) || null,
        isrc: q.isrc || null,
        ids: q.ids || {},
      }));
      this.queueShown = queue;
      this.sentQueueKey = queueKey(queue);
      this.lastQueueSend = t;
      this.log(`送る: ${desc.title} (${st.isPlaying ? '再生' : '一時停止'} ${position.toFixed(1)}秒、次 ${queue.length}曲)`);
      this.send({ song: desc, isPlaying: !!st.isPlaying, position: Math.round(position * 100) / 100, queue });
    }

    // だれかが新しく部屋に入ってきた時: 今流れていれば、その人にも流すために送り直す
    announce(st) {
      if (!st || !st.available || !st.song || !st.song.id || !st.isPlaying) return;
      if (this.target) return;
      this._broadcast(st, this.clock());
    }

    _detect(st, t, opts) {
      const song = st.song;
      if (!song || !song.id) return;
      if (this.notFound) {
        // 届いた曲が見つからなかった後は、自分で別の曲を選ぶまで何も送らない
        if (song.id === this.notFound.localId) return;
        if (st.phase !== PLAYING) return;
        this.notFound = null;
      }
      const sh = this.shared;
      const playing = !!st.isPlaying;
      if (!sh || song.id !== sh.ownId) {
        if (!(playing && st.phase === PLAYING)) return;
        // 曲が最後まで流れて、自分のプレイヤーが勝手に次の曲(キューの次・おすすめの自動再生)を始めた時。
        // その曲を選んで流していたのが自分でなければ、みんなに送らない(送ると、流していた人のキューから外れてしまう)。
        // 共有されているキューの次の曲を流すか、流していた人から次の曲が届くのを待つ
        if (this.autoHold && this.autoHold.localId === song.id) {
          if (t < this.autoHold.until) return;
          this.autoHold = null; // しばらく待っても誰からも来なかった → この曲をみんなに送る
        } else if (sh && !sh.mine && this._autoAdvanced(sh, st)) {
          const next = (this.remoteQueue || [])[0];
          if (next) {
            let ownId = next.ids && this.service ? next.ids[this.service] || null : null;
            if (!ownId && this.resolveCache.get(descKey(next))) ownId = this.resolveCache.get(descKey(next));
            this.log(`曲が終わった → みんなのキューの次の曲: ${next.title}`);
            this.remoteQueue = this.remoteQueue.slice(1);
            this.queueShown = this.remoteQueue;
            const snap = { desc: next, ownId, playing: true, position: 0, at: t, mine: false };
            this.shared = snap;
            this.target = Object.assign({}, snap, { deadline: t + 25, from: null });
            this.lastCmd = {};
            return this._converge(st, t);
          }
          this.log('曲が終わった → 流していた人から次の曲が届くのを待つ');
          this.autoHold = { localId: song.id, until: t + AUTO_HOLD_SEC };
          return;
        }
        this._broadcast(st, t);
        return;
      }
      if (TRANSIENT.has(st.phase)) return;
      const position = Number(st.position) || 0;
      if (playing !== sh.playing) {
        if (!playing) {
          if (st.phase !== PAUSED) return;
          const duration = Number(song.duration) || 0;
          if (duration && position >= duration - 2.5) return; // 曲が最後まで終わっただけ
        }
        this._broadcast(st, t);
        return;
      }
      if (Math.abs(position - this._expected(sh, t)) > 3.0) {
        this._broadcast(st, t); // シークした
        return;
      }
      // 同じ曲のままキューだけ変わった(次の曲を足した・並べ替えた) → みんなのキューも更新する
      if (playing && Array.isArray(st.queue) && queueKey(st.queue) !== this.sentQueueKey && t - this.lastQueueSend > 3) {
        this._broadcast(st, t);
      }
    }
  }

  function norm(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function descKey(d) {
    if (!d) return '';
    return d.isrc || `${norm(d.title)}|${norm(d.artist)}`;
  }

  function queueKey(q) {
    return (q || []).slice(0, 5).map(descKey).join('/');
  }

  function sameDesc(a, b) {
    if (!a || !b) return false;
    if (a.ids && b.ids) {
      for (const k of Object.keys(a.ids)) if (b.ids[k] && b.ids[k] === a.ids[k]) return true;
    }
    if (a.isrc && b.isrc) return a.isrc === b.isrc;
    return norm(a.title) === norm(b.title) && norm(a.artist) === norm(b.artist);
  }

  function withId(desc, service, id) {
    const ids = Object.assign({}, desc.ids || {});
    if (service && id) ids[service] = id;
    return Object.assign({}, desc, { ids });
  }

  const api = { SyncEngine, sameDesc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcsSync = api;
})(typeof self !== 'undefined' ? self : this);
