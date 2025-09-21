**Project Overview**

The BSOD AI Analyzer is an enterprise-grade application designed to diagnose Windows crash dump errors using Google's Gemini AI. It features a secure client-server architecture, with a React frontend for user interaction and an Express.js backend that proxies sensitive Gemini API calls. The application supports various crash dump formats, provides detailed analysis reports, and integrates advanced debugging capabilities. A key aspect of its design is robust security, including server-side API key protection and in-memory processing of crash dumps to ensure no sensitive data is stored.

**Building and Running**

This project uses Node.js and npm for dependency management and script execution.

**Prerequisites:**
*   Node.js 18+
*   Google Cloud account (for deployment)
*   Gemini API key from [Google AI Studio](https://aistudio.google.com/)

**Local Development:**

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/faratech/bsod-analyzer.git
    cd bsod-analyzer
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up environment:**
    Create a `.env.local` file in the project root with your Gemini API key:
    ```
    GEMINI_API_KEY=your-gemini-api-key
    ```
    For additional secrets like `TURNSTILE_SECRET_KEY` and `SESSION_SECRET`, you can add them to `.env.local` or set them as environment variables directly.

4.  **Start development server:**
    ```bash
    npm run dev
    ```
    This command concurrently starts both the backend (on port 8080) and the frontend development server.

**Development Commands:**
*   `npm run dev`: Starts both backend and frontend servers.
*   `npm run dev:backend`: Starts the backend server only.
*   `npm run dev:frontend`: Starts the frontend development server only.
*   `npm run build`: Builds the production-ready frontend.
*   `npm start`: Runs the production server.

**Deployment:**

The application can be deployed to Google Cloud Run. The `README.md` provides detailed instructions for quick deployment using `deploy-with-secret.sh` script, manual deployment via Docker and gcloud CLI, and CI/CD setup with Cloud Build.

**Development Conventions**

*   **Technology Stack:**
    *   **Frontend:** React 19, TypeScript, Vite
    *   **Backend:** Express.js with ES modules
    *   **AI Service:** Google Gemini 2.5 Flash with grounding via `@google/generative-ai` SDK
    *   **Styling:** Custom CSS
    *   **Deployment:** Docker, Google Cloud Run, Secret Manager
*   **Secret Management:**
    *   **Production:** All secrets (e.g., `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `SESSION_SECRET`) are stored in Google Secret Manager and injected as environment variables by Cloud Run.
    *   **Local Development:** Secrets are managed via `.env.local` files or direct environment variables. The `.env.local` file is git-ignored and should never be committed.
    *   Dedicated scripts (`setup-all-secrets.sh`, `update-turnstile-secret.sh`, `deploy-with-secret.sh`) are provided for secret management.
*   **Security Best Practices:**
    *   Never commit secrets to the repository.
    *   Regularly rotate secrets.
    *   Utilize Secret Manager for production environments.
    *   Adhere to the principle of least privilege for secret access.
*   **Code Structure:**
    *   Frontend components are located in the `components/` and `pages/` directories.
    *   Backend logic is primarily in `server.js` and `services/`.
    *   Utility functions are in the `utils/` directory.
*   **Testing:** (No explicit testing commands or frameworks were identified in the `README.md` beyond general development commands. Further exploration would be needed to determine specific testing conventions.)