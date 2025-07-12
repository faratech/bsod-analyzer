# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Install dependencies**: `npm install`
- **Start development server**: `npm run dev`
- **Build for production**: `npm run build`
- **Preview production build**: `npm run preview`

No test or lint commands are configured in this project.

## Environment Setup

- Set `GEMINI_API_KEY` in `.env.local` file for the Google Gemini AI service
- The API key is exposed to the client via Vite environment variables

## Architecture Overview

This is a React-based BSOD (Blue Screen of Death) analyzer web application that uses Google's Gemini AI to analyze Windows crash dump files.

### Core Components

- **App.tsx**: Main application component handling file upload, analysis orchestration, and UI state
- **services/geminiService.ts**: AI service layer that processes dump files and communicates with Google Gemini API
- **types.ts**: TypeScript definitions for file status, analysis results, and dump file structures
- **components/**: Reusable UI components including file uploader, analysis cards, icons, and loader

### Key Workflows

1. **File Processing**: Supports .dmp files and .zip archives containing dump files. Uses JSZip for archive extraction.
2. **Binary Analysis**: Extracts printable strings and hex dumps from binary dump files for AI analysis
3. **AI Analysis**: Generates structured reports with probable causes, recommendations, and stack traces
4. **Advanced Analysis**: Provides WinDbg-style debugging commands (!analyze -v, lm kv, !process 0 0, !vm)

### Data Flow

1. User uploads .dmp or .zip files via FileUploader
2. Files are categorized as 'minidump' or 'kernel' based on size (5MB threshold)
3. Binary data is extracted as strings and hex dumps
4. Gemini AI analyzes the data using structured prompts and JSON schema
5. Results are displayed in AnalysisReportCard components with expandable advanced analysis tools

### Technology Stack

- **Frontend**: React 19, TypeScript, Vite
- **AI Service**: Google Gemini 2.5 Flash model via @google/genai
- **Styling**: CSS with custom properties and animations
- **File Processing**: FileReader API, JSZip for archive handling
- **Markdown**: react-markdown with remark-gfm for report rendering

### Security Considerations

This application processes potentially sensitive crash dump files containing system information. The files are processed locally in the browser before being sent to Google's AI service for analysis.