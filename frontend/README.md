# AVC Election frontend

JavaScript React frontend for the AVC election staff panels and voting terminal.
The structure follows the React Enterprise SOP, with the project's JavaScript
preference in place of strict TypeScript.

## Run locally

1. Install Node.js 22.12 or newer.
2. From this directory, install the locked dependencies:

   ```powershell
   npm ci
   ```

3. Copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL` to the
   FastAPI address. The default uses Vite's `/api` proxy to local FastAPI at
   `http://127.0.0.1:8000`; change the proxy target in `vite.config.js` if your
   backend uses another address.
4. Start the Vite development server:

   ```powershell
   npm run dev
   ```

The dev server binds to `127.0.0.1:5173`.

## Structure

- `src/api/` contains the shared HTTP client and endpoint modules.
- `src/app/` contains routing, role guards, and application setup.
- `src/components/ui/` contains reusable UI components.
- `src/features/` contains code grouped by election workflow and role.
- `src/i18n/` contains local English and Tamil resources.
- `src/layouts/` contains authentication, staff-panel, and terminal layouts.
- `src/stores/` contains small client-only Zustand stores. Access tokens stay
  in memory; server data belongs in TanStack Query.
- `src/styles/` contains the Tailwind entry point, design tokens, and shared UI
  styles.

The admin dashboard reads `/healthz` and displays the API/database connection
state. The panel routes and login form are scaffolding. They call the endpoint
paths from the implementation plan, but backend authentication and panel APIs
still need to be implemented. Position names are expected to come from election
data; none are hard-coded in the UI. Tamil strings are working drafts and
require native-reader review before election use.

## Checks

```powershell
npm run lint
npm run lint:css
npm run build
```
