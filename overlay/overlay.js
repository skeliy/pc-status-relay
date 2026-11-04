// 透明なウィンドウの中で歌詞を描く部分。マウスやキーボードの操作は受け取らない。
(function () {
  const { parseTTML, topIndex, progress, Clock } = window.LyricsCore;
  const root = document.getElementById('root');
  const stack = document.getElementById('stack');
  const clock = new Clock();

  const PAUSE_HIDE_MS = 20000; // 一時停止がこれだけ続いたら消す
  const LOST_MS = 4000; // ブラウザからの連絡がこれだけ無ければ消す
  const VISIBLE_RANGE = 4;

  let song = null; // { id, lines: [{ data, el, top, parts: [{ el, begin, end, last }] }] }
  let settings = { offsetMs: 0, enabled: true };
  let lastTickAt = 0;
  let pausedSince = 0;
  let top = -1;
  let visible = false;
  let raf = 0;
  let preview = false;
  let moving = false;

  // ---- 文字の組み立て ----
  const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

  function makeWord(part) {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = part.text;
    return span;
  }

  // 間にスペースの無い単語のかけら(音節)は、途中で折り返さないよう1つにまとめる。日本語などは折り返してよい
  function fillWords(container, words, out) {
    let group = null;
    let lastText = '';
    for (const part of words) {
      if (part.space) {
        group = null;
        container.appendChild(document.createTextNode(' '));
      }
      const el = makeWord(part);
      const joinable = !part.space && lastText && !CJK.test(lastText.slice(-1)) && !CJK.test(part.text[0]);
      if (joinable) {
        if (!group) {
          const prev = container.lastChild;
          group = document.createElement('span');
          group.className = 'group';
          container.replaceChild(group, prev);
          group.appendChild(prev);
        }
        group.appendChild(el);
      } else {
        group = null;
        container.appendChild(el);
      }
      out.push({ el, begin: part.begin, end: part.end, last: null });
      lastText = part.text;
    }
  }

  function buildLine(data) {
    const el = document.createElement('div');
    el.className = 'line' + (data.alt ? ' alt' : '');
    const line = { data, el, parts: [], bgParts: [], top: 0 };
    if (data.words) {
      fillWords(el, data.words, line.parts);
    } else {
      const span = document.createElement('span');
      span.className = 'w whole';
      span.textContent = data.text;
      el.appendChild(span);
      line.parts.push({ el: span, begin: data.begin, end: data.begin, last: null, whole: true });
    }
    if (data.bg) {
      const bg = document.createElement('div');
      bg.className = 'bg';
      fillWords(bg, data.bg, line.bgParts);
      el.appendChild(bg);
    }
    return line;
  }

  // 折り返した下の段ほど、まだ歌っていない文字を暗くする
  function measure() {
    if (!song) return;
    const fontSize = parseFloat(getComputedStyle(stack).fontSize) || 36;
    const rowHeight = fontSize * 1.34;
    for (const line of song.lines) {
      line.top = line.el.offsetTop;
      for (const part of line.parts) {
        const row = Math.max(0, Math.round((part.el.getBoundingClientRect().top - line.el.getBoundingClientRect().top) / rowHeight));
        part.el.style.setProperty('--dim', Math.max(0.24, 0.56 - row * 0.085).toFixed(3));
      }
    }
    top = -1;
  }

  function setSong(id, parsed) {
    stack.textContent = '';
    if (!parsed) {
      song = null;
      setVisible(false);
      return;
    }
    const lines = parsed.lines.map(buildLine);
    const frag = document.createDocumentFragment();
    for (const line of lines) frag.appendChild(line.el);
    stack.appendChild(frag);
    song = { id, lines, timeline: parsed.lines };
    measure();
    startLoop();
  }

  // ---- 1コマごとの更新 ----
  function paintPart(part, t) {
    const value = part.whole ? (t >= part.begin ? 118 : -18) : -18 + 136 * progress(part.begin, part.end, t);
    if (part.last !== null && Math.abs(part.last - value) < 0.15) return;
    part.last = value;
    part.el.style.setProperty('--p', value.toFixed(1) + '%');
    if (!part.whole) part.el.style.setProperty('--lift', ((value + 18) / 136).toFixed(3));
  }

  function applyTop(next) {
    const lines = song.lines;
    const anchor = next < lines.length ? lines[next].top : (lines[lines.length - 1].top + lines[lines.length - 1].el.offsetHeight);
    const from = Math.max(0, Math.min(top < 0 ? next : top, next) - 1);
    const to = Math.min(lines.length - 1, Math.max(top < 0 ? next : top, next) + VISIBLE_RANGE);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const d = i - next;
      const cls = d < 0 ? (d === -1 ? 'past' : '') : d < VISIBLE_RANGE ? 'd' + d : '';
      const wanted = 'line' + (line.data.alt ? ' alt' : '') + (cls ? ' ' + cls : '');
      if (line.el.className.replace(' bg-on', '') !== wanted) line.el.className = wanted;
      if (i >= from && i <= to) {
        line.el.style.setProperty('--stagger', (Math.max(0, d) * 0.05).toFixed(2) + 's');
        line.el.style.transform = `translateY(${-anchor}px)`;
      }
    }
    top = next;
  }

  function frame() {
    raf = 0;
    if (!song) return;
    const t = clock.current() + (settings.offsetMs || 0) / 1000;
    const next = topIndex(song.timeline, t);
    if (next !== top) applyTop(next);

    const end = Math.min(song.lines.length, next + VISIBLE_RANGE);
    for (let i = Math.max(0, next - 1); i < end; i++) {
      const line = song.lines[i];
      for (const part of line.parts) paintPart(part, t);
      if (line.data.bg) {
        for (const part of line.bgParts) paintPart(part, t);
        line.el.classList.toggle('bg-on', t >= line.data.bg[0].begin - 0.3 && t <= line.data.end);
      }
    }

    const now = Date.now();
    const finished = next >= song.lines.length;
    const lost = !preview && now - lastTickAt > LOST_MS;
    const longPause = !preview && pausedSince && now - pausedSince > PAUSE_HIDE_MS;
    setVisible(moving || (settings.enabled !== false && !finished && !lost && !longPause));

    if (visible && clock.playing) startLoop();
    else if (!visible) raf = 0;
  }

  function startLoop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    root.classList.toggle('visible', v);
    window.overlayApi.setVisible(v);
  }

  // ---- 設定 ----
  function applySettings(next) {
    const prevFont = settings.fontSize;
    const prevWidth = settings.width;
    settings = next;
    const style = document.documentElement.style;
    style.setProperty('--font-size', next.fontSize + 'px');
    style.setProperty('--overlay-opacity', String(next.opacity / 100));
    style.setProperty('--shadow', next.shadow ? 'drop-shadow(0 1px 3px rgba(0, 0, 0, 0.6))' : 'drop-shadow(0 0 0 transparent)');
    if (song && (prevFont !== next.fontSize || prevWidth !== next.width)) {
      // ウィンドウの大きさが変わってから測り直す
      setTimeout(() => {
        measure();
        startLoop();
      }, 60);
    }
    startLoop();
  }

  // ---- 設定中に見本を流す(歌詞が流れていない時だけ) ----
  const SAMPLE = {
    lines: [
      ['This is how', 'your lyrics', 'will look'],
      ['Move the sliders', 'to find your spot'],
      ['ここで透明度と', '大きさを', '変えられます'],
      ['Words light up', 'one by one'],
    ],
  };
  function buildSample() {
    let t = 0.5;
    const lines = SAMPLE.lines.map((chunks) => {
      const begin = t;
      const words = [];
      chunks.forEach((chunk, ci) => {
        chunk.split(' ').forEach((text, wi) => {
          const dur = 0.2 + text.length * 0.06;
          words.push({ text, begin: t, end: t + dur, space: ci + wi > 0 });
          t += dur;
        });
      });
      const end = t;
      t += 0.5;
      return { begin, end, text: chunks.join(' '), words, bg: null, alt: false };
    });
    return { lines, length: t };
  }
  let sampleTimer = 0;
  function setPreview(on) {
    if (on === preview) return;
    preview = on;
    clearInterval(sampleTimer);
    sampleTimer = 0;
    if (on && (!song || song.id === 'preview' || Date.now() - lastTickAt > LOST_MS)) {
      const sample = buildSample();
      setSong('preview', sample);
      const started = Date.now();
      const run = () => {
        const pos = ((Date.now() - started) / 1000) % sample.length;
        clock.sample(pos, Date.now(), true);
        startLoop();
      };
      run();
      sampleTimer = setInterval(run, 500);
    } else if (!on && song && song.id === 'preview') {
      setSong(null, null);
      window.overlayApi.requestLyrics();
    }
  }

  // ---- メインプロセスからの連絡 ----
  window.overlayApi.onTick((tick) => {
    if (preview && song && song.id === 'preview') return;
    lastTickAt = Date.now();
    if (!tick.id) {
      if (song) setSong(null, null);
      return;
    }
    // 次の曲の歌詞が届くまで、前の曲の歌詞を出したままにしない
    if (song && song.id !== tick.id) setSong(null, null);
    clock.sample(tick.pos, tick.at, tick.playing);
    pausedSince = tick.playing ? 0 : pausedSince || Date.now();
    if (song && song.id === tick.id) startLoop();
  });

  window.overlayApi.onLyrics(({ id, ttml }) => {
    if (preview && song && song.id === 'preview') return;
    if (song && song.id === id) return;
    setSong(id, ttml ? parseTTML(ttml) : null);
  });

  window.overlayApi.onSettings(applySettings);
  window.overlayApi.onPreview(setPreview);

  // ---- ドラッグで位置を変える ----
  const moveFrame = document.getElementById('moveFrame');
  const moveDone = document.getElementById('moveDone');
  window.overlayApi.onMoveMode(({ on, hint, done }) => {
    moving = on;
    moveFrame.hidden = !on;
    document.getElementById('moveHint').textContent = hint;
    moveDone.textContent = done;
    startLoop();
  });
  moveFrame.addEventListener('pointerdown', (e) => {
    if (e.target === moveDone || e.button !== 0) return;
    moveFrame.setPointerCapture(e.pointerId);
    window.overlayApi.moveStart();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    moveFrame.addEventListener(type, () => window.overlayApi.moveEnd());
  }
  moveDone.addEventListener('click', () => window.overlayApi.moveDone());
  window.addEventListener('resize', () => {
    if (song) {
      measure();
      startLoop();
    }
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  window.overlayApi.ready();

  // 動作確認用
  window.__overlayDebug = { state: () => ({ top, visible, id: song && song.id, t: clock.current() }) };
})();
