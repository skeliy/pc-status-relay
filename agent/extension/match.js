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
  // 別バージョンを表す言葉(元の曲名に無いのに候補の曲名にあれば、別バージョンとみなす)
  const VERSION_WORDS = /\b(live|acoustic|remix(?:ed)?|cover|karaoke|instrumental|inst|sped\s*up|speed\s*up|slowed|reverb|nightcore|8d|demo|unplugged|orchestral|piano\s*ver(?:sion)?|lofi|lo-fi|backing|made popular|made famous|originally performed|in the style of|tribute)\b|ライブ|弾いてみた|歌ってみた|カバー|リミックス|アコースティック|カラオケ|オルゴール/gi;
  function versionWords(s) {
    return new Set((String(s || '').normalize('NFKC').toLowerCase().match(VERSION_WORDS) || []).map((w) => w.replace(/\s+/g, ' ')));
  }
  function otherVersion(candTitle, wantTitle) {
    const want = versionWords(wantTitle);
    const cand = versionWords(candTitle);
    for (const w of cand) if (!want.has(w)) return true; // 例: 元はスタジオ版なのに候補はライブ版
    for (const w of want) if (!cand.has(w)) return true; // 例: 元はライブ版なのに候補はスタジオ版
    return false;
  }

  // 曲名・アーティスト名は、届いた名前と別の言語の名前(alt。例: 日本のストアのカタカナ名に対する英語名)の、合うほうで比べる
  // 届いた名前と、別の名前(alt / alts。英語・日本語など)をまとめる
  function variants(desc) {
    const out = [{ title: desc.title, artist: desc.artist }];
    if (desc.alt) out.push(desc.alt);
    for (const n of desc.alts || []) if (n) out.push(n);
    return out;
  }
  function titleNames(desc) {
    return Array.from(new Set(variants(desc).map((v) => v.title).filter(Boolean)));
  }
  function titleScore(c, desc) {
    let t = 0;
    for (const n of titleNames(desc)) t = Math.max(t, similarity(c.title, n));
    return t;
  }
  function exactTitle(c, desc) {
    return titleNames(desc).some((n) => raw(c.title) === raw(n));
  }
  function artistNames(desc) {
    return Array.from(new Set(variants(desc).map((v) => v.artist).filter(Boolean)));
  }
  function artistScore(c, desc) {
    const names = artistNames(desc);
    if (!names.length) return 0.5;
    let top = 0;
    for (const n of names) {
      const cn = compact(n);
      top = Math.max(top, similarity(c.artist, n), compact(c.artist).includes(cn.slice(0, 6)) ? 0.8 : 0);
      // YouTube では投稿したチャンネル名がアーティストとは限らないので、「アーティスト - 曲名」の形の題名も見る
      if (cn.length >= 3 && compact(c.title).includes(cn)) top = Math.max(top, 0.7);
    }
    return top;
  }
  // 文字の種類(カタカナ・漢字 / ローマ字)が同じで、比べられるか
  function script(s) {
    const t = String(s || '');
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t)) return 'cjk';
    return /[a-z]/i.test(t) ? 'latin' : 'other';
  }
  function comparable(c, desc) {
    return artistNames(desc).some((n) => script(n) === script(c.artist));
  }
  // アーティスト名が比べられるのに合わない = 別の人の曲(カバー・同じ題名の別の曲など)
  function otherArtist(c, desc) {
    return artistNames(desc).length > 0 && artistScore(c, desc) < 0.5 && comparable(c, desc);
  }

  function best(candidates, desc) {
    let top = null;
    for (const c of candidates || []) {
      if (otherArtist(c, desc)) continue;
      const t = titleScore(c, desc);
      const a = artistScore(c, desc);
      const d = durationScore(Number(c.duration) || 0, Number(desc.duration) || 0);
      // 括弧の中まで含めて曲名がぴったり同じなら少し加点(「(Remaster)」「(Live)」などの別バージョンより優先)
      const exact = exactTitle(c, desc) ? 0.08 : 0;
      const score = 0.55 * t + 0.3 * a + 0.15 * d + exact + (c.preferred ? 0.05 : 0) - (otherVersion(c.title, desc.title) ? 0.3 : 0);
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
      const t = titleScore(c, desc);
      const a = artistScore(c, desc);
      if (t < 0.6 || a < 0.5) continue;
      const diff = want && c.duration ? Math.abs(Number(c.duration) - want) : 999;
      ok.push({
        id: c.id,
        diff,
        other: otherVersion(c.title, desc.title) ? 1 : 0, // ライブ版・アコースティック版など
        pref: c.preferred ? 1 : 0, // 公式の音源(YouTube の「〜 - Topic」、YouTube Music の「曲」)
        score: 0.6 * t + 0.4 * a + (exactTitle(c, desc) ? 0.08 : 0),
        candidate: c,
      });
    }
    // アーティスト名が比べられない時(カタカナとローマ字など)だけ、ふつうの選び方。比べられて合わない人の曲は選ばない
    if (!ok.length) return best(candidates, desc);
    // 1. 別バージョンは後回し  2. 長さが3秒以上違えば近いほう  3. 公式の音源  4. 長さが近いほう  5. 曲名がよく合うほう
    ok.sort(
      (x, y) =>
        x.other - y.other ||
        (Math.abs(x.diff - y.diff) > 3 ? x.diff - y.diff : 0) ||
        y.pref - x.pref ||
        (Math.abs(x.diff - y.diff) > 1.5 ? x.diff - y.diff : y.score - x.score)
    );
    return ok[0];
  }

  function parseClock(text) {
    const m = String(text || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!m) return 0;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  }

  // 検索に使う言葉(届いた名前と別の名前で、重複なく最大 max 個。日本語などの名前を先に)
  function queries(desc, max) {
    const qs = [];
    // 探し直しの時は、新しく分かった名前(受け取った人の言語での名前)から先に探す
    for (const n of desc.retry || []) {
      const q = [n.title, n.artist].filter(Boolean).join(' ');
      if (q && !qs.includes(q)) qs.push(q);
    }
    const vs = variants(desc).map((v) => [v.title || desc.title, v.artist || desc.artist].filter(Boolean).join(' ')).filter(Boolean);
    const cjk = (q) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(q);
    for (const q of vs.filter(cjk).concat(vs.filter((q) => !cjk(q)))) if (!qs.includes(q)) qs.push(q);
    return qs.slice(0, max || 3);
  }

  window.__pcsMatch = { best, closest, similarity, parseClock, queries };
})();
