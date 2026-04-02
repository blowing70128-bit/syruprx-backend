# SyrupRX Backend Relay

This service now handles **both** license validation and AI relay for SyrupRX.

## What changed
- Customer downloads no longer need local OpenAI keys.
- The FiveM resource sends prompts to your private backend.
- The backend validates the Payhip license, checks the server fingerprint, then calls OpenAI.

## Required environment variables
- `OPENAI_API_KEY`
- `SYRUPRX_ADMIN_SECRET`

## Optional environment variables
- `OPENAI_MODEL` (default: `gpt-5.4-mini`)
- `SYRUPRX_RELAY_SECRET` (if you want the FiveM resource to include a backend shared secret)

## Deploy
1. Upload this folder to Heroku or another Node host.
2. Set the environment variables above.
3. Confirm `GET /health` returns JSON.
4. Add your Payhip keys using the admin upsert endpoint.
5. In each SyrupRX build, set:
   - `syruprx_license_api_url` to this backend base URL
   - `syruprx_backend_url` to this backend base URL

## AI endpoint
- `POST /v1/ai/agent`
- Validates the license on every request and relays to OpenAI Responses API.

## Seed sample data
```bash
npm install
npm run seed
npm start
```


## Demo product codes
- syruprx-demo-qbcore
- syruprx-demo-esx
- syruprx-demo-qbox

Add demo licenses with the same admin upsert endpoint used for the paid builds.
"# syruprx-backend" 
