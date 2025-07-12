import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// Initialize Gemini AI with server-side API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Proxy endpoint for Gemini API calls
app.post('/api/gemini/generateContent', async (req, res) => {
  try {
    const { model, contents, generationConfig, safetySettings, config } = req.body;
    
    // Handle model specification - use the same model as frontend
    const modelName = model || 'gemini-2.5-flash';
    
    // Extract configuration - frontend sends 'config', SDK expects 'generationConfig'
    const frontendConfig = config || generationConfig || {};
    
    // Build proper generationConfig for the SDK
    const sdkGenerationConfig = {};
    
    // Handle response_mime_type (correct field name for the SDK)
    if (frontendConfig.responseMimeType) {
      sdkGenerationConfig.response_mime_type = frontendConfig.responseMimeType;
    }
    
    // Handle response_schema (correct field name for the SDK)
    if (frontendConfig.responseSchema) {
      sdkGenerationConfig.response_schema = frontendConfig.responseSchema;
    }
    
    // Handle temperature if provided
    if (frontendConfig.temperature !== undefined) {
      sdkGenerationConfig.temperature = frontendConfig.temperature;
    }
    
    // Copy any other config properties
    Object.keys(frontendConfig).forEach(key => {
      if (key !== 'responseMimeType' && key !== 'responseSchema' && key !== 'temperature') {
        sdkGenerationConfig[key] = frontendConfig[key];
      }
    });
    
    // Configure model with tools for grounding
    const modelConfig = {
      model: modelName,
      generationConfig: sdkGenerationConfig,
      safetySettings
    };
    
    // Add grounding tools configuration
    const tools = req.body.tools || [];
    if (tools.length > 0) {
      modelConfig.tools = tools;
    }
    
    const geminiModel = genAI.getGenerativeModel(modelConfig);
    
    const result = await geminiModel.generateContent(contents);
    const response = await result.response;
    
    // Return the text directly for compatibility
    const text = response.text();
    
    res.json({
      candidates: response.candidates || [{ content: { parts: [{ text }] } }],
      usageMetadata: response.usageMetadata,
      modelVersion: response.modelVersion,
      text // Include text for easier access
    });
  } catch (error) {
    console.error('Gemini API error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API Key configured: ${process.env.GEMINI_API_KEY ? 'Yes' : 'No'}`);
});