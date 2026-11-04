// 歌詞の読み取りと、再生位置の計算(画面に関係しない部分)。
(function (root) {
  // "1:02.345" "01:02:03.5" "12.5s" "12.5" を秒にする
  function parseTime(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/^[\d.]+s$/.test(s)) return parseFloat(s);
    const parts = s.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  const ROLE = 'ttm:role';
  const SKIP_ROLES = new Set(['x-translation', 'x-roman', 'x-pronunciation']);

  // <p> や背景コーラスの <span> の中身を、時間の付いた文字のかたまりの列にする
  function readParts(node) {
    const parts = [];
    let bg = null;
    let pendingSpace = false;
    let text = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const raw = child.nodeValue || '';
        text += raw;
        if (!raw.trim()) {
          if (parts.length) pendingSpace = true;
          continue;
        }
        // 時間の付いていない文字。前のかたまりと同じ時間で扱う
        const prev = parts[parts.length - 1];
        parts.push({
          text: raw.trim(),
          begin: prev ? prev.end : null,
          end: prev ? prev.end : null,
          space: pendingSpace || /^\s/.test(raw),
        });
        pendingSpace = /\s$/.test(raw);
      } else if (child.nodeType === 1 && child.localName === 'span') {
        const role = child.getAttribute(ROLE);
        if (SKIP_ROLES.has(role)) continue;
        if (role === 'x-bg') {
          const inner = readParts(child);
          bg = inner.parts.length ? inner : bg;
          continue;
        }
        const content = child.textContent || '';
        if (!content.trim()) {
          if (parts.length) pendingSpace = true;
          continue;
        }
        text += content;
        parts.push({
          text: content.trim(),
          begin: parseTime(child.getAttribute('begin')),
          end: parseTime(child.getAttribute('end')),
          space: pendingSpace || /^\s/.test(content),
        });
        pendingSpace = /\s$/.test(content);
      }
    }
    if (parts.length) parts[0].space = false;
    return { parts, bg, text: text.replace(/\s+/g, ' ').trim() };
  }

  // Apple Music の TTML を、表示に使う形にする。時間の情報が無ければ null
  function parseTTML(ttml, ParserClass) {
    if (!ttml || typeof ttml !== 'string') return null;
    const Parser = ParserClass || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!Parser) return null;
    const doc = new Parser().parseFromString(ttml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    const lines = [];
    let firstAgent = null;
    for (const p of Array.from(doc.getElementsByTagName('p'))) {
      const begin = parseTime(p.getAttribute('begin'));
      const end = parseTime(p.getAttribute('end'));
      if (begin == null || end == null || end <= begin) continue;
      const { parts, bg, text } = readParts(p);
      if (!text) continue;
      const agent = p.getAttribute('ttm:agent') || null;
      if (agent && !firstAgent && agent !== 'v1000') firstAgent = agent;
      const timed = parts.filter((x) => x.begin != null && x.end != null);
      const hasWords = timed.length > 0 && timed.length === parts.length;
      let lineEnd = end;
      if (bg) for (const x of bg.parts) if (x.end != null && x.end > lineEnd) lineEnd = x.end;
      lines.push({
        begin,
        end: lineEnd,
        text,
        words: hasWords ? parts : null, // null の時は行全体を一度に光らせる
        bg: bg && bg.parts.every((x) => x.begin != null && x.end != null) ? bg.parts : null,
        alt: !!(agent && firstAgent && agent !== firstAgent && agent !== 'v1000'),
      });
    }
    if (!lines.length) return null;
    lines.sort((a, b) => a.begin - b.begin);
    return { lines, wordTimed: lines.some((l) => l.words) };
  }

  const LINE_HOLD = 0.15; // 歌い終わってから、次の行へ移るまでの秒数

  // 画面の一番上に出す行。今歌っている行か、まだ始まっていない次の行
  function topIndex(lines, t) {
    for (let i = 0; i < lines.length; i++) if (lines[i].end + LINE_HOLD > t) return i;
    return lines.length;
  }

  function progress(begin, end, t) {
    if (t <= begin) return 0;
    if (t >= end) return 1;
    return (t - begin) / (end - begin);
  }

  // 拡張機能から届く秒数は少し揺れるので、少しのずれはなめらかに直し、シークなどの大きなずれはすぐ合わせる
  class Clock {
    constructor(now) {
      this.nowFn = now || (() => Date.now());
      this.pos = 0;
      this.at = this.nowFn();
      this.playing = false;
    }
    current() {
      return this.playing ? this.pos + (this.nowFn() - this.at) / 1000 : this.pos;
    }
    sample(pos, at, playing) {
      const n = this.nowFn();
      const reported = playing ? pos + Math.max(0, n - at) / 1000 : pos;
      const cur = this.current();
      const diff = reported - cur;
      const snap = Math.abs(diff) > 0.35 || playing !== this.playing;
      this.pos = snap ? reported : cur + diff * 0.15;
      this.at = n;
      this.playing = playing;
    }
  }

  const api = { parseTime, parseTTML, topIndex, progress, Clock };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LyricsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
