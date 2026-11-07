(function () {
  const FH = window.FH || {};
  const container = document.getElementById('root');
  if (container && FH.App && FH.html) {
    const root = window.ReactDOM.createRoot(container);
    root.render(FH.html`<${FH.App} />`);
  }
})();