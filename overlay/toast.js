(function () {
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') === 'game' ? 'game' : 'voice';
  document.body.dataset.kind = kind;
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const closeLabel = q.get('lang') === 'ja' ? '閉じる' : 'Close';
  $('x1').setAttribute('aria-label', closeLabel);
  $('x2').setAttribute('aria-label', closeLabel);

  // 画像が読めない時は、名前の頭文字の丸にする
  function setAvatar(img, url, name) {
    const fallback = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const g = c.getContext('2d');
      g.fillStyle = '#5865f2';
      g.fillRect(0, 0, 96, 96);
      g.fillStyle = '#fff';
      g.font = '600 44px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(name || '?').trim().slice(0, 1).toUpperCase(), 48, 52);
      img.src = c.toDataURL();
    };
    img.onerror = fallback;
    if (url && /^https:\/\/cdn\.discordapp\.com\//.test(url)) img.src = url;
    else fallback();
  }

  window.toastApi.onData((d) => {
    if (kind === 'voice') {
      $('gname').textContent = d.guildName || '';
      $('gicon').onerror = () => ($('gicon').hidden = true);
      if (d.guildIcon && /^https:\/\/cdn\.discordapp\.com\//.test(d.guildIcon)) $('gicon').src = d.guildIcon;
      else $('gicon').hidden = true;
      $('name1').textContent = d.name || '';
      $('line1').textContent = d.text || '';
      setAvatar($('avatar1'), d.avatar, d.name);
    } else {
      $('name2').textContent = d.name || '';
      $('playing').textContent = d.playing || '';
      $('gameTitle').textContent = d.game || '';
      setAvatar($('avatar2'), d.avatar, d.name);
    }
    requestAnimationFrame(() => card.classList.add('in'));
  });
  window.toastApi.onLeave(() => card.classList.add('out'));
  // カーソルが乗っている間は消さない
  card.addEventListener('mouseenter', () => window.toastApi.hold(true));
  card.addEventListener('mouseleave', () => window.toastApi.hold(false));
  for (const x of [$('x1'), $('x2')]) {
    x.addEventListener('click', () => {
      card.classList.add('out');
      setTimeout(() => window.toastApi.close(), 180);
    });
  }
})();
