const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  function createBlackHoleIcon(size) {
    const canvas = Buffer.alloc(size * size * 4);
    const cx = size / 2;
    const cy = size / 2;
    
    const scale = size / 22; // Scale based on 22x22 base
    const outerRadius = 9 * scale;
    const ringThickness = 1.5 * scale;
    const innerRadius = outerRadius - ringThickness;
    const eventHorizon = 2.5 * scale;
    const diskHeight = 2 * scale;
    const diskExtend = 10 * scale;
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Simple 4x4 multisampling for anti-aliasing
        let alphaSum = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const subX = x + (sx + 0.5) / 4;
            const subY = y + (sy + 0.5) / 4;
            const dx = subX - cx;
            const dy = subY - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            let a = 0;
            if (Math.abs(dy) <= diskHeight && Math.abs(dx) <= diskExtend) {
              if (dist > eventHorizon) {
                a = 255;
              }
            }
            if (dist >= innerRadius && dist <= outerRadius) {
              a = 255;
            }
            if (dist <= eventHorizon) {
              a = 0;
            }
            alphaSum += a;
          }
        }
        
        const alpha = Math.round(alphaSum / 16);
        const idx = (y * size + x) * 4;
        
        // For Template icons, the color should be black (0,0,0) and use alpha channel.
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = alpha;
      }
    }
    
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  const icon1x = createBlackHoleIcon(22);
  const icon2x = createBlackHoleIcon(44);
  
  const assetsDir = path.join(__dirname, '../assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  
  fs.writeFileSync(path.join(assetsDir, 'trayIconTemplate.png'), icon1x.toPNG());
  fs.writeFileSync(path.join(assetsDir, 'trayIconTemplate@2x.png'), icon2x.toPNG());
  
  console.log('Tray icons generated.');
  app.quit();
});
