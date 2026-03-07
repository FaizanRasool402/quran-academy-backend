# QuranAcademy BackEnd

Simple Node.js/Express backend for Aiza Quran Academy.

## Features

- `POST /api/contact` endpoint for contact / admission forms
- CORS enabled for the frontend (`http://localhost:3000` by default)

## Setup

1. Open a terminal in:

   ```bash
   cd "c:\\Users\\Dell\\Desktop\\QuranAcademy\\BackEnd"
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. (Optional) Create a `.env` file in this folder if you want to override defaults:

   ```bash
   PORT=5000
   CLIENT_ORIGIN=http://localhost:3000
   ```

4. Run the server:

   ```bash
   npm run dev
   ```

   or

   ```bash
   npm start
   ```

The Hero form in the frontend is configured to send requests to `http://localhost:5000/api/contact` by default, so no extra configuration is needed if you keep the same port.

