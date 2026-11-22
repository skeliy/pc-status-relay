// 通話の通知の音を鳴らすだけの、見えない画面
(function () {
  const a = document.getElementById('a');
  window.play = () => {
    try {
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
    return true;
  };
})();
