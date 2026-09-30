# Even From Afar
Local: `npm install && npm start` → http://localhost:3000 (LAN devices: https://<LAN-IP>:3443).
Online: deploy on Render (free Web Service; Build `npm install`, Start `npm start`). HTTPS is automatic.
Optional reliable TURN (env vars in Render): METERED_APP=<yourapp>.metered.live and METERED_API_KEY=<key>,
or TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL. Without them a free public relay is used (best effort).
