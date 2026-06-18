import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Generate SRI hash for a file
function generateSRIHash(filePath) {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha384').update(content).digest('base64');
  return `sha384-${hash}`;
}

// Update HTML with SRI hashes
function updateHTMLWithSRI() {
  const distPath = path.join(__dirname, '..', 'dist');
  const htmlPath = path.join(distPath, 'index.html');
  const assetsPath = path.join(distPath, 'assets');
  
  if (!fs.existsSync(htmlPath)) {
    console.error('index.html not found. Run build first.');
    return;
  }
  
  let html = fs.readFileSync(htmlPath, 'utf8');
  const sriMapping = {};

  if (!fs.existsSync(assetsPath)) {
    console.error('dist/assets not found. Run build first.');
    return;
  }

  const files = fs.readdirSync(assetsPath);
  for (const file of files) {
    if (!/\.(js|css)$/.test(file)) continue;
    sriMapping[file] = generateSRIHash(path.join(assetsPath, file));
  }

  function addIntegrityToTag(tag) {
    const assetMatch = tag.match(/\b(?:src|href)="\/assets\/([^"?]+)(?:\?[^"]*)?"/);
    if (!assetMatch) return tag;

    const sriHash = sriMapping[assetMatch[1]];
    if (!sriHash) return tag;

    const openingEnd = tag.indexOf('>');
    if (openingEnd === -1) return tag;

    let openingTag = tag.slice(0, openingEnd);
    const suffix = tag.slice(openingEnd);
    openingTag = openingTag.replace(/\s+integrity="[^"]*"/, '');
    openingTag = openingTag.replace(/\s+crossorigin(?:="[^"]*")?/, '');
    return `${openingTag} integrity="${sriHash}" crossorigin="anonymous"${suffix}`;
  }

  html = html.replace(/<script\b[^>]*\bsrc="\/assets\/[^"]+"[^>]*><\/script>/g, addIntegrityToTag);
  html = html.replace(/<link\b[^>]*\bhref="\/assets\/[^"]+"[^>]*>/g, addIntegrityToTag);
  
  // Save the SRI mapping for server validation
  fs.writeFileSync(
    path.join(distPath, 'sri-mapping.json'),
    JSON.stringify(sriMapping, null, 2)
  );
  
  // Save updated HTML
  fs.writeFileSync(htmlPath, html);
  console.log('SRI hashes added to index.html');
  console.log('SRI mapping:', sriMapping);
}

updateHTMLWithSRI();
