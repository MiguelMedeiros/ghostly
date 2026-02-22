const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function captureScreenshots() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }
  
  console.log('Navigating to http://localhost:3001...');
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle2' });
  
  const sections = [
    { name: '01-hero-section', scrollY: 0, description: 'Hero section (top of page)' },
    { name: '02-what-is-ghostly', scrollY: 800, description: 'What is Ghostly? section with stat cards' },
    { name: '03-how-it-works', scrollY: 1600, description: 'How It Works protocol steps' },
    { name: '04-features-grid', scrollY: 2400, description: 'Features grid' },
    { name: '05-protocol-deep-dive', scrollY: 3200, description: 'Protocol Deep Dive' },
    { name: '06-app-preview', scrollY: 4000, description: 'App Preview section' },
    { name: '07-download-footer', scrollY: 4800, description: 'Download section and footer' }
  ];
  
  console.log('\nCapturing screenshots...\n');
  
  for (const section of sections) {
    console.log(`📸 ${section.description}...`);
    
    await page.evaluate((y) => {
      window.scrollTo(0, y);
    }, section.scrollY);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const screenshotPath = path.join(screenshotsDir, `${section.name}.png`);
    await page.screenshot({ 
      path: screenshotPath,
      fullPage: false
    });
    
    console.log(`   ✓ Saved: ${section.name}.png`);
  }
  
  console.log('\n📷 Full page screenshot...');
  const fullPagePath = path.join(screenshotsDir, '00-full-page.png');
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.screenshot({ 
    path: fullPagePath,
    fullPage: true
  });
  console.log('   ✓ Saved: 00-full-page.png');
  
  await browser.close();
  
  console.log(`\n✨ All screenshots saved to: ${screenshotsDir}`);
  console.log('\nScreenshots captured:');
  sections.forEach(s => console.log(`  - ${s.name}.png: ${s.description}`));
  console.log(`  - 00-full-page.png: Complete page`);
}

captureScreenshots().catch(console.error);
