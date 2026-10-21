const { app, screen } = require('electron');

app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay();
  console.log(JSON.stringify({
    bounds: d.bounds,
    workArea: d.workArea,
    workAreaSize: d.workAreaSize,
    scaleFactor: d.scaleFactor,
  }, null, 2));
  app.quit();
});
