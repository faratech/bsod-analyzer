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
  
  // Find all JS files and generate SRI hashes
  const files = fs.readdirSync(assetsPath);
  for (const file of files) {
    if (file.endsWith('.js')) {
      const filePath = path.join(assetsPath, file);
      const sriHash = generateSRIHash(filePath);
      sriMapping[file] = sriHash;
      
      // Update script tags with integrity attribute
      const scriptRegex = new RegExp(`<script([^>]*src="/assets/${file}"[^>]*)>`, 'g');
      html = html.replace(scriptRegex, (match, attributes) => {
        if (!attributes.includes('integrity=')) {
          // Check if crossorigin already exists
          if (attributes.includes('crossorigin')) {
            return `<script${attributes} integrity="${sriHash}">`;
          } else {
            return `<script${attributes} integrity="${sriHash}" crossorigin="anonymous">`;
          }
        }
        return match;
      });
    }
  }
  
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