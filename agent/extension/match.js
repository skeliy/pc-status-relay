// 「同じ曲か」を判定する部品(3つのサービスの部品が共通で使う。ページの中で動く)。
// 曲名・アーティスト・長さの近さで点数を付け、いちばん近い候補を選ぶ。
(function () {
  if (window.__pcsMatch) return;

  function base(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\(\[【（].*?[\)\]】）]/g, ' ') // (feat. ...) [Remastered] 【MV】 など(「」は曲名のことが多いので残す)
      .replace(/\s+-\s+.*(remaster|version|ver\.|edit|mix|live|from).*$/i, ' ')
      .replace(/\b(feat|ft)\.?\s.*$/i, ' ')
      .replace(/official (music )?video|music video|lyric video|topic/gi, ' ');
  }

  function compact(s) {
    return base(s).replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function raw(s) {
    return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function bigrams(s) {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  function similarity(a, b) {
    const x = compact(a);
    const y = compact(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.85;
    if (x.length < 2 || y.length < 2) return 0;
    const bx = bigrams(x);
    const by = bigrams(y);
    let hit = 0;
    for (const [g, n] of bx) hit += Math.min(n, by.get(g) || 0);
    return (2 * hit) / (x.length - 1 + (y.length - 1));
  }

  function durationScore(a, b) {
    if (!a || !b) return 0.5;
    const d = Math.abs(a - b);
    if (d <= 3) return 1;
    if (d <= 8) return 0.7;
    if (d <= 20) return 0.3;
    return 0;
  }

  // candidates: [{ id, title, artist, duration }] / desc: { title, artist, duration }
  function best(candidates, desc) {
    let top = null;
    for (const c of candidates || []) {
      const t = similarity(c.title, desc.title);
      const a = desc.artist ? Math.max(similarity(c.artist, desc.artist), compact(c.artist).includes(compact(desc.artist).slice(0, 6)) ? 0.8 : 0) : 0.5;
      const d = durationScore(Number(c.duration) || 0, Number(desc.duration) || 0);
      // 括弧の中まで含めて曲名がぴったり同じなら少し加点(「(Remaster)」「(Live)」などの別バージョンより優先)
      const exact = raw(c.title) === raw(desc.title) ? 0.08 : 0;
      const score = 0.55 * t + 0.3 * a + 0.15 * d + exact;
      if (t < 0.6 || score < 0.6) continue;
      if (!top || score > top.score) top = { id: c.id, score, candidate: c };
    }
    return top;
  }

  // 曲名とアーティストが合っている候補の中から、長さがいちばん近いものを選ぶ(YouTube などで使う)。
  // 同じ曲でも MV・ライブ・音源で長さが違うので、長さが近いほど位置合わせがずれにくい。
  function closest(candidates, desc) {
    const want = Number(desc.duration) || 0;
    const ok = [];
    for (const c of candidates || []) {
      const t = similarity(c.title, desc.title);
      const a = desc.artist ? Math.max(similarity(c.artist, desc.artist), compact(c.artist).includes(compact(desc.artist).slice(0, 6)) ? 0.8 : 0) : 0.5;
      if (t < 0.6 || a < 0.5) continue;
      const diff = want && c.duration ? Math.abs(Number(c.duration) - want) : 999;
      ok.push({ id: c.id, diff, score: 0.6 * t + 0.4 * a + (raw(c.title) === raw(desc.title) ? 0.08 : 0), candidate: c });
    }
    if (!ok.length) return best(candidates, desc); // アーティスト名が合わない時(チャンネル名が違う等)は、ふつうの選び方
    ok.sort((x, y) => (Math.abs(x.diff - y.diff) > 1.5 ? x.diff - y.diff : y.score - x.score));
    return ok[0];
  }

  function parseClock(text) {
    const m = String(text || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m) return 0;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  }

  window.__pcsMatch = { best, closest, similarity, parseClock };
})();
