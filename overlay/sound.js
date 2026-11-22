// 通話の通知の音を鳴らすだけの、見えない画面
(function () {
  const a = document.getElementById('a');
  a.volume = 0.5; // 元の音の半分の大きさ
  window.play = () => {
    try {
      a.volume = 0.5;
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    return true;
  };
})();
