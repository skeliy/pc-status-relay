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
  const STABLE_SEC = 1.0; // 合った状態がこの時間続いたら「合った」とする
  const SEEK_CONFIRM_SEC = 1.0; // 再生位置の飛びがこの時間続いたら「自分でシークした」とする(読み取りの一瞬のぶれでは送らない)

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
      this.lookupOwnId = opts.lookupOwnId || (() => null); // 前に自分で選んで覚えた「代わりの曲」(サービス, 曲) → 番号
      this.onLearn = opts.onLearn || (() => {}); // 代わりの曲を選んだ時に覚えてもらう
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
      this.lastOnShared = null; // 共有の曲を最後に見た時の自分のプレイヤー { id, position, duration, at } (曲が最後まで行って次に変わったかを見分ける)
      this.autoHold = null; // { localId, until } 曲の終わりに勝手に始まった曲を、しばらく送らないでおく
      this.seekSince = null; // 再生位置が共有の状態から飛んでいるのに気付いた時刻
      this.substitute = null; // { until, desc } 見つからなかった曲の代わりに、聴いている人が自分で選ぶのを待っている
      this.ourLoads = new Map(); // こちらで流した曲の番号 -> 時刻(遅れて始まった曲を「自分で選んだ曲」と間違えないため)
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
      if (!ownId && this.service) ownId = this.lookupOwnId(this.service, song) || null; // 前に代わりの曲を選んだ曲
      const snap = { desc: song, ownId, playing, position, at: t, mine: false };
      // 同じ曲の情報なら、こちらで見つけた番号を引き継ぐ
      if (!snap.ownId && this.shared && sameDesc(this.shared.desc, song)) snap.ownId = this.shared.ownId;
      this.shared = snap;
      this.target = Object.assign({}, snap, { deadline: t + 25, from: fromLabel || null });
      this.lastCmd = {};
      this.notFound = null;
      this.autoHold = null;
      this.seekSince = null;
      this.substitute = null;
      if (this.notice && this.notice.text && this.notice.text.key === 'skipped') this.notice = null; // 前の曲の「見つからなかった」は消す
      this.log(`届いた: ${song.title} / ${song.artist} (${playing ? '再生' : '一時停止'} ${position.toFixed(1)}秒) from ${fromLabel}`);
    }

    // 拡張機能の部品が指示を実行した結果
    onResult(result) {
      const cmd = this.pending[result.id];
      delete this.pending[result.id];
      if (!cmd) return;
      if (result.resolvedId) this.ourLoads.set(result.resolvedId, this.clock());
      if (result.ok) {
        if (cmd.action === 'load' && result.resolvedId) {
          if (this.target && sameDesc(this.target.desc, cmd.desc)) {
            this.target.ownId = result.resolvedId;
            this.target.loaded = true; // こちらで曲を流し終えた(この後に曲が変わったら、聴いている人が自分で選んだ曲)
          }
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
      const sharedId = (this.target && this.target.ownId) || (this.shared && this.shared.ownId);
      if (song && song.id && song.id === sharedId) {
        this.lastOnShared = { id: song.id, position: Number(state.position) || 0, duration: Number(song.duration) || 0, at: t };
      }
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
        // 合わせきれなかった自分の状態を「新しく選んだ・シークした」と勘違いして送らないよう、今の状態を基準にしておく
        if (st.song && st.song.id) {
          this.shared = { desc: tg.desc, ownId: st.song.id, playing: !!st.isPlaying, position: Number(st.position) || 0, at: t, mine: false };
        }
        return [];
      }
      if (!tg.ownId && this.service && tg.desc.ids && tg.desc.ids[this.service]) tg.ownId = tg.desc.ids[this.service];
      const expected = this._expected(tg, t);
      const since = (a) => t - (this.lastCmd[a] == null ? -1e9 : this.lastCmd[a]);
      const localId = st.song && st.song.id;

      // 曲を流し終えた後に、聴いている人が自分で別の曲を選んだ → 合わせるのをやめて、その曲をみんなに送る
      const loadingNow = Object.values(this.pending).some((c) => c.action === 'load');
      if (tg.loaded && tg.ownId && localId && localId !== tg.ownId && this._autoAdvanced(tg.ownId, st, t)) {
        this.target = null;
        return this._holdAutoAdvance(this.shared, st, t);
      }
      if (tg.loaded && tg.ownId && localId && localId !== tg.ownId && !loadingNow && since('load') > 3 && st.phase === PLAYING) {
        this.log('合わせている途中で、自分で別の曲を選んだ');
        this.target = null;
        return this._detect(st, t, {}) || [];
      }
      // プレイヤーが曲を読み込み中(曲名がまだ分からない)の間は、少しだけ待つ(自分で別の曲を選んだ直後かもしれない)
      if (!localId && st.phase === 'loading') {
        if (tg.loadingSince == null) tg.loadingSince = t;
        if (t - tg.loadingSince < 3) return [];
      } else {
        tg.loadingSince = null;
      }
      if (!tg.ownId || localId !== tg.ownId) {
        // 曲を探して流す(探すのに時間がかかることがあるので、少し長めに待ってから出し直す)
        // 前に出した「曲を流す」の結果がまだ来ていなければ待つ(探すのに時間がかかる Spotify などで、二重に流さないため)
        const loading = Object.values(this.pending).some((c) => c.action === 'load');
        if (since('load') > (loading ? 30 : 10)) {
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
      // 画面の表示だけ一瞬変わって、実際の再生位置が動いていないことがある(Spotify のシークなど)。
      // 合った状態が少し続いてから「合った」とする
      if (posOk && playOk) {
        if (tg.okSince == null) tg.okSince = t;
        if (t - tg.okSince >= STABLE_SEC) {
          this.target = null;
          this.needsClick = false;
          this.shared = { desc: tg.desc, ownId: tg.ownId, playing: tg.playing, position: expected, at: t, mine: false };
        }
      } else {
        tg.okSince = null;
      }
      return cmds;
    }

    // 共有の曲を最後近くまで流していたのに、今は別の曲 = 曲が終わって、自分のプレイヤーが自分のキュー・おすすめで次に進んだ
    // (次の曲が「読み込み中」の間に前の曲の記録が上書きされないよう、共有の曲を最後に見た時の記録で判断する)
    _autoAdvanced(ownId, st, t) {
      const prev = this.lastOnShared;
      if (!prev || prev.id !== ownId || !prev.duration || !st.song || st.song.id === ownId) return false;
      return prev.position >= prev.duration - AUTO_END_SEC && t - prev.at < 30;
    }

    // 曲を選んだのが自分でない時、曲の終わりに自分のプレイヤーが勝手に始めた曲は止めて、選んだ人の次の曲を待つ
    // (選んだ人の曲がまだ終わっていなければ、その残りの時間も待つ)
    _holdAutoAdvance(sh, st, t) {
      const remaining = sh ? Math.max(0, (Number(sh.desc && sh.desc.duration) || 0) - this._expected(sh, t)) : 0;
      this.autoHold = { localId: st.song.id, until: t + remaining + AUTO_HOLD_SEC, sawPaused: false };
      this.log('曲が終わった → 自分のプレイヤーが始めた曲は止めて、選んだ人の次の曲を待つ');
      return st.isPlaying ? [this._cmd('pause')] : [];
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
        alt: song.alt || (sameAsShared ? this.shared.desc.alt : null) || null, // 別の言語の曲名・アーティスト名(探す時に使う)
        alts: (song.alts && song.alts.length ? song.alts : sameAsShared ? this.shared.desc.alts : null) || [], // 別の名前ぜんぶ
        lang: st.lang || null, // 曲名がどの言語で書かれているか(受け取った人は、まずこの言語で探す)
        cc: st.cc || null, // 送った人の国(Apple Music ならストアの国)
        // localOnly: 自分のライブラリでしか通じない番号(相手には送らず、曲名などで探してもらう)
        ids: song.localOnly ? Object.assign({}, baseIds) : Object.assign({}, baseIds, { [st.service]: song.id }),
      };
      const position = Number(st.position) || 0;
      this.shared = { desc, ownId: song.id, playing: !!st.isPlaying, position, at: t, mine: true };
      this.autoHold = null;
      this.seekSince = null;
      this.log(`送る: ${desc.title} (${st.isPlaying ? '再生' : '一時停止'} ${position.toFixed(1)}秒)`);
      this.send({ song: desc, isPlaying: !!st.isPlaying, position: Math.round(position * 100) / 100 });
    }

    // 見つからなかった曲を、別の名前(受け取った人の国・言語での名前など)を足して、もう一度探す。探し直す時は true
    retryWithAlts(desc, alts) {
      const sh = this.shared;
      if (!this.notFound || !sh || sh.mine || !sameDesc(sh.desc, desc) || !alts || !alts.length) return false;
      const key = (n) => norm(n.title) + '|' + norm(n.artist);
      const have = new Set([key(sh.desc)].concat((sh.desc.alts || []).map(key)));
      const add = alts.filter((n) => n && (n.title || n.artist) && !have.has(key(n)));
      if (!add.length) return false;
      sh.desc = Object.assign({}, sh.desc, { alts: (sh.desc.alts || []).concat(add), retry: add });
      const t = this.clock();
      this.notFound = null;
      this.notice = null;
      this.target = Object.assign({}, sh, { ownId: null, deadline: t + 25, from: null });
      this.lastCmd = {};
      this.log(`別の名前でもう一度探す: ${add.map((n) => n.title + ' / ' + n.artist).join(', ')}`);
      return true;
    }

    // 見つからなかった曲の代わりを、聴いている人が自分で探して流すのを待つ(流し始めた曲を、その曲の代わりにする)
    startSubstitute(seconds) {
      if (!this.shared || this.shared.mine) return false;
      this.substitute = { until: this.clock() + (seconds || 180), desc: this.shared.desc, localId: this.notFound ? this.notFound.localId : null };
      return true;
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
      const sub = this.substitute;
      if (sub && t > sub.until) this.substitute = null;
      if (this.substitute && this.shared && sameDesc(this.shared.desc, sub.desc) && song.id !== sub.localId && song.id !== this.shared.ownId) {
        // 見つからなかった曲の代わりに、聴いている人が自分で選んだ曲 → みんなには送らず、この曲で同じ位置に合わせる
        if (!(st.isPlaying && st.phase === PLAYING)) return;
        this.substitute = null;
        this.notFound = null;
        this.notice = null;
        const sh = this.shared;
        sh.ownId = song.id;
        sh.desc = withId(sh.desc, this.service, song.id);
        this.target = Object.assign({}, sh, { deadline: t + 25, loaded: true, from: null });
        this.lastCmd = {};
        this.log(`代わりの曲にする: ${song.title} (${sh.desc.title} の代わり)`);
        try {
          this.onLearn(this.service, sh.desc, song.id);
        } catch (e) {}
        return [];
      }
      if (this.notFound) {
        // 届いた曲が見つからなかった後は、自分で別の曲を選ぶまで何も送らない
        if (song.id === this.notFound.localId) return;
        if (st.phase !== PLAYING) return;
        this.notFound = null;
      }
      const sh = this.shared;
      const playing = !!st.isPlaying;
      if (!sh || song.id !== sh.ownId) {
        // こちらで流した曲が、次の曲が届いた後に遅れて始まっただけ → 送らない(届いた曲に合わせ直す)
        const ours = this.ourLoads.get(song.id);
        if (ours != null && t - ours < 30 && sh && !sh.mine) return;
        // 曲が最後まで流れて、自分のプレイヤーが勝手に次の曲(キューの次・おすすめの自動再生)を始めた時。
        // その曲を選んで流していたのが自分でなければ、止めて、みんなには送らない(選んだ人のキューの次の曲に合わせる)
        const hold = this.autoHold;
        if (hold && hold.localId === song.id) {
          if (!playing) {
            if (hold.pausedAt == null) hold.pausedAt = t;
            hold.resumedAt = null;
            return;
          }
          // 止めた後にまた流れ始めた。読み込みの途中で止めると、読み込み終わりにプレイヤーが自分で再生し直すことがあるので、
          // 止まってから少しの間に始まったものはプレイヤーのせいとみなして、もう一度止める。しばらくしてからなら、聴いている人が再生した
          const sincePause = t - (this.lastCmd.pause == null ? -1e9 : this.lastCmd.pause);
          const userResumed = hold.pausedAt != null && t - hold.pausedAt > 4;
          if (!userResumed) {
            if (sincePause > 1.5) return [this._cmd('pause')];
            return;
          }
          if (t < hold.until) return; // 選んだ人の次の曲が届くのを待つ(届けばそちらに合わせる)
          this.autoHold = null; // 待っても届かず、聴いている人が自分で再生した → この曲をみんなに送る
        } else if (sh && !sh.mine && this._autoAdvanced(sh.ownId, st, t)) {
          return this._holdAutoAdvance(sh, st, t);
        }
        if (!(playing && st.phase === PLAYING)) return;
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
        // シークした(読み取りが一瞬ぶれただけのこともあるので、少し続いてから送る)
        if (this.seekSince == null) this.seekSince = t;
        else if (t - this.seekSince >= SEEK_CONFIRM_SEC) this._broadcast(st, t);
      } else {
        this.seekSince = null;
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
